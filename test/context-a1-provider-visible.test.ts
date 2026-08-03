import { createHash } from "node:crypto";

import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { projectLogicalUnits, type HistoryProjectionUnit } from "../src/context/projection.js";
import {
  PROVIDER_VISIBLE_SERIALIZER_VERSION,
  renderUnitProviderVisible,
} from "../src/context/provider-visible.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

/**
 * Feature A1 — lossless provider-visible P5 projection contract (issue #8).
 *
 * The projection must carry a canonical, deterministic, provider-visible
 * semantic representation of input / assistant / tool-call / tool-result /
 * reasoning content — NOT structural placeholders. The projection hash must
 * cover the provider-visible output and the serializer identity. Internal
 * metadata (companions, wire frames, provenance internals) must not leak.
 */

const SESSION = "iris-runtime-2026-08-01-1";

function userEntry(id: string, parentId: string | null, text: string, ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function customCompanion(id: string, parentId: string, inputId: string, ts = 2): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: "<iris-input-meta/>",
    display: false,
    details: { iris: { inputId, pairKey: `k-${inputId}` } },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  parts: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    | { type: "thinking"; thinking: string }
  >,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: parts,
      api: "anthropic-messages",
      provider: "mock",
      model: "model-v1",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        totalTokens: 0,
      },
      stopReason: "stop",
      timestamp: ts,
    },
  };
}

function toolResultEntry(
  id: string,
  parentId: string,
  callId: string,
  text = "read-only result: iris",
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:04.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read_only_test_tool",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 4,
    },
  };
}

function unitOf(
  result: ReturnType<typeof projectLogicalUnits>,
  predicate: (unit: HistoryProjectionUnit) => boolean,
): HistoryProjectionUnit | undefined {
  return result.units.find(predicate);
}

test("A1: verified input renders origin-labelled real payload, never the wire header", () => {
  const wire = "IRIS_INPUT_V1\ninline_text:5\nhello\n";
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, wire),
    customCompanion("c-1", "u-1", "in-1"),
  ];
  const result = projectLogicalUnits(SESSION, entries);
  const input = unitOf(result, (u) => u.kind === "input");
  assert.ok(input?.kind === "input");
  // Real semantics preserved: the payload words are present.
  assert.ok(input.providerVisible.includes("hello"), "user payload words must be present");
  // Wire envelope never leaks.
  assert.ok(!input.providerVisible.includes("IRIS_INPUT_V1"), "wire header must not leak");
  // Structural placeholder contract: the rendered text is NOT "[input N-M]".
  assert.ok(!/^\[input \d/.test(input.providerVisible), "structural placeholders are forbidden");
  // Deterministic: same input -> same bytes.
  const again = projectLogicalUnits(SESSION, entries);
  const inputAgain = unitOf(again, (u) => u.kind === "input");
  assert.ok(inputAgain?.kind === "input");
  assert.equal(inputAgain.providerVisible, input.providerVisible);
});

test("A1: unverified user renders the fixed fail-conservative omission, never fabricated content", () => {
  const wire = "IRIS_INPUT_V1\ninline_text:5\nhello\n";
  const entries: SessionTreeEntry[] = [userEntry("u-1", null, wire)];
  const result = projectLogicalUnits(SESSION, entries);
  const input = unitOf(result, (u) => u.kind === "input");
  assert.ok(input?.kind === "input");
  assert.equal(input.verified, false);
  assert.equal(input.providerVisible, "[USER REQUEST | UNVERIFIED]");
  assert.ok(!input.providerVisible.includes("hello"), "unverified payload is not fabricated");
});

test("A1: assistant unit renders real text and tool calls as semantic lines", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "text", text: "I will read the file." },
      {
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "a.txt" },
      },
    ]),
  ];
  const result = projectLogicalUnits(SESSION, entries);
  const assistant = unitOf(result, (u) => u.kind === "assistant");
  assert.ok(assistant?.kind === "assistant");
  assert.ok(
    assistant.providerVisible.includes("I will read the file."),
    "assistant text semantics preserved",
  );
  assert.ok(
    assistant.providerVisible.includes("TOOL CALL: read_file("),
    "tool call rendered as semantic line",
  );
  assert.ok(
    !/^\[assistant \d/.test(assistant.providerVisible),
    "structural placeholders are forbidden",
  );
});

test("A1: tool result unit renders the real result content", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
    ]),
    toolResultEntry("tr-1", "a-1", "call-1", "file content: 42 lines"),
  ];
  const result = projectLogicalUnits(SESSION, entries);
  const toolResult = unitOf(result, (u) => u.kind === "tool_result");
  assert.ok(toolResult?.kind === "tool_result");
  assert.ok(
    toolResult.providerVisible.includes("file content: 42 lines"),
    "tool result semantics preserved",
  );
});

