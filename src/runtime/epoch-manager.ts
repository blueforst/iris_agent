import { DatabaseSync } from "node:sqlite";

import type { RuntimeSessionEpoch } from "../contracts/runtime.js";

function localDate(timeZone: string, now: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(now));
}

export class RuntimeEpochStore {
  private readonly db: DatabaseSync;
  private rolloverPendingReason: string | null = null;

  constructor(
    databasePath: string,
    private readonly sessionPrefix: string,
    private readonly timeZone: string,
  ) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  getActive(): RuntimeSessionEpoch | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runtime_epochs WHERE status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as RuntimeSessionEpochRow | undefined;
    return row === undefined ? null : rowToEpoch(row);
  }

  /**
   * Corrupt-state detection: count rows that are durably 'active'. Exactly
   * one is required; more than one means the registry is locally corrupt and
   * must NOT silently pick one (03 Host Runtime, Recovery).
   */
  countActive(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_epochs WHERE status = 'active'")
      .get() as { count: number };
    return row.count;
  }

  ensureActive(now: string): RuntimeSessionEpoch {
    const existing = this.getActive();
    if (existing !== null) {
      return existing;
    }
    const date = localDate(this.timeZone, now);
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_epochs WHERE local_date = ?")
      .get(date) as { count: number };
    const ordinal = row.count + 1;
    const epochId = `${this.sessionPrefix}-${date}-${ordinal}`;
    const runtimeSessionId = `${this.sessionPrefix}-${date}-${ordinal}`;
    this.db
      .prepare(
        `INSERT INTO runtime_epochs(epoch_id, runtime_session_id, local_date, ordinal_within_date, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(epochId, runtimeSessionId, date, ordinal, new Date(now).toISOString());
    const created = this.getActive();
    if (created === null) {
      throw new Error("failed to create active runtime epoch");
    }
    return created;
  }

  markClosed(epochId: string, status: "closed" | "closed_incomplete", closedAt: string): void {
    this.db
      .prepare("UPDATE runtime_epochs SET status = ?, closed_at = ? WHERE epoch_id = ?")
      .run(status, closedAt, epochId);
  }

  /**
   * Record a rollover request. The switch itself must wait for Pi settled
   * (spec: 02 Runtime Sessions & History Archive, Rollover Boundary); this
   * only marks intent so `rolloverAfterSettled()` knows to act.
   */
  requestRollover(reason: string): void {
    this.rolloverPendingReason = reason;
  }

  isRolloverPending(): boolean {
    return this.rolloverPendingReason !== null;
  }

  /**
   * Begin a settled-only rollover (spec 02, Rollover Boundary). Creates a
   * new Epoch row in 'creating' state and returns it WITHOUT touching the
   * still-active epoch — a crash here is recoverable: the 'creating' row is
   * garbage or re-created by the caller after restart. The actual switch
   * (old -> closed, new -> active, previous_epoch_id link) is a single
   * transaction in `activateRollover()`, so no intermediate zero-active or
   * double-active state is ever durable.
   */
  beginRollover(now: string): RuntimeSessionEpoch {
    const active = this.getActive();
    if (active === null) {
      throw new Error("cannot rollover without an active epoch");
    }
    // Single pending 'creating' row at a time: a second beginRollover while
    // one is outstanding would orphan the previous row (review blocker #3).
    const existingCreating = this.db
      .prepare("SELECT epoch_id FROM runtime_epochs WHERE status = 'creating'")
      .get() as { epoch_id: string } | undefined;
    if (existingCreating !== undefined) {
      throw new Error(`rollover already in progress (creating epoch ${existingCreating.epoch_id})`);
    }
    const date = localDate(this.timeZone, now);
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_epochs WHERE local_date = ?")
      .get(date) as { count: number };
    const ordinal = row.count + 1;
    const epochId = `${this.sessionPrefix}-${date}-${ordinal}`;
    const runtimeSessionId = `${this.sessionPrefix}-${date}-${ordinal}`;
    this.db
      .prepare(
        `INSERT INTO runtime_epochs(epoch_id, runtime_session_id, local_date, ordinal_within_date, status, created_at, previous_epoch_id)
         VALUES (?, ?, ?, ?, 'creating', ?, ?)`,
      )
      .run(epochId, runtimeSessionId, date, ordinal, new Date(now).toISOString(), active.epochId);
    return this.getByEpochId(epochId);
  }

  /**
   * Atomically switch the runtime Session: old epoch -> closed, the newly
   * created 'creating' epoch -> active, with the previous_epoch_id link
   * already recorded at creation. Single transaction => no window with zero
   * active epochs; a crash before commit leaves the old epoch active and the
   * new one 'creating' (recoverable).
   */
  activateRollover(now: string): RuntimeSessionEpoch {
    const pending = this.db
      .prepare(
        "SELECT * FROM runtime_epochs WHERE status = 'creating' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as RuntimeSessionEpochRow | undefined;
    if (pending === undefined) {
      throw new Error("no creating epoch to activate (call beginRollover first)");
    }
    const active = this.getActive();
    if (active === null) {
      throw new Error("cannot activate rollover without an active epoch");
    }
    const closedAt = new Date(now).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE runtime_epochs SET status = ?, closed_at = ? WHERE epoch_id = ?")
        .run("closed", closedAt, active.epochId);
      this.db
        .prepare("UPDATE runtime_epochs SET status = 'active' WHERE epoch_id = ?")
        .run(pending.epoch_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.rolloverPendingReason = null;
    return this.getByEpochId(pending.epoch_id);
  }

  /**
   * Startup recovery: any leftover 'creating' epoch (crash between
   * beginRollover and activateRollover) is unlinked and discarded so the
   * active epoch invariant (exactly zero or one active) holds again.
   * Returns the orphaned runtime_session_id values so the caller can also
   * delete the corresponding orphan Pi Session rows (review blocker #3).
   */
  /**
   * Read-only list of stale 'creating' Epochs. Does NOT delete anything, so
   * the caller can first (idempotently) delete the orphan Pi Session rows
   * and only then remove the Epoch rows — a crash between the two steps is
   * re-entrant: the next startup still sees the creating rows (review
   * blocker #1, fourth pass).
   */
  listCreating(): Array<{ epochId: string; runtimeSessionId: string }> {
    const rows = this.db
      .prepare("SELECT epoch_id, runtime_session_id FROM runtime_epochs WHERE status = 'creating'")
      .all() as Array<{ epoch_id: string; runtime_session_id: string }>;
    return rows.map((row) => ({ epochId: row.epoch_id, runtimeSessionId: row.runtime_session_id }));
  }

  /**
   * Startup recovery (second phase): delete the 'creating' Epoch rows whose
   * orphan Pi Session rows have already been cleaned up by the caller.
   * `orphanSessionIds` are the runtime_session_ids that no longer have a Pi
   * Session row (deleted idempotently). Rows NOT in the list are left alone
   * (their cleanup did not complete; a future startup retries). Returns the
   * count of Epoch rows removed.
   */
  recoverCreating(orphanSessionIds: ReadonlyArray<string>): number {
    const bySession = new Set(orphanSessionIds);
    const stale = this.listCreating();
    const remove = this.db.prepare(
      "DELETE FROM runtime_epochs WHERE epoch_id = ? AND status = 'creating'",
    );
    let removed = 0;
    for (const row of stale) {
      if (bySession.has(row.runtimeSessionId)) {
        remove.run(row.epochId);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Perform the settled-only rollover (compat wrapper): begin + activate in
   * one call. Kept for callers that do not need to interleave Pi Session
   * creation between the two phases.
   */
  rolloverAfterSettled(now: string): RuntimeSessionEpoch {
    if (this.rolloverPendingReason === null) {
      throw new Error("rolloverAfterSettled called without requestRollover");
    }
    const created = this.beginRollover(now);
    void created;
    return this.activateRollover(now);
  }

  getByEpochId(epochId: string): RuntimeSessionEpoch {
    const row = this.db.prepare("SELECT * FROM runtime_epochs WHERE epoch_id = ?").get(epochId) as
      RuntimeSessionEpochRow | undefined;
    if (row === undefined) {
      throw new Error(`runtime epoch not found: ${epochId}`);
    }
    return rowToEpoch(row);
  }

  /** Force a pending flag for deterministic tests. */
  setRolloverPending(reason: string): void {
    this.rolloverPendingReason = reason;
  }

  countAll(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM runtime_epochs").get() as {
      count: number;
    };
    return row.count;
  }

  /** List epochs newest-first for diagnostics/admin archives. */
  listAll(limit: number): RuntimeSessionEpoch[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runtime_epochs ORDER BY created_at DESC, ordinal_within_date DESC LIMIT ?",
      )
      .all(limit) as unknown as RuntimeSessionEpochRow[];
    return rows.map(rowToEpoch);
  }

  close(): void {
    this.db.close();
  }
}

interface RuntimeSessionEpochRow {
  epoch_id: string;
  runtime_session_id: string;
  local_date: string;
  ordinal_within_date: number;
  status: string;
  previous_epoch_id: string | null;
  continuity_snapshot_id: string | null;
  runtime_recovery_notice_id: string | null;
  created_at: string;
  closed_at: string | null;
}

function rowToEpoch(row: RuntimeSessionEpochRow): RuntimeSessionEpoch {
  return {
    epochId: row.epoch_id,
    runtimeSessionId: row.runtime_session_id,
    localDate: row.local_date,
    ordinalWithinDate: row.ordinal_within_date,
    status: row.status as RuntimeSessionEpoch["status"],
    ...(row.previous_epoch_id !== null ? { previousEpochId: row.previous_epoch_id } : {}),
    ...(row.continuity_snapshot_id !== null
      ? { continuitySnapshotId: row.continuity_snapshot_id }
      : {}),
    ...(row.runtime_recovery_notice_id !== null
      ? { runtimeRecoveryNoticeId: row.runtime_recovery_notice_id }
      : {}),
    createdAt: row.created_at,
    ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
  };
}
