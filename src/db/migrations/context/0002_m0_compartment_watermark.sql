-- 0002: m0 compartment watermark + m1 delta correctness (issue #8 A2).
--
-- The represented watermark must match what m0/m1 actually cover. A2 adds
-- the folded-compartment watermark so the pipeline can render a REAL m1
-- delta (new committed P3/P4 after m0) instead of the fixed "(delta)"
-- placeholder, and so SOFT+/SOFT replay the persisted stable prefix
-- byte-identically.

ALTER TABLE context_lineages ADD COLUMN m0_compartment_watermark INTEGER NOT NULL DEFAULT 0;
