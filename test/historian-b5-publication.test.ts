import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { HistorianRunner } from "../src/historian/historian-runner.js";
import {
  createPublicationCommitHook,
  PublicationService,
} from "../src/historian/historian-publication.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";

/**
 * Feature B5 — Publication + authoritative outbox atomic transaction.
 */

const SESSION = "iris-runtime-2026-08-01-1";

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
      content: [{ type: "toolCall", id: callId, name: "read_file", arguments: {} }],
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
      toolName: "read_file",
      content: [{ type: "text", text: "file content: 42 lines" }],
      isError: false,
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function storeFixture(): { store: HistorianStore; dir: string; service: PublicationService } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const service = new PublicationService({ store });
  return { store, dir, service };
}

async function runOneCycle(
  store: HistorianStore,
  entries: SessionTreeEntry[],
  processedThroughEntrySeq = 0,
) {
  const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
  const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
  const freeze = freezeBoundary({
    runtimeSessionId: SESSION,
    entries: page.entries,
    processedThroughEntrySeq,
    tailMarginEntries: 0,
    modelProviderProfile: "opencode/deepseek-v4-flash",
    frozenAt: "2026-08-01T00:00:00.000Z",
  });
  const runner = new HistorianRunner({
    store,
    readPort: port,
    commitHook: createPublicationCommitHook({ store }),
  });
  return runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
}

