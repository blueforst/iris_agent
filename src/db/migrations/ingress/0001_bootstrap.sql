CREATE TABLE IF NOT EXISTS ingress_acceptances (
  input_id TEXT NOT NULL,
  instance_epoch INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  acceptance_state TEXT NOT NULL CHECK (acceptance_state IN ('accepted', 'session_committed', 'rejected')),
  pi_user_entry_id TEXT,
  pi_meta_companion_entry_id TEXT,
  accepted_at TEXT NOT NULL,
  session_committed_at TEXT,
  PRIMARY KEY (instance_epoch, input_id)
);

CREATE INDEX IF NOT EXISTS idx_ingress_acceptances_state ON ingress_acceptances(acceptance_state);
