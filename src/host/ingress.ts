import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentConfigV3 } from "../config/schema.js";
import type { ExternalizedPayloadRef } from "../contracts/origin.js";
import { resolveDataRootPaths } from "./data-root.js";

/**
 * Durable input acceptance ledger (00 Module Boundaries / 03 Host Runtime:
 * Durable Input Acceptance; 03 Runtime Coordinator: Durable Ingress Handoff).
 *
 * The Host owns ingress.db — a narrow transport ledger for client retry
 * deduplication. It never stores assistant content, ToolResult, provider
 * response, runtime phase, settled or a durable invocation outcome.
 *
 * Identity is `instanceEpoch + inputId`:
 *  - same identity + same payload   -> existing acceptance result (duplicate)
 *  - same identity + different payload -> typed idempotency conflict
 *
 * `accepted` only means the bounded normalized AgentInput envelope is durably
 * stored (inline or via normalizedInputRef). `session_committed` is set only
 * after the matching Pi UserMessage + iris_input_meta companion pair is
 * durably present in the bound Runtime Session.
 */

export type IngressAcceptanceState = "accepted" | "session_committed" | "rejected";

export interface InputAcceptanceRecord {
  inputId: string;
  instanceEpoch: number;
  payloadHash: string;
  state: IngressAcceptanceState;
  normalizedInputRef?: ExternalizedPayloadRef;
  runtimeSessionId?: string;
  userEntryId?: string;
  rejectionCode?: string;
  acceptedAt: string;
  updatedAt: string;
}

export type IngressAcceptOutcome =
  | { outcome: "accepted"; record: InputAcceptanceRecord }
  | { outcome: "duplicate"; record: InputAcceptanceRecord }
  | { outcome: "idempotency_conflict"; record: InputAcceptanceRecord; receivedPayloadHash: string };

export class IngressQueueFullError extends Error {
  constructor(public readonly capacity: number) {
    super(`ingress queue full (max ${capacity})`);
    this.name = "IngressQueueFullError";
  }
}

export class IngressConflictError extends Error {
  constructor(
    public readonly inputId: string,
    public readonly instanceEpoch: number,
    public readonly expectedPayloadHash: string,
    public readonly receivedPayloadHash: string,
  ) {
    super(
      `idempotency conflict for ${instanceEpoch}/${inputId}: payload ${receivedPayloadHash} does not match accepted ${expectedPayloadHash}`,
    );
    this.name = "IngressConflictError";
  }
}

interface IngressRow {
  input_id: string;
  instance_epoch: number;
  payload_hash: string;
  acceptance_state: string;
  normalized_input_ref: string | null;
  pi_user_entry_id: string | null;
  runtime_session_id: string | null;
  rejection_code: string | null;
  accepted_at: string;
  session_committed_at: string | null;
  updated_at: string | null;
}

function rowToRecord(row: IngressRow): InputAcceptanceRecord {
  const record: InputAcceptanceRecord = {
    inputId: row.input_id,
    instanceEpoch: row.instance_epoch,
    payloadHash: row.payload_hash,
    state: row.acceptance_state as IngressAcceptanceState,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at ?? row.accepted_at,
  };
  if (row.normalized_input_ref !== null) {
    record.normalizedInputRef = JSON.parse(row.normalized_input_ref) as ExternalizedPayloadRef;
  }
  if (row.runtime_session_id !== null) {
    record.runtimeSessionId = row.runtime_session_id;
  }
  if (row.pi_user_entry_id !== null) {
    record.userEntryId = row.pi_user_entry_id;
  }
  if (row.rejection_code !== null) {
    record.rejectionCode = row.rejection_code;
  }
  return record;
}

/**
 * Deterministic canonical JSON: recursively sorts object keys so the same
 * logical envelope always hashes identically across retries/processes.
 * NOTE: must NOT use an array-replacer form of JSON.stringify — that filters
 * nested keys and would drop the block content from the hash.
 */
export function canonicalInputJson(input: unknown): string {
  return JSON.stringify(sortCanonical(input), null, 2);
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortCanonical(record[key]);
    }
    return sorted;
  }
  return value;
}

export function computePayloadHash(input: unknown): string {
  return createHash("sha256").update(canonicalInputJson(input)).digest("hex");
}

export class InputAcceptanceLedger {
  private readonly db: DatabaseSync;
  private readonly blobDir: string;
  private readonly queue: Array<{ inputId: string; instanceEpoch: number }> = [];
  /**
   * M1: inputs currently dequeued and being processed by the Host pump. A
   * client retry while the turn is in flight must NOT be re-enqueued — the
   * duplicate branch skips entries that are in-flight (they are already being
   * prompted) or queued.
   */
  private readonly inFlight = new Set<string>();
  private readonly maxQueued: number;

