-- 0002: extend ingress_acceptances with the durable normalized-envelope ref,
-- the bound Runtime Session identity, the optional rejection code and a
-- general updated_at timestamp.
--
-- Contract: InputAcceptanceRecord (00 Module Boundaries, Host Runtime ->
-- Durable Input Acceptance). `accepted` only means the bounded normalized
-- AgentInput envelope is durably stored (inline or via normalizedInputRef);
-- `session_committed` is set only after the matching Pi UserMessage +
-- iris_input_meta companion pair is durably present in the bound Runtime
-- Session. The ledger never stores assistant content, ToolResult, provider
-- response, runtime phase, settled or a durable invocation outcome.

ALTER TABLE ingress_acceptances ADD COLUMN normalized_input_ref TEXT;
ALTER TABLE ingress_acceptances ADD COLUMN runtime_session_id TEXT;
ALTER TABLE ingress_acceptances ADD COLUMN rejection_code TEXT;
ALTER TABLE ingress_acceptances ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ingress_acceptances_epoch_state
    ON ingress_acceptances(instance_epoch, acceptance_state);
