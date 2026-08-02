# R1-P1 Round 2 Validation Evidence

Date: 2026-08-02
Baseline: `36322bc` (blueforst/iris_agent main, first-round merge)
Branch: `round2/r1-p1-live-slice`
Environment: local Windows checkout, Node.js `22.19.0`, npm `10.9.3`.

Scope: R0 convergence items, R1-P1 real provider vertical slice, epoch
rollover, thin runtime coordinator, and the R1 crash-window suite. Evidence
here is sanitized: no API keys, prompts, reasoning text or user content.

## Full check

Command: `npm run check`

Result: passed.

- `format:check`: Prettier all matched files formatted (`.gitignore` now
  excludes `.omo/`, `.cortexkit/`).
- `lint`: ESLint clean.
- `typecheck`: `tsc --noEmit` clean.
- `test`: 27/27 passed without a live API key, 2 live tests skipped
  (original 14 plus opencode-go provider seam, live slice, restart,
  rollover x4, coordinator x5; the two live-provider tests run when
  `OPENCODE_GO_API_KEY` is set).
- `migration:smoke`: idempotent.
- `crash:check`: all 6 boundaries passed (real child-process SIGKILL).
- `build`: clean.
- `dist:smoke`: runtime-epochs.db + ingress.db present in dist.

## R1-P1 live provider vertical slice

The locked pi-ai 0.82.1 ships `opencodeGoProvider()` with `deepseek-v4-flash`
(baseUrl `https://opencode.ai/zen/go/v1`). A real provider request was issued
through the full Pi Capsule path (Epoch -> Pi Session -> AgentHarness ->
Context hook -> sequential tool -> ToolResult details.iris -> settled).

Live test (with development API key set):

- `settled: true`, `stopReason: stop`
- model emitted one `test_read_tool` tool call, received its result, and
  produced a final text reply
- session persisted 5 entries (user, iris_input_meta companion, assistant
  tool-call, toolResult, final assistant)
- restart reopened the same runtime session with identical entry count

Without the API key, the two live tests skip cleanly (`2 pass + 2 skip`), so
CI stays hermetic.

## Crash-window suite (real SIGKILL + recovery)

`npm run crash:check` spawns a child process that advances a real data root to
a boundary, writes a marker, then parks forever on a live event loop; the
parent SIGKILLs the still-running process and reopens the data root to assert
invariants. A kill probe confirmed the worker stays alive after writing the
marker (SIGKILL genuinely lands on a live process). All 6 boundaries passed:

| boundary                 | entries | user | companion | assistant | toolResult | synthetic? |
| ------------------------ | ------- | ---- | --------- | --------- | ---------- | ---------- |
| before_any_write         | 0       | 0    | 0         | 0         | 0          | no         |
| after_user_append        | 1       | 1    | 0         | 0         | 0          | no         |
| after_companion_append   | 2       | 1    | 1         | 0         | 0          | no         |
| after_epoch_created      | 0       | 0    | 0         | 0         | 0          | no         |
| after_settled            | 5       | 1    | 1         | 2         | 1          | no         |
| after_tool_result_commit | 5       | 1    | 1         | 2         | 1          | no         |

No `invocation.db` / `result.db` synthetic repair artifacts in any window.

## Epoch rollover

`RuntimeEpochStore` now implements `requestRollover` / `rolloverAfterSettled`
(spec 02: switch only after settled) and links epochs via
`previous_epoch_id`. Rollover tests (4/4):

- old epoch closed, fresh empty session activated
- rollover without explicit request is rejected
- single-active-epoch invariant holds after rollover
- no synthetic repair artifacts

## Runtime coordinator

`RuntimeCoordinator` implements `AgentRuntimePort` (single-writer latch,
queued inputs with capacity, settled latch release, abort forwarding to the
Pi harness). Tests 5/5: latch, concurrency rejection, queue, capacity, abort.

## Contract pin alignment

The agent pin (`src/contracts/pins/memory-contracts.json`) now matches the
published iris-memory v0.1.0 manifest exactly (13 schemas, including
`sequence-conflict-error-v1.schema.json` that was missing). New test asserts
the pin schema set equals the published manifest.

## Known gaps

- Live tests require `OPENCODE_GO_API_KEY`; skipped in CI by design.
- `RuntimeSessionEpochPort` (contracts/runtime.ts) declares async signatures
  while `RuntimeEpochStore` is synchronous with a `now` parameter; no consumer
  exists yet, so the drift is latent and tracked for the R2 port wiring round.
- Rollover `markClosed -> ensureActive` is not a single transaction; a crash
  between the two leaves zero active epochs. The crash suite covers
  pre/post-settled windows but not a mid-rollover kill (known gap).
- Benchmark (`npm run bench`) remains manual; rollover capacity thresholds
  still provisional until the locked Pi benchmark updates them.
- `npm audit` high-severity transitive findings (ESLint chain) unchanged and
  documented in the first-round evidence.
