import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import {
  applyContextPass,
  renderProviderVisible,
  runContextPass,
} from "../src/context/pipeline.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  M0_EMPTY_BODY,
  M1_EMPTY_PLACEHOLDER,
  IRIS_INPUT_META_CUSTOM_TYPE,
} from "../src/contracts/context.js";

/**
 * Feature A2 — real m0/m1/live-tail materialization (issue #8).
 *
 *  HARD  → rebuild/persist m0 + reset/render m1 + live tail
 *  SOFT  → replay persisted m0 + render/persist REAL m1 delta + live tail
 *  SOFT+ → byte-identical replay persisted m0/m1 + current invocation live delta
 *
 * Contracts asserted here:
 *  - m1 is never a fixed "(delta)" placeholder;
 *  - SOFT+/SOFT never omit the stable prefix (carriers always present);
 *  - m0, m1, live tail appear in fixed order;
 *  - stable empty placeholder bytes match the authority;
 *  - represented watermark matches what m0/m1 really represent;
 *  - identical input + state → byte-identical prefix.
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
  text: string,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
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

function wire(text: string): string {
  return `IRIS_INPUT_V1\ninline_text:${Buffer.byteLength(text, "utf8")}\n${text}\n`;
}

function makeStore(): { store: ContextStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-a2-"));
  const path = join(dir, "context.db");
  return { store: ContextStore.open(path), path };
}

function baseInput(entries: SessionTreeEntry[]) {
  return {
    runtimeSessionId: SESSION,
    entries,
    lineage: undefined as never,
    source: {
      contextSourceSnapshotId: "src-1",
      personaSnapshotId: "persona-1",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "system prompt",
      systemProjectionHash: "sys-hash-1",
    },
    model: { provider: "opencode", modelId: "model-a" },
    usagePercentage: 30,
    contextLimit: 8_000,
    executeThresholdPercentage: 65,
  };
}

function seedLineage(store: ContextStore) {
  store.createLineage({
    runtimeSessionId: SESSION,
    contextSourceSnapshotId: "src-1",
    epochId: SESSION,
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "system prompt",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-golden-v1",
    carrierSchemaVersion: "1",
  });
}

function entriesForTwoTurns(): SessionTreeEntry[] {
  return [
    userEntry("u-1", null, wire("hello")),
    customCompanion("c-1", "u-1", "in-1"),
    assistantEntry("a-1", "c-1", "hi back"),
    userEntry("u-2", "a-1", wire("more"), 5),
    customCompanion("c-2", "u-2", "in-2", 6),
    assistantEntry("a-2", "c-2", "done", 7),
  ];
}

function carrierText(messages: Array<{ content?: unknown }>): string[] {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((text) => text.length > 0);
}

test("A2: HARD pass renders a complete provider-visible result — m0 + m1 + live tail in fixed order", () => {
  const { store, path } = makeStore();
  try {
    seedLineage(store);
    const entries = entriesForTwoTurns();
    const decision = runContextPass({
      ...baseInput(entries),
      // Force a small N so the head is non-empty and m0 has content.
      contextLimit: 8_000,
      usagePercentage: 30,
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    assert.equal(decision.classification, "HARD");
    assert.equal(decision.action.kind, "materialize_m0");
    assert.ok(decision.carriers, "HARD builds carriers");
    // Fixed order: m0 first, m1 second, live tail after.
    const visible = renderProviderVisible(decision, decision.projection);
    const texts = carrierText(visible.messages as Array<{ content?: unknown }>);
    assert.ok(texts.length >= 2);
    assert.equal(visible.messages[0]?.role, "custom");
    const surfaces = (
      visible.messages as Array<{ details?: { irisContext?: { surface?: string } } }>
    )
      .map((m) => m.details?.irisContext?.surface)
      .filter((s): s is string => s !== undefined);
    const m0Index = surfaces.indexOf("m0");
    const m1Index = surfaces.indexOf("m1");
    assert.ok(m0Index >= 0 && m1Index > m0Index, "m0 precedes m1");
    for (let index = m1Index + 1; index < surfaces.length; index += 1) {
      assert.equal(surfaces[index], "live", "live tail comes after m0/m1");
    }
    // m1 is the stable empty placeholder on HARD reset (authority bytes).
    const m1 = visible.messages[m1Index] as { content?: unknown };
    assert.equal(m1.content, M1_EMPTY_PLACEHOLDER, "HARD resets m1 to the authority placeholder");
    // The live tail carries REAL semantics (not markers).
    const liveTexts = texts.slice(m1Index + 1).join("\n");
    assert.ok(liveTexts.length > 0, "live tail is not empty");
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("A2: SOFT persists a REAL m1 delta and replays persisted m0 (never (delta))", () => {
  const { store, path } = makeStore();
  try {
    seedLineage(store);
    const entries = entriesForTwoTurns();
    // Pass 1: HARD materialize.
    const pass1 = runContextPass({
      ...baseInput(entries),
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    applyContextPass(store, SESSION, pass1, 1000);
    // Pass 2: a new P3 compartment commit above the watermark → SOFT.
    const lineage = store.getLineage(SESSION);
    assert.ok(lineage);
    const pass2 = runContextPass({
      ...baseInput(entries),
      lineage,
      p3Committed: {
        compartments: [
          {
            compartmentId: "c-2",
            runtimeSessionId: SESSION,
            sequence: 2,
            startEntrySeq: 1,
            endEntrySeq: 4,
            title: "new work",
            p1: "the new semantic content",
            sourceHash: "h",
          },
        ],
      },
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    assert.equal(pass2.classification, "SOFT");
    assert.equal(pass2.action.kind, "materialize_m1");
    // The decision's m1 body is the REAL delta (never "(delta)").
    assert.ok(
      pass2.action.kind === "materialize_m1" &&
        pass2.action.m1Body.includes("new semantic content"),
      "m1 delta carries the new compartment's semantic content",
    );
    assert.ok(
      !(pass2.action.kind === "materialize_m1" && pass2.action.m1Body.includes("(delta)")),
      "fixed (delta) placeholder forbidden",
    );
    // SOFT carries the persisted m0 prefix (never omitted).
    assert.ok(pass2.carriers);
    assert.equal(
      pass2.carriers.m0.content,
      lineage.m0Body,
      "SOFT replays persisted m0 byte-identically",
    );
    // Persist the SOFT pass; the stored m1 is the real delta wrapped in the
    // authority wire shape, and the stored watermark matches headEnd.
    applyContextPass(store, SESSION, pass2, 2000);
    const stored = store.getLineage(SESSION);
    assert.ok(stored);
    assert.ok(stored.m1Body?.includes("new semantic content"));
    assert.ok(!(stored.m1Body ?? "").includes("(delta)"));
    assert.equal(
      stored.representedThroughEntrySeq,
      pass1.protectedTail.headEndEntrySeq,
      "represented watermark matches what m0/m1 represent",
    );
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("A2: SOFT+ replays persisted m0/m1 byte-identically with only the live delta appended", () => {
  const { store, path } = makeStore();
  try {
    seedLineage(store);
    const entries = entriesForTwoTurns();
    const pass1 = runContextPass({
      ...baseInput(entries),
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    applyContextPass(store, SESSION, pass1, 1000);

    const lineage = store.getLineage(SESSION);
    assert.ok(lineage);
    const pass2 = runContextPass({
      ...baseInput(entries),
      lineage,
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    assert.equal(pass2.classification, "SOFT+");
    assert.equal(pass2.action.kind, "reuse");
    // Byte-identical prefix replay: carriers rebuild from persisted bytes.
    assert.ok(pass2.carriers);
    assert.equal(pass2.carriers.m0.content, lineage.m0Body, "m0 byte-identical");
    assert.equal(
      pass2.carriers.m1.content,
      lineage.m1Body ?? M1_EMPTY_PLACEHOLDER,
      "m1 byte-identical",
    );

    // The full rendered wire for identical inputs is byte-identical.
    const wire1 = renderProviderVisible(pass1, pass1.projection).messages.map((m) =>
      JSON.stringify({ role: m.role, content: (m as { content?: unknown }).content }),
    );
    const wire2 = renderProviderVisible(pass2, pass2.projection).messages.map((m) =>
      JSON.stringify({ role: m.role, content: (m as { content?: unknown }).content }),
    );
    // m0/m1 slots are identical; live tail identical too (same projection).
    assert.deepEqual(wire1, wire2, "same input + state → byte-identical provider wire");
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("A2: stable empty placeholder bytes match the authority constants", () => {
  assert.equal(M0_EMPTY_BODY, "<session-history></session-history>");
  assert.equal(
    M1_EMPTY_PLACEHOLDER,
    "<session-history-since>(no new content since last materialization)</session-history-since>",
  );
});

test("A2: represented watermark equals the real m0/m1 head boundary after HARD", () => {
  const { store, path } = makeStore();
  try {
    seedLineage(store);
    const entries = entriesForTwoTurns();
    const decision = runContextPass({
      ...baseInput(entries),
      unitTokenCounts: [2_000, 2_000, 2_000, 2_000, 2_000, 2_000],
    });
    assert.equal(decision.action.kind, "materialize_m0");
    applyContextPass(store, SESSION, decision, 1000);
    const lineage = store.getLineage(SESSION);
    assert.ok(lineage);
    assert.equal(
      lineage.representedThroughEntrySeq,
      decision.protectedTail.headEndEntrySeq,
      "watermark = head end (what m0/m1 represent), not the whole projection",
    );
  } finally {
    store.close();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});
