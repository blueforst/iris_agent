import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

  constructor(
    databasePath: string,
    private readonly sessionPrefix: string,
    private readonly timeZone: string,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_epochs (
        epoch_id TEXT PRIMARY KEY,
        runtime_session_id TEXT NOT NULL UNIQUE,
        local_date TEXT NOT NULL,
        ordinal_within_date INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'closing', 'closed', 'closed_incomplete')),
        previous_epoch_id TEXT,
        continuity_snapshot_id TEXT,
        runtime_recovery_notice_id TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);
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
