# R1-P2 Round 3 Validation Evidence — Long-lived Host & Durable Ingress

Date: 2026-08-02
Baseline: `83c545a` (blueforst/iris_agent main, second-round merge)
Branch: `agent/r1-p2-long-lived-host-rollover`
Environment: local Windows checkout, Node.js `22.19.0`, npm `10.9.3`.

Scope: third-round R1 Exit Gate convergence — `iris serve` as a real
long-lived Host, durable input acceptance, single-writer scheduling,
native-settled rollover, fresh Harness + fresh Context lineage, and the
rollover/recovery crash matrix on the real product startup path. Evidence is
sanitized: no API keys, prompts, reasoning text or user content.

## Full check

Command: `npm run check` (includes `test:subprocess`)

Result: passed.

- `format:check`: Prettier all matched files formatted.
- `lint`: ESLint clean.
- `typecheck`: `tsc --noEmit` clean.
- `test`: 57 unit tests — 55 passed + 2 live-provider skipped
  (`OPENCODE_GO_API_KEY` not set; the two live tests run when the key is set).
- `test:subprocess`: 3 cross-process subprocess tests passed (real `iris
serve` child processes + HTTP clients).
- `migration:smoke`: idempotent.
- `crash:check`: all 7 boundaries passed (real child-process SIGKILL).
- `build`: clean.
- `dist:smoke`: runtime-epochs.db + ingress.db present in dist.
- `bench`: 200 appends, ~1.85 ms/message.

## `iris serve` is now a long-lived Host

`iris serve` no longer composes and exits. It:

- acquires `<dataRoot>/iris.lock` and holds it for the full Host lifetime;
- validates config and runs re-entrant startup recovery (stale `creating`
  Epochs + orphan Pi Session rows);
- opens the active Epoch + Pi Session and constructs the Capsule
  (AgentHarness + Context hooks + tools) and the RuntimeCoordinator;
- starts the durable ingress pump and the loopback HTTP/SSE transport
  (default `127.0.0.1:18001`);
- reports ready only after startup; flips not-ready when shutdown starts;
- stays alive until SIGINT/SIGTERM (or stdin EOF, for cross-process test
  drivers) and always releases the lock through the graceful shutdown path.

A second process against the same data root fails fast with
`Lock file is already being held` (verified cross-process).

Endpoints:

```text
GET  /v1/health
POST /v1/input
POST /v1/abort/{invocationId}
GET  /v1/stream                         (SSE; Coordinator events only)
GET  /v1/admin/session/status
POST /v1/admin/session/rollover
GET  /v1/admin/session/archives
```

SSE reuses Coordinator events — the transport is never a second runtime event
truth.

## Durable input acceptance (ingress.db)

`InputAcceptanceLedger` implements the `InputAcceptanceRecord` contract:

- identity = `instanceEpoch + inputId`;
- same identity + same payload -> existing acceptance result;
- same identity + different payload -> typed idempotency conflict (HTTP 409);
- `accepted` = durable normalized envelope (fsynced blob + row);
- `session_committed` = matching Pi UserMessage + `iris_input_meta` companion
  pair verified in the bound Runtime Session (via `resolveCommittedPair`);
- `rejected` = typed rejection code;
- bounded FIFO with explicit `IngressQueueFullError` (HTTP 429) — no silent
  drop, and the queue-capacity check happens BEFORE the DB write so an
  overflow never leaves a phantom accepted record;
- committed inputs are removed from the FIFO and never re-prompted.

Crash windows verified by tests (`test/ingress.test.ts`, 9 tests):

| window                                       | behavior                                  |
| -------------------------------------------- | ----------------------------------------- |
| 1. before accepted commit                    | retry re-accepts (no trace)               |
| 2. accepted, before Pi append                | recovery re-enters the FIFO               |
| 3. UserMessage, before companion             | accepted-but-uncommitted survives restart |
| 4. companion, before session_committed       | accepted-but-uncommitted survives restart |
| 5. session_committed, before client response | never re-prompted                         |

## Active Runtime Registry

`ActiveRuntimeRegistry` exposes exactly one `ActiveRuntimeHandle`
(`epochId` + `runtimeSessionId` + `runtime`). The Coordinator reads the
current Capsule from the registry on every `prompt()`; the Host performs the
rollover CAS. No module caches a stale Harness/Session.

## Native-settled rollover

`IrisHost.requestRollover()` only marks the request; the switch happens after
the Coordinator observes Pi native settled on the CURRENT active Epoch
(`onSettledBoundary`). The rollover path:

1. captures the old Session head and closes old storage;
2. creates a real empty new Pi Session;
3. constructs a fresh AgentHarness with fresh hooks/tools/systemPrompt
   resolver and a fresh ContextSourceSnapshot lineage;
4. activates the new Epoch (DB CAS) and swaps the active runtime handle;
5. the next queued input becomes the new Session's first normal prompt.

A crash between the Epoch CAS and the registry swap self-heals on restart:
startup rebuilds the harness from the DB's active Epoch (never a stale
registry). Multiple ordered Epochs per day are supported.

## Rollover/recovery crash matrix (`test/host.test.ts`, 9 tests)

Using the real `IrisHost.open()` startup path:

| window                             | covered                                                | recovery                                                     |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| 1. old Session settled 前          | yes                                                    | old active Epoch kept, no new Epoch                          |
| 2. old frozen, new create 前       | yes (crash harness `after_creating_epoch` + host test) | creating Epoch + orphan Session cleaned, one active Epoch    |
| 3. new created, CAS 前             | yes (same)                                             | one active Epoch, no guessing                                |
| 4. CAS 后, Harness construction 前 | yes                                                    | new active Epoch served from DB                              |
| 5. Harness ready, first prompt 前  | yes (same)                                             | fresh empty Session is the active Epoch; old archived closed |

Also verified:

- exactly one active Epoch invariant;
- registry consistency with the Pi Session;
- corrupt multiple-active state is not silently guessed;
- closed/closed_incomplete Sessions never receive new inputs;
- second Host fails fast on the lock;
- graceful shutdown rejects new inputs and releases the lock (restart works).

## Cross-process tests (`test/subprocess.test.ts`, 3 tests)

Real `iris serve` subprocess + HTTP clients:

- Host stays alive; multiple clients share one Iris; HTTP dedup + typed
  conflict on retry; rollover produces a closed archive Epoch;
- a second Host against the same data root is rejected by the lock;
- graceful shutdown (stdin EOF / signal) releases the lock and the same data
  root reopens for recovery.

Mock Provider is the CI-forced path; live provider remains credential-gated.

## Remaining gaps (unchanged by this round)

- Live provider tests still require `OPENCODE_GO_API_KEY` (skipped in CI).
- `RuntimeSessionEpochPort` async-vs-sync drift is closed for consumers: the
  Host now drives `requestRollover`/rollover through the store directly; the
  async Port remains the R4 wiring contract.
- Rollover capacity thresholds still provisional until locked Pi benchmarks.
- Full Historian/outbox delivery is a later milestone (R3/R4); this round
  adds no second outbox or invocation-result ledger.
