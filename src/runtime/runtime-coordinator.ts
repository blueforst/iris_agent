import type { AgentHarness, SettledEvent } from "@earendil-works/pi-agent-core";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { AgentInput } from "../contracts/origin.js";
import { encodeInputFrames } from "./companion.js";

/**
 * Thin Runtime Coordinator (00 Module Boundaries, 05 Pi Runtime Capsule).
 *
 * Owns only: one-active-invocation latch, process-local invocationId
 * correlation, precise abort forwarding to the Pi Harness, native event
 * forwarding, and latch release on Pi settled. It does NOT own a second
 * phase machine, message queue, model/tool loop, message persistence,
 * pending-write recovery, durable invocation outcome or assistant result
 * store. All of those belong to Pi / the Capsule.
 */

export interface RuntimeCoordinatorOptions {
  harness: AgentHarness;
  maxQueuedInputs?: number;
}

export class RuntimeCoordinator implements AgentRuntimePort {
  private readonly harness: AgentHarness;
  private readonly maxQueuedInputs: number;
  private activeInvocation: string | null = null;
  private readonly queuedInputs: AgentInput[] = [];
  private phase: AgentRuntimePhase = "idle";

  constructor(options: RuntimeCoordinatorOptions) {
    this.harness = options.harness;
    this.maxQueuedInputs = options.maxQueuedInputs ?? 20;
  }

  getPhase(): AgentRuntimePhase {
    return this.phase;
  }

  /**
   * Queue an origin-aware input for a later invocation. The coordinator is
   * a thin Port and does not drive the next turn itself: after the current
   * invocation reaches Pi settled, the caller drains via `dequeue()` and
   * starts each queued input as a fresh `prompt()` (spec: queued nextTurn is
   * a fresh prompt, never a bare steer).
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

  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    if (this.activeInvocation !== null) {
      throw new Error(`invocation ${this.activeInvocation} already active`);
    }
    const invocationId = `invocation-${input.inputId}`;
    this.activeInvocation = invocationId;
    this.phase = "turn";
    let unsubscribe: (() => void) | undefined;
    try {
      yield { type: "turn_start", invocationId };

      // Observe Pi settled as the authoritative end boundary; the latch
      // releases only after the harness resolves.
      let observedSettled = false;
      let settledNextTurnCount = 0;
      unsubscribe = this.harness.subscribe(async (event) => {
        if (event.type === "settled") {
          observedSettled = true;
          settledNextTurnCount = (event as SettledEvent).nextTurnCount;
        }
      });

      await this.harness.prompt(encodeInputFrames(input.blocks));

      if (observedSettled) {
        yield { type: "settled", invocationId, nextTurnCount: settledNextTurnCount };
      }
    } finally {
      // Always release the subscription, even when the harness throws
      // (e.g. live provider failure), so no observer leaks on the harness.
      unsubscribe?.();
      this.activeInvocation = null;
      this.phase = "idle";
    }
  }

  async abort(invocationId: string, reason?: string): Promise<void> {
    if (this.activeInvocation !== invocationId) {
      throw new Error(`no active invocation ${invocationId}`);
    }
    void reason;
    await this.harness.abort();
  }
}
