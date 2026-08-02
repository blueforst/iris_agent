import type { Session } from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { AgentInput, ExternalizedPayloadRef } from "../contracts/origin.js";
import type { AgentRuntimeEvent } from "../contracts/ports.js";
import type { RuntimeSessionEpoch } from "../contracts/runtime.js";
import { initializeDataRoot, resolveDataRootPaths } from "./data-root.js";
import { acquireDataRootLock, type DataRootLockHandle } from "./lock.js";
import {
  IngressConflictError,
  IngressQueueFullError,
  InputAcceptanceLedger,
  type IngressAcceptOutcome,
  type InputAcceptanceRecord,
} from "./ingress.js";
import { RuntimeEpochStore } from "../runtime/epoch-manager.js";
import { nodeSqliteRepoEnv } from "../runtime/pi-env.js";
import {
  closeSessionStorage,
  composeProvider,
  openOrCreateSession,
  prepareContextSources,
  makeReadOnlyTestTool,
} from "../runtime/vertical-slice.js";
import { createIrisHarness, type InvocationBinding } from "../runtime/harness-factory.js";
import { PiRuntimeAdapter } from "../runtime/pi-runtime-adapter.js";
import {
  ActiveRuntimeRegistry,
  activeRuntimeHandle,
  type ActiveRuntimeHandle,
} from "../runtime/active-runtime-registry.js";
import { RuntimeCoordinator } from "../runtime/runtime-coordinator.js";

export interface IrisHostOptions {
  dataRoot: string;
  config?: AgentConfigV3;
  /** Provider mode for the active Capsule. */
  provider: "mock" | "live";
  /** Durable instance epoch used as the ingress dedupe identity dimension. */
  instanceEpoch?: number;
}

export interface IrisHostHealth {
  ready: boolean;
  dataRoot: string;
  epochId: string;
  runtimeSessionId: string;
  coordinatorPhase: string;
  queuedInputs: number;
  rolloverPending: boolean;
}

export interface SessionStatusView {
  epochId: string;
  runtimeSessionId: string;
  localDate: string;
  ordinalWithinDate: number;
  status: string;
  previousEpochId?: string;
  createdAt: string;
  closedAt?: string;
}

export interface ArchiveEntryView {
  epochId: string;
  runtimeSessionId: string;
  status: string;
  localDate: string;
  ordinalWithinDate: number;
  createdAt: string;
  closedAt?: string;
}

export type HostRuntimeEvent =
  | AgentRuntimeEvent
  | {
      type: "rollover_completed";
      epochId: string;
      runtimeSessionId: string;
      settledEpochId: string;
    }
  | { type: "ingress_accepted"; inputId: string; instanceEpoch: number; state: string };

/**
 * IrisHost — the single long-lived Host process (00 Module Boundaries, 03
 * Host Runtime). It:
 *
 *  1. acquires <dataRoot>/iris.lock and holds it for the FULL lifetime;
 *  2. runs startup recovery (stale creating Epochs + orphan Pi Sessions);
 *  3. opens the active Epoch + Pi Session and constructs the Capsule;
 *  4. constructs the RuntimeCoordinator + ActiveRuntimeRegistry;
 *  5. starts the durable ingress pump (auto-consumes the FIFO queue);
 *  6. drives settled-only rollover when requested;
 *  7. reports ready only after startup; flips not-ready on shutdown.
 *
 * The CLI / HTTP / future clients are Host clients; they never open the data
 * root or construct another Iris.
 */
export class IrisHost {
  private readonly dataRoot: string;
  private readonly config: AgentConfigV3;
  private readonly lock: DataRootLockHandle;
  private readonly epochStore: RuntimeEpochStore;
  private readonly ingress: InputAcceptanceLedger;
  private readonly registry: ActiveRuntimeRegistry;
  private readonly coordinator: RuntimeCoordinator;
  private readonly providerMode: "mock" | "live";

  private readyFlag = false;
  private shuttingDown = false;
  private readonly listeners = new Set<(event: HostRuntimeEvent) => void>();
  private readonly wake = createWakeSignal();
  private currentEpoch: RuntimeSessionEpoch;
  private instanceEpoch: number;

