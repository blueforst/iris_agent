import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import type { RuntimeSessionHistoryReadPort } from "../src/contracts/historian.js";
import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { HistorianRunner, unprocessedFromEntrySeq } from "../src/historian/historian-runner.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";

/**
 * Feature B3 — frozen boundary, finite batch, pure validation.
 */

const SESSION = "iris-runtime-2026-08-01-1";

function u(id: string, parentId: string | null, ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: "hello", timestamp: ts },
  } as unknown as SessionTreeEntry;
}

function c(id: string, parentId: string, ts = 2): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: "iris_input_meta",
    content: "<iris-input-meta/>",
    display: false,
  } as unknown as SessionTreeEntry;
}

function assistantWithToolCall(
  id: string,
  parentId: string,
  callId: string,
  ts = 3,
): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "tool", arguments: {} }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function toolResult(id: string, parentId: string, callId: string, ts = 4): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "tool",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function makePort(entries: SessionTreeEntry[]): SessionHistoryReadPort {
  return new SessionHistoryReadPort({ readRawEntries: async () => entries });
}

function storeFixture(): { store: HistorianStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b3-"));
  return { store: HistorianStore.open({ databasePath: join(dir, "historian.db") }), dir };
}

test("B3: freeze finds a safe seam — never cuts a tool arc or the protected tail", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
    u("u-2", "tr-1"),
    c("c-2", "u-2"),
  ];
  const port = makePort(entries);
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
  const freeze = freezeBoundary({
    runtimeSessionId: SESSION,
    entries: page.entries,
    processedThroughEntrySeq: 0,
    tailMarginEntries: 2,
    modelProviderProfile: "opencode/deepseek-v4-flash",
    frozenAt: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(freeze.nothingNew, false);
  // Protected tail = last 2 entries (u-2, c-2); the seam must stop before
  // the tail: eligibleThrough ≤ 4. The last complete tool arc ends at 4.
  assert.ok(
    freeze.snapshot.eligibleThroughEntrySeq <= 4,
    `eligible seam ${freeze.snapshot.eligibleThroughEntrySeq} must not cut the protected tail`,
  );
  assert.equal(
    freeze.snapshot.protectedTailStartEntrySeq,
    freeze.snapshot.eligibleThroughEntrySeq + 1,
  );
  assert.equal(freeze.unprocessedFromEntrySeq, 1);
});

test("B3: freeze with nothing new returns nothingNew", async () => {
  const entries: SessionTreeEntry[] = [u("u-1", null), c("c-1", "u-1")];
  const port = makePort(entries);
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
  const freeze = freezeBoundary({
    runtimeSessionId: SESSION,
    entries: page.entries,
    processedThroughEntrySeq: 2,
    tailMarginEntries: 2,
    modelProviderProfile: "m",
    frozenAt: "x",
  });
  assert.equal(freeze.nothingNew, true, "head == cursor → nothing new");
});

