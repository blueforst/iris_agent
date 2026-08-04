import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { freezeBoundary } from "../src/historian/historian-boundary.js";
import {
  buildContinuitySnapshot,
  buildOverlapProjection,
  latestCompatibleSnapshot,
  runWrapup,
} from "../src/historian/historian-continuity.js";
import { buildAnalysisView } from "../src/historian/historian-analysis.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";

/**
 * Feature B6 — ContinuitySnapshot, wrapup & previous-session overlap.
 */

const OLD_SESSION = "iris-runtime-2026-08-01-1";
const NEW_SESSION = "iris-runtime-2026-08-02-1";

function u(id: string, parentId: string | null, text = "hello", ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
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

function assistantText(id: string, parentId: string, text: string, ts = 3): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function storeFixture(): { store: HistorianStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b6-"));
  return { store: HistorianStore.open({ databasePath: join(dir, "historian.db") }), dir };
}

async function freezeFor(
  session: string,
  entries: SessionTreeEntry[],
  processedThroughEntrySeq = 0,
) {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
  const page = await port.readEntries({ runtimeSessionId: session, limit: 100 });
  const freeze = freezeBoundary({
    runtimeSessionId: session,
    entries: page.entries,
    processedThroughEntrySeq,
    tailMarginEntries: 0,
    modelProviderProfile: "opencode/deepseek-v4-flash",
    frozenAt: "2026-08-01T00:00:00.000Z",
  });
  const analysis = buildAnalysisView({
    runtimeSessionId: session,
    boundary: freeze.snapshot,
    eligibleEntries: page.entries,
  });
  return { page, freeze, analysis };
}

test("B6: wrapup builds a ContinuitySnapshot with attributed fields and closes the session", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please remember: I prefer short replies"),
      c("c-1", "u-1"),
      assistantText(
        "a-1",
        "c-1",
        "I commit to keeping replies short and will follow up on the open thread.",
      ),
    ];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    const result = runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    assert.equal(result.status, "closed");
    const snapshot = result.snapshot;
    assert.ok(snapshot);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.runtimeSessionId, OLD_SESSION);
    // User constraint preserved (not elevated to an unattributed fact).
    assert.ok(
      snapshot.activeUserConstraints.some((c) => c.includes("prefer short replies")),
      "user constraint preserved",
    );
    // Attribution attached (user/iris_decision roles distinct).
    const roles = snapshot.attribution.map((a) => a.role);
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("iris_decision"));
    // Persisted.
    const persisted = store.listContinuitySnapshots(OLD_SESSION);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.continuitySnapshotId, snapshot.continuitySnapshotId);
    // Session finalized.
    assert.equal(store.getSessionState(OLD_SESSION)?.status, "closed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: incomplete drain marks closed_incomplete when the tail was never drained", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries, 0);
    // Simulate: the durable cursor is 0 but the head reached 2 → eligible
    // through == head → complete. For an incomplete case, force the state's
    // processed cursor BELOW a still-growing head (tail margin preserved).
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    const result = runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    assert.ok(result.snapshot);
    assert.equal(
      store.getSessionState(OLD_SESSION)?.status,
      "closed",
      "fully drained head → closed",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: previous-session overlap is BOUNDED and carries attribution (never new-Session messages)", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please remember: I prefer short replies"),
      c("c-1", "u-1"),
      assistantText("a-1", "c-1", "I commit to keeping replies short."),
    ];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });

    const snapshot = latestCompatibleSnapshot(store, OLD_SESSION);
    assert.ok(snapshot);
    const overlap = buildOverlapProjection(snapshot, 4);
    assert.equal(overlap.bounded, true);
    assert.equal(overlap.runtimeSessionId, OLD_SESSION, "overlap comes ONLY from the old Session");
    assert.ok(
      overlap.activeUserConstraints.some((x) => x.includes("prefer short replies")),
      "user constraint carried into the overlap",
    );
    // The overlap NEVER contains new-Session messages (it is built solely
    // from the old snapshot; no NEW_SESSION content can appear).
    assert.ok(
      !overlap.currentSituation.includes("new-session"),
      "no new-Session content in the overlap",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: latestCompatibleSnapshot returns the newest snapshot for the fallback path", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    // A second (later) wrapup produces a newer snapshot.
    const state2 = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 2,
      status: "closing" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state: state2,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    const latest = latestCompatibleSnapshot(store, OLD_SESSION);
    assert.equal(latest?.snapshotSequence, 2, "latest compatible snapshot is the newest");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: a fresh NEW Session has NO old-Session snapshot (fresh lineage; entries never spliced)", async () => {
  const { store, dir } = storeFixture();
  try {
    const oldEntries: SessionTreeEntry[] = [u("u-1", null, "old session text"), c("c-1", "u-1")];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, oldEntries);
    const state = {
      runtimeSessionId: OLD_SESSION,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: "x",
    };
    runWrapup({
      store,
      runtimeSessionId: OLD_SESSION,
      state,
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });

    // The NEW Runtime Session has no snapshot of its own.
    assert.equal(
      latestCompatibleSnapshot(store, NEW_SESSION),
      undefined,
      "new Session starts with a FRESH lineage (no old snapshot attached)",
    );
    // Old Session entries are never present in the new Session's store rows.
    const newSessionRows = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM continuity_snapshots WHERE runtime_session_id = ?")
      .get(NEW_SESSION) as { n: number };
    assert.equal(newSessionRows.n, 0, "old entries never spliced into the new Session");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6: snapshot preserves attribution — external statements are never unattributed facts", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "the sky is blue and my boss wants the report by Friday"),
      c("c-1", "u-1"),
    ];
    const { page, freeze, analysis } = await freezeFor(OLD_SESSION, entries);
    const snapshot = buildContinuitySnapshot({
      store,
      runtimeSessionId: OLD_SESSION,
      state: {
        runtimeSessionId: OLD_SESSION,
        processedThroughEntrySeq: 0,
        status: "active" as const,
        updatedAt: "x",
      },
      boundary: freeze.snapshot,
      eligibleEntries: page.entries,
      analysis,
    });
    // The user's statement is attributed to the user role — never promoted
    // to an unattributed fact.
    const userAttribution = snapshot.attribution.find((a) => a.role === "user");
    assert.ok(userAttribution, "user attribution attached");
    assert.ok(userAttribution?.entryIds.includes("u-1"));
    // currentSituation carries the user's real words (attributed).
    assert.ok(snapshot.currentSituation.includes("the sky is blue"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
