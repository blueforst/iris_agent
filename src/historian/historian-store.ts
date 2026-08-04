import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "../db/migrate.js";
import type { HistorianBoundarySnapshot, HistorianSessionState } from "../contracts/historian.js";
import type {
  AttributionManifest,
  EvidenceSet,
  HistoricalCompartment,
  HistorianSegment,
} from "./historian-compartment.js";

/**
 * R3 HistorianStore — the Historian's OWN durable store (historian.db,
 * issue #8 Phase B Feature B1).
 *
 * Boundaries honored here:
 *  - the Historian NEVER reads the Context repository (m0/m1/LKG) and NEVER
 *    writes the Pi Session;
 *  - every durable write the Historian performs is committed in ONE
 *    transaction together with the publication + outbox row (B5);
 *  - migrations are forward-only, checksum-verified, idempotent, and a
 *    NEWER schema (an applied version absent from the migration dir) fails
 *    closed at open.
 *
 * The store exposes the DTO layer only; the semantic pipeline (trigger →
 * freeze → read → validate → commit) lives in the historian runtime modules
 * (B2-B7).
 */

export interface HistorianStoreOptions {
  /** historian.db path. */
  databasePath: string;
  /** Migrations directory (defaults to src/db/migrations/historian). */
  migrationsDir?: string;
  nowMs?: () => number;
}

const SESSION_STATE_SQL = {
  select:
    "SELECT runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at FROM session_state WHERE runtime_session_id = ?",
  upsert:
    "INSERT INTO session_state (runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(runtime_session_id) DO UPDATE SET " +
    "processed_through_entry_seq = excluded.processed_through_entry_seq, " +
    "status = excluded.status, " +
    "observed_head_entry_seq = excluded.observed_head_entry_seq, " +
    "updated_at = excluded.updated_at",
};

const BOUNDARY_SQL = {
  insert:
    "INSERT INTO boundary_snapshots " +
    "(boundary_snapshot_id, runtime_session_id, observed_head_entry_seq, eligible_through_entry_seq, " +
    "protected_tail_start_entry_seq, true_raw_eligible_tokens, narratable_eligible_tokens, " +
    "source_range_hash, model_provider_profile, frozen_at, consumed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) " +
    "ON CONFLICT(runtime_session_id, observed_head_entry_seq) DO UPDATE SET " +
    "eligible_through_entry_seq = excluded.eligible_through_entry_seq, " +
    "protected_tail_start_entry_seq = excluded.protected_tail_start_entry_seq, " +
    "true_raw_eligible_tokens = excluded.true_raw_eligible_tokens, " +
    "narratable_eligible_tokens = excluded.narratable_eligible_tokens, " +
    "source_range_hash = excluded.source_range_hash, " +
    "model_provider_profile = excluded.model_provider_profile, " +
    "frozen_at = excluded.frozen_at",
  selectBySession:
    "SELECT boundary_snapshot_id, runtime_session_id, observed_head_entry_seq, eligible_through_entry_seq, " +
    "protected_tail_start_entry_seq, true_raw_eligible_tokens, narratable_eligible_tokens, " +
    "source_range_hash, model_provider_profile, frozen_at, consumed_at " +
    "FROM boundary_snapshots WHERE runtime_session_id = ? ORDER BY observed_head_entry_seq DESC LIMIT ?",
};

export class HistorianStore {
  private readonly db: DatabaseSync;
  private readonly nowMs: () => number;
  private closed = false;

  private constructor(db: DatabaseSync, nowMs: () => number) {
    this.db = db;
    this.nowMs = nowMs;
  }

