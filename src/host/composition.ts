import type { AgentHarness } from "@earendil-works/pi-agent-core";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { AgentInput } from "../contracts/origin.js";
import type { SliceProviderMode } from "../runtime/vertical-slice.js";
import {
  composeProvider,
  openOrCreateSession,
  closeSessionStorage,
  prepareContextSources,
  makeReadOnlyTestTool,
} from "../runtime/vertical-slice.js";
import { createIrisHarness, type InvocationBinding } from "../runtime/harness-factory.js";
import { RuntimeCoordinator } from "../runtime/runtime-coordinator.js";
import { RuntimeEpochStore } from "../runtime/epoch-manager.js";
import type { RuntimeSessionEpoch } from "../contracts/runtime.js";
import { initializeDataRoot, resolveDataRootPaths } from "./data-root.js";
import { acquireDataRootLock, type DataRootLockHandle } from "./lock.js";
import { SqliteSessionRepo } from "@earendil-works/pi-storage-sqlite-node";
import { createNodeSqliteFactory } from "@earendil-works/pi-storage-sqlite-node";
import { nodeSqliteRepoEnv } from "../runtime/pi-env.js";

/**
 * Host composition (00 Module Boundaries): the product path that both
 * `iris serve` and `iris run` share. It owns startup recovery (discards
 * stale 'creating' Epochs and their orphan Pi Session rows), the active
 * Runtime Session, the Pi Harness and the RuntimeCoordinator. This is the
 * real composition seam the CLI uses — not a one-shot library call.
 */
export interface HostComposition {
  dataRoot: string;
  config: AgentConfigV3;
  epochStore: RuntimeEpochStore;
  epoch: RuntimeSessionEpoch;
  coordinator: RuntimeCoordinator;
  currentInvocation: InvocationBinding;
  close(): Promise<void>;
}

export interface OpenHostOptions {
  dataRoot: string;
  config?: AgentConfigV3;
  provider: SliceProviderMode;
}

export async function openHost(options: OpenHostOptions): Promise<HostComposition> {
  const config = options.config ?? defaultAgentConfig();
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock: DataRootLockHandle = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  try {
    initializeDataRoot(options.dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );

    // Startup recovery: discard any stale 'creating' Epoch (crash between
    // beginRollover and activateRollover) AND delete the orphan Pi Session
    // rows they referenced, so no dead session rows accumulate.
    const orphanSessions = epochStore.recoverCreating();
    if (orphanSessions.length > 0) {
      const repo = new SqliteSessionRepo({
        env: nodeSqliteRepoEnv(options.dataRoot),
        sqlite: createNodeSqliteFactory(),
        databasePath: paths.sessionDb,
      });
      const list = await repo.list({ cwd: options.dataRoot });
      for (const orphan of orphanSessions) {
        const metadata = list.find((candidate) => candidate.id === orphan);
        if (metadata !== undefined) {
          await repo.delete?.(metadata);
        }
      }
    }

    const epoch = epochStore.ensureActive(new Date().toISOString());
    const { session } = await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId);
    const { models, model, providerProfileId } = await composeProvider(options.provider);
    const currentInvocation: InvocationBinding = {
      input: emptyPlaceholderInput(),
      prepared: prepareContextSources(
        emptyPlaceholderInput(),
        epoch.runtimeSessionId,
        epoch.epochId,
        config,
        new Date().toISOString(),
      ),
      invocationId: `invocation-${epoch.runtimeSessionId}`,
    };
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now: new Date().toISOString(),
      providerProfileId,
    });
    const coordinator = new RuntimeCoordinator({
      harness,
      currentInvocation,
      prepareInvocation: async (input: AgentInput) =>
        prepareContextSources(
          input,
          epoch.runtimeSessionId,
          epoch.epochId,
          config,
          new Date().toISOString(),
        ),
    });

    let closed = false;
    return {
      dataRoot: options.dataRoot,
      config,
      epochStore,
      epoch,
      coordinator,
      currentInvocation,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await closeSessionStorage(session);
        epochStore.close();
        await lock.release();
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

function emptyPlaceholderInput(): AgentInput {
  return {
    inputId: "host-placeholder",
    triggerOrigin: {
      schemaVersion: 1,
      channel: "host",
      principalKind: "system",
      authority: "internal_control",
      trust: "trusted",
    },
    blocks: [
      {
        blockId: "host-placeholder-block",
        sourceOrigin: {
          schemaVersion: 1,
          channel: "host",
          principalKind: "system",
          authority: "internal_control",
          trust: "trusted",
        },
        content: { mode: "inline_text", text: "" },
        contentHash: "",
      },
    ],
  };
}

export type { AgentHarness };
