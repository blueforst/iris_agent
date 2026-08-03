# Feature A4 Review — LKG, failure and emergency fail-closed

- Reviewed commit: dbea9fc (initial) + 203420e (review fixes)
- Reviewer: independent subagent (general), not the implementer
- Files: src/context/pipeline.ts, src/context/protected-tail.ts,
  src/context/context-runtime.ts, src/runtime/vertical-slice.ts,
  test/context-a4-lkg.test.ts (new), test/context-parity-gate.test.ts,
  test/context-pipeline.test.ts, package.json
- Authority: issue #8 P0 finding 3 (failure contract); Notion 01 Context
  Assembly (LKG binding list, failure policy, forbidden raw fallback);
  OpenCode lkg-replay.ts slash-form model key

## Commands actually run (reviewer)

- npm run lint — PASS
- npm run typecheck — PASS
- npx tsx --test a4/lkg/pipeline/parity-gate/a3 — PASS (39/39)
- npm test — PASS (224 tests, 222 pass)
- npm run check — PASS (full gate)

## Findings

- [NON_BLOCKING] oversize→emergency was dead code (no contextLimit wired) —
  FIXED in 203420e (ContextRuntime forwards contextLimit/threshold from
  verified metadata; real escalation test added at the pipeline layer).
- [NON_BLOCKING] readEntries sat outside the try — FIXED in 203420e (read
  failure now walks the typed fail-closed contract; regression test added).
- [NON_BLOCKING] LKG captured only after HARD (stale SOFT snapshot on
  replay) — tracked as issue #8 P1.3 growing-window replay, A5 scope.
- [NON_BLOCKING] LKG payload doesn't bind serializer/carrier version —
  tracked as issue #8 P1.4, A5 scope.
- [NON_BLOCKING] replay test didn't assert mock identity absence — FIXED in
  203420e.

## Verdict

PASS (after fixes; no BLOCKING at any point)