test("A1: reasoning unit renders preserved thinking; tool arc renders empty (semantics in parts)", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [
      { type: "thinking", thinking: "inner reasoning trace" },
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
    ]),
    toolResultEntry("tr-1", "a-1", "call-1"),
  ];
  const result = projectLogicalUnits(SESSION, entries);
  const reasoning = unitOf(result, (u) => u.kind === "reasoning");
  assert.ok(reasoning?.kind === "reasoning");
  assert.ok(
    reasoning.providerVisible.includes("inner reasoning trace"),
    "preserved reasoning text is rendered",
  );
  const arc = unitOf(result, (u) => u.kind === "tool_arc");
  assert.ok(arc?.kind === "tool_arc");
  assert.equal(renderUnitProviderVisible(arc), "", "tool arc renders empty (atomicity seam)");
});

test("A1: compaction and branch boundaries render their summaries, not seq placeholders", () => {
  const entries: SessionTreeEntry[] = [
    {
      type: "compaction",
      id: "cp-1",
      parentId: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      summary: "early discussion about architecture",
      firstKeptEntryId: "u-1",
      tokensBefore: 10,
    },
    userEntry("u-1", "cp-1", "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    {
      type: "branch_summary",
      id: "bs-1",
      parentId: "c-1",
      timestamp: "2026-08-01T00:00:04.000Z",
      fromId: "root",
      summary: "main thread",
    },
  ];
  const result = projectLogicalUnits(SESSION, entries);
  const compaction = unitOf(result, (u) => u.kind === "compaction_boundary");
  assert.ok(compaction?.kind === "compaction_boundary");
  assert.ok(
    compaction.providerVisible.includes("early discussion about architecture"),
    "compaction summary rendered",
  );
  assert.ok(!/^\[compaction \d/.test(compaction.providerVisible));
  const branch = unitOf(result, (u) => u.kind === "branch_boundary");
  assert.ok(branch?.kind === "branch_boundary");
  assert.ok(branch.providerVisible.includes("main thread"), "branch summary rendered");
});

test("A1: projectionHash covers provider-visible content — a content change changes the hash", () => {
  const base: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "first reply" }]),
  ];
  const changed: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "second reply" }]),
  ];
  const first = projectLogicalUnits(SESSION, base);
  const second = projectLogicalUnits(SESSION, changed);
  assert.notEqual(
    first.projectionHash,
    second.projectionHash,
    "different provider-visible content must produce a different projection hash",
  );
  // Identity-only hash (unit ids + hashes) would NOT have caught this: the
  // assistant unit id and entry id are identical in both projections.
  const firstAssistant = unitOf(first, (u) => u.kind === "assistant");
  const secondAssistant = unitOf(second, (u) => u.kind === "assistant");
  assert.ok(firstAssistant?.kind === "assistant");
  assert.ok(secondAssistant?.kind === "assistant");
  assert.equal(firstAssistant.unitId, secondAssistant.unitId, "unit identity is unchanged");
  assert.equal(firstAssistant.contentHash, secondAssistant.contentHash, "identity hash unchanged");
});

test("A1: projectionHash is deterministic and serializer-versioned", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply" }]),
  ];
  const first = projectLogicalUnits(SESSION, entries);
  const second = projectLogicalUnits(SESSION, entries);
  assert.equal(first.projectionHash, second.projectionHash, "byte-stable for identical input");
  // The serializer version genuinely participates in the hash: recomputing
  // the projection hash with a different serializer version MUST produce a
  // different digest, proving a serializer bump invalidates the projection
  // (HARD taxonomy dependency). The version string is folded into the
  // per-unit material exactly as projection.ts does.
  const withVersion = (version: string): string => {
    const material = first.units
      .map((unit) => {
        const unitHash = (unit as { contentHash: string }).contentHash;
        const visible = (unit as { providerVisible: string }).providerVisible;
        return `${unit.unitId}\0${unitHash}\0${visible}\0${version}`;
      })
      .join("\n");
    return createHash("sha256").update(material).digest("hex");
  };
  const v1 = withVersion(PROVIDER_VISIBLE_SERIALIZER_VERSION);
  const v2 = withVersion("iris-provider-visible-v2-next");
  assert.equal(v1, first.projectionHash, "recomputation reproduces the projection hash");
  assert.notEqual(v1, v2, "serializer version bump must change the projection hash");
  assert.equal(PROVIDER_VISIBLE_SERIALIZER_VERSION, "iris-provider-visible-v1");
});

test("A1: renderUnitProviderVisible is the single deterministic rendering path", () => {
  const entries: SessionTreeEntry[] = [
    userEntry("u-1", null, "IRIS_INPUT_V1\ninline_text:5\nhello\n"),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", [{ type: "text", text: "reply" }]),
  ];
  const result = projectLogicalUnits(SESSION, entries);
  for (const unit of result.units) {
    const rendered = renderUnitProviderVisible(unit);
    assert.equal(typeof rendered, "string");
    // Every semantic unit must render REAL content or an explicit marker —
    // never a structural seq placeholder.
    assert.ok(
      !/^\[(input|assistant|tool_result|tool_arc|reasoning|compaction|branch) \d/.test(rendered),
      `structural placeholder leaked from ${unit.kind}: ${rendered}`,
    );
    assert.equal(renderUnitProviderVisible(unit), rendered, "rendering is deterministic per unit");
  }
});
