import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextStore } from "../src/context/context-store.js";

function makeStore(): { store: ContextStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-context-store-"));
  const path = join(dir, "context.db");
  return { store: ContextStore.open(path), path };
}

function makeLineageInput(runtimeSessionId = "iris-runtime-2026-08-01-1") {
  return {
    runtimeSessionId,
    contextSourceSnapshotId: `src-${runtimeSessionId}`,
    epochId: "iris-runtime-2026-08-01-1",
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "system prompt bytes",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-golden-v1",
    carrierSchemaVersion: "1",
  };
}

test("context-store: empty DB initializes cleanly and lineage can be created", () => {
  const { store, path } = makeStore();
  try {
    const lineage = store.createLineage(makeLineageInput());
    assert.equal(lineage.runtimeSessionId, "iris-runtime-2026-08-01-1");
    assert.equal(lineage.emergencyState, "ok");
    assert.equal(lineage.representedThroughEntrySeq, 0);
    // Re-open proves durability.
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const loaded = reopened.getLineage("iris-runtime-2026-08-01-1");
      assert.equal(loaded?.materializationId, "mat-1");
      assert.equal(loaded?.m0Body, null, "never materialized");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: repeated open is idempotent (no double migration)", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.close();
    // Second open must not fail and must not re-apply migrations.
    const again = ContextStore.open(path);
    try {
      const lineage = again.getLineage("iris-runtime-2026-08-01-1");
      assert.ok(lineage);
      const db = new DatabaseSync(path);
      try {
        const count = (
          db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
        ).c;
        assert.equal(
          count,
          2,
          "both migrations applied exactly once (0001 bootstrap + 0002 watermark)",
        );
      } finally {
        db.close();
      }
    } finally {
      again.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: HARD materializeM0 commits m0+m1 atomically and persists", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "<session-history></session-history>",
      m1Body:
        "<session-history-since>(no new content since last materialization)</session-history-since>",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys-v1",
      cachedM0ModelKey: "mock/model-v1",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 42,
      protectedTailStartEntrySeq: 30,
      lastSafeUserAnchorEntrySeq: 28,
      atMs: 1_785_000_000_000,
    });
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const lineage = reopened.getLineage("iris-runtime-2026-08-01-1");
      assert.equal(lineage?.m0Body, "<session-history></session-history>");
      assert.equal(lineage?.m0MaterializedAt, 1_785_000_000_000);
      assert.equal(lineage?.representedThroughEntrySeq, 42);
      assert.equal(lineage?.protectedTailStartEntrySeq, 30);
      assert.equal(lineage?.cachedM0SystemHash, "sys-v1");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: SOFT materializeM1 updates m1 only, m0 untouched", () => {
  const { store } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "m0-baseline",
      m1Body: "m1-v1",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys-v1",
      cachedM0ModelKey: "mock/model-v1",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 42,
      protectedTailStartEntrySeq: 30,
      lastSafeUserAnchorEntrySeq: 28,
      atMs: 1_000,
    });
    store.materializeM1({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m1Body: "m1-v2",
      m1ContentHash: "h2",
      representedThroughEntrySeq: 50,
      atMs: 2_000,
    });
    const lineage = store.getLineage("iris-runtime-2026-08-01-1");
    assert.equal(lineage?.m0Body, "m0-baseline", "m0 must be byte-identical");
    assert.equal(lineage?.m0ContentHash, "h0");
    assert.equal(lineage?.m1Body, "m1-v2");
    assert.equal(lineage?.m1ContentHash, "h2");
    assert.equal(lineage?.representedThroughEntrySeq, 50);
  } finally {
    store.close();
  }
});