  /** Open (or create) historian.db, verifying the schema before use. */
  static open(options: HistorianStoreOptions): HistorianStore {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    // Migration runner: empty data root -> creates; upgrade -> applies only
    // missing forward-only versions; repeated -> idempotent; a changed
    // applied file or a NEWER schema -> throws (fail closed).
    migrateDatabase(options.databasePath, options.migrationsDir ?? historianMigrationsDir());
    const db = new DatabaseSync(options.databasePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return new HistorianStore(db, options.nowMs ?? (() => Date.now()));
  }

  /** Reopen an existing DB (startup recovery). */
  static reopen(
    databasePath: string,
    migrationsDir?: string,
    nowMs?: () => number,
  ): HistorianStore {
    return HistorianStore.open({
      databasePath,
      ...(migrationsDir === undefined ? {} : { migrationsDir }),
      ...(nowMs === undefined ? {} : { nowMs }),
    });
  }

  getSessionState(runtimeSessionId: string): HistorianSessionState | undefined {
    const row = this.db.prepare(SESSION_STATE_SQL.select).get(runtimeSessionId) as
      | {
          runtime_session_id: string;
          processed_through_entry_seq: number;
          status: string;
          observed_head_entry_seq: number | null;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      runtimeSessionId: row.runtime_session_id,
      processedThroughEntrySeq: row.processed_through_entry_seq,
      status: row.status as HistorianSessionState["status"],
      ...(row.observed_head_entry_seq === null
        ? {}
        : { observedHeadEntrySeq: row.observed_head_entry_seq }),
      updatedAt: row.updated_at,
    };
  }

  upsertSessionState(state: HistorianSessionState): void {
    this.db
      .prepare(SESSION_STATE_SQL.upsert)
      .run(
        state.runtimeSessionId,
        state.processedThroughEntrySeq,
        state.status,
        state.observedHeadEntrySeq ?? null,
        state.updatedAt,
      );
  }

  saveBoundarySnapshot(snapshot: HistorianBoundarySnapshot): void {
    this.db
      .prepare(BOUNDARY_SQL.insert)
      .run(
        snapshot.boundarySnapshotId,
        snapshot.runtimeSessionId,
        snapshot.observedHeadEntrySeq,
        snapshot.eligibleThroughEntrySeq,
        snapshot.protectedTailStartEntrySeq,
        snapshot.trueRawEligibleTokens,
        snapshot.narratableEligibleTokens,
        snapshot.sourceRangeHash,
        snapshot.modelProviderProfile,
        snapshot.frozenAt,
      );
  }

  /** Latest boundary snapshots for a session (newest first). */
  listBoundarySnapshots(runtimeSessionId: string, limit = 1): HistorianBoundarySnapshot[] {
    const rows = this.db
      .prepare(BOUNDARY_SQL.selectBySession)
      .all(runtimeSessionId, limit) as Array<{
      boundary_snapshot_id: string;
      runtime_session_id: string;
      observed_head_entry_seq: number;
      eligible_through_entry_seq: number;
      protected_tail_start_entry_seq: number;
      true_raw_eligible_tokens: number;
      narratable_eligible_tokens: number;
      source_range_hash: string;
      model_provider_profile: string;
      frozen_at: string;
      consumed_at: string | null;
    }>;
    return rows.map((row) => ({
      boundarySnapshotId: row.boundary_snapshot_id,
      runtimeSessionId: row.runtime_session_id,
      observedHeadEntrySeq: row.observed_head_entry_seq,
      eligibleThroughEntrySeq: row.eligible_through_entry_seq,
      protectedTailStartEntrySeq: row.protected_tail_start_entry_seq,
      trueRawEligibleTokens: row.true_raw_eligible_tokens,
      narratableEligibleTokens: row.narratable_eligible_tokens,
      sourceRangeHash: row.source_range_hash,
      modelProviderProfile: row.model_provider_profile,
      frozenAt: row.frozen_at,
    }));
  }

  /** BEGIN a write transaction; the caller commits or rolls back. */
  begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
  }

  /** Insert an immutable compartment (B4; must run inside a transaction). */
  insertCompartment(compartment: HistoricalCompartment): void {
    this.db
      .prepare(
        "INSERT INTO compartments (compartment_id, runtime_session_id, compartment_sequence, " +
          "start_entry_seq, end_entry_seq, source_range_hash, content, p1, p2, p3, p4, " +
          "importance, episode_type, attribution_manifest_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        compartment.compartmentId,
        compartment.runtimeSessionId,
        compartment.compartmentSequence,
        compartment.startEntrySeq,
        compartment.endEntrySeq,
        compartment.sourceRangeHash,
        compartment.content,
        compartment.p1 ?? "",
        compartment.p2 ?? "",
        compartment.p3 ?? "",
        compartment.p4 ?? "",
        compartment.importance,
        compartment.episodeType,
        compartment.attributionManifestId,
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** Insert immutable segments (B4; must run inside a transaction). */
  insertSegments(segments: HistorianSegment[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO segments (segment_id, compartment_id, runtime_session_id, " +
        "start_entry_seq, end_entry_seq, source_range_hash, content, attribution_manifest_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date(this.nowMs()).toISOString();
    for (const segment of segments) {
      stmt.run(
        segment.segmentId,
        segment.compartmentId,
        segment.runtimeSessionId,
        segment.startEntrySeq,
        segment.endEntrySeq,
        segment.sourceRangeHash,
        segment.content,
        segment.attributionManifestId,
        now,
      );
    }
  }

  /** Insert an immutable evidence set (B4; never a summary/recall). */
  insertEvidenceSet(evidence: EvidenceSet): void {
    this.db
      .prepare(
        "INSERT INTO evidence_sets (evidence_set_id, runtime_session_id, compartment_id, " +
          "start_entry_seq, end_entry_seq, source_range_hash, entries_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        evidence.evidenceSetId,
        evidence.runtimeSessionId,
        evidence.compartmentId,
        evidence.startEntrySeq,
        evidence.endEntrySeq,
        evidence.sourceRangeHash,
        JSON.stringify(evidence.entries),
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** Insert an attribution manifest (B4; roles kept distinct). */
  insertAttributionManifest(manifest: AttributionManifest): void {
    this.db
      .prepare(
        "INSERT INTO attribution_manifests (attribution_manifest_id, runtime_session_id, " +
          "compartment_id, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        manifest.attributionManifestId,
        manifest.runtimeSessionId,
        manifest.compartmentId,
        JSON.stringify(manifest.attributions),
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** Highest committed compartment sequence for a session (B4 session-local
   * sequence continuity). */
  maxCompartmentSequence(runtimeSessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(compartment_sequence) AS max_seq FROM compartments WHERE runtime_session_id = ?",
      )
      .get(runtimeSessionId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  now(): number {
    return this.nowMs();
  }

  /** Raw DatabaseSync access for transactional composition (B5). */
  raw(): DatabaseSync {
    return this.db;
  }

  /** Convenience: hash of a JSON-serialized payload (deterministic). */
  static hash(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}

/** Absolute migrations dir for historian.db (works from dist + src). */
function historianMigrationsDir(): string {
  // dev: src/db/migrations/historian; dist: dist/db/migrations/historian
  // (scripts/copy-migrations.mjs copies the dir into dist).
  return fileURLToPath(new URL("../db/migrations/historian", import.meta.url));
}
