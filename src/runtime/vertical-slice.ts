import { createHash } from "node:crypto";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";

import type { ContextMessageUnit } from "../contracts/context-units.js";
import type { RuntimeEvent } from "../contracts/runtime-events.js";
import { RuntimeEventLedger } from "./runtime-event-ledger.js";
import { ContextStore } from "../context/context-store.js";
import { ContextIngest } from "../context/context-ingest.js";
import { attachRuntimeEventSeam } from "./runtime-event-seam.js";

import {
  type AgentHarnessTool,
  type Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
  type SqliteSessionMetadata,
} from "@earendil-works/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { PreparedContextSources } from "../contracts/context.js";
import type { AgentInput } from "../contracts/origin.js";
import { directUserRequest } from "../contracts/origin.js";
import { acquireDataRootLock } from "../host/lock.js";
import { initializeDataRoot, resolveDataRootPaths } from "../host/data-root.js";
import { nodeSqliteRepoEnv } from "./pi-env.js";
import { RuntimeEpochStore } from "./epoch-manager.js";
import { encodeInputFrames } from "./companion.js";
import { createMockProvider } from "./mock-provider.js";
import { createOpenCodeGoProvider } from "./opencode-go-provider.js";
import {
  createIrisHarness,
  type HarnessObservers,
  type IrisHarnessCallbacks,
} from "./harness-factory.js";

export interface VerticalSliceResult {
  epochId: string;
  runtimeSessionId: string;
  observers: HarnessObservers;
  assistantMessage: AssistantMessage;
  entries: SessionTreeEntry[];
  /** R1-P1e：runtime-event ledger exactly-once 提交的不可变事件流。 */
  ledgerEvents: RuntimeEvent[];
  /** R2-P0：ContextMessageUnit 语义单元（ingest 折叠后）。 */
  contextUnits: ContextMessageUnit[];
  dataRoot: string;
}

export type SliceProviderMode = "mock" | "live";

export interface ProviderComposition {
  models: Parameters<typeof createIrisHarness>[0]["models"];
  model: Parameters<typeof createIrisHarness>[0]["model"];
  providerProfileId: string;
}

export async function composeProvider(
  mode: SliceProviderMode,
  onContext?: (messages: unknown[]) => void,
): Promise<ProviderComposition> {
  if (mode === "mock") {
    const { models, model } = createMockProvider(onContext === undefined ? {} : { onContext });
    return { models, model, providerProfileId: "mock-iris-provider-v1" };
  }
  const { models, model } = await createOpenCodeGoProvider();
  return {
    models,
    model,
    providerProfileId: "opencode-go-deepseek-v4-flash-dev-nonthinking-v1",
  };
}

/**
 * 0.83.0+：Session 不再暴露 storage 访问器；连接生命周期由
 * SqliteSessionRepository 管理。关闭 = repo[Symbol.asyncDispose]()。
 */
export async function closeSessionStorage(repo: {
  [Symbol.asyncDispose](): Promise<void>;
}): Promise<void> {
  await repo[Symbol.asyncDispose]();
}

export function prepareContextSources(
  input: AgentInput,
  runtimeSessionId: string,
  epochId: string,
  config: AgentConfigV3,
  now: string,
): PreparedContextSources {
  const canonicalSystemPrompt =
    `IRIS SYSTEM PROMPT V1\n` +
    `instance: ${config.instance_name}\n` +
    `runtimeSessionId: ${runtimeSessionId}\n` +
    `epochId: ${epochId}\n` +
    `inputId: ${input.inputId}\n` +
    `providerProfileId: ${config.model.main_agent.active_profile}\n` +
    `binding: immutable-for-invocation\n`;
  return {
    contextSourceSnapshotId: `snapshot-${createHash("sha256").update(canonicalSystemPrompt).digest("hex").slice(0, 12)}`,
    runtimeSessionId,
    canonicalSystemPrompt,
    systemProjectionHash: createHash("sha256").update(canonicalSystemPrompt).digest("hex"),
    materializationIdentity: "mock-m0m1-v1",
    preparedAt: new Date(now).toISOString(),
  };
}

export function sampleAgentInput(): AgentInput {
  return {
    inputId: "input-0001",
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: "block-0001",
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text: "hello iris, run the read tool" },
        contentHash: createHash("sha256").update("hello iris, run the read tool").digest("hex"),
      },
    ],
    interaction: { interactionId: "interaction-0001" },
  };
}

export async function openOrCreateSession(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<{ repo: SqliteSessionRepository; session: Session<SqliteSessionMetadata> }> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata !== undefined) {
    return { repo, session: await repo.open(metadata) };
  }
  return { repo, session: await repo.create({ id: runtimeSessionId, cwd: dataRoot }) };
}

export function makeReadOnlyTestTool(): AgentHarnessTool<undefined> {
  return {
    name: "test_read_tool",
    label: "Test read tool",
    description: "Deterministic read-only test tool used by the R1-P0 vertical slice.",
    parameters: Type.Object({ query: Type.String() }),
    executionMode: "sequential",
    async execute() {
      return {
        content: [{ type: "text", text: "read-only result: iris" }],
        details: { source: "mock-read-tool", query: "iris" },
      };
    },
  };
}

