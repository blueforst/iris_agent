import type { AgentMessage, Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
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
  composeProvider,
  openOrCreateSession,
  prepareContextSources,
  makeReadOnlyTestTool,
} from "../runtime/vertical-slice.js";
import { findInputPairs } from "../runtime/context-adapter.js";
import { decodeInputFrames } from "../runtime/companion.js";
import { AgentInputValidationError, validateAgentInput } from "./input-validation.js";
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
  /**
   * Durable ingress dedupe identity dimension (M4). Semantics: the Host
   * INSTANCE epoch, NOT the Runtime Session Epoch ordinal. It is stable
   * across rollover and restart so a client retrying the same inputId always
   * hits the same dedupe namespace (window-5: session_committed inputs are
   * never re-prompted). Defaults to 1; override only for tests.
   */
  instanceEpoch?: number;
}

/** Default Host instance epoch for the durable ingress dedupe namespace. */
export const HOST_INSTANCE_EPOCH = 1;

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
  private failedFlag = false;
  private pumpPromise: Promise<void> | null = null;
  /** A7: transport owned by the Host lifecycle; closed BEFORE lock release. */
  private transportClose: (() => Promise<void>) | null = null;
  /** A3: one-time native-settled authorization bound to the active Epoch.
   * Shared mutable box so static open() can wire the Coordinator callback
   * before the instance exists. */
  private readonly settledTokenBox: { value: { epochId: string; invocationId: string } | null };
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
    settledTokenBox: { value: { epochId: string; invocationId: string } | null };
  }) {
    this.dataRoot = options.dataRoot;
    this.config = options.config;
    this.providerMode = options.provider;
    this.lock = options.lock;
    this.epochStore = options.epochStore;
    this.ingress = options.ingress;
    this.settledTokenBox = options.settledTokenBox;
    this.registry = options.registry;
    this.coordinator = options.coordinator;
    this.currentEpoch = options.currentEpoch;
    this.instanceEpoch = options.instanceEpoch;
  }

  getReady(): boolean {
    return this.readyFlag;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  isFailed(): boolean {
    return this.failedFlag;
  }

  /**
   * A7 (审查 #7): attach the ingress/admin transport to the Host lifecycle.
   * shutdown() closes the transport FIRST (stop accepting clients), then
   * drains the runtime and releases the lock — there is never a window where
   * the lock is free while an old HTTP server is still reachable.
   */
  attachTransport(close: () => Promise<void>): void {
    this.transportClose = close;
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
      ready: this.readyFlag && !this.shuttingDown && !this.failedFlag,
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
  /**
   * review-pass-2 #5: the Host is the ONLY normalization/validation authority.
   * Every transport (HTTP, CLI, future Body/adapter) goes through this
   * method: the envelope is validated, the dedupe instanceEpoch is
   * HOST-owned (callers cannot choose the namespace), and the transport
   * inputId must equal the envelope inputId.
   */
  acceptInput(input: unknown, inputId: string): IngressAcceptOutcome {
    // Host-owned validation: a poisoned envelope is rejected BEFORE it can
    // ever become a durable `accepted` record.
    const validated = validateAgentInput(input);
    if (validated.inputId !== inputId) {
      throw new AgentInputValidationError(
        "input_invalid",
        `transport inputId '${inputId}' does not match envelope inputId '${validated.inputId}'`,
      );
    }
    try {
      const outcome = this.ingress.accept(validated, validated.inputId, this.instanceEpoch);
      if (outcome.outcome === "accepted") {
        this.emit({
          type: "ingress_accepted",
          inputId: validated.inputId,
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
  run(): Promise<void> {
    if (this.pumpPromise !== null) {
      throw new Error("host pump already started");
    }
    this.markReady();
    this.pumpPromise = this.pumpLoop();
    return this.pumpPromise;
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (!this.shuttingDown) {
        // M2: a failed invocation enters not-ready; the pump keeps waiting for
        // operator recovery (recover()) instead of dying on the next input.
        if (this.failedFlag) {
          await this.wake.wait();
          continue;
        }
        // 1. If a rollover was requested AND a native-settled token exists for
        //    the current active Epoch, switch now. Without a token the pump
        //    must NOT block: it keeps consuming inputs so an in-flight input
        //    can settle and produce the token (A3).
        if (
          this.epochStore.isRolloverPending() &&
          this.settledTokenBox.value !== null &&
          this.settledTokenBox.value.epochId === this.epochStore.getActive()?.epochId
        ) {
          const switched = await this.maybeRolloverAfterSettled();
          if (switched) {
            continue;
          }
          // Token consumed or switch failed: fall through to input processing.
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
    } catch (error) {
      // The pump must never die silently: record the failure, flip not-ready,
      // and re-raise so the caller (serve) surfaces it. Data remains durable.
      this.failedFlag = true;
      this.emit({ type: "failed", invocationId: "host-pump", code: "pump_error" });
      throw error;
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
      let failed = false;
      try {
        for await (const event of this.coordinator.prompt(input)) {
          this.emit(event);
          if (event.type === "failed") {
            // M2: no native settled. The input stays `accepted` in the ledger
            // (never committed) and is dropped from in-flight so a later
            // client retry (accept -> duplicate) or a restart recovery re-
            // enters it through the normal single-writer path. The Host flips
            // not-ready and the pump waits for operator recovery; the input is
            // NOT auto-requeued (a poisoned input must not loop forever).
            failed = true;
            this.failedFlag = true;
            this.ingress.dropInFlight(inputId, instanceEpoch);
            this.emit({ type: "failed", invocationId: event.invocationId, code: "settle_failed" });
          }
          if (event.type === "settled") {
            settled = event;
          }
        }
      } catch (error) {
        // A harness/encoding/provider error also fails the invocation (M2):
        // flip not-ready, keep the input durable-accepted (never committed),
        // keep the pump alive.
        failed = true;
        this.failedFlag = true;
        this.ingress.dropInFlight(inputId, instanceEpoch);
        this.emit({
          type: "failed",
          invocationId: `invocation-${inputId}`,
          code: "invocation_error",
        });
        void error;
      }
      // After native settled: resolve the committed Pi input pair and mark
      // session_committed (never a synthetic repair).
      if (settled !== undefined && !failed) {
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
   * Operator recovery after a failed invocation (M2): resets the Coordinator
   * latch AND the Capsule adapter (both may be in a failed state after a
   * provider/encoding error), then clears the not-ready flag so the pump
   * resumes consuming the FIFO. The failed input stays durably `accepted`;
   * a client retry or restart recovery re-enters it.
   */
  recover(): void {
    if (!this.failedFlag) {
      return;
    }
    this.coordinator.reset();
    // review-pass-2 #3: a failed invocation must not leave a stale settled
    // token that a later rollover request could mis-consume.
    this.settledTokenBox.value = null;
    const handle = this.registry.getActiveOrNull();
    if (handle !== null) {
      const runtime = handle.runtime;
      if (runtime instanceof PiRuntimeAdapter) {
        runtime.reset();
      }
    }
    this.failedFlag = false;
    this.wake.notify();
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
    // A3 (审查 #3): a rollover requires a ONE-TIME native-settled
    // authorization produced by the Coordinator when Pi settled on THIS
    // active Epoch. `idle` alone is NOT authorization (a freshly started or
    // recovered Host is also idle). Consume the token exactly once.
    if (this.settledTokenBox.value?.epochId !== active.epochId) {
      return false;
    }
    const token = this.settledTokenBox.value;
    this.settledTokenBox.value = null; // consume
    void token.invocationId;
    // The registry must point at the same active Epoch whose invocation
    // reached settled.
    const handle = this.registry.getActiveRuntime();
    if (handle.epochId !== active.epochId) {
      this.settledTokenBox.value = null;
      throw new Error(
        `rollover refused: registry epoch ${handle.epochId} does not match active epoch ${active.epochId}`,
      );
    }

    const now = new Date().toISOString();
    const pending = this.epochStore.beginRollover(now);

    // review-pass-2 #4: staged Capsule construction — build the ENTIRE new
    // Capsule (new Session + fresh Harness + adapter) BEFORE touching the old
    // one. If any step fails, only the new resources need cleanup and the old
    // Capsule stays fully serviceable (not-ready only on real corruption).
    let newSession: Session | undefined;
    let nextHandle: ActiveRuntimeHandle | undefined;
    try {
      // Create the empty new Pi Session (a REAL row, not a missing one).
      const newSessionHandle = await openOrCreateSession(
        this.dataRoot,
        this.config,
        pending.runtimeSessionId,
      );
      newSession = newSessionHandle.session;

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
      nextHandle = activeRuntimeHandle(pending, adapter, binding);
    } catch (error) {
      // New Capsule construction failed: clean up the new Session and surface
      // the original error. The old Capsule was never touched.
      if (newSession !== undefined) {
        try {
          const storage = newSession.getStorage() as unknown as { cleanup(): Promise<void> };
          await storage.cleanup();
        } catch (cleanupError) {
          // Preserve the original error; cleanup failures are secondary.
          void cleanupError;
        }
      }
      throw error;
    }

    // The new Capsule is fully ready. NOW freeze/dispose the old Capsule's
    // REAL Session (flushing pending writes) before the atomic activation.
    const oldHandle = this.registry.getActiveOrNull();
    if (oldHandle !== null && oldHandle.runtime instanceof PiRuntimeAdapter) {
      await oldHandle.runtime.dispose();
    }

    // Atomic activation: Epoch CAS first, then the registry swap. A crash
    // between them leaves the DB new-active with a real Session row; the next
    // startup rebuilds the harness from the DB (never a stale registry).
    if (nextHandle === undefined) {
      throw new Error("rollover internal error: new Capsule was not constructed");
    }
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

  /**
   * A4 (审查 #4): dispose the CURRENT active Capsule's Session on shutdown.
   */
  private async disposeActiveCapsule(): Promise<void> {
    const handle = this.registry.getActiveOrNull();
    if (handle !== null && handle.runtime instanceof PiRuntimeAdapter) {
      await handle.runtime.dispose();
    }
  }

  /**
   * Graceful shutdown (C1/M3): mark not-ready, reject new inputs, abort any
   * active invocation and WAIT for the Pi native settled boundary, then wait
   * for the pump to fully exit (so the last markSessionCommitted has flushed),
   * and only then close Session/Epoch DB/ledger and release the lock. Every
   * cleanup failure is collected; the lock is ALWAYS released last.
   */
  async shutdown(timeoutMs = 15000): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.readyFlag = false;
    this.wake.notify();

    let firstError: unknown;
    try {
      // A7 (审查 #7): stop accepting clients FIRST (reject new inputs and
      // close SSE connections) before draining the runtime, so no request can
      // be served once the lock is about to be released.
      if (this.transportClose !== null) {
        await this.transportClose();
      }
    } catch (error) {
      firstError ??= error;
    }
    try {
      // Abort the active invocation and wait for native settled, so the turn
      // completes BEFORE we close the ledger (C1: never close the DB under a
      // live invocation that still needs to mark session_committed).
      await this.coordinator.abortActive(timeoutMs);
    } catch (error) {
      firstError ??= error;
    }
    try {
      // Wait for the pump to exit: the current turn (if any) finishes, its
      // session_committed flush completes, and only then we close resources.
      if (this.pumpPromise !== null) {
        await withTimeoutHost(this.pumpPromise, timeoutMs);
      }
    } catch (error) {
      firstError ??= error;
    }
    try {
      // A4 (审查 #4): dispose the active Capsule's REAL Session (flush writes,
      // release Pi SQLite/storage) before closing the ledger/store.
      await this.disposeActiveCapsule();
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
    /** review-pass-2 #4: the Session opened before Capsule construction, so a
     * failed startup can dispose it (it is not yet owned by an adapter). */
    let openedSession: Session | undefined;
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

      // Corrupt-state gate (03 Host Runtime, Recovery): more than one durably
      // active Epoch means the local registry is corrupt. Enter not-ready
      // instead of silently guessing one by creation time.
      if (epochStore.countActive() > 1) {
        throw new Error(
          `runtime epoch registry is corrupt: ${epochStore.countActive()} active epochs found`,
        );
      }

      // A5 / review-pass-2 #2: Session selection must be decided BEFORE any
      // reconciliation touches the Session store.
      //  - no active Epoch (fresh data root OR only archived epochs): create a
      //    new active Epoch + its fresh Session.
      //  - an active Epoch exists: open its EXACT Pi Session; a missing
      //    Session is not-ready/corrupt — never silently create an empty one
      //    that masquerades as the lost history.
      const hasActiveEpoch = epochStore.getActive() !== null;
      const epoch = epochStore.ensureActive(new Date().toISOString());
      const instanceEpoch = options.instanceEpoch ?? HOST_INSTANCE_EPOCH;
      const session = hasActiveEpoch
        ? await openActiveSession(options.dataRoot, config, epoch.runtimeSessionId)
        : (await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId)).session;
      openedSession = session;

      // Recover accepted-but-uncommitted inputs into the FIFO (durable
      // ingress), reconciled against the VERIFIED active Session.
      ingress = InputAcceptanceLedger.open(options.dataRoot, config, instanceEpoch);
      // A1 / review-pass-2 #1: classify each accepted record — verified full
      // pair -> session_committed (never re-prompt); no Pi append -> normal
      // delivery; partial/mismatched -> fail closed (rejected).
      const pending = ingress.recoverUncommitted();
      if (pending.length > 0) {
        await reconcileUncommitted(pending, epoch.runtimeSessionId, session, ingress);
      }

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

      // A3 (审查 #3): the settled-authorization box is shared between the
      // Coordinator callback (writes) and the Host rollover (reads/consumes).
      const settledTokenBox: { value: { epochId: string; invocationId: string } | null } = {
        value: null,
      };
      const coordinator = new RuntimeCoordinator({
        activeRuntime: registry,
        prepareInvocation: async (input: AgentInput, runtimeSessionId: string, epochId: string) =>
          prepareContextSources(input, runtimeSessionId, epochId, config, new Date().toISOString()),
        maxQueuedInputs: config.host.input_queue_max ?? 20,
        // A3: consume the ONE-TIME native-settled authorization. Every
        // invocation that observes Pi native settled on the active Epoch
        // records a token bound to (epochId, invocationId); rollover may only
        // fire when such a token exists for the CURRENT active Epoch and is
        // consumed exactly once.
        onSettledBoundary: (info) => {
          settledTokenBox.value = { epochId: info.epochId, invocationId: info.invocationId };
        },
        // review-pass-2 #3: a new invocation invalidates any stale token from
        // a previous invocation (e.g. a success followed by a failure).
        onInvocationStart: () => {
          settledTokenBox.value = null;
        },
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
        settledTokenBox,
      });
    } catch (error) {
      // Setup failed partway (review-pass-2 #4): release every acquired
      // resource — including a Session already opened but not yet wrapped in
      // a Capsule — preserving the original error and NEVER leaking the lock.
      let firstError: unknown = error;
      if (openedSession !== undefined) {
        try {
          const storage = openedSession.getStorage() as unknown as {
            cleanup(): Promise<void>;
          };
          await storage.cleanup();
        } catch (cleanupError) {
          firstError ??= cleanupError;
        }
      }
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

/**
 * A1 / review-pass-2 #1: reconcile accepted-but-uncommitted ingress records
 * against the ACTIVE Pi Session on startup. Recovery is classified into
 * exactly three states:
 *
 *   verified full pair  -> the input's complete UserMessage + iris_input_meta
 *                          companion already exists -> promote to
 *                          session_committed (NEVER re-prompt);
 *   no Pi append        -> no matching UserMessage exists -> keep the input
 *                          durable-accepted for the normal single-writer
 *                          delivery path (safe re-prompt);
 *   partial/mismatched  -> a matching UserMessage exists WITHOUT a verified
 *                          companion, or the pair is corrupt/misaligned ->
 *                          fail closed (mark rejected, never re-prompt and
 *                          never synthesize a companion).
 */
async function reconcileUncommitted(
  pending: Array<{ inputId: string; instanceEpoch: number }>,
  runtimeSessionId: string,
  session: Session,
  ingress: InputAcceptanceLedger,
): Promise<void> {
  const entries = await session.getEntries();
  const messages = entries
    .map((entry) => (entry as SessionTreeEntry & { message?: AgentMessage }).message)
    .filter((message): message is AgentMessage => message !== undefined);
  const pairs = findInputPairs(messages);

  // 1. Verified full pairs: inputId -> userEntryId.
  const committedInputIds = new Map<string, string>();
  for (const pair of pairs) {
    const details = pair.companion.details as { iris?: { inputId?: string } } | undefined;
    const inputId = details?.iris?.inputId;
    if (typeof inputId === "string" && inputId !== "") {
      const userIndex = messages.indexOf(pair.userMessage);
      const userEntry = entries[userIndex];
      if (userEntry !== undefined) {
        committedInputIds.set(inputId, userEntry.id);
      }
    }
  }

  // 2. Content fingerprints of EVERY user message in the Session (frame
  //    payloads), so a partial pair (UserMessage without companion) can be
  //    attributed to a specific pending input.
  const userMessageFingerprints: Array<{ entryId: string; texts: string[] }> = [];
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const raw = Array.isArray(message.content)
      ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : message.content;
    let frames;
    try {
      frames = decodeInputFrames(raw);
    } catch {
      continue; // not an IRIS_INPUT frame
    }
    const texts = frames.map((frame) => frame.payload);
    const userIndex = messages.indexOf(message);
    const userEntry = entries[userIndex];
    if (userEntry !== undefined && texts.length > 0) {
      userMessageFingerprints.push({ entryId: userEntry.id, texts });
    }
  }

  // 3. Fingerprints of each pending envelope (block text / ref previews).
  const pendingFingerprints = new Map<string, string[]>(); // inputId -> texts
  for (const entry of pending) {
    const envelope = ingress.loadEnvelope(entry.inputId, entry.instanceEpoch);
    if (envelope === undefined) {
      continue;
    }
    const candidate = envelope as Partial<AgentInput>;
    const texts: string[] = [];
    for (const block of candidate.blocks ?? []) {
      const content = block.content as
        { mode?: string; text?: string; ref?: { uri?: string } } | undefined;
      if (content?.mode === "inline_text" && typeof content.text === "string") {
        texts.push(content.text);
      } else if (
        (content?.mode === "external_ref" || content?.mode === "image_ref") &&
        typeof content.ref?.uri === "string"
      ) {
        texts.push(content.ref.uri);
      }
    }
    if (texts.length > 0) {
      pendingFingerprints.set(entry.inputId, texts);
    }
  }

  function fingerprintMatches(inputId: string, entryId: string): boolean {
    const pendingTexts = pendingFingerprints.get(inputId);
    const userTexts = userMessageFingerprints.find((u) => u.entryId === entryId)?.texts;
    if (pendingTexts === undefined || userTexts === undefined) {
      return false;
    }
    return (
      pendingTexts.length === userTexts.length &&
      pendingTexts.every((text, index) => text === userTexts[index])
    );
  }

  for (const entry of pending) {
    const committedUserEntry = committedInputIds.get(entry.inputId);
    if (committedUserEntry !== undefined) {
      // Verified full pair: promote (never re-prompt).
      ingress.markSessionCommitted(
        entry.inputId,
        entry.instanceEpoch,
        runtimeSessionId,
        committedUserEntry,
      );
      ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
      continue;
    }
    // No full pair. Attribute the input to any UserMessage with a matching
    // content fingerprint: if one exists, the pair is PARTIAL (UserMessage
    // committed without its companion) -> fail closed, never re-prompt, never
    // synthesize a companion. If no UserMessage matches, the input was never
    // appended -> keep durable-accepted for normal delivery.
    const partial = userMessageFingerprints.some((u) =>
      fingerprintMatches(entry.inputId, u.entryId),
    );
    ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
    if (partial) {
      ingress.markRejected(entry.inputId, entry.instanceEpoch, "partial_pair_incomplete");
    }
  }
}

/**
 * A5 (审查 #5): open the EXACT Pi Session for an existing active Epoch. A
 * missing Session is not-ready/corrupt — never silently create an empty
 * Session that masquerades as the lost history.
 */
async function openActiveSession(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<Session> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepo({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata === undefined) {
    throw new Error(
      `active epoch session is missing/corrupt: Pi Session '${runtimeSessionId}' not found (not-ready)`,
    );
  }
  return repo.open(metadata);
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

async function withTimeoutHost(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("host pump did not exit within timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
export type { ExternalizedPayloadRef, InputAcceptanceRecord };
