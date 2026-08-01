# R0 / R1-P0 Validation Evidence

Date: 2026-08-01
Environment: local Windows checkout, Node.js `22.19.0`, npm `10.9.3`.

## Full check

Command: `npm run check`

Result: passed.

- `format:check`: Prettier reported all matched files formatted.
- `lint`: ESLint completed without errors.
- `typecheck`: `tsc --noEmit` completed without errors.
- `test`: 13/13 tests passed (original 9 plus multi-block frame round-trip, orphan
  companion filtering, corrupted pair-key fallback, verified pair projection).
- `migration:smoke`: first run applied `0001_bootstrap`; second run applied nothing; status `idempotent`.
- `build`: `tsc -p tsconfig.build.json` plus migration asset copy completed.
- `dist:smoke`: compiled `dist` initialized an empty data root with both
  `runtime-epochs.db` and `ingress.db`, proving SQL migrations are present in the
  build artifact.

## Benchmark smoke

Command: `npm run bench`

Result: passed.

```json
{
  "appends": 200,
  "elapsedMs": 397.78,
  "appendMsPerMessage": 1.989,
  "status": "ok"
}
```

## Crash-boundary harness

Command: `npm run crash:harness -- --boundary <name>`

Result: passed for all four current boundaries.

- `before_any_write`: entries `0`
- `after_user_append`: entries `1`
- `after_companion_append`: entries `2`
- `after_settled`: entries `5`, `settled: true`

## Dependency audit

Command: `npm audit`

Result: `5 high severity` transitive vulnerabilities reported through the
ESLint `brace-expansion`/`minimatch` dependency chain. They were not force-fixed
in this round because the available fix upgrades ESLint to a breaking major
version; the issue is recorded as a known gap.

## Scope note

This evidence covers the R0 engineering baseline and the R1-P0 deterministic
mock vertical slice only. It does not claim R0 or R1 completion, and it does not
update the accepted Notion Roadmap percentage.
