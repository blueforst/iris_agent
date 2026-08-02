import type { AgentHarness } from "@earendil-works/pi-agent-core";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { PreparedContextSources } from "../contracts/context.js";
import type { AgentInput } from "../contracts/origin.js";
import type { InvocationBinding } from "./harness-factory.js";
import { encodeInputFrames } from "./companion.js";

/**
 * Thin Runtime Coordinator (00 Module Boundaries, 05 Pi Runtime Capsule).
 *
 * Owns only: one-active-invocation latch, process-local invocationId
 * correlation, precise abort forwarding to the Pi Harness, native event
 * forwarding, and latch release gated on Pi settled. It does NOT own a second
 * phase machine, model/tool loop, message persistence, pending-write recovery,
 * durable invocation outcome or assistant result store. All of those belong to
 * Pi / the Capsule.
 */

export interface RuntimeCoordinatorOptions {
  harness: AgentHarness;
  /**
   * Mutable per-invocation binding owned by the composition root. Before each
   * prompt() the coordinator re-derives the binding for the CURRENT input so
   * companion pairing and the context hook never use a stale input.
   */
  currentInvocation: InvocationBinding;
  /**
   * Derives ContextSourceSnapshot + canonical system prompt for an input,
   * scoped to the active runtime Session/Epoch (ContextRuntimePort.prepare
   * semantics). Called before every prompt().
   */
  prepareInvocation: (input: AgentInput) => Promise<PreparedContextSources>;
  maxQueuedInputs?: number;
}

/** Minimal FIFO async queue used to bridge native Pi events into the port stream. */
class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async next(): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) {
      return item;
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(undefined as T);
    }
    this.waiters.length = 0;
  }
}

export class RuntimeCoordinator implements AgentRuntimePort {
  private readonly harness: AgentHarness;
  private readonly currentInvocation: InvocationBinding;
  private readonly prepareInvocation: (input: AgentInput) => Promise<PreparedContextSources>;
  private readonly maxQueuedInputs: number;
  private activeInvocation: string | null = null;
  private readonly queuedInputs: AgentInput[] = [];
  private phase: AgentRuntimePhase = "idle";

  constructor(options: RuntimeCoordinatorOptions) {
    this.harness = options.harness;
    this.currentInvocation = options.currentInvocation;
    this.prepareInvocation = options.prepareInvocation;
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
    // Bind THIS invocation's input/context before the turn begins, so the
    // companion pairing and context hook reflect the current input (review
    // blocker #1): a second prompt(B) must pair with B, not the first input.
    const invocationId = `invocation-${input.inputId}`;
    this.activeInvocation = invocationId;
    this.phase = "turn";
    let unsubscribe: (() => void) | undefined;
    let settledNextTurnCount: number | undefined;
    let failedCode: string | undefined;
    const queue = new EventQueue<AgentRuntimeEvent>();
    try {
      yield { type: "turn_start", invocationId };

      // Bridge native Pi events into the port stream. The latch is released
      // ONLY after a native settled arrives (review blocker #2): abort alone
      // (native abort/agent_end without settled) must not release the latch.
      unsubscribe = this.harness.subscribe(async (event) => {
        switch (event.type) {
          case "message_update": {
            const text = extractTextDelta(event);
            if (text !== "") {
              queue.push({ type: "message_delta", invocationId, text });
            }
            return;
          }
          case "tool_execution_start":
            queue.push({
              type: "tool_call",
              invocationId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            return;
          case "tool_execution_end":
            queue.push({
              type: "tool_result",
              invocationId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            return;
          case "settled":
            settledNextTurnCount = event.nextTurnCount;
            queue.push({ type: "settled", invocationId, nextTurnCount: event.nextTurnCount });
            return;
          default:
            return;
        }
      });

      // Re-derive the ContextSourceSnapshot + canonical system prompt for
      // THIS input, then bind it so companion pairing and the context hook
      // never use a stale invocation (review blocker #1).
      const prepared = await this.prepareInvocation(input);
      this.currentInvocation.input = input;
      this.currentInvocation.prepared = prepared;
      this.currentInvocation.invocationId = invocationId;

      await this.harness.prompt(encodeInputFrames(input.blocks));

      // Drain events observed during the run (the harness may emit native
      // events after prompt() resolves but before settled is processed).
      let sawSettled = false;
      for (;;) {
        const event = await queue.next();
        if (event === undefined) {
          break;
        }
        if (event.type === "settled") {
          sawSettled = true;
          yield event;
          break;
        }
        yield event;
      }

      if (!sawSettled && settledNextTurnCount === undefined) {
        // No native settled observed (provider/harness failure or abort
        // without settlement): enter the explicit failure path instead of
        // silently releasing the latch as if the turn completed.
        failedCode = "settled_not_observed";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      }
    } catch (error) {
      if (failedCode === undefined) {
        failedCode = "harness_error";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      }
      throw error;
    } finally {
      // Always release the subscription, even when the harness throws
      // (e.g. live provider failure), so no observer leaks on the harness.
      unsubscribe?.();
      queue.close();
      if (this.phase !== "failed") {
        this.phase = "idle";
      }
      this.activeInvocation = null;
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

interface MessageUpdateEventLike {
  type: "message_update";
  assistantMessageEvent: {
    type: string;
    delta?: string;
    text?: string;
  };
}

function extractTextDelta(event: MessageUpdateEventLike): string {
  const delta = event.assistantMessageEvent.delta;
  if (typeof delta === "string") {
    return delta;
  }
  const text = event.assistantMessageEvent.text;
  if (typeof text === "string") {
    return text;
  }
  return "";
}
