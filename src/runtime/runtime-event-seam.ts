import type { AgentHarness } from "@earendil-works/pi-agent-core";

import type { PiSeamEvent, RuntimeEventIngestPort } from "../contracts/runtime-events.js";

export interface RuntimeEventSeamOptions {
  /** exactly-once 提交目标 ledger。 */
  ledger: RuntimeEventIngestPort;
  /** identity-level runtime session id（Context 的键，非 Pi 会话内部 id）。 */
  runtimeSessionId: string;
  piSessionId?: string;
}

/**
 * R1-P1e：把 blueforst/pi 的 RuntimeEvent lifecycle seam（PI-016/017：
 * message_finalized / turn_committed / tool_execution_committed，加
 * settled / abort）转换并 exactly-once 提交到 RuntimeEvent ledger。
 *
 * fork 的 OwnEvent（含 save_point/settled/message_finalized 等）只通过
 * harness.subscribe（"*" 订阅）投递；on(type) 只覆盖 emitHook 事件。
 * 本 adapter 因此挂 harness.subscribe 并按其 event.type 分发。
 */
export function attachRuntimeEventSeam(
  harness: AgentHarness,
  options: RuntimeEventSeamOptions,
): void {
  harness.subscribe((event) => {
    const base = (
      payload: Omit<PiSeamEvent, "runtimeSessionId" | "piSessionId" | "occurredAt">,
    ): PiSeamEvent => ({
      ...payload,
      runtimeSessionId: options.runtimeSessionId,
      ...(options.piSessionId !== undefined ? { piSessionId: options.piSessionId } : {}),
      occurredAt: new Date().toISOString(),
    });
    switch (event.type) {
      case "message_finalized":
        options.ledger.ingest(
          base({
            type: "message_finalized",
            entryId: event.entryId,
            ...(event.receipt.entrySeq !== undefined ? { entrySeq: event.receipt.entrySeq } : {}),
            contentHash: event.contentHash,
          }),
        );
        break;
      case "turn_committed":
        options.ledger.ingest(
          base({
            type: "turn_committed",
            toolResultCount: event.toolResultCount,
            hadPendingMutations: event.hadPendingMutations,
          }),
        );
        break;
      case "tool_execution_committed":
        options.ledger.ingest(
          base({
            type: "tool_execution_committed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
          }),
        );
        break;
      case "settled":
        options.ledger.ingest(base({ type: "agent_settled" }));
        break;
      case "abort":
        options.ledger.ingest(base({ type: "abort" }));
        break;
      default:
        break;
    }
  });
}
