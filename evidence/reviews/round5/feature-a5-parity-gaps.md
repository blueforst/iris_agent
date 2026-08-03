# Feature A5 Review — close all known parity/test gaps

- Reviewed commits: e8b5d9a (initial) + c92b43d (review fixes)
- Reviewer: independent subagent (general), not the implementer
- Files: src/context/protected-tail.ts, src/context/replay.ts,
  src/context/pass-taxonomy.ts, src/context/pipeline.ts,
  src/context/context-runtime.ts, src/runtime/vertical-slice.ts,
  scripts/crash-worker.ts / crash-harness.ts / crash-check.ts,
  test/context-parity-gate.test.ts, test/context-protected-tail.test.ts,
  test/context-a4-lkg.test.ts
- Authority: issue #8 P1 (10 items); OpenCode protected-tail-boundary.ts
  (NORMAL_HYSTERESIS_TOKENS=256 token churn), inject-compartments.ts
  (M1_ABSOLUTE_CAP_RATIO=0.2), lkg-replay.ts (slash-form model key)

## Commands actually run (reviewer)

- npm run lint / typecheck — PASS
- npm run crash:check — PASS (all 8 boundaries incl. context_store_materialized)
- targeted context tests — PASS (46/46)
- npm test — PASS (229 pass, 0 fail)
- npm run check — PASS (full gate)

## Findings

- [NON_BLOCKING] m1 absolute-cap backstop inert on the product path (no
  historyBudgetTokens wiring) — FIXED in c92b43d (factory derives and
  forwards it; negative small-delta test added).
- [NON_BLOCKING] no negative test for the m1-cap rule — FIXED in c92b43d.
- [NON_BLOCKING] growing-window LKG had no SOFT-pass refresh test — FIXED
  in c92b43d.
- [NON_BLOCKING] crash boundary parks after store close (weaker than
  mid-write) — accepted: still proves SIGKILL+reopen recovery of the fully
  committed lineage (item 8 gate satisfied).
- [NON_BLOCKING] hysteresis range differs from authority's exact formula —
  accepted: requested semantic (small token change holds boundary),
  constant (256) and hold/move tests all match.
- PLUS: reviewer's review surfaced a REAL regression — executeThreshold
  absent → 0 → N≈1 → false oversize → spurious emergency on the product
  path. FIXED in c92b43d (authority-safe 65 default in both
  deriveProtectedTailTokenTarget and selectPerRunCap) with tests green.

## Verdict

PASS (after fixes; no BLOCKING at any point)