test("context-store: materialization on a missing lineage fails closed (no partial state)", () => {
  const { store } = makeStore();
  try {
    assert.throws(() => {
      store.materializeM0({
        runtimeSessionId: "no-such-session",
        m0Body: "x",
        m1Body: "y",
        m0ContentHash: "h0",
        m1ContentHash: "h1",
        cachedM0SystemHash: "sys",
        cachedM0ModelKey: "model",
        cachedM0ProviderProfileId: "mock",
        representedThroughEntrySeq: 1,
        protectedTailStartEntrySeq: 1,
        lastSafeUserAnchorEntrySeq: 1,
        atMs: 1,
      });
    }, /fail closed/);
    assert.equal(store.getLineage("no-such-session"), undefined);
  } finally {
    store.close();
  }
});

test("context-store: deferred operations preserve ordering via monotonic cursor", () => {
  const { store } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.enqueueDeferredOperation("iris-runtime-2026-08-01-1", "drop", '{"id":"d1"}');
    store.enqueueDeferredOperation("iris-runtime-2026-08-01-1", "publish", '{"id":"p1"}');
    const ops = store.listDeferredOperations("iris-runtime-2026-08-01-1");
    assert.equal(ops.length, 2);
    assert.equal(ops[0]?.opKind, "drop");
    assert.equal(ops[1]?.opKind, "publish");
    assert.ok((ops[1]?.seq ?? 0) > (ops[0]?.seq ?? 0));
    // Cursor advances independently.
    store.setDeferredSignalCursor("iris-runtime-2026-08-01-1", 5);
    assert.equal(store.getLineage("iris-runtime-2026-08-01-1")?.deferredSignalCursor, 5);
  } finally {
    store.close();
  }
});

test("context-store: LKG slots upsert and reload", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.captureLkgSlot({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      slotKey: "prefix",
      lkgJson: '{"jsonPrefix":"[]"}',
      capturedAt: "2026-08-01T12:00:00.000Z",
    });
    store.captureLkgSlot({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      slotKey: "prefix",
      lkgJson: '{"jsonPrefix":"[1]"}',
      capturedAt: "2026-08-01T12:00:01.000Z",
    });
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const slot = reopened.getLkgSlot("iris-runtime-2026-08-01-1", "prefix");
      assert.equal(slot?.lkgJson, '{"jsonPrefix":"[1]"}', "upsert overwrites");
      assert.equal(reopened.getLkgSlot("iris-runtime-2026-08-01-1", "other"), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: corrupt DB fails closed on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-context-corrupt-"));
  const path = join(dir, "context.db");
  writeFileSync(path, "this is not a sqlite database at all", "utf8");
  assert.throws(() => ContextStore.open(path), /error|Error|file|not a database/i);
});

test("context-store: newer schema version fails closed (fence)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-context-newer-"));
  const path = join(dir, "context.db");
  // First open applies the current schema.
  const store = ContextStore.open(path);
  store.close();
  // Simulate a NEWER binary having written a newer migration version.
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES ('9999_newer', ?, 'abc')",
    ).run(new Date().toISOString());
  } finally {
    db.close();
  }
  assert.throws(
    () => ContextStore.open(path),
    /newer than supported|fail closed/i,
    "a DB written by a newer binary must refuse to open",
  );
});

