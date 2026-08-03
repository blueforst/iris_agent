import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { ContextStore } from "../src/context/context-store.js";
import { createContextRuntime } from "../src/runtime/vertical-slice.js";
import { runMinimalSlice, sampleAgentInput } from "../src/runtime/vertical-slice.js";
import { resolveDataRootPaths } from "../src/host/data-root.js";
import { M1_EMPTY_PLACEHOLDER } from "../src/contracts/context.js";

/**
 * Feature A3 — real Harness Context hook wiring (issue #8).
 *
 * The Pi `context` hook must run the ContextStore-backed pipeline on EVERY
 * provider call: identity-preserving projection → runContextPass →
 * applyContextPass → renderProviderVisible → provider request. The legacy
 * mock transformer (mock-m0m1-v1) is never used on the product path, and the
 * provider must actually receive system + m0 + m1 + live tail.
 */

test("A3: product path runs the REAL Context pipeline on every provider call", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-a3-slice-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();
  try {
    const result = await runMinimalSlice({ dataRoot, config, input });
    // Every provider call went through the context hook (>=2: initial call +
    // post-tool follow-up).
    assert.ok(
      result.observers.contextPasses >= 2,
      `context hook ran ${result.observers.contextPasses} times (expected >=2)`,
    );
    assert.equal(result.observers.settled, true);
    // The durable lineage exists with real materialized m0 (HARD first pass
    // persisted) — NOT the legacy mock-m0m1-v1 identity.
    const paths = resolveDataRootPaths(dataRoot, config);
    const store = ContextStore.open(paths.contextDb);
    try {
      const lineage = store.getLineage(result.runtimeSessionId);
      assert.ok(lineage, "Context lineage exists after the product run");
      assert.ok(lineage.m0Body !== null, "m0 was materialized by the REAL pass");
      assert.ok(
        !lineage.materializationId.includes("mock-m0m1-v1"),
        "materialization identity is NOT the legacy mock",
      );
      assert.ok(
        lineage.m0Body.includes("<session-history>"),
        "m0 persisted in the authority wire shape",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("A3: provider receives system + m0 + m1 + live tail with NO companion/wire leakage", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-a3-provider-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();
  try {
    const result = await runMinimalSlice({ dataRoot, config, input });
    // Direct observation of the mock Provider's full received message list
    // (composeProvider onContext captures the converted-to-LLM messages).
    const snapshots = result.observers.providerContextSnapshots;
    assert.ok(snapshots.length >= 2, "provider saw at least 2 calls");
    const first = JSON.parse(snapshots[0] ?? "[]") as Array<{
      role: string;
      content?: unknown;
    }>;
    // The provider received the m0/m1 carriers converted to user role
    // (Pi native convertToLlm: custom → user) plus the live tail projection.
    const allText = first.map((m) => JSON.stringify(m.content ?? "")).join("\n");
    assert.ok(
      allText.includes("<session-history>"),
      "provider received the m0 carrier (stable prefix present)",
    );
    assert.ok(
      allText.includes(M1_EMPTY_PLACEHOLDER) || allText.includes("<session-history-since>"),
      "provider received the m1 carrier",
    );
    // No companion, no raw wire frame, no mock identity reaches the provider.
    assert.ok(!allText.includes("iris_input_meta"), "companion type must not reach the provider");
    assert.ok(
      !allText.includes("IRIS_INPUT_V1"),
      "raw IRIS wire frames must not reach the provider",
    );
    assert.ok(!allText.includes("mock-m0m1-v1"), "mock identity must not reach the provider");
    assert.ok(
      !allText.includes("<iris-input-meta/>"),
      "companion content must not reach the provider",
    );
    // The live tail's REAL semantics reach the provider: the projected user
    // payload (origin-labelled) is present — the model receives equivalent
    // conversation content, not empty markers.
    const userPayload = input.blocks
      .map((b) => (b.content.mode === "inline_text" ? b.content.text : ""))
      .join("");
    assert.ok(
      allText.includes(userPayload),
      `live tail must carry the real user payload semantics, got: ${allText.slice(0, 300)}`,
    );
    const allSnapshots = snapshots.map((s) => s).join("\n");
    assert.ok(
      allSnapshots.includes("mock assistant final") ||
        allSnapshots.includes("read-only result: iris"),
      "later provider calls carry assistant/tool-result semantics",
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("A3: ContextRuntime transform is pure + persists; companion is filtered before the wire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a3-runtime-"));
  const dataRoot = join(dir, "root");
  const config = defaultAgentConfig();
  const { runtime, store } = createContextRuntime({
    dataRoot,
    config,
    readEntries: async () => [],
    nowMs: () => 1_000,
  });
  try {
    const prepared = runtime.prepareInvocationSources({
      inputId: "in-1",
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      epochId: "epoch-1",
    });
    assert.ok(prepared.contextSourceSnapshotId.length > 0);
    assert.ok(
      !prepared.materializationIdentity.includes("mock-m0m1-v1"),
      "prepare never claims the legacy mock identity",
    );
    // A transform over an empty session is a valid HARD first pass.
    const result = await runtime.transformMessages({
      invocationId: "inv-1",
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      messages: [],
      model: { provider: "mock", modelId: "mock-deepseek-v4-flash" },
      providerProfileId: "mock-iris-provider-v1",
    });
    // The provider-visible view: m0 + m1 carriers (no companion — there is
    // no input to leak).
    assert.ok(result.messages.length >= 2, "m0 + m1 carriers present");
    const content = result.messages
      .map((m) =>
        typeof (m as { content?: unknown }).content === "string"
          ? (m as { content: string }).content
          : "",
      )
      .join("\n");
    assert.ok(content.includes("<session-history>"), "m0 stable prefix rendered");
    assert.ok(content.includes(M1_EMPTY_PLACEHOLDER), "m1 placeholder rendered");
    // Persisted durably.
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    assert.ok(lineage);
    assert.ok(lineage.m0Body !== null);
    await runtime.releaseInvocation("inv-1"); // no-op, must not throw
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A3: fail-closed transform throws typed ContextFailClosedError before provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-a3-failclosed-"));
  const dataRoot = join(dir, "root");
  const config = defaultAgentConfig();
  const { runtime, store } = createContextRuntime({
    dataRoot,
    config,
    readEntries: async () => [],
    nowMs: () => 1_000,
  });
  try {
    // No prepare → no lineage → the pass cannot materialize; the runtime
    // must fail closed with the typed error rather than fabricate a wire.
    await assert.rejects(
      () =>
        runtime.transformMessages({
          invocationId: "inv-1",
          runtimeSessionId: "no-lineage-session",
          messages: [],
          model: { provider: "mock", modelId: "mock-deepseek-v4-flash" },
          providerProfileId: "mock-iris-provider-v1",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message === "IRIS_CONTEXT_TRANSFORM_UNAVAILABLE" ||
            error.message === "IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED",
          `typed fail-closed error, got: ${error.message}`,
        );
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A3: context.db exists in the data root after a product run (owned by Host lifecycle)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-a3-db-"));
  const config = defaultAgentConfig();
  try {
    const result = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput() });
    assert.ok(result.observers.settled);
    const paths = resolveDataRootPaths(dataRoot, config);
    assert.ok(existsSync(paths.contextDb), "context.db created in the data root");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
