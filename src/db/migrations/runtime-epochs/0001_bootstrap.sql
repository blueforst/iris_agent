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
);

CREATE INDEX IF NOT EXISTS idx_runtime_epochs_status ON runtime_epochs(status);
