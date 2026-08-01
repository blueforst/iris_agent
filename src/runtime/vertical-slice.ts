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

async function closeSessionStorage(session: Session): Promise<void> {
  const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
  await storage.cleanup();
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

async function openOrCreateSession(
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
    const { harness, observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      prepared,
      input,
      invocationId: `invocation-${input.inputId}`,
      now,
      providerProfileId,
      callbacks: options.callbacks,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    const assistantMessage = await harness.prompt(encodeInputFrames(input.blocks));
    const entries = await session.getEntries();
    await closeSessionStorage(session);
    epochStore.close();
    return {
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      observers,
      assistantMessage,
      entries,
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
    const { session } = await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId);
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
    const { observers } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      prepared,
      input,
      invocationId: `restart-${input.inputId}`,
      now,
      providerProfileId,
    });
    observers.providerContextSnapshots = providerContextSnapshots;
    const entries = await session.getEntries();
    await closeSessionStorage(session);
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
 * Settled-only rollover: close the active Epoch and open a fresh one.
 * Mirrors the spec's rollover boundary (02 Runtime Sessions) in the minimal
 * slice: after Pi settled, the old Session is closed and a new empty Pi
 * Session is created for the next Epoch. Returns both Epoch/Session identities
 * so tests can assert the CAS transition (old closed, new active, linked).
 */
export async function rolloverActiveSession(options: {
  dataRoot: string;
  config?: AgentConfigV3;
  now?: string;
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
    epochStore.requestRollover("test-rollover");
    const next = epochStore.rolloverAfterSettled(now);
    const entries = await sessionEntriesFor(options.dataRoot, config, next.runtimeSessionId);
    epochStore.close();
    return {
      previousEpochId: previous.epochId,
      previousSessionId: previous.runtimeSessionId,
      newEpochId: next.epochId,
      newSessionId: next.runtimeSessionId,
      previousStatus: "closed",
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
