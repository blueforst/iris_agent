# Phase A Total-Gate Review — issue #8 (R2 product-path OpenCode parity)

- Reviewed range: dc248ffd..c8e3653 (16 commits: A1-A5 features + review fixes)
- Four independent reviewers ran in parallel against the REAL product path
  (harness context hook -> ContextRuntime -> pipeline -> convertToLlm ->
  provider), each reading the actual diff + authority sources.

## Reviewer A — Notion/OpenCode spec & provider-visible parity: PASS
- P0-1: transformContextMessages/mock-m0m1-v1 gone from the product path
  (only legacy context-adapter.ts + tests)
- P0-2: renderM0Head/SOFT/renderProviderVisible render REAL semantics (no
  [input N]/[assistant N]/(delta)/[live ...] markers)
- P0-3: failure contract implemented (LKG replay or typed errors; emergency)
- All 10 P1 items authority-backed (token-churn hysteresis, oversize
  eligible-head, growing-window LKG, replayHash+watermark, slash model key,
  m1_absolute_cap, fixture direct assertions, ContextStore crash aggregate,
  provider-visible bytes, dual assertions)
- NON_BLOCKING x3: oversize not product-path reachable (FIXED c8e3653),
  stale docstrings (FIXED c8e3653), ttl_idle unreachable in pipeline
  (documented, not in issue P0/P1)

## Reviewer B — code quality/concurrency/SQLite/lifecycle: BLOCKING -> PASS
- BLOCKING: ContextStore leaked on IrisHost.open() setup-failure catch
  (host.ts) — FIXED c8e3653 (hoisted setupContextStore, closed in catch)
- RE-REVIEW: PASS (fix verified end-to-end, 230 pass, no new issues)
- Verified: single-row atomic SQLite writes, monotonic-guarded watermarks,
  SIGKILL reopen consistency, serialized hook calls + single-writer latch =
  no torn reads on rollover, no as any/@ts-ignore/non-null, LKG replay is
  genuinely safe-prefix-validated, module boundaries hold

## Reviewer C — tests/fixtures/bench/crash/evidence: NON_BLOCKING
- 229 pass / 0 fail reproduced; all 12 fixture hashes match provenance.json;
  generate.ts anti-self-certification anchors + locked-commit check; 8 crash
  boundaries incl. context_store_materialized genuinely SIGKILL live
  processes; 2 skipped tests are documented live-API-key skips; evidence
  records honest (every command count reproducible)
- NON_BLOCKING x2: A4 read-port test assertion looser than title (FIXED
  c8e3653 — now strictly typed), ttl-idle test title broader than assertion
  (documented)

## Reviewer D — security/provenance/failure/LKG/boundaries: PASS
- No raw wire/companion/pairKey/layout/blocks reaches the provider on normal
  OR failure path (convertToLlm + openai-completions serializer drop
  details); no structural markers; no synthetic repair; LKG
  runtimeSessionId-scoped (fresh lineage on rollover); typed fail-closed
  before provider; no Memory Router/Neo4j/Graphiti access; .env gitignored;
  no eval/shell on untrusted content
- NON_BLOCKING x2: replay suffix is raw current-session tail (safe — anchor
  is newest user so no wire in tail; companion filtered; details dropped
  twice), companion filter shape-match vs customType-only predicate (safe
  today, single producer)

## Final verdict: PASS (all BLOCKING fixed and re-reviewed)

Phase A (issue #8) is complete: every P0/P1 item has product-path evidence,
the four-gate review passed, and the branch may proceed to R3 (Phase B).