test("B3: runner commits the safe prefix and advances the cursor; re-run is nothing_new", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
    u("u-2", "tr-1"),
    c("c-2", "u-2"),
  ];
  const { store, dir } = storeFixture();
  try {
    const port = makePort(entries);
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const runner = new HistorianRunner({ store, readPort: port });
    const first = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    assert.equal(first.status, "committed");
    assert.equal(first.committed, true);
    assert.ok(first.commitThroughEntrySeq >= 4, `committed through ${first.commitThroughEntrySeq}`);
    const state = store.getSessionState(SESSION);
    assert.equal(state?.processedThroughEntrySeq, first.commitThroughEntrySeq, "cursor advanced");
    // Re-run with the SAME snapshot: nothing new.
    const second = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    assert.equal(second.status, "nothing_new");
    assert.equal(second.committed, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: an incomplete tool arc (toolCall without toolResult) is DISCARDED from the commit", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"), // NO toolResult — in flight
    u("u-2", "a-1"),
    c("c-2", "u-2"),
  ];
  const { store, dir } = storeFixture();
  try {
    const port = makePort(entries);
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 0, // no tail margin → the seam tries to reach the head
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const runner = new HistorianRunner({ store, readPort: port });
    const result = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    // The incomplete arc's assistant (a-1 @3) is never committed — the
    // commit stops at the last safe prefix (u-1/c-1 = seq 2), unless the
    // whole range validates. With no toolResult, a-1 is unsafe.
    assert.ok(
      result.commitThroughEntrySeq <= 2,
      `incomplete arc must be discarded; committed through ${result.commitThroughEntrySeq}`,
    );
    const state = store.getSessionState(SESSION);
    assert.ok((state?.processedThroughEntrySeq ?? 0) <= 2, "cursor never passes an unsafe arc");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: validation failure never advances the cursor (range hash mismatch)", async () => {
  const { store, dir } = storeFixture();
  try {
    const mutable: SessionTreeEntry[] = [
      u("u-1", null),
      c("c-1", "u-1"),
      assistantWithToolCall("a-1", "c-1", "call-1"),
      toolResult("tr-1", "a-1", "call-1"),
    ];
    const port = makePort(mutable);
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    assert.ok(
      freeze.snapshot.eligibleThroughEntrySeq >= 1,
      `eligible seam must be ≥ 1 to exercise validation, got ${freeze.snapshot.eligibleThroughEntrySeq}`,
    );
    // The Session MUTATES after the freeze INSIDE the eligible range (the
    // first entry's content changes), so the runner's re-read differs from
    // the frozen source range → the frozen sourceRangeHash cannot match →
    // validation fails closed and the cursor never advances.
    mutable[0] = u("u-1", null, 99);
    const runner = new HistorianRunner({ store, readPort: port });
    const result = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    assert.equal(result.status, "validation_failed");
    assert.equal(result.committed, false);
    assert.equal(
      store.getSessionState(SESSION),
      undefined,
      "cursor untouched on validation failure",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: runner never widens beyond the frozen ceiling (finite batch)", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
    u("u-2", "tr-1"),
    c("c-2", "u-2"),
  ];
  const { store, dir } = storeFixture();
  try {
    const port = makePort(entries);
    // Freeze when the head was only 2 entries (simulated older freeze).
    const page2 = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const staleBoundary = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page2.entries.slice(0, 2),
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const runner = new HistorianRunner({ store, readPort: port });
    const result = await runner.run({
      runtimeSessionId: SESSION,
      boundary: staleBoundary.snapshot,
    });
    // The runner must NOT commit beyond the frozen eligibleThroughEntrySeq
    // even though the live session has more entries now.
    assert.ok(
      result.commitThroughEntrySeq <= staleBoundary.snapshot.eligibleThroughEntrySeq,
      "runner respects the frozen ceiling",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: unprocessedFromEntrySeq is deterministic from the durable cursor", () => {
  assert.equal(unprocessedFromEntrySeq(undefined), 1);
  assert.equal(
    unprocessedFromEntrySeq({
      runtimeSessionId: SESSION,
      processedThroughEntrySeq: 0,
      status: "active",
      updatedAt: "x",
    }),
    1,
  );
  assert.equal(
    unprocessedFromEntrySeq({
      runtimeSessionId: SESSION,
      processedThroughEntrySeq: 7,
      status: "active",
      updatedAt: "x",
    }),
    8,
  );
});

test("B3: commit hook runs INSIDE the transaction; a hook failure rolls back the cursor", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
  ];
  const { store, dir } = storeFixture();
  try {
    const port = makePort(entries);
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    let hookCalls = 0;
    const runner = new HistorianRunner({
      store,
      readPort: port,
      commitHook: {
        commitSafePrefix: () => {
          hookCalls += 1;
          throw new Error("publication commit failed (simulated)");
        },
      },
    });
    await assert.rejects(
      () => runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot }),
      /publication commit failed/,
    );
    assert.equal(hookCalls, 1);
    assert.equal(
      store.getSessionState(SESSION),
      undefined,
      "cursor rolled back when the commit hook failed",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: completed tool arcs with orphan-free prefix commit fully", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
    u("u-2", "tr-1"),
    c("c-2", "u-2"),
    assistantWithToolCall("a-2", "c-2", "call-2"),
    toolResult("tr-2", "a-2", "call-2"),
  ];
  const { store, dir } = storeFixture();
  try {
    const port = makePort(entries);
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const runner = new HistorianRunner({ store, readPort: port });
    const result = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    assert.equal(result.status, "committed");
    // Eligible range = head - tailMargin(2) = 6: the FIRST complete arc
    // (u-1..tr-1 @4) commits fully; the second arc (a-2 @7, tr-2 @8) is in
    // the protected tail (eligibleThrough = 6), so the commit stops at the
    // last complete arc — never cutting into the tail.
    assert.ok(
      result.commitThroughEntrySeq >= 4,
      `first complete arc committed through ${result.commitThroughEntrySeq}`,
    );
    assert.ok(result.commitThroughEntrySeq <= 6, "commit never enters the protected tail");
    assert.equal(result.discardedFromEntrySeq, null, "no unsafe suffix within the eligible range");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: multi-cycle processing on a GROWING session — each cycle advances the cursor (regression for the BLOCKING freeze-hash bug)", async () => {
  // The B3 review BLOCKING: the frozen sourceRangeHash covered the whole
  // prefix including already-processed entries, so every cycle after the
  // first commit failed validation closed and the Historian stalled. The
  // frozen hash now covers ONLY the unprocessed window, so a growing live
  // session processes continuously.
  const mutable: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
  ];
  const { store, dir } = storeFixture();
  try {
    const port = makePort(mutable);
    const runner = new HistorianRunner({ store, readPort: port });

    // Cycle 1: head = 4 → commit through the first arc.
    let page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze1 = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const first = await runner.run({ runtimeSessionId: SESSION, boundary: freeze1.snapshot });
    assert.equal(first.status, "committed");
    const cursor1 = store.getSessionState(SESSION)?.processedThroughEntrySeq ?? 0;
    assert.ok(cursor1 >= 2, `cycle 1 committed through ${cursor1}`);

    // The Session GROWS: a second user turn + complete arc.
    mutable.push(
      u("u-2", "tr-1"),
      c("c-2", "u-2"),
      assistantWithToolCall("a-2", "c-2", "call-2"),
      toolResult("tr-2", "a-2", "call-2"),
    );

    // Cycle 2: fresh freeze from the CURRENT cursor — must commit NEW
    // entries (regression: this used to fail validation closed forever).
    page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze2 = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: cursor1,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const second = await runner.run({ runtimeSessionId: SESSION, boundary: freeze2.snapshot });
    assert.equal(
      second.status,
      "committed",
      `cycle 2 must commit, got ${second.status} ${second.errorCode ?? ""}`,
    );
    const cursor2 = store.getSessionState(SESSION)?.processedThroughEntrySeq ?? 0;
    assert.ok(cursor2 > cursor1, `cycle 2 must advance the cursor (${cursor1} → ${cursor2})`);

    // Cycle 3: nothing new when the head stops growing.
    page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze3 = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: cursor2,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const third = await runner.run({ runtimeSessionId: SESSION, boundary: freeze3.snapshot });
    assert.equal(third.status, "nothing_new");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: a durable gap at freeze time fails closed (runner honors the gap, never spans it)", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
  ];
  const { store, dir } = storeFixture();
  try {
    // A port that ALWAYS reports a gap on page reads.
    const gapPort = new SessionHistoryReadPort({ readRawEntries: async () => entries });
    const gappedPort: RuntimeSessionHistoryReadPort = {
      readEntries: async (input: {
        runtimeSessionId: string;
        afterEntrySeqExclusive?: number;
        limit: number;
      }) => {
        const page = await gapPort.readEntries(input);
        return {
          ...page,
          gap: {
            fromEntrySeq: 2,
            toEntrySeq: 3,
            kind: "sequence_gap" as const,
            detail: "simulated durable gap",
          },
        };
      },
    };
    const page = await gapPort.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 2,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const runner = new HistorianRunner({ store, readPort: gappedPort });
    await assert.rejects(
      () => runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot }),
      /historian read gap sequence_gap/,
    );
    assert.equal(
      store.getSessionState(SESSION),
      undefined,
      "gap fail-closed leaves the cursor untouched",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: analysis view is deterministic (same input → same units)", async () => {
  const entries: SessionTreeEntry[] = [
    u("u-1", null),
    c("c-1", "u-1"),
    assistantWithToolCall("a-1", "c-1", "call-1"),
    toolResult("tr-1", "a-1", "call-1"),
  ];
  const port = makePort(entries);
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
  const freeze = freezeBoundary({
    runtimeSessionId: SESSION,
    entries: page.entries,
    processedThroughEntrySeq: 0,
    tailMarginEntries: 2,
    modelProviderProfile: "m",
    frozenAt: "x",
  });
  const { buildAnalysisView } = await import("../src/historian/historian-analysis.js");
  const a = buildAnalysisView({
    runtimeSessionId: SESSION,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
  });
  const b = buildAnalysisView({
    runtimeSessionId: SESSION,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
  });
  assert.deepEqual(a.units, b.units, "deterministic classification");
  assert.ok(a.units.some((unit) => unit.kind === "tool_result"));
});
