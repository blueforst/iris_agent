import { createHash } from "node:crypto";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";

import {
  type AgentHarnessTool,
  type Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-storage-sqlite-node";

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
import { ContextRuntime } from "../context/context-runtime.js";
import { ContextStore } from "../context/context-store.js";

export interface VerticalSliceResult {
  epochId: string;
  runtimeSessionId: string;
  observers: HarnessObservers;
  assistantMessage: AssistantMessage;
  entries: SessionTreeEntry[];
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

export async function closeSessionStorage(session: Session): Promise<void> {
  const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
  await storage.cleanup();
}

/**
 * Create the REAL Context runtime (issue #8 A3): the ContextStore-backed
 * pipeline the Pi `context` hook calls for every provider request. The
 * `readEntries` port is the narrow Session history read supplied by the
 * Capsule (never the concrete Session object). The legacy mock transformer
 * (mock-m0m1-v1) is NOT used on this path.
 */
export function createContextRuntime(options: {
  dataRoot: string;
  config: AgentConfigV3;
  readEntries: () => Promise<SessionTreeEntry[]>;
  nowMs?: () => number;
  contextLimit?: number;
  executeThresholdPercentage?: number;
}): { runtime: ContextRuntime; store: ContextStore } {
  const paths = resolveDataRootPaths(options.dataRoot, options.config);
  const store = ContextStore.open(paths.contextDb);
  const nowMs = options.nowMs ?? (() => Date.now());
  const identity = {
    personaSnapshotId: "persona-baseline-v1",
    declarationVersion: "iris-declarations-v1",
    providerProfileId: options.config.model.main_agent.active_profile,
    canonicalSystemPrompt: `IRIS SYSTEM PROMPT V1\ninstance: ${options.config.instance_name}\nproviderProfileId: ${options.config.model.main_agent.active_profile}\nbinding: immutable-for-invocation\n`,
    systemProjectionHash: createHash("sha256")
      .update(
        `IRIS SYSTEM PROMPT V1\ninstance: ${options.config.instance_name}\nproviderProfileId: ${options.config.model.main_agent.active_profile}\nbinding: immutable-for-invocation\n`,
        "utf8",
      )
      .digest("hex"),
  };
  // Context window for the unresolved-hard-overflow escalation: prefer the
  // verified model metadata, allow the caller to override (tests / usage).
  const verifiedWindow = options.config.model.main_agent.verified_model_metadata?.context_window;
  // History block budget for the m1 absolute-cap backstop: authority
  // historyBlockBudget = effectiveExecuteBudget × history_budget_percentage
  // (default 0.15, capped at 80% of the context limit). When the verified
  // window is known, derive it; otherwise leave the backstop disabled.
  const historyBudgetTokens =
    verifiedWindow === undefined ? undefined : Math.round(verifiedWindow * 0.65 * 0.15);
  const runtime = new ContextRuntime({
    store,
    readEntries: options.readEntries,
    identity,
    nowMs,
    ...(options.contextLimit === undefined
      ? verifiedWindow !== undefined
        ? { contextLimit: verifiedWindow }
        : {}
      : { contextLimit: options.contextLimit }),
    ...(options.executeThresholdPercentage === undefined
      ? {}
      : { executeThresholdPercentage: options.executeThresholdPercentage }),
    ...(historyBudgetTokens === undefined ? {} : { historyBudgetTokens }),
  });
  return { runtime, store };
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
    // Real identity is established by the ContextRuntime lineage; the pure
    // helper can only claim a placeholder until the runtime binds the
    // Session lineage (issue #8 A3: never the legacy mock-m0m1-v1).
    materializationIdentity: `pending-${runtimeSessionId}`,
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
): Promise<{ repo: SqliteSessionRepo; session: Session }> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepo({
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
    const { session } = await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId);
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    // The REAL Context pipeline (issue #8 A3): the Pi `context` hook runs the
    // ContextStore-backed pass on every provider call. The narrow read port
    // is the session's raw entries (Capsule-owned; Context never holds the
    // Session object). prepareInvocationSources binds the lineage so the
    // first transform materializes (HARD) instead of failing closed.
    const { runtime, store: contextStore } = createContextRuntime({
      dataRoot: options.dataRoot,
      config,
      readEntries: async () => session.getEntries(),
      nowMs: () => new Date(now).getTime(),
    });
    const prepared = runtime.prepareInvocationSources({
      inputId: input.inputId,
      runtimeSessionId: epoch.runtimeSessionId,
      epochId: epoch.epochId,
    });
    const currentInvocation = {
      input,
      prepared,
      invocationId: `invocation-${input.inputId}`,
    };
    const { harness, observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId,
      contextTransform: (transformInput) =>
        runtime.transformMessages({
          invocationId: transformInput.invocationId,
          runtimeSessionId: transformInput.runtimeSessionId,
          messages: transformInput.messages,
          model: transformInput.model,
          providerProfileId: transformInput.providerProfileId,
        }),
      callbacks: options.callbacks,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    try {
      const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
      const entries = await session.getEntries();
      return {
        epochId: epoch.epochId,
        runtimeSessionId: epoch.runtimeSessionId,
        observers,
        assistantMessage,
        entries,
        dataRoot: options.dataRoot,
      };
    } finally {
      contextStore.close();
      await closeSessionStorage(session);
      epochStore.close();
    }
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
    const { session } = await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId);
    const providerContextSnapshots: string[] = [];
    const { models, model, providerProfileId } = await composeProvider(providerMode, (messages) => {
      providerContextSnapshots.push(JSON.stringify(messages));
    });
    const { runtime, store: contextStore } = createContextRuntime({
      dataRoot: options.dataRoot,
      config,
      readEntries: async () => session.getEntries(),
      nowMs: () => new Date(now).getTime(),
    });
    const prepared = runtime.prepareInvocationSources({
      inputId: input.inputId,
      runtimeSessionId: epoch.runtimeSessionId,
      epochId: epoch.epochId,
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
      contextTransform: (transformInput) =>
        runtime.transformMessages({
          invocationId: transformInput.invocationId,
          runtimeSessionId: transformInput.runtimeSessionId,
          messages: transformInput.messages,
          model: transformInput.model,
          providerProfileId: transformInput.providerProfileId,
        }),
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    try {
      const entries = await session.getEntries();
      return {
        runtimeSessionId: epoch.runtimeSessionId,
        observers,
        entries,
      };
    } finally {
      contextStore.close();
      await closeSessionStorage(session);
      epochStore.close();
    }
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
    await closeSessionStorage(newSessionHandle.session);

    // Close the old Pi Session storage (flush pending writes) before the CAS.
    const oldSessionHandle = await openOrCreateSession(
      options.dataRoot,
      config,
      previous.runtimeSessionId,
    );
    await closeSessionStorage(oldSessionHandle.session);

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
  const repo = new SqliteSessionRepo({
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
  await closeSessionStorage(session);
  return entries;
}