export async function runMinimalSlice(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  input?: AgentInput;
  now?: string;
  provider?: SliceProviderMode;
  callbacks?: IrisHarnessCallbacks;
}): Promise<VerticalSliceResult> {
  const config = options.config ?? defaultAgentConfig();
  const input = options.input ?? sampleAgentInput();
  const now = options.now ?? "2026-08-01T00:00:00.000Z";
  const providerMode = options.provider ?? "mock";
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const { repo, session } = await openOrCreateSession(
      options.dataRoot,
      config,
      epoch.runtimeSessionId,
    );
    const prepared = prepareContextSources(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    const currentInvocation = {
      input,
      prepared,
      invocationId: `invocation-${input.inputId}`,
    };
    // R1-P1e: runtime-event ledger exactly-once 记录 Pi seam 生命周期事件。
    const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
    // R2-P0: ContextMessageUnit 语义 ledger（context.db）——事件提交后
    // ensureUnitsUpTo 建单元；contextController 从单元投影（不再依赖 Session）。
    const contextStore = ContextStore.open(paths.contextDb);
    const contextIngest = new ContextIngest(ledger, contextStore);
    const { harness, observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId,
      callbacks: options.callbacks,
      contextIngest,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    attachRuntimeEventSeam(harness, {
      ledger,
      runtimeSessionId: epoch.runtimeSessionId,
      piSessionId: epoch.runtimeSessionId,
      contextIngest,
    });
    const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
    const ledgerEvents = ledger.listBySession(epoch.runtimeSessionId);
    const contextUnits = contextIngest.listUnits(epoch.runtimeSessionId);
    ledger.close();
    contextStore.close();
    const entries = await session.getEntries();
    await closeSessionStorage(repo);
    epochStore.close();
    return {
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      observers,
      assistantMessage,
      entries,
      ledgerEvents,
      contextUnits,
      dataRoot: options.dataRoot,
    };
  } finally {
    await lock.release();
  }
}

export async function reopenActiveSession(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  input?: AgentInput;
  now?: string;
  provider?: SliceProviderMode;
}): Promise<{
  runtimeSessionId: string;
  observers: HarnessObservers;
  entries: SessionTreeEntry[];
}> {
  const config = options.config ?? defaultAgentConfig();
  const input = options.input ?? sampleAgentInput();
  const now = options.now ?? "2026-08-01T00:00:00.000Z";
  const providerMode = options.provider ?? "mock";
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const { repo, session } = await openOrCreateSession(
      options.dataRoot,
      config,
      epoch.runtimeSessionId,
    );
    const prepared = prepareContextSources(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    const currentInvocation = {
      input,
      prepared,
      invocationId: `restart-${input.inputId}`,
    };
    const { observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    const entries = await session.getEntries();
    await closeSessionStorage(repo);
    epochStore.close();
    return {
      runtimeSessionId: epoch.runtimeSessionId,
      observers,
      entries,
    };
  } finally {
    await lock.release();
  }
}

export interface RolloverResult {
  previousEpochId: string;
  previousSessionId: string;
  newEpochId: string;
  newSessionId: string;
  previousStatus: string;
  entries: SessionTreeEntry[];
}

/**
 * Settled-only rollover (02 Runtime Sessions, Rollover Boundary).
 *
 * Implements the recoverable two-phase switch:
 *  1. beginRollover(now)   -> new Epoch row in 'creating' (old stays active)
 *  2. createPiSession(...) -> actually create the new Pi Session row
 *  3. close old Session storage (flush pending writes)
 *  4. activateRollover(now) -> single-transaction CAS: old -> closed,
 *                              new -> active (previous_epoch_id linked at creation)
 *
 * A crash between 1 and 4 leaves the old epoch active + a 'creating' row,
 * which `recoverCreating()` (startup) cleans up — the active-epoch invariant
 * is never durably violated and no zero-active window exists.
 */
export async function rolloverActiveSession(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  now?: string;
  /**
   * Settled authorization (review blocker #3): the epoch id that reached Pi
   * settled. rollover refuses to switch unless the currently active epoch is
   * exactly this one — an arbitrary caller cannot start a rollover while an
   * invocation is still active on a different epoch.
   */
  settledEpochId: string;
}): Promise<RolloverResult> {
  const config = options.config ?? defaultAgentConfig();
  const now = options.now ?? "2026-08-01T00:00:00.000Z";
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const previous = epochStore.ensureActive(now);
    // Settled-only guard: the caller must prove the epoch that settled is the
    // one currently active. Without this, any caller could roll over while an
    // invocation is still running.
    if (previous.epochId !== options.settledEpochId) {
      epochStore.close();
      throw new Error(
        `rollover refused: active epoch ${previous.epochId} is not the settled epoch ${options.settledEpochId}`,
      );
    }
    const pending = epochStore.beginRollover(now);

    // Create the new Pi Session (actually materializes a row; a test asserting
    // "fresh empty session" must find a real session, not a missing one).
    const newSessionHandle = await openOrCreateSession(
      options.dataRoot,
      config,
      pending.runtimeSessionId,
    );
    await closeSessionStorage(newSessionHandle.repo);

    // Close the old Pi Session storage (flush pending writes) before the CAS.
    const oldSessionHandle = await openOrCreateSession(
      options.dataRoot,
      config,
      previous.runtimeSessionId,
    );
    await closeSessionStorage(oldSessionHandle.repo);

    const next = epochStore.activateRollover(now);
    const entries = await sessionEntriesFor(options.dataRoot, config, next.runtimeSessionId);
    epochStore.close();
    return {
      previousEpochId: previous.epochId,
      previousSessionId: previous.runtimeSessionId,
      newEpochId: next.epochId,
      newSessionId: next.runtimeSessionId,
      previousStatus: previous.status,
      entries,
    };
  } finally {
    await lock.release();
  }
}

async function sessionEntriesFor(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<SessionTreeEntry[]> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata === undefined) {
    return [];
  }
  const session = await repo.open(metadata);
  const entries = await session.getEntries();
  await closeSessionStorage(repo);
  return entries;
}
