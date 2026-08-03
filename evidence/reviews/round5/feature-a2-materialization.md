# Feature A2 Review — Real m0/m1/live-tail materialization

- Reviewed commit: 138557c (initial) + 7ffcd05 (review nits fix)
- Reviewer: independent subagent (general), not the implementer
- Files: src/context/pipeline.ts, src/context/context-store.ts,
  src/db/migrations/context/0002_m0_compartment_watermark.sql (new),
  test/context-a2-materialization.test.ts (new), test/context-store.test.ts,
  test/context-pipeline.test.ts, test/context-parity-gate.test.ts,
  test/context-carriers.test.ts, test/context-pass-taxonomy.test.ts, package.json
- Authority: issue #8 P0 item 2 (delta placeholder, carriers undefined,
  watermark honesty, byte-identical prefix); Notion 01/02 (SOFT+/SOFT/HARD,
  append-only tail is not a prefix divergence); OpenCode v0.33.0
  inject-compartments.ts wire shape (verified from upstream source)

## Commands actually run (reviewer)

- npm run lint — PASS
- npm run typecheck — PASS
- npx tsx --test a2/pipeline/parity-gate/store — PASS (30/30)
- npx tsx --test golden/carriers/pass-taxonomy/a1 — PASS (35/35)
- Empirical append-only check: identical→SOFT+, assistant-only append→SOFT+,
  new user turn→SOFT — confirmed
- npm run check — PASS (211 unit + 4 golden + 13 context migrations + crash + cli)

## Findings

- [NON_BLOCKING] Carrier envelope timestamp differed between HARD render (atMs 0)
  and SOFT+ replay (m0MaterializedAt) — FIXED in 7ffcd05 (pinned atMs=0 on replay
  so the FULL envelope is byte-identical).
- [NON_BLOCKING] No regression test for append-only live-tail growth → SOFT+ —
  FIXED in 7ffcd05 (new test: grown assistant delta stays SOFT+, prefix
  byte-identical, live delta appended).

## Verdict

PASS (after fixes; no BLOCKING at any point)
