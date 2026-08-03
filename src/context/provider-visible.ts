import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { OriginEnvelope } from "../contracts/origin.js";
import type { IrisBlockLayoutV1 } from "../contracts/tool.js";
import type { InputFrame } from "../runtime/companion.js";
import type { HistoryProjectionUnit } from "./projection.js";

/**
 * Provider-visible P5 rendering contract (issue #8 Feature A1).
 *
 * ONE deterministic, lossless rendering path from HistoryProjectionUnit to
 * provider-visible text. The same unit ALWAYS renders the same bytes; the
 * rendered text carries the REAL semantics (user request with origin label,
 * assistant text, tool call, tool result, allowed reasoning) — never
 * structural placeholders like `[input 1-2]`.
 *
 * Safety rules (01 Context Assembly — Pi Input and Provenance Projection):
 *  - the iris_input_meta companion and raw IRIS wire frames are never exposed;
 *  - internal provenance metadata (pairKey, layout hashes, blocks) is folded
 *    into a short origin label or omitted — never leaked as raw metadata;
 *  - a verified input pair folds to origin-labelled frames; an unverified one
 *    uses the fixed fail-conservative omission projection (never synthesizes);
 *  - reasoning is rendered when preserved (provider-compatible), else omitted.
 */

/** Serializer identity of this rendering contract. Bump on a semantic change
 * (affects projectionHash + HARD taxonomy). */
export const PROVIDER_VISIBLE_SERIALIZER_VERSION = "iris-provider-visible-v1";

function authorityLabel(authority: OriginEnvelope["authority"]): string {
  switch (authority) {
    case "user_request":
      return "USER REQUEST";
    case "notice_only":
      return "NOTICE ONLY";
    case "data_only":
      return "DATA ONLY";
    case "internal_control":
      return "INTERNAL CONTROL";
  }
}

/** Model-visible origin label (principalKind + channel + authority + trust). */
export function originLabel(origin: OriginEnvelope): string {
  const kind = origin.principalKind.toUpperCase();
  return `[${kind} | ${origin.channel} | ${authorityLabel(origin.authority)} | ${origin.trust.toUpperCase()}]`;
}

function frameOriginLabel(
  index: number,
  blocks: IrisBlockLayoutV1[] | undefined,
  frames: InputFrame[] | undefined,
): string {
  if (!Array.isArray(blocks)) {
    return "[DATA ONLY | UNTRUSTED]";
  }
  const origin = blocks[index]?.sourceOrigin;
  if (origin === undefined) {
    return "[DATA ONLY | UNTRUSTED]";
  }
  void frames;
  return originLabel(origin);
}

/** Unverified input omission projection (01 Context Assembly: fixed
 * fail-conservative omission — never guess, never synthesize history). */
const UNVERIFIED_INPUT_OMISSION = "[USER REQUEST | UNVERIFIED]";

/**
 * Render a verified-or-unverified input unit to provider-visible text.
 * Verified: each wire frame is re-labelled with its block's origin and the
 * frame payload is presented verbatim — the user's real words remain present.
 * Unverified: the fixed omission projection (safe, no fabricated content).
 */
export function renderInputProviderVisible(args: {
  frames: InputFrame[] | undefined;
  blocks: IrisBlockLayoutV1[] | undefined;
  verified: boolean;
}): string {
  if (args.frames === undefined || !args.verified) {
    return UNVERIFIED_INPUT_OMISSION;
  }
  return args.frames
    .map((frame, index) => `${frameOriginLabel(index, args.blocks, args.frames)}\n${frame.payload}`)
    .join("\n\n");
}

interface TextContentPart {
  type: string;
  text?: string;
}

/** Narrow an AgentMessage to its content-array shape (Pi message union). */
function contentPartsOf(message: AgentMessage): unknown[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/**
 * Render an assistant unit: text parts verbatim (the assistant's real words),
 * plus compact tool-call lines. Reasoning parts are NOT rendered here — they
 * are rendered by the reasoning unit (preserved reasoning contract).
 */
export function renderAssistantProviderVisible(message: AgentMessage): string {
  const lines: string[] = [];
  for (const rawPart of contentPartsOf(message)) {
    const part = rawPart as TextContentPart;
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.length > 0) {
        lines.push(part.text);
      }
      continue;
    }
    if (part.type === "toolCall") {
      const call = rawPart as {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
      const args =
        typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
      lines.push(`TOOL CALL: ${call.name ?? "unknown"}(${args})`);
    }
  }
  return lines.join("\n");
}

/** Render a tool result unit: the result text verbatim. */
export function renderToolResultProviderVisible(message: AgentMessage): string {
  const parts = contentPartsOf(message) as TextContentPart[];
  const text = parts
    .filter((part): part is TextContentPart & { text: string } => {
      return part.type === "text" && typeof part.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
  return text.length > 0 ? text : "(empty tool result)";
}

/** Render a reasoning unit: the preserved thinking text. Pi thinking parts
 * carry the text in the `thinking` field (pi-ai ThinkingContent). */
export function renderReasoningProviderVisible(message: AgentMessage): string {
  const lines: string[] = [];
  for (const rawPart of contentPartsOf(message)) {
    const part = rawPart as TextContentPart & { thinking?: string };
    if (part.type === "thinking" && typeof part.thinking === "string") {
      lines.push(part.thinking);
    }
  }
  return lines.join("\n");
}

/**
 * Render any projection unit to its canonical provider-visible text.
 * Structure-only units (tool_arc) render as empty: their semantics are fully
 * carried by the assistant (tool call) + tool_result units, and they exist
 * for atomicity/fencing, not for content. Compaction/branch boundaries return
 * the unit's OWN rendered summary (single source of truth — the same bytes
 * the projection stored).
 */
export function renderUnitProviderVisible(unit: HistoryProjectionUnit): string {
  switch (unit.kind) {
    case "input":
      return unit.providerVisible;
    case "assistant":
      return unit.providerVisible;
    case "tool_result":
      return unit.providerVisible;
    case "reasoning":
      return unit.providerVisible;
    case "compaction_boundary":
    case "branch_boundary":
      return unit.providerVisible;
    case "tool_arc":
      // Semantic content is in the assistant + tool_result units.
      return "";
  }
}