test("context-store: emergency state persists and fails closed on read", () => {
  const { store, path } = makeStore();
  try {
    store.createLineage(makeLineageInput());
    store.setEmergencyState(
      "iris-runtime-2026-08-01-1",
      "emergency_fail_closed",
      "transform exploded",
    );
    store.close();
    const reopened = ContextStore.open(path);
    try {
      const lineage = reopened.getLineage("iris-runtime-2026-08-01-1");
      assert.equal(lineage?.emergencyState, "emergency_fail_closed");
      assert.equal(lineage?.lastTransformError, "transform exploded");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test("context-store: separate runtime sessions keep fully isolated lineages (rollover)", () => {
  const { store } = makeStore();
  try {
    const sessionA = "iris-runtime-2026-08-01-1";
    const sessionB = "iris-runtime-2026-08-02-1";
    store.createLineage(makeLineageInput(sessionA));
    store.createLineage(makeLineageInput(sessionB));
    store.materializeM0({
      runtimeSessionId: sessionA,
      m0Body: "A-m0",
      m1Body: "A-m1",
      m0ContentHash: "a0",
      m1ContentHash: "a1",
      cachedM0SystemHash: "sys-A",
      cachedM0ModelKey: "model-A",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 10,
      protectedTailStartEntrySeq: 5,
      lastSafeUserAnchorEntrySeq: 3,
      atMs: 1_000,
    });
    // B's lineage must NOT inherit A's m0/LKG/mutations (fresh lineage).
    const b = store.getLineage(sessionB);
    assert.equal(b?.m0Body, null, "rollover must NOT inherit old m0");
    assert.equal(b?.representedThroughEntrySeq, 0);
    assert.equal(store.getLkgSlot(sessionB, "prefix"), undefined);
  } finally {
    store.close();
  }
});

test("context-store: SIGKILL crash leaves a reopenable, consistent DB", async () => {
  // Spawn a child that creates a lineage + materializes m0, signals via a
  // marker file, then parks. Parent SIGKILLs it mid-flight; reopening must
  // succeed with a consistent state (never a partially advanced m0).
  const dir = mkdtempSync(join(tmpdir(), "iris-context-sigkill-"));
  const path = join(dir, "context.db");
  const marker = join(dir, "ready.marker");
  const scriptPath = join(dir, "crash-child.mjs");
  // Resolve the ContextStore module to an absolute file:// URL the child can
  // import regardless of its own working directory.
  const storeModuleUrl = new URL("../src/context/context-store.ts", import.meta.url).href;
  const script = `
    import { writeFileSync } from "node:fs";
    import { ContextStore } from ${JSON.stringify(storeModuleUrl)};
    const store = ContextStore.open(process.argv[2]);
    store.createLineage({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      contextSourceSnapshotId: "src-1",
      epochId: "e1",
      personaSnapshotId: "p1",
      declarationVersion: "v1",
      providerProfileId: "mock",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "sh",
      preparedAt: "2026-08-01T12:00:00.000Z",
      materializationId: "mat-1",
      contextSerializerVersion: "iris-context-golden-v1",
      carrierSchemaVersion: "1",
    });
    store.materializeM0({
      runtimeSessionId: "iris-runtime-2026-08-01-1",
      m0Body: "m0-after-crash",
      m1Body: "m1-after-crash",
      m0ContentHash: "h0",
      m1ContentHash: "h1",
      cachedM0SystemHash: "sys",
      cachedM0ModelKey: "model",
      cachedM0ProviderProfileId: "mock",
      representedThroughEntrySeq: 7,
      protectedTailStartEntrySeq: 4,
      lastSafeUserAnchorEntrySeq: 2,
      atMs: Date.now(),
    });
    writeFileSync(process.argv[3], "ready");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  `;
  writeFileSync(scriptPath, script, "utf8");

  const { spawn } = await import("node:child_process");
  // The child is TS source (imports end in .js but resolve via tsx).
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), scriptPath, path, marker],
    { stdio: "ignore" },
  );
  try {
    // Wait for the marker: the child has fully committed its writes.
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      const { existsSync } = await import("node:fs");
      if (existsSync(marker)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, "child must reach the ready marker before the kill");
    // SIGKILL — no graceful shutdown, no checkpoint.
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reopen: consistent (m0 either fully present or fully absent, never
    // partial), and the ledger is readable.
    const reopened = ContextStore.open(path);
    try {
      const lineage = reopened.getLineage("iris-runtime-2026-08-01-1");
      assert.ok(lineage, "lineage must be readable after SIGKILL");
      assert.ok(
        lineage.m0Body === null || lineage.m0Body === "m0-after-crash",
        "m0 must be either fully committed or fully absent, never partial",
      );
      if (lineage.m0Body !== null) {
        assert.equal(lineage.m1Body, "m1-after-crash");
        assert.equal(lineage.representedThroughEntrySeq, 7);
      }
    } finally {
      reopened.close();
    }
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
test("context-store: 0001 → 0002 upgrade path adds the compartment watermark without data loss", () => {
  // Simulate a DB that was migrated at 0001 only (an R2-era store), then
  // upgraded: opening with the current LATEST_MIGRATION_VERSION must apply
  // 0002 and preserve the existing lineage rows (forward-only, additive).
  const dir = mkdtempSync(join(tmpdir(), "iris-context-upgrade-"));
  const path = join(dir, "context.db");
  const storeV1 = new DatabaseSync(path);
  try {
    storeV1.exec("PRAGMA journal_mode = WAL");
    storeV1.exec("PRAGMA foreign_keys = ON");
    storeV1.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL DEFAULT '')",
    );
    // Apply ONLY the 0001 bootstrap SQL (parse the file and execute).
    const sql = readFileSync(
      join(process.cwd(), "src", "db", "migrations", "context", "0001_bootstrap.sql"),
      "utf8",
    );
    storeV1.exec(sql);
    storeV1
      .prepare("INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (?, ?, ?)")
      .run(
        "0001_bootstrap",
        new Date().toISOString(),
        createHash("sha256").update(sql, "utf8").digest("hex"),
      );
    // Seed a legacy lineage row exactly as 0001 defined it.
    storeV1
      .prepare(
        `INSERT INTO context_lineages (
          runtime_session_id, context_source_snapshot_id, epoch_id, persona_snapshot_id,
          declaration_version, continuity_seed_id, runtime_recovery_notice_id,
          stable_memory_pool_version, provider_profile_id, canonical_system_prompt,
          system_projection_hash, prepared_at, materialization_id,
          context_serializer_version, carrier_schema_version,
          m0_body, m1_body, m0_content_hash, m1_content_hash,
          m0_materialized_at, m1_updated_at,
          cached_m0_system_hash, cached_m0_model_key, cached_m0_provider_profile_id,
          last_response_time, represented_through_entry_seq,
          protected_tail_start_entry_seq, last_safe_user_anchor_entry_seq,
          cleared_reasoning_through_tag, tool_reclaim_watermark,
          mutation_replay_watermark, deferred_signal_cursor,
          emergency_state, last_transform_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "iris-runtime-legacy-1",
        "src-1",
        "e1",
        "p1",
        "v1",
        null,
        null,
        null,
        "mock",
        "sys",
        "sh",
        "2026-08-01T12:00:00.000Z",
        "mat-1",
        "v1",
        "1",
        "<session-history>baseline</session-history>",
        "<session-history-since>(no new content since last materialization)</session-history-since>",
        "h0",
        "h1",
        1000,
        1000,
        "sys-v1",
        "model-v1",
        "mock",
        1000,
        5,
        3,
        2,
        0,
        0,
        0,
        0,
        "ok",
        null,
        "2026-08-01T12:00:00.000Z",
        "2026-08-01T12:00:00.000Z",
      );
  } finally {
    storeV1.close();
  }

  // Upgrade: open with the current store — 0002 applies, data survives, and
  // the watermark defaults to 0 (the folded watermark of a legacy baseline).
  const upgraded = ContextStore.open(path);
  try {
    const lineage = upgraded.getLineage("iris-runtime-legacy-1");
    assert.ok(lineage, "legacy lineage survives the upgrade");
    assert.equal(lineage.m0CompartmentWatermark, 0, "legacy rows default to watermark 0");
    assert.equal(
      lineage.m0Body,
      "<session-history>baseline</session-history>",
      "legacy m0 bytes preserved",
    );
    assert.equal(lineage.representedThroughEntrySeq, 5, "legacy watermark preserved");
  } finally {
    upgraded.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
