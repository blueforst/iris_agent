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
   * Perform the settled-only rollover: close the current active Epoch and
   * activate a fresh one linked through previous_epoch_id.
   */
  rolloverAfterSettled(now: string): RuntimeSessionEpoch {
    const active = this.getActive();
    if (active === null) {
      throw new Error("cannot rollover without an active epoch");
    }
    if (this.rolloverPendingReason === null) {
      throw new Error("rolloverAfterSettled called without requestRollover");
    }
    this.markClosed(active.epochId, "closed", new Date(now).toISOString());
    const created = this.ensureActive(now);
    if (created === null) {
      throw new Error("failed to create replacement epoch");
    }
    this.db
      .prepare("UPDATE runtime_epochs SET previous_epoch_id = ? WHERE epoch_id = ?")
      .run(active.epochId, created.epochId);
    this.rolloverPendingReason = null;
    const next = this.getActive();
    if (next === null) {
      throw new Error("rollover produced no active epoch");
    }
    return next;
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