test("B5: one atomic transaction commits compartments + publication + outbox + cursor", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "please read the file"),
      c("c-1", "u-1"),
      assistantWithToolCall("a-1", "c-1", "call-1"),
      toolResult("tr-1", "a-1", "call-1"),
    ];
    const result = await runOneCycle(store, entries);
    assert.equal(result.status, "committed");

    // Compartment persisted.
    const compartment = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM compartments WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(compartment.n, 1, "one compartment committed");
    // Publication persisted with sequence = 1 (MAX+1, never pre-allocated).
    const pub = store
      .raw()
      .prepare(
        "SELECT publication_sequence, publication_id, processing_key, output_hash, state FROM publications WHERE runtime_session_id = ?",
      )
      .get(SESSION) as {
      publication_sequence: number;
      publication_id: string;
      processing_key: string;
      output_hash: string;
      state: string;
    };
    assert.equal(pub.publication_sequence, 1);
    assert.ok(pub.publication_id.startsWith(`publication-${SESSION}-1`));
    assert.ok(pub.processing_key.includes(`${SESSION}:`));
    assert.equal(pub.output_hash.length, 64);
    assert.equal(pub.state, "pending");
    // Outbox row in the SAME transaction.
    const outbox = store
      .raw()
      .prepare(
        "SELECT publication_id, payload_hash, state FROM publication_outbox WHERE publication_id = ?",
      )
      .get(pub.publication_id) as { publication_id: string; payload_hash: string; state: string };
    assert.equal(outbox.payload_hash, pub.output_hash, "outbox payload hash matches");
    assert.equal(outbox.state, "pending");
    // Cursor advanced to the same commit point.
    const state = store.getSessionState(SESSION);
    assert.equal(state?.processedThroughEntrySeq, result.commitThroughEntrySeq);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: publicationSequence is strictly increasing across publications (MAX+1 in-transaction)", async () => {
  const { store, dir } = storeFixture();
  try {
    const entries1: SessionTreeEntry[] = [u("u-1", null, "first"), c("c-1", "u-1")];
    const r1 = await runOneCycle(store, entries1);
    assert.equal(r1.status, "committed");
    const entries2: SessionTreeEntry[] = [
      u("u-1", null, "first"),
      c("c-1", "u-1"),
      u("u-2", "c-1", "second"),
      c("c-2", "u-2"),
    ];
    const r2 = await runOneCycle(store, entries2, r1.commitThroughEntrySeq);
    assert.equal(r2.status, "committed");
    const rows = store
      .raw()
      .prepare(
        "SELECT publication_sequence FROM publications WHERE runtime_session_id = ? ORDER BY publication_sequence",
      )
      .all(SESSION) as unknown as Array<{ publication_sequence: number }>;
    assert.deepEqual(
      rows.map((row) => row.publication_sequence),
      [1, 2],
      "strictly increasing, no pre-allocation gaps",
    );
    // The second publication chains to the first.
    const pub2 = store
      .raw()
      .prepare(
        "SELECT previous_publication_sequence, previous_session_processed_through_entry_seq FROM publications WHERE publication_sequence = 2",
      )
      .get() as {
      previous_publication_sequence: number | null;
      previous_session_processed_through_entry_seq: number;
    };
    assert.equal(pub2.previous_publication_sequence, 1, "previous publication chain");
    assert.equal(
      pub2.previous_session_processed_through_entry_seq,
      r1.commitThroughEntrySeq,
      "previous session cursor chain records the cursor BEFORE this commit",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: outbox state machine — claim → delivering → delivered (Router ACK)", async () => {
  const { store, dir, service } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const result = await runOneCycle(store, entries);
    assert.equal(result.status, "committed");
    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    const batch = service.claimBatch({ batchSize: 10 });
    assert.equal(batch.length, 1, "one row claimed");
    assert.equal(batch[0]?.publicationId, pubId);
    assert.equal(batch[0]?.state, "delivering", "claimed → delivering");
    assert.ok(batch[0]?.claimLeasedUntil, "lease set");

    // The delivering row is NOT re-claimed while the lease is active.
    const again = service.claimBatch({ batchSize: 10 });
    assert.equal(again.length, 0, "active lease suppresses re-claim");

    service.markDelivered({ publicationId: pubId, receiptHash: "receipt-1" });
    const outbox = store
      .raw()
      .prepare("SELECT state FROM publication_outbox WHERE publication_id = ?")
      .get(pubId) as { state: string };
    assert.equal(outbox.state, "delivered", "Router ACK → delivered");
    const pub = store
      .raw()
      .prepare("SELECT state, delivered_receipt_hash FROM publications WHERE publication_id = ?")
      .get(pubId) as { state: string; delivered_receipt_hash: string | null };
    assert.equal(pub.state, "delivered");
    assert.equal(
      pub.delivered_receipt_hash,
      "receipt-1",
      "ACK receipt persisted for the audit trail",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: expired claim lease is recovered (crashed claim re-claimed)", async () => {
  const { store, dir } = storeFixture();
  const shortLease = new PublicationService({ store, claimLeaseMs: 5 });
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    await runOneCycle(store, entries);
    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    // Claim with a very short lease.
    shortLease.claimBatch({ batchSize: 10 });
    // Immediately re-claim: the lease has NOT expired yet.
    assert.equal(shortLease.claimBatch({ batchSize: 10 }).length, 0, "unexpired lease blocks");
    // Wait for expiry.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The crashed claim is recovered.
    const recovered = shortLease.claimBatch({ batchSize: 10 });
    assert.equal(recovered.length, 1, "expired lease → re-claimed");
    assert.equal(recovered[0]?.publicationId, pubId);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: markFailed → retry_wait → quarantined after max attempts", async () => {
  const { store, dir, service } = storeFixture();
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    await runOneCycle(store, entries);
    const pubId = (
      store.raw().prepare("SELECT publication_id FROM publications LIMIT 1").get() as {
        publication_id: string;
      }
    ).publication_id;

    service.markFailed({ publicationId: pubId, errorCode: "router_unreachable" });
    let outbox = store
      .raw()
      .prepare("SELECT state, attempt_count FROM publication_outbox WHERE publication_id = ?")
      .get(pubId) as { state: string; attempt_count: number };
    assert.equal(outbox.state, "retry_wait");
    assert.equal(outbox.attempt_count, 1);
    // Exhaust attempts → quarantined.
    for (let index = 0; index < 8; index += 1) {
      service.markFailed({ publicationId: pubId, errorCode: "router_unreachable" });
    }
    outbox = store
      .raw()
      .prepare("SELECT state, attempt_count FROM publication_outbox WHERE publication_id = ?")
      .get(pubId) as { state: string; attempt_count: number };
    assert.equal(outbox.state, "quarantined", "max attempts → quarantined");
    // Quarantined rows are NOT re-claimed.
    assert.equal(service.claimBatch({ batchSize: 10 }).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: a publication with recall projections commits assessment deltas in the SAME transaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-assess-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const entries: SessionTreeEntry[] = [
      u("u-1", null, "the user confirms the deployment plan is correct"),
      c("c-1", "u-1"),
    ];
    const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 0,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    const runner = new HistorianRunner({
      store,
      readPort: port,
      commitHook: createPublicationCommitHook({
        store,
        recallProjections: [
          {
            invocationId: "inv-1",
            runtimeSessionId: SESSION,
            memoryRefs: ["memory-ref-deployment"],
          },
        ],
      }),
    });
    const result = await runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot });
    assert.equal(result.status, "committed");
    // The assessment delta was committed atomically with the publication.
    const deltas = store
      .raw()
      .prepare(
        "SELECT assessment_id, relation FROM memory_assessment_deltas WHERE runtime_session_id = ?",
      )
      .all(SESSION) as unknown as Array<{ assessment_id: string; relation: string }>;
    assert.ok(deltas.length >= 1, "assessment delta committed with the publication");
    assert.equal(deltas[0]?.relation, "supports");
    // The publication references the assessment delta ids.
    const pub = store
      .raw()
      .prepare("SELECT assessment_delta_ids_json FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { assessment_delta_ids_json: string };
    const ids = JSON.parse(pub.assessment_delta_ids_json) as string[];
    assert.deepEqual(
      ids,
      deltas.map((d) => d.assessment_id),
      "publication chains its assessment deltas",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: a publication commit-hook failure rolls back cursor + publication + outbox atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-fail-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const entries: SessionTreeEntry[] = [u("u-1", null, "hello"), c("c-1", "u-1")];
    const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
    const page = await port.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      runtimeSessionId: SESSION,
      entries: page.entries,
      processedThroughEntrySeq: 0,
      tailMarginEntries: 0,
      modelProviderProfile: "m",
      frozenAt: "x",
    });
    // A hook that throws AFTER partially inserting (simulating a failure
    // inside the publication path) — the transaction must roll back ALL of
    // it (cursor, compartments, publication, outbox).
    const failingHook = {
      commitSafePrefix: () => {
        throw new Error("model/parse failure (simulated)");
      },
    };
    const runner = new HistorianRunner({ store, readPort: port, commitHook: failingHook });
    await assert.rejects(
      () => runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot }),
      /model\/parse failure/,
    );
    assert.equal(store.getSessionState(SESSION), undefined, "cursor rolled back");
    const compartmentCount = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM compartments WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(compartmentCount.n, 0, "no compartments on failure");
    const pubCount = store.raw().prepare("SELECT COUNT(*) AS n FROM publications").get() as {
      n: number;
    };
    assert.equal(pubCount.n, 0, "no publication on failure");
    const outboxCount = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publication_outbox")
      .get() as { n: number };
    assert.equal(outboxCount.n, 0, "no outbox row on failure");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