  constructor(
    databasePath: string,
    blobDir: string,
    maxQueued: number,
    private readonly instanceEpoch: number,
  ) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.blobDir = blobDir;
    mkdirSync(blobDir, { recursive: true });
    this.maxQueued = maxQueued;
  }

  /** Resolve the ledger for a data root using config (host-owned paths). */
  static open(
    dataRoot: string,
    config: AgentConfigV3,
    instanceEpoch: number,
  ): InputAcceptanceLedger {
    const paths = resolveDataRootPaths(dataRoot, config);
    return new InputAcceptanceLedger(
      paths.ingressDb,
      paths.blobsIngress,
      config.host.input_queue_max ?? 20,
      instanceEpoch,
    );
  }

  close(): void {
    this.db.close();
  }

  getMaxQueued(): number {
    return this.maxQueued;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Accept one normalized AgentInput envelope.
   *
   * Writes the accepted record + the durable normalized envelope BEFORE any
   * Pi append. `accepted` is the crash-window-1 boundary: if we crash before
   * this commit the client retry simply re-accepts (no record, no duplicate).
   */
  accept(input: unknown, inputId: string, instanceEpoch?: number): IngressAcceptOutcome {
    const epoch = instanceEpoch ?? this.instanceEpoch;
    const payloadHash = computePayloadHash(input);
    const existing = this.getRecord(inputId, epoch);
    if (existing !== undefined) {
      if (existing.payloadHash === payloadHash) {
        // Same identity + same payload: return the existing acceptance result.
        // Do NOT re-enqueue when the input is already queued OR currently
        // in-flight (M1: a retry during an active turn must not double-prompt).
        // session_committed inputs are bound to a Pi pair and never re-prompted.
        if (existing.state === "accepted" && !this.isActive(inputId, epoch)) {
          this.enqueueLocked({ inputId, instanceEpoch: epoch });
        }
        return { outcome: "duplicate", record: existing };
      }
      return {
        outcome: "idempotency_conflict",
        record: existing,
        receivedPayloadHash: payloadHash,
      };
    }

    const now = new Date().toISOString();
    // Check FIFO capacity BEFORE writing the DB row: an overflow must not
    // leave a durable accepted record that would turn a client retry into a
    // silent "duplicate" of an input that was never enqueued (queue overflow
    // returns a clear error, never a silent drop).
    if (this.queue.length >= this.maxQueued) {
      throw new IngressQueueFullError(this.maxQueued);
    }
    const ref = this.writeEnvelopeBlob(input, payloadHash);
    const refJson = JSON.stringify(ref);
    this.db
      .prepare(
        `INSERT INTO ingress_acceptances
         (input_id, instance_epoch, payload_hash, acceptance_state, normalized_input_ref,
          accepted_at, updated_at)
         VALUES (?, ?, ?, 'accepted', ?, ?, ?)`,
      )
      .run(inputId, epoch, payloadHash, refJson, now, now);
    const record = this.getRecord(inputId, epoch);
    if (record === undefined) {
      throw new Error(`accepted record missing after insert: ${epoch}/${inputId}`);
    }
    this.enqueueLocked({ inputId, instanceEpoch: epoch });
    return { outcome: "accepted", record };
  }

  /** FIFO dequeue for the Host input pump. Returns undefined when empty. */
  dequeue(): { inputId: string; instanceEpoch: number } | undefined {
    const entry = this.queue.shift();
    if (entry !== undefined) {
      this.inFlight.add(`${entry.instanceEpoch}/${entry.inputId}`);
    }
    return entry;
  }

  /**
   * Drop the in-flight marker for an input whose invocation failed WITHOUT
   * reaching session_committed. The input stays durably `accepted`; a client
   * retry (accept -> duplicate) or a restart recovery re-enters it through
   * the normal single-writer path. It is NOT auto-requeued — a poisoned input
   * must not loop forever (M2).
   */
  dropInFlight(inputId: string, instanceEpoch: number): void {
    this.inFlight.delete(`${instanceEpoch}/${inputId}`);
  }

  /** Mark an input done (committed/rejected): drop it from in-flight. */
  private markIdle(inputId: string, instanceEpoch: number): void {
    this.inFlight.delete(`${instanceEpoch}/${inputId}`);
  }

  /**
   * Load a normalized input envelope from its content-addressed blob. Used by
   * the Host pump to reconstruct the AgentInput before enqueuing to the
   * Coordinator. Returns undefined when the blob is missing (corrupt).
   */
  loadEnvelope(inputId: string, instanceEpoch: number): unknown {
    const record = this.getRecord(inputId, instanceEpoch);
    if (record?.normalizedInputRef === undefined) {
      return undefined;
    }
    const path = join(this.blobDir, record.normalizedInputRef.uri);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * Mark the accepted input as bound to a durable Pi UserMessage + companion
   * pair in a Runtime Session. After this transition the input is never
   * re-prompted, even if the client response was lost (crash window 5).
   */
  markSessionCommitted(
    inputId: string,
    instanceEpoch: number,
    runtimeSessionId: string,
    userEntryId: string,
  ): InputAcceptanceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE ingress_acceptances
         SET acceptance_state = 'session_committed', runtime_session_id = ?,
             pi_user_entry_id = ?, session_committed_at = ?, updated_at = ?
         WHERE input_id = ? AND instance_epoch = ?`,
      )
      .run(runtimeSessionId, userEntryId, now, now, inputId, instanceEpoch);
    // A committed input must never be re-delivered: remove it from the
    // in-memory FIFO + in-flight set so the Host pump cannot prompt it again.
    this.removeFromQueue(inputId, instanceEpoch);
    this.markIdle(inputId, instanceEpoch);
    return this.getRecord(inputId, instanceEpoch) ?? this.throwMissing(inputId, instanceEpoch);
  }

  /** Mark the input rejected with a typed code (validation/queue/persistence). */
  markRejected(
    inputId: string,
    instanceEpoch: number,
    rejectionCode: string,
  ): InputAcceptanceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE ingress_acceptances
         SET acceptance_state = 'rejected', rejection_code = ?, updated_at = ?
         WHERE input_id = ? AND instance_epoch = ?`,
      )
      .run(rejectionCode, now, inputId, instanceEpoch);
    this.removeFromQueue(inputId, instanceEpoch);
    this.markIdle(inputId, instanceEpoch);
    return this.getRecord(inputId, instanceEpoch) ?? this.throwMissing(inputId, instanceEpoch);
  }

  /**
   * Recovery (03 Host Runtime, Durable Input Acceptance): return every input
   * that is `accepted` but NOT `session_committed`. Each is re-entered through
   * the normal single-writer ingress path; a `session_committed` record is
   * never re-prompted. The returned entries are also re-enqueued so a crash
   * after recovery does not lose them.
   *
   * m1: recovery bypasses the strict accept capacity — a durable accepted
   * record must never fail to be restored because the new-accept slot budget
   * is smaller than the number of crash-leftover inputs.
   */
  recoverUncommitted(): Array<{ inputId: string; instanceEpoch: number }> {
    const rows = this.db
      .prepare(
        "SELECT * FROM ingress_acceptances WHERE acceptance_state = 'accepted' ORDER BY accepted_at ASC",
      )
      .all() as unknown as IngressRow[];
    const pending: Array<{ inputId: string; instanceEpoch: number }> = [];
    for (const row of rows) {
      const entry = { inputId: row.input_id, instanceEpoch: row.instance_epoch };
      if (!this.isActive(entry.inputId, entry.instanceEpoch)) {
        this.queue.push(entry);
      }
      pending.push(entry);
    }
    return pending;
  }

  getRecord(inputId: string, instanceEpoch: number): InputAcceptanceRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM ingress_acceptances WHERE input_id = ? AND instance_epoch = ?")
      .get(inputId, instanceEpoch) as IngressRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  private isQueued(inputId: string, instanceEpoch: number): boolean {
    return this.queue.some(
      (entry) => entry.inputId === inputId && entry.instanceEpoch === instanceEpoch,
    );
  }

  /** M1: true when the input is queued OR currently being processed. */
  private isActive(inputId: string, instanceEpoch: number): boolean {
    return (
      this.isQueued(inputId, instanceEpoch) || this.inFlight.has(`${instanceEpoch}/${inputId}`)
    );
  }

  private removeFromQueue(inputId: string, instanceEpoch: number): void {
    const index = this.queue.findIndex(
      (entry) => entry.inputId === inputId && entry.instanceEpoch === instanceEpoch,
    );
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private enqueueLocked(entry: { inputId: string; instanceEpoch: number }): void {
    if (this.queue.length >= this.maxQueued) {
      throw new IngressQueueFullError(this.maxQueued);
    }
    this.queue.push(entry);
  }

  /**
   * Test/diagnostic seam (A1 regression): rewind a session_committed record to
   * `accepted` to simulate the crash-after-Pi-pair-before-settled window, so a
   * restart test can prove reconciliation promotes it without re-prompting.
   */
  rewindToAccepted(inputId: string, instanceEpoch: number): void {
    this.db
      .prepare(
        `UPDATE ingress_acceptances
         SET acceptance_state = 'accepted', runtime_session_id = NULL,
             pi_user_entry_id = NULL, session_committed_at = NULL, updated_at = ?
         WHERE input_id = ? AND instance_epoch = ?`,
      )
      .run(new Date().toISOString(), inputId, instanceEpoch);
  }

  private writeEnvelopeBlob(input: unknown, payloadHash: string): ExternalizedPayloadRef {
    const fileName = `${payloadHash}.json`;
    const targetPath = join(this.blobDir, fileName);
    const tmpPath = `${targetPath}.tmp`;
    const bytes = Buffer.from(canonicalInputJson(input), "utf8");
    // fsync + atomic rename so the blob is durable before the DB row commits.
    writeFileSync(tmpPath, bytes);
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
    return {
      schemaVersion: 1,
      kind: "iris.ingress.envelope.v1",
      hash: payloadHash,
      byteLength: bytes.byteLength,
      uri: fileName,
    };
  }

  private throwMissing(inputId: string, instanceEpoch: number): never {
    throw new Error(`ingress record missing: ${instanceEpoch}/${inputId}`);
  }
}