  private constructor(options: {
    dataRoot: string;
    config: AgentConfigV3;
    provider: "mock" | "live";
    lock: DataRootLockHandle;
    epochStore: RuntimeEpochStore;
    ingress: InputAcceptanceLedger;
    registry: ActiveRuntimeRegistry;
    coordinator: RuntimeCoordinator;
    currentEpoch: RuntimeSessionEpoch;
    instanceEpoch: number;
  }) {
    this.dataRoot = options.dataRoot;
    this.config = options.config;
    this.providerMode = options.provider;
    this.lock = options.lock;
    this.epochStore = options.epochStore;
    this.ingress = options.ingress;
    this.registry = options.registry;
    this.coordinator = options.coordinator;
    this.currentEpoch = options.currentEpoch;
    this.instanceEpoch = options.instanceEpoch;
  }

  getReady(): boolean {
    return this.readyFlag;
  }

  getDataRoot(): string {
    return this.dataRoot;
  }

  getEpochStore(): RuntimeEpochStore {
    return this.epochStore;
  }

  getIngress(): InputAcceptanceLedger {
    return this.ingress;
  }

  getRegistry(): ActiveRuntimeRegistry {
    return this.registry;
  }

  getCoordinator(): RuntimeCoordinator {
    return this.coordinator;
  }

  getCurrentEpoch(): RuntimeSessionEpoch {
    return this.currentEpoch;
  }

