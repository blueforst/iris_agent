# Feature A1 Review — Lossless provider-visible P5 projection

- Reviewed commit: 1448734 (initial) + 3c923d4 (review nits fix)
- Reviewer: independent subagent (general), not the implementer
- Files: src/context/provider-visible.ts (new), src/context/projection.ts,
  src/context/pipeline.ts, test/context-a1-provider-visible.test.ts (new),
  test/context-pipeline.test.ts, package.json
- Authority: issue #8 P0 "renderer loses conversation semantics", Notion 01
  Context Assembly (projection/pair/omission rules), pi-ai ThinkingContent
  (field 'thinking'), pi-agent-core AgentMessage union

## Commands actually run

- npm run lint — PASS
- npm run typecheck — PASS
- npm run format:check — PASS
- npx tsx --test context-a1/context-projection/context-pipeline — PASS (29/29)
- npm run test:context-golden — PASS (4/4)
- npm run test:context-migrations — PASS (12/12)
- npm test — PASS (205 pass, 0 fail, 2 skipped)
- npm run check — PASS (aggregate green)

## Findings

- [NON_BLOCKING] projection 'verified' criterion (companion !== undefined) does
  not yet recompute pairKey/layout hash — pre-existing; deferred to A3 wiring
  (reviewer recommendation). Rendered payload is always the user's real wire
  words and labels come from Host-created blocks.
- [NON_BLOCKING] serializer-version test was vacuous — FIXED in 3c923d4
  (recompute under bumped version and assert difference).
- [NON_BLOCKING] renderUnitProviderVisible re-derived compaction/branch text —
  FIXED in 3c923d4 (returns unit.providerVisible, single source of truth).

## Verdict

PASS (after fixes; no BLOCKING at any point)
