import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { PreparedContextSources } from "../contracts/context.js";
import type { AgentInput } from "../contracts/origin.js";
import type { ActiveRuntimePort } from "./active-runtime-registry.js";

/**
 * Thin Runtime Coordinator (00 Module Boundaries, 03 Runtime Coordinator).
 *
 * Owns only: one-active-invocation latch, process-local invocationId
 * correlation, precise abort forwarding to the CURRENT active Capsule, native
 * event forwarding, and latch release gated on Pi settled. It does NOT own a
 * second phase machine, model/tool loop, message persistence, pending-write
 * recovery, durable invocation outcome or assistant result store — those
 * belong to Pi / the Capsule (PiRuntimeAdapter).
 *
 * The Coordinator obtains the active Capsule through the ActiveRuntimePort
 * (registry) on every prompt() — ordinary modules never cache a stale
 * Harness/Session, and after a rollover CAS the old runtime is no longer
 * reachable (03 Host Runtime: Active Runtime Registry).
 *
 * The Coordinator observes the native settled boundary and notifies the Host
 * through `onSettledBoundary`. The Host (not the Coordinator) drives the
 * rollover; this callback is the "settled authorization" — only a settled
 * observed on the CURRENT active Epoch may authorize one switch.
 */

export interface SettledBoundaryInfo {
  invocationId: string;
  epochId: string;
  runtimeSessionId: string;
  settledAt: string;
}

export interface RuntimeCoordinatorOptions {
  /** Registry providing the current ready Capsule (ActiveRuntimePort). */
  activeRuntime: ActiveRuntimePort;
  /**
   * Derives ContextSourceSnapshot + canonical system prompt for an input,
   * scoped to the active runtime Session/Epoch (ContextRuntimePort.prepare
   * semantics). Called before every prompt().
   */
  prepareInvocation: (
    input: AgentInput,
    runtimeSessionId: string,
    epochId: string,
  ) => Promise<PreparedContextSources>;
  /**
   * Fired exactly once per invocation when Pi native settled is observed on
   * the bound active Epoch. The Host uses this to release the invocation and,
   * when a rollover was requested, to switch Epochs (02 Runtime Sessions,
   * Rollover Boundary: settled is the only normal switch point).
   */
  onSettledBoundary?: (info: SettledBoundaryInfo) => void | Promise<void>;
  maxQueuedInputs?: number;
}

export class RuntimeCoordinator implements AgentRuntimePort {
  private readonly activeRuntime: ActiveRuntimePort;
  private readonly prepareInvocation: RuntimeCoordinatorOptions["prepareInvocation"];
  private readonly onSettledBoundary: RuntimeCoordinatorOptions["onSettledBoundary"];
  private readonly maxQueuedInputs: number;
  private activeInvocation: string | null = null;
  private readonly queuedInputs: AgentInput[] = [];
  private phase: AgentRuntimePhase = "idle";

  constructor(options: RuntimeCoordinatorOptions) {
    this.activeRuntime = options.activeRuntime;
    this.prepareInvocation = options.prepareInvocation;
    this.onSettledBoundary = options.onSettledBoundary;
    this.maxQueuedInputs = options.maxQueuedInputs ?? 20;
  }

  getPhase(): AgentRuntimePhase {
    return this.phase;
  }

  /**
   * Queue an origin-aware input for a later invocation. The Host input pump
   * drains the queue after each settled boundary and starts each queued input
   * as a fresh prompt() (spec: queued nextTurn is a fresh prompt, never a
   * bare steer). Queueing is bounded: overflow throws a typed error instead
   * of silently dropping the input.
   */
  enqueue(input: AgentInput): void {
    if (this.queuedInputs.length >= this.maxQueuedInputs) {
      throw new Error(`input queue full (max ${this.maxQueuedInputs})`);
    }
    this.queuedInputs.push(input);
  }

  queuedCount(): number {
    return this.queuedInputs.length;
  }

  /** FIFO dequeue; returns undefined when the queue is empty. */
  dequeue(): AgentInput | undefined {
    return this.queuedInputs.shift();
  }

  /**
   * Run one invocation through the CURRENT active Capsule.
   *
   * The runtimeSessionId is frozen at invocation start and never changes mid-
   * invocation (03 Runtime Coordinator, Invocation Invariant). The latch is
   * released ONLY after native settled is observed on that bound Epoch; an
   * abort without settled leaves the latch held until the Host recovers.
   */
  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    if (this.activeInvocation !== null) {
      throw new Error(`invocation ${this.activeInvocation} already active`);
    }
    if (this.phase === "failed") {
      throw new Error("coordinator is in failed state; call reset() before a new invocation");
    }

    // Read the current ready Capsule from the registry — never a cached one.
    const handle = this.activeRuntime.getActiveRuntime();
    const epochId = handle.epochId;
    const runtimeSessionId = handle.runtimeSessionId;

    const invocationId = `invocation-${input.inputId}`;
    this.activeInvocation = invocationId;
    this.phase = "turn";
    let failedCode: string | undefined;
    let settledSeen = false;
    try {
      yield { type: "turn_start", invocationId };

      // Prepare + bind ContextSourceSnapshot for THIS input, scoped to the
      // active Session/Epoch (invariant: the bound runtimeSessionId does not
      // change mid-invocation). The binding is a shared mutable container
      // (the adapter holds the same object reference), so updating its
      // fields keeps companion pairing and the context hook in sync — never
      // a stale input (review blocker #1).
      const prepared = await this.prepareInvocation(input, runtimeSessionId, epochId);
      handle.binding.input = input;
      handle.binding.prepared = prepared;
      handle.binding.invocationId = invocationId;

      // Forward native events from the current Capsule. Consume the FULL
      // generator: breaking early would return() the Capsule generator and
      // skip its phase transition to idle, leaving the single-writer latch
      // held forever. `settledSeen` records the boundary without interrupting.
      for await (const event of handle.runtime.prompt(input)) {
        if (event.type === "settled") {
          settledSeen = true;
        }
        yield event;
      }

      if (!settledSeen) {
        // Native settled never observed even though prompt() resolved: enter
        // the explicit failure path instead of silently releasing the latch.
        failedCode = "settled_not_observed";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      } else {
        this.phase = "idle";
        await this.onSettledBoundary?.({
          invocationId,
          epochId,
          runtimeSessionId,
          settledAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      if (failedCode === undefined) {
        failedCode = "harness_error";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      }
      throw error;
    } finally {
      if (this.phase === "idle" || this.phase === "failed") {
        if (this.phase === "idle") {
          this.activeInvocation = null;
        }
      }
    }
  }

  /**
   * Explicit recovery after a failed invocation (native settled never
   * observed): releases the latch so the Host may recover or replace the
   * Epoch. No-op when not in failed state.
   */
  reset(): void {
    if (this.phase === "failed") {
      this.phase = "idle";
      this.activeInvocation = null;
    }
  }

  /**
   * Precise abort forwarding: forwards to the CURRENT active Capsule when the
   * invocation is active, then waits for Pi native settled (abort ->
   * native agent_end/settled -> release invocation). A wrong invocation id is
   * rejected; the latch is NOT released by abort alone (03 Runtime
   * Coordinator, Abort).
   */
  async abort(invocationId: string, reason?: string): Promise<void> {
    if (this.activeInvocation !== invocationId) {
      throw new Error(`no active invocation ${invocationId}`);
    }
    const handle = this.activeRuntime.getActiveRuntime();
    await handle.runtime.abort(invocationId, reason);
  }
}