  onEvent(listener: (event: HostRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostRuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  health(): IrisHostHealth {
    void this.registry.getActiveOrNull();
    return {
      ready: this.readyFlag && !this.shuttingDown,
      dataRoot: this.dataRoot,
      epochId: this.currentEpoch.epochId,
      runtimeSessionId: this.currentEpoch.runtimeSessionId,
      coordinatorPhase: this.coordinator.getPhase(),
      queuedInputs: this.ingress.queuedCount(),
      rolloverPending: this.epochStore.isRolloverPending(),
    };
  }

  sessionStatus(): SessionStatusView {
    const epoch = this.epochStore.getActive();
    if (epoch === null) {
      return {
        epochId: this.currentEpoch.epochId,
        runtimeSessionId: this.currentEpoch.runtimeSessionId,
        localDate: this.currentEpoch.localDate,
        ordinalWithinDate: this.currentEpoch.ordinalWithinDate,
        status: "none",
        createdAt: this.currentEpoch.createdAt,
      };
    }
    return {
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      localDate: epoch.localDate,
      ordinalWithinDate: epoch.ordinalWithinDate,
      status: epoch.status,
      ...(epoch.previousEpochId !== undefined ? { previousEpochId: epoch.previousEpochId } : {}),
      createdAt: epoch.createdAt,
      ...(epoch.closedAt !== undefined ? { closedAt: epoch.closedAt } : {}),
    };
  }

  archives(limit: number): ArchiveEntryView[] {
    const rows = this.epochStore.listAll(limit);
    return rows.map((epoch) => ({
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      status: epoch.status,
      localDate: epoch.localDate,
      ordinalWithinDate: epoch.ordinalWithinDate,
      createdAt: epoch.createdAt,
      ...(epoch.closedAt !== undefined ? { closedAt: epoch.closedAt } : {}),
    }));
  }

  /**
   * Durable input acceptance (03 Host Runtime). Validates the envelope
   * identity, writes the accepted record + normalized envelope, enqueues for
   * the active runtime and wakes the pump. Retries of an accepted-but-
   * uncommitted input re-enter the normal single-writer path; a
   * session_committed input returns its existing result without re-prompting.
   */
  acceptInput(input: unknown, inputId: string, instanceEpoch?: number): IngressAcceptOutcome {
    try {
      const outcome = this.ingress.accept(input, inputId, instanceEpoch);
      if (outcome.outcome === "accepted") {
        this.emit({
          type: "ingress_accepted",
          inputId,
          instanceEpoch: outcome.record.instanceEpoch,
          state: outcome.record.state,
        });
      }
      this.wake.notify();
      return outcome;
    } catch (error) {
      if (error instanceof IngressQueueFullError || error instanceof IngressConflictError) {
        throw error;
      }
      throw error;
    }
  }

  /** Explicit rollover request (admin). Switch happens only after native settled. */
  requestRollover(reason: string): void {
    this.epochStore.requestRollover(reason);
    this.wake.notify();
  }

  /** Precise abort forwarded to the current invocation (waits for settled). */
  async abort(invocationId: string): Promise<void> {
    await this.coordinator.abort(invocationId);
  }

  /**
   * Mark the host ready AFTER startup + recovery complete. The HTTP transport
   * must not report ready before this call.
   */
  markReady(): void {
    if (this.shuttingDown) {
      throw new Error("cannot mark ready after shutdown started");
    }
    this.readyFlag = true;
  }

  /** Long-lived pump: auto-consumes the bounded FIFO and drives rollover. */
  async run(): Promise<void> {
    this.markReady();
    while (!this.shuttingDown) {
      // 1. If a rollover was requested and no invocation is active, switch now.
      if (this.epochStore.isRolloverPending()) {
        const switched = await this.maybeRolloverAfterSettled();
        if (!switched) {
          // Invocation still active (or rollover not yet authorized): wait for
          // the settled boundary via the pump wake.
          await this.wake.wait();
          continue;
        }
        continue;
      }

      // 2. Consume one accepted input.
      const entry = this.ingress.dequeue();
      if (entry === undefined) {
        await this.wake.wait();
        continue;
      }

      const envelope = this.ingress.loadEnvelope(entry.inputId, entry.instanceEpoch);
      if (envelope === undefined) {
        this.ingress.markRejected(entry.inputId, entry.instanceEpoch, "envelope_missing");
        this.emit({
          type: "failed",
          invocationId: `ingress-${entry.inputId}`,
          code: "envelope_missing",
        });
        continue;
      }
      await this.runInvocation(entry.inputId, entry.instanceEpoch, envelope);
    }
  }

  private async runInvocation(
    inputId: string,
    instanceEpoch: number,
    envelope: unknown,
  ): Promise<void> {
    const input = envelope as AgentInput;
    // The Coordinator reads the CURRENT active runtime from the registry, so
    // a rollover between queued inputs automatically routes the next input to
    // the fresh Capsule (03 Runtime Coordinator, Queued-input Provenance).
    try {
      // Consume the FULL generator: breaking early would return() the
      // Coordinator generator and skip its phase transition to idle, leaving
      // the single-writer latch held forever.
      let settled: (AgentRuntimeEvent & { type: "settled" }) | undefined;
      for await (const event of this.coordinator.prompt(input)) {
        this.emit(event);
        if (event.type === "failed") {
          // No native settled: enter not-ready/recovery instead of blindly
          // resetting. The Host keeps the latch held; operator recovery or a
          // restart replaces the Epoch.
          this.emit({ type: "failed", invocationId: event.invocationId, code: "settle_failed" });
          return;
        }
        if (event.type === "settled") {
          settled = event;
        }
      }
      // After native settled: resolve the committed Pi input pair and mark
      // session_committed (never a synthetic repair).
      if (settled !== undefined) {
        const settledHandle = this.registry.getActiveRuntime();
        const pair = await (settledHandle.runtime as PiRuntimeAdapter).resolveCommittedPair();
        if (pair !== undefined) {
          this.ingress.markSessionCommitted(
            inputId,
            instanceEpoch,
            settledHandle.runtimeSessionId,
            pair.userEntryId,
          );
        }
      }
    } finally {
      this.wake.notify();
    }
  }

  /**
   * Settled-only rollover (02 Runtime Sessions, Rollover Boundary): old
   * Session frozen after native settled, new empty Pi Session created, fresh
   * Harness constructed, then the Epoch + active runtime handle CAS together.
   * The settled authorization comes from the Coordinator observing Pi native
   * settled on the CURRENT active Epoch — never from a caller-supplied string.
   */
  private async maybeRolloverAfterSettled(): Promise<boolean> {
    if (this.coordinator.getPhase() !== "idle") {
      return false;
    }
    const active = this.epochStore.getActive();
    if (active === null) {
      throw new Error("cannot rollover without an active epoch");
    }
    // Settled authorization: the registry must point at the same active Epoch
    // whose invocation reached settled (the pump only reaches here when the
    // Coordinator is idle, i.e. after a settled boundary released the latch).
    const handle = this.registry.getActiveRuntime();
    if (handle.epochId !== active.epochId) {
      throw new Error(
        `rollover refused: registry epoch ${handle.epochId} does not match active epoch ${active.epochId}`,
      );
    }

    const now = new Date().toISOString();
    const pending = this.epochStore.beginRollover(now);

    // Capture old Session final head, then close old storage (flush writes).
    const oldSession = await this.openSession(active.runtimeSessionId);
    await closeSessionStorage(oldSession);

    // Create the empty new Pi Session (a REAL row, not a missing one).
    const newSessionHandle = await openOrCreateSession(
      this.dataRoot,
      this.config,
      pending.runtimeSessionId,
    );
    const newSession = newSessionHandle.session;

    // Construct a fresh Harness + fresh Context lineage for the new Session.
    const { models, model, providerProfileId } = await composeProvider(this.providerMode);
    const binding: InvocationBinding = {
      input: emptyPlaceholderInput(),
      prepared: prepareContextSources(
        emptyPlaceholderInput(),
        pending.runtimeSessionId,
        pending.epochId,
        this.config,
        now,
      ),
      invocationId: `invocation-${pending.runtimeSessionId}`,
    };
    const { harness } = createIrisHarness({
      session: newSession,
      instanceEpoch: pending.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: binding,
      now,
      providerProfileId,
    });
    const adapter = new PiRuntimeAdapter({ harness, session: newSession, binding });
    const nextHandle: ActiveRuntimeHandle = activeRuntimeHandle(pending, adapter, binding);

    // Atomic activation: Epoch CAS first, then the registry swap. A crash
    // between them leaves the DB new-active with a real Session row; the next
    // startup rebuilds the harness from the DB (never a stale registry).
    const nextEpoch = this.epochStore.activateRollover(now);
    const swapped = this.registry.casSwap(active.epochId, nextHandle);
    if (!swapped) {
      throw new Error(`rollover CAS lost race for epoch ${active.epochId}`);
    }
    this.currentEpoch = nextEpoch;
    this.emit({
      type: "rollover_completed",
      epochId: nextEpoch.epochId,
      runtimeSessionId: nextEpoch.runtimeSessionId,
      settledEpochId: active.epochId,
    });
    return true;
  }

  private async openSession(runtimeSessionId: string): Promise<Session> {
    const { session } = await openOrCreateSession(this.dataRoot, this.config, runtimeSessionId);
    return session;
  }

  /**
   * Graceful shutdown: mark not-ready, reject new inputs (pump exits), close
   * Session storage / Epoch DB / ledger, then release the lock. Every cleanup
   * failure is collected; the lock is ALWAYS released last.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.readyFlag = false;
    this.wake.notify();

    let firstError: unknown;
    try {
      // Drain: wait briefly for the active invocation to reach settled (the
      // pump loop exits on shuttingDown; a running prompt() completes its
      // current turn first).
      await drainActiveInvocation(this.coordinator, this.wake);
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.ingress.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.epochStore.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      await this.lock.release();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      const message = firstError instanceof Error ? firstError.message : JSON.stringify(firstError);
      throw new Error(message);
    }
  }

  /**
   * Startup composition + recovery. Returns a fully-constructed host that has
   * NOT yet reported ready (the caller starts the transport first).
   */
  static async open(options: IrisHostOptions): Promise<IrisHost> {
    const config = options.config ?? defaultAgentConfig();
    const paths = resolveDataRootPaths(options.dataRoot, config);
    const lock: DataRootLockHandle = await acquireDataRootLock(options.dataRoot, paths.lockFile);

    let epochStore: RuntimeEpochStore | undefined;
    let ingress: InputAcceptanceLedger | undefined;
    try {
      initializeDataRoot(options.dataRoot, config);
      epochStore = new RuntimeEpochStore(
        paths.epochRegistryDb,
        config.runtime_sessions.session_id_prefix,
        config.runtime_sessions.timezone,
      );

      // Re-entrant startup recovery (see openHost in composition.ts).
      const staleCreating = epochStore.listCreating();
      if (staleCreating.length > 0) {
        const repo = new SqliteSessionRepo({
          env: nodeSqliteRepoEnv(options.dataRoot),
          sqlite: createNodeSqliteFactory(),
          databasePath: paths.sessionDb,
        });
        const list = await repo.list({ cwd: options.dataRoot });
        const cleaned: string[] = [];
        for (const stale of staleCreating) {
          const metadata = list.find((candidate) => candidate.id === stale.runtimeSessionId);
          if (metadata !== undefined) {
            await repo.delete?.(metadata);
          }
          cleaned.push(stale.runtimeSessionId);
        }
        epochStore.recoverCreating(cleaned);
      }

      const epoch = epochStore.ensureActive(new Date().toISOString());
      const instanceEpoch = options.instanceEpoch ?? epoch.ordinalWithinDate;

      // Recover accepted-but-uncommitted inputs into the FIFO (durable ingress).
      ingress = InputAcceptanceLedger.open(options.dataRoot, config, instanceEpoch);
      const pending = ingress.recoverUncommitted();
      if (pending.length > 0) {
        // Recovered inputs are re-entered through the normal single-writer
        // path by the pump; session_committed inputs were never returned here.
      }

      const sessionHandle = await openOrCreateSession(
        options.dataRoot,
        config,
        epoch.runtimeSessionId,
      );
      const session = sessionHandle.session;
      const { models, model, providerProfileId } = await composeProvider(options.provider);

      const binding: InvocationBinding = {
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
        currentInvocation: binding,
        now: new Date().toISOString(),
        providerProfileId,
      });
      const adapter = new PiRuntimeAdapter({ harness, session, binding });
      const registry = new ActiveRuntimeRegistry();
      registry.install(activeRuntimeHandle(epoch, adapter, binding));

      const coordinator = new RuntimeCoordinator({
        activeRuntime: registry,
        prepareInvocation: async (input: AgentInput, runtimeSessionId: string, epochId: string) =>
          prepareContextSources(input, runtimeSessionId, epochId, config, new Date().toISOString()),
        maxQueuedInputs: config.host.input_queue_max ?? 20,
      });

      const readyEpochStore = epochStore;
      const readyIngress = ingress;
      return new IrisHost({
        dataRoot: options.dataRoot,
        config,
        provider: options.provider,
        lock,
        epochStore: readyEpochStore,
        ingress: readyIngress,
        registry,
        coordinator,
        currentEpoch: epoch,
        instanceEpoch,
      });
    } catch (error) {
      // Setup failed partway: release every acquired resource, preserving the
      // original error and NEVER leaking the lock.
      let firstError: unknown = error;
      try {
        ingress?.close();
      } catch (cleanupError) {
        firstError ??= cleanupError;
      }
      try {
        epochStore?.close();
      } catch (cleanupError) {
        firstError ??= cleanupError;
      }
      try {
        await lock.release();
      } catch (cleanupError) {
        firstError ??= cleanupError;
      }
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
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

interface WakeSignal {
  notify(): void;
  wait(): Promise<void>;
}

function createWakeSignal(): WakeSignal {
  let resolveCurrent: (() => void) | undefined;
  return {
    notify() {
      const resolve = resolveCurrent;
      resolveCurrent = undefined;
      resolve?.();
    },
    wait() {
      if (resolveCurrent !== undefined) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
    },
  };
}

async function drainActiveInvocation(
  coordinator: RuntimeCoordinator,
  wake: WakeSignal,
): Promise<void> {
  // If a turn is active, give it up to the configured grace window to reach
  // native settled; the pump loop then exits because shuttingDown is set.
  if (coordinator.getPhase() === "turn") {
    const deadline = Date.now() + 5000;
    while (coordinator.getPhase() === "turn" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  void wake;
}

export type { ExternalizedPayloadRef, InputAcceptanceRecord };
