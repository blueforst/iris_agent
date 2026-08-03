import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { ContextRuntime, ContextFailClosedError } from "../src/context/context-runtime.js";
import { ContextStore } from "../src/context/context-store.js";
import { defaultAgentConfig } from "../src/config/load.js";
import { LKG_SLOT_KEY } from "../src/context/lkg.js";
import { createContextRuntime } from "../src/runtime/vertical-slice.js";
import { IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

/**
 * Feature A4 — LKG, failure and emergency fail-closed (issue #8).
 *
 *  ordinary transform/storage failure
 *    → validate compatible LKG
 *    → replay LKG + current suffix
 *    → otherwise IRIS_CONTEXT_TRANSFORM_UNAVAILABLE
 *
 *  armed emergency / unresolved hard overflow
 *    → IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED
 *
 * All before any provider request. No raw message fallback, no synthetic
 * repair, no fixed blocked placeholder, no cross-Session LKG reuse.
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

function makeRuntime(): {
  runtime: ContextRuntime;
  store: ContextStore;
  dir: string;
  entriesRef: { entries: SessionTreeEntry[] };
} {
  const dir = mkdtempSync(join(tmpdir(), "iris-a4-"));
  const dataRoot = join(dir, "root");
  const entriesRef: { entries: SessionTreeEntry[] } = { entries: [] };
  const { runtime, store } = createContextRuntime({
    dataRoot,
    config: defaultAgentConfig(),
    readEntries: async () => entriesRef.entries,
    nowMs: () => 1_000,
  });
  return { runtime, store, dir, entriesRef };
}

function baseTransform(runtime: ContextRuntime) {
  return runtime.transformMessages({
    invocationId: "inv-1",
    runtimeSessionId: SESSION,
    messages: [],
    model: { provider: "opencode", modelId: "deepseek-v4-flash" },
    providerProfileId: "opencode-go-deepseek-v4-flash-dev-nonthinking-v1",
  });
}

test("A4: successful HARD pass captures an LKG slot with the provider-visible prefix", async () => {
  const { runtime, store, dir, entriesRef } = makeRuntime();
  try {
    runtime.prepareInvocationSources({
      inputId: "in-1",
      runtimeSessionId: SESSION,
      epochId: SESSION,
    });
    entriesRef.entries = [
      userEntry("u-1", null, wire("hello")),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    const result = await baseTransform(runtime);
    // Provider-visible view present (m0/m1 carriers).
    assert.ok(result.messages.length >= 2);
    // LKG slot captured with slash-form model identity.
    const slot = store.getLkgSlot(SESSION, LKG_SLOT_KEY);
    assert.ok(slot, "LKG slot captured after a successful HARD pass");
    const payload = JSON.parse(slot.lkgJson) as { modelKey: string; providerKey: string };
    assert.equal(payload.modelKey, "opencode/deepseek-v4-flash", "slash-form model key (A5 #5)");
    assert.equal(payload.providerKey, "opencode");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4: ordinary transform failure replays a compatible LKG (prefix + current suffix), never raw fallback", async () => {
  const { runtime, store, dir, entriesRef } = makeRuntime();
  try {
    runtime.prepareInvocationSources({
      inputId: "in-1",
      runtimeSessionId: SESSION,
      epochId: SESSION,
    });
    entriesRef.entries = [
      userEntry("u-1", null, wire("hello")),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    // Pass 1: successful HARD → LKG captured.
    await baseTransform(runtime);
    assert.ok(store.getLkgSlot(SESSION, LKG_SLOT_KEY));

    // Pass 2: simulate a storage failure — the lineage table becomes
    // unavailable so the materialization path throws an ordinary error,
    // while the LKG slot table (the recovery artifact) stays intact.
    const db = store.raw();
    db.exec("DROP TABLE context_lineages");

    // The transform now fails; the compatible LKG must replay the safe
    // prefix + current suffix instead of raw fallback.
    const result = await baseTransform(runtime);
    // Replay output: the captured provider-visible prefix (carriers) + the
    // current suffix — the user payload semantics must still be present.
    const text = result.messages
      .map((m) => {
        const content = (m as { content?: unknown }).content;
        return typeof content === "string" ? content : "";
      })
      .join("\n");
    assert.ok(text.includes("hello"), "replayed prefix carries the user payload semantics");
    // No raw wire frame, no companion, no mock identity leaks through replay.
    assert.ok(!text.includes("IRIS_INPUT_V1"), "no raw wire passthrough on LKG replay");
    assert.ok(!text.includes("iris_input_meta"), "no companion on LKG replay");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4: no compatible LKG → IRIS_CONTEXT_TRANSFORM_UNAVAILABLE before provider", async () => {
  const { runtime, store, dir, entriesRef } = makeRuntime();
  try {
    runtime.prepareInvocationSources({
      inputId: "in-1",
      runtimeSessionId: SESSION,
      epochId: SESSION,
    });
    entriesRef.entries = [
      userEntry("u-1", null, wire("hello")),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    // Storage failure with NO LKG captured (no successful HARD pass ever ran)
    // → no compatible recovery → typed fail-closed before any provider call.
    const db = store.raw();
    db.exec("DROP TABLE context_lineages");
    await assert.rejects(
      () => baseTransform(runtime),
      (error: unknown) => {
        assert.ok(error instanceof ContextFailClosedError);
        assert.equal(error.code, "IRIS_CONTEXT_TRANSFORM_UNAVAILABLE");
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4: armed emergency fails closed with IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED", async () => {
  const { runtime, store, dir, entriesRef } = makeRuntime();
  try {
    runtime.prepareInvocationSources({
      inputId: "in-1",
      runtimeSessionId: SESSION,
      epochId: SESSION,
    });
    entriesRef.entries = [
      userEntry("u-1", null, wire("hello")),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    // Arm the emergency state (a prior pass escalated).
    store.setEmergencyState(SESSION, "emergency_fail_closed", "previous hard overflow");
    await assert.rejects(
      () => baseTransform(runtime),
      (error: unknown) => {
        assert.ok(error instanceof ContextFailClosedError);
        assert.equal(error.code, "IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED");
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4: LKG slot is Session-scoped — never reused across Runtime Sessions", async () => {
  const { runtime, store, dir, entriesRef } = makeRuntime();
  try {
    runtime.prepareInvocationSources({
      inputId: "in-1",
      runtimeSessionId: SESSION,
      epochId: SESSION,
    });
    entriesRef.entries = [
      userEntry("u-1", null, wire("hello")),
      customCompanion("c-1", "u-1", "in-1"),
      assistantEntry("a-1", "c-1", "hi back"),
    ];
    await baseTransform(runtime);
    assert.ok(store.getLkgSlot(SESSION, LKG_SLOT_KEY));
    // A DIFFERENT Runtime Session has NO LKG slot (rollover = fresh lineage).
    const other = store.getLkgSlot("iris-runtime-2026-08-02-1", LKG_SLOT_KEY);
    assert.equal(other, undefined, "LKG never crosses Runtime Session boundaries");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
