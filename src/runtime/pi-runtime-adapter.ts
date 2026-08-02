import type {
  AgentHarness,
  Session,
  SessionTreeEntry,
  AgentMessage,
} from "@earendil-works/pi-agent-core";

import type { AgentRuntimeEvent, AgentRuntimePort } from "../contracts/ports.js";
import type { AgentRuntimePhase } from "../contracts/runtime-ports.js";
import type { AgentInput } from "../contracts/origin.js";
import type { InvocationBinding } from "./harness-factory.js";
import { encodeInputFrames } from "./companion.js";
import { findInputPairs } from "./context-adapter.js";

/**
 * PiRuntimeAdapter wraps one AgentHarness + its mutable InvocationBinding into
 * an AgentRuntimePort. It owns the per-prompt binding update, the
 * input-frame encoding, native Pi event bridging and the settled gate —
 * exactly what the previous RuntimeCoordinator.prompt() did, but now as a
 * per-Capsule runtime object so the ActiveRuntimeRegistry can swap runtimes on
 * rollover without ever re-wiring the Coordinator to a new harness.
 *
 * The adapter is created once per Pi Session (per Runtime Epoch). After a
 * rollover the old adapter's harness is not reused; it only completes
 * cleanup/diagnostics (02 Runtime Sessions, 03 Host Runtime: Active Runtime
 * Registry).
 */

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

export class PiRuntimeAdapter implements AgentRuntimePort {
  private readonly harness: AgentHarness;
  private readonly session: Session;
  private readonly binding: InvocationBinding;
  private phase: AgentRuntimePhase = "idle";

  constructor(options: { harness: AgentHarness; session: Session; binding: InvocationBinding }) {
    this.harness = options.harness;
    this.session = options.session;
    this.binding = options.binding;
  }

  getPhase(): AgentRuntimePhase {
    return this.phase;
  }

  /**
   * Resolve the committed Pi input pair (UserMessage + iris_input_meta
   * companion) for the CURRENT invocation's inputId, if the pair is durably
   * present. The Host uses this to mark the ingress record session_committed
   * (03 Host Runtime, Durable Input Acceptance) — never a synthetic repair.
   */
  async resolveCommittedPair(): Promise<
    { userEntryId: string; companionEntryId: string } | undefined
  > {
    const entries = await this.session.getEntries();
    const messages = entries
      .map((entry) => (entry as SessionTreeEntry & { message?: AgentMessage }).message)
      .filter((message): message is AgentMessage => message !== undefined);
    const pairs = findInputPairs(messages);
    const inputId = this.binding.input.inputId;
    // Find the LAST pair whose companion carries the current inputId.
    for (let index = pairs.length - 1; index >= 0; index -= 1) {
      const pair = pairs[index];
      if (pair === undefined) {
        continue;
      }
      const details = pair.companion.details as { iris?: { inputId?: string } } | undefined;
      if (details?.iris?.inputId === inputId) {
        const userIndex = messages.indexOf(pair.userMessage);
        const companionIndex = messages.indexOf(pair.companion);
        const userEntry = entries[userIndex];
        const companionEntry = entries[companionIndex];
        if (userEntry !== undefined && companionEntry !== undefined) {
          return { userEntryId: userEntry.id, companionEntryId: companionEntry.id };
        }
        return undefined;
      }
    }
    return undefined;
  }

  async *prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent> {
    if (this.phase === "failed") {
      throw new Error(
        "runtime is in failed state; the Epoch must be recovered before a new prompt",
      );
    }
    const invocationId = this.binding.invocationId;
    this.phase = "turn";
    let unsubscribe: (() => void) | undefined;
    let settledSeen = false;
    let failedCode: string | undefined;
    const queue = new EventQueue<AgentRuntimeEvent>();
    try {
      // NOTE: the Coordinator emits turn_start; the adapter must not duplicate
      // it (single event truth for the port stream).

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
            settledSeen = true;
            queue.push({ type: "settled", invocationId, nextTurnCount: event.nextTurnCount });
            return;
          default:
            return;
        }
      });

      // The binding was updated by the Coordinator before prompt(); encode the
      // CURRENT input's frames so companion pairing never uses a stale input.
      const promptPromise = this.harness.prompt(encodeInputFrames(input.blocks));
      for (;;) {
        const event = await Promise.race([queue.next(), promptPromise.then(() => undefined)]);
        if (event === undefined) {
          break;
        }
        if (event.type === "settled") {
          yield event;
          break;
        }
        yield event;
      }
      await promptPromise.catch(() => undefined);

      if (!settledSeen) {
        failedCode = "settled_not_observed";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      } else {
        this.phase = "idle";
      }
    } catch (error) {
      if (failedCode === undefined) {
        failedCode = "harness_error";
        this.phase = "failed";
        yield { type: "failed", invocationId, code: failedCode };
      }
      throw error;
    } finally {
      unsubscribe?.();
      queue.close();
    }
  }

  async abort(invocationId: string, reason?: string): Promise<void> {
    void reason;
    await this.harness.abort();
  }

  /** Release the failed latch so the Epoch can be recovered/replaced. */
  reset(): void {
    if (this.phase === "failed") {
      this.phase = "idle";
    }
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
