Task Result

Task ID: bg_700b1f8a
Description: R1 架构咨询 oracle
Duration: 5m 11s
Session ID: ses_03244b494ffef3bpWELVYQLAhH

---

Let me analyze this carefully. The user is asking for architectural advisory on R1 of the Iris Roadmap v13. This is a READ-ONLY advisory task — no code changes. They want decisive answers to 6 key architectural questions, plus a work breakdown, vertical slice design, risks, and open questions.

The context is very detailed and self-contained. Let me digest the key facts:

**Three-project boundary:**
- blueforst/pi = generic runtime substrate fork (NO Iris cognitive semantics)
- blueforst/iris_agent = event-driven cognitive runtime
- blueforst/iris_memory = memory service

**Canonical cognitive chain:** RuntimeEvent → Context ingest → immutable ContextMessageUnit(contextSeq) → dual projection (Provider Renderer / ContextHistoryReadPort → Historian).

**R1 deliverables (20%):** stable RuntimeEvent lifecycle + SessionCommitReceipt; Provider Context Controller (full systemPrompt/messages/tools replacement BEFORE provider conversion); explicit Session close, sequenced archive reads, settled/abort/tool-loop contracts; mock deterministic baseline + at least one real non-thinking provider vertical slice.

**R1 Exit Gates:**
1. Iris normal Provider path does NOT construct Context from Session.buildContext()
2. default Pi native path stays compatible
3. user/tool/assistant/crash-window ordering + exactly-once attribution executable verification
4. no synthetic assistant/ToolResult repair

**Pi fork seam requirements (PI-015~PI-019):**
- PI-015 Provider Context Controller: before provider conversion, decide system/messages/tools completely; Iris path must not force Session.buildContext(); default native implementation stays compatible.
- PI-016 Session Commit Receipt: awaited receipt after user/assistant/ToolResult append
- PI-017 Runtime Event Lifecycle: stable distinction of message finalized, session committed, tool execution/result committed, turn committed, agent settled
- PI-018 Archive API: consistent forward sequenced reads
- PI-019 Storage performance

**Pi current state:**
- createTurnState() calls `await this.session.buildContext()` → context.messages
- Has AgentHarnessOwnEvent observer mechanism with 23 event types (retry_scheduled, settled, tool_call, tool_result, context, abort, before_provider_request, before_provider_payload, after_provider_response, etc.)
- Missing: message_finalized / session_committed / tool_execution_committed / turn_committed granularity (PI-017); awaited append receipts (PI-016); pre-conversion context replacement controller (PI-015)
- Session append semantics: appendMessage/appendCustomMessageEntry set new entry parentId to current leaf; companion+UserMessage appended consecutively → companion.parentId === UserMessage entry id, adjacent entry_seq; inserting entries between breaks the chain.
- Pi packages 0.83.0-dev on fork main (ab5f8d88); iris_agent depends on npm @earendil-works/pi-* 0.82.1

**iris_agent current state:**
- src/runtime/harness-factory.ts: createIrisHarness() static hook chain
- src/runtime/context-adapter.ts: transformContextMessages
- src/context/context-store.ts: full v12 Context SQLite (Session-derived)
- src/runtime/runtime-coordinator.ts: single-writer latch
- src/runtime/vertical-slice.ts: runMinimalSlice/reopenActiveSession
- R0 production lock: node 22.19.0, pi 0.82.1 npm, magic-context v0.33.0

**Questions to answer:**

Q1. RuntimeEvent source: (A) fork seams first, (B) iris_agent adapter over 23 OwnEvents now, fork seams later, (C) hybrid — minimal fork seams (append receipt + message/tool/turn committed events) + iris_agent ledger.

Q2. PI-015 Provider Context Controller minimal design in fork.

Q3. RuntimeEvent ledger schema — SQLite in R1 or in-memory + persist R2?

Q4. R1 vertical slice shape.

Q5. Sequencing with v12 Context code.

Q6. Fork seam landing strategy: single PR or split?

Let me think through each deeply.

---

**Q1: RuntimeEvent source**

Key consideration: Exit Gate 1 requires the Iris normal Provider path NOT construct Context from Session.buildContext(). Exit Gate 2 requires default Pi native path stays compatible.

The question frames: can Exit Gate 1 be satisfied WITHOUT the fork PI-015 seam, e.g. by overriding context before provider conversion through existing hooks?

Looking at the pi state: createTurnState() calls buildContext() → context.messages → createContext() → createStreamFn() → streamSimple. The AgentHarnessOwnEvent has `before_provider_request`, `before_provider_payload` — these fire after createTurnState presumably, meaning buildContext() has ALREADY been called by the time these fire. So hooking before_provider_payload does NOT avoid buildContext() — it just allows replacing the payload that will be sent. But the requirement is more subtle: "Iris path must not FORCE Session.buildContext()" — meaning the Iris path shouldn't be coupled to session-derived context; and Exit Gate 1 says the Iris provider path does NOT construct Context from buildContext.

Wait, but there's a subtlety: if buildContext() is still called (wasted work, and it could fail or be expensive) but its result is discarded in favor of the controller's context, does that satisfy the gate? The gate says "does NOT construct Context from Session.buildContext()" — strictly, if you override before provider conversion, the Context that goes to the provider is not constructed from buildContext(), even if buildContext() was invoked and its output discarded. That would technically pass the letter of the gate but fail the spirit (performance, and dependency on session state that Iris doesn't want to own).

Actually, the more important issue: Iris's Context is identity-level and durable, NOT session-derived. The v13 design says Context is identity-level durable (contextLineageId); rollover does not migrate Context. The Session is a bounded raw archive only. So for the Iris path, the session's buildContext() result is semantically WRONG (it would derive context from the raw session archive, which is not the canonical Context). Relying on the before_provider_payload override means the harness still runs the full session-derived pipeline internally (buildContext, potentially message folding, etc.) and Iris patches over it. That's fragile and fights the framework.

Also consider: the harness event `context` exists — there's an event that fires with context. Hmm.

Now the decision: (A) fork first, (B) adapter now, (C) hybrid.

Consider the risk profile. The fork is at 0.83.0-dev on fork main; iris_agent is locked on 0.82.1 npm. There's already a version drift (0.82.1 → 0.83.0-dev). Landing fork seams and consuming them means a version bump and carrying patches. R0 is complete with pi fork governance merged — so the fork process exists and works.

Option A (fork first, then consume): cleanest dependency direction, but delays R1 progress until the fork lands; also the fork patches need generic rationale, tests, removal conditions, upstream PR status — heavyweight. And PI-017 granularity events in the fork are a "generic runtime" concern (message finalized, session committed, tool execution committed, turn committed) — these are legitimately generic. PI-016 append receipts are generic. PI-015 is generic (a context override controller). So all three are justifiable as generic-runtime features.

Option B (iris_agent adapter over the 23 OwnEvents now): The 23 events lack the granularity needed: no message_finalized, no session_committed, no tool_execution_committed, no turn_committed, no awaited append receipts. The events are observer-style (fire-and-forget callbacks), not awaited receipts. For exactly-once attribution and crash-window ordering (Exit Gate 3), you need to know precisely WHEN an append was durably committed, and whether a message was finalized before a crash. Deriving "committed" from an observed event is inferential — the event fires after the fact but you can't await durability. Actually the events DO include save_point and settled... but attribution/durability semantics are not expressible. The ledger in iris_agent would be built on inference, not on contract. Exit Gate 3 requires executable verification of ordering + exactly-once attribution — that's much harder to verify if the source of truth is fire-and-forget events with no durability contract.

Also, Exit Gate 1 — without a fork seam, the Iris path still forces buildContext() to run (it's in createTurnState, unconditionally). The override hooks (before_provider_request/payload) fire after the turn state is built. So strictly, Iris can override the payload, but buildContext() still runs → the gate "does NOT construct Context from buildContext()" — well, the Context that goes to the provider wouldn't be from buildContext(). But there's a real problem: does the harness internally use context.messages for anything else (e.g., the session tree, the `context` event, save points)? If the override replaces only the provider payload, internal state still derives from the session context. And "Iris path must not FORCE Session.buildContext()" — the fork seam requirement PI-015 says "before provider conversion, decide system/messages/tools completely; Iris path must not force Session.buildContext()". The phrase "must not force" suggests the seam is about NOT forcing the native path to run — i.e., when the controller is present, buildContext() should be SKIPPED, not just overridden after.

Hmm, but actually re-reading: "PI-015 Provider Context Controller: before provider conversion, decide system/messages/tools completely; Iris path must not force Session.buildContext(); default native implementation stays compatible."

So the controller lets the caller decide the full context; and the native default must stay byte-compatible. Whether buildContext() is skipped when the controller is present — I think yes, that's the point: the controller REPLACES the context construction, so buildContext() isn't called at all in the Iris path. That's the clean way to satisfy Exit Gate 1's letter AND spirit.

So my recommendation for Q1: **Option C — hybrid, but sequenced**: land the minimal fork seams (PI-016 receipts + PI-017 event granularity + PI-015 controller) as the FIRST fork PR batch, and in iris_agent build the RuntimeEvent ledger that consumes them. Wait — but the question asks which ORDER minimizes risk while satisfying Exit Gate 1. C is listed as "minimal fork seams + iris_agent ledger". The hybrid IS the answer, but the sequencing matters: the fork seams are a prerequisite for the ledger's durability semantics (receipts), and the PI-015 controller is the only clean way to satisfy Exit Gate 1.

Hmm, but should I consider: can Exit Gate 1 be satisfied WITHOUT the fork PI-015 seam? Let me think harder. Existing hooks: `before_provider_request`, `before_provider_payload`, `context` event, and the hook chain in harness-factory has onSystemPrompt/onContext/onToolCall/onToolResult/onSettled/onAfterToolResultProviderCall. The onSystemPrompt hook exists in iris_agent already — so systemPrompt replacement is already possible. What about messages/tools? onContext presumably receives the context object. Could Iris replace messages/tools there? If onContext fires before createStreamFn, and the context object is mutable or replaceable, then yes — but buildContext() has already run. Exit Gate 1's letter: "Iris normal Provider path does NOT construct Context from Session.buildContext()" — if Iris replaces the context entirely via a hook and the provider consumes the replaced context, then technically the provider path's Context is not from buildContext(). But buildContext() still ran. Is that acceptable?

The risk: the gate is an executable verification presumably — a test that proves the provider received a Context not derived from buildContext(). If the fork seam isn't there, the test can't verify "buildContext never called" — it can only verify "provider received replaced context". The spec text for PI-015 says "Iris path must not force Session.buildContext()" — this is a requirement on the fork seam. So the spec itself wants the seam. I should recommend the seam.

But there's a pragmatic middle: satisfy Exit Gate 1 NOW with a hook-level override (Option B adapter) while the fork seams are in flight, so R1 isn't blocked on fork PR review cycles. Hmm, but the question asks to be decisive. Let me weigh:

- The fork PR review cycle for carried patches: governance is in place (R0 complete, pi fork governance merged). A carried patch PR batch for PI-015+016+017 is a bounded piece of work. The iris_agent ledger design DEPENDS on the receipt/event contract from PI-016/017 — building the ledger against inferred events (Option B) then re-plumbing to real receipts is throwaway work. The ledger schema and consumer code should be built against the real contract.
- However, the vertical slice and mock baseline can proceed in parallel against a defined contract (the contract is knowable in advance — PI-016/017 define it).
- So: sequencing = fork seams land first (they're small and self-contained), iris_agent consumes them. The mock deterministic baseline can be developed against the contract in parallel (contract-first testing) since it's mock-based anyway.

Decision for Q1: **C, ordered as: fork seam PR first (PI-015+016+017 minimal), iris_agent consumes.** Rationale:
1. Exit Gate 1's clean satisfaction requires PI-015 (skip buildContext, not override-after). Adapter-only (B) can only override after buildContext ran, which fails the spirit and makes the gate test weak/cheaty.
2. The ledger's exactly-once attribution (Gate 3) needs awaited receipts + explicit committed events — you cannot derive durability from observer events. Option B's ledger would be inference-based and would need rework when seams land.
3. A is over-committed: PI-018 (archive API) and PI-019 (storage perf) are NOT needed for R1 gates; landing them now expands the carried-patch surface. Keep them out of the critical path.

Risk of C: iris_agent is on npm 0.82.1; the fork is 0.83.0-dev. Consuming fork seams requires either (i) bumping iris_agent to the fork's published/linked packages (0.83.0-dev), or (ii) local link/overrides. Version drift is a real risk — the R0 lock says pi 0.82.1 npm. Need a decision: publish fork packages to a private registry or use npm overrides/patch-package with a tarball. Actually — carrying patches via npm overrides with git tarball dependencies is the standard approach: iris_agent depends on @earendil-works/pi-* from the fork's git tarball (blueforst/pi), version 0.83.0-dev, rather than npm 0.82.1. That's a one-time dependency change. Risk: the fork's 0.83.0-dev may include other upstream changes that break the R0 lock (e.g., magic-context interplay). Mitigation: pin the fork commit (ab5f8d88 + seam commits) as the dependency ref; regression-run R0's existing tests and the pi compatibility tests.

Also note: Gate 2 "default Pi native path stays compatible" — the seam must be default-absent-behavior-identical. Test: run pi's own native harness tests against the forked packages; byte-compare default context construction.

**Q2: PI-015 Provider Context Controller minimal design**

Seam point: createTurnState() currently does:
```
await this.session.buildContext() → context.messages
systemPrompt resolver
createContext() assembles systemPrompt/messages/tools
createStreamFn() → models.streamSimple(model, context)
```

Design: an optional `contextController` hook on the harness (or agent options): `contextController?: (params: { session, model, resolveSystemPrompt }) => Promise<{ systemPrompt?, messages?, tools? }>`. When absent → exactly current native path. When present → the harness uses the controller's output to assemble the provider context and does NOT call session.buildContext() for the messages; but careful: buildContext() in pi may do more than messages — need to check what else it computes (system prompt resolution? tools? session tree?). In current pi, createTurnState: buildContext() → context.messages; systemPrompt resolver (string or fn) separate; createContext() assembles. So buildContext's output is context.messages only? Actually buildContext might also return systemPrompt? The given facts: "createTurnState() calls `await this.session.buildContext()` → context.messages; systemPrompt resolver (string or fn); createContext() assembles systemPrompt/messages/tools". So buildContext primarily produces messages (and maybe more — but the description limits it to context.messages). The controller should receive a resolved native-systemPrompt too? No — "before provider conversion, decide system/messages/tools completely" — the controller decides ALL three. Default when absent: current path byte-for-byte.

API shape options:
(a) Controller receives session+model and returns {systemPrompt, messages, tools}. Messages in what format? To be byte-compatible default, the native path builds messages via buildContext() which returns some message shape, then createContext converts to LLM message shape. If the controller returns messages in the LLM-ready shape, then default-absent needs to reproduce the exact same conversion — testable by comparing native vs controller-wrapped output byte-for-byte.
(b) Controller receives the native context and returns a modified one — but that's not "decide completely before conversion".

Minimal design: controller returns the final LLM message array (or a context-like object) that createStreamFn/streamSimple consumes. The guarantee of byte-compat default: the seam is `if (!options.contextController) { ...existing code... }` — i.e., a pure branch, no code path changes to the native branch. Test: run the same turn with and without the controller where the controller reimplements the native output — assert byte equality of the provider payload (via before_provider_payload capture). Actually simpler: contract test that the native path (no controller) produces an identical provider payload before and after the seam lands (regression on existing harness tests). And a test that with controller present, buildContext is not called.

Testing "Iris path never calls buildContext": a probe/counter. Options: (i) monkey-patch/instrument Session.prototype.buildContext to count calls in the test harness; (ii) a debug counter in the harness options (e.g., a `hooks.onBuildContextCalled` or a `debug: { countBuildContextCalls: true }`); (iii) make the seam such that when the controller is present, the code path provably excludes the call (static reachability — e.g., early return before buildContext). Best: (iii) structural + (i) executable: in the contract test, wrap buildContext with a spy that throws if called; run a full Iris turn; assert no throw + provider payload matches the controller output. A spy-that-throws is stronger than a counter because it fails fast. But careful: if anything in the native harness legitimately calls buildContext for other purposes (session tree, save points), the spy must be scoped to the turn's provider path. The requirement "Iris path must not force Session.buildContext()" — scope the spy to the createTurnState→createStreamFn window.

Also: systemPrompt — pi already resolves systemPrompt (string or fn). The controller should be able to override it. Keep the resolver available to the controller (pass resolved native systemPrompt as a default parameter, controller may override). Hmm — "decide system/messages/tools completely" — controller decides all three. Give the controller `{ session, model }` plus maybe `defaultSystemPrompt` for convenience, and it returns all three. Default when absent = native.

Tools: what shape? Pi tools are in some tool registry shape; provider conversion converts them. To "decide before conversion", controller returns tools in pi's tool shape, and the conversion runs after. But for Iris, tools come from Iris's Tool System — so the controller maps Iris tool specs into pi's tool shape. Keep the seam at the pi tool shape (pre-conversion), not post-conversion — because "before provider conversion".

Effort: Short (the fork change is small — one optional hook + branch + tests).

Byte-compatible default guarantee: (1) the native branch is textually unchanged (pure if/else); (2) regression: existing pi harness tests still pass; (3) explicit test: run a scripted turn with controller=undefined → capture before_provider_payload → assert equals a golden record captured pre-seam (store golden in test fixtures, or compare across the seam commit via CI on the fork).

Edge: message shape mismatch between buildContext output and LLM-ready shape — the controller returns LLM-ready messages (the same shape createContext produces). For byte-compat of the DEFAULT, what matters is that no-controller path is unchanged; the controller path has its own contract test (Iris turn → payload equals controller output, buildContext spy not called).

**Q3: RuntimeEvent ledger schema**

v13 trajectory: immutable ContextMessageUnit(contextSeq) ledger, identity-level, dual projection. R1 minimal: eventId/runtimeSessionId/entryId/entrySeq/contentHash/eventType/contextSeq(optional)/disposition(include/reference_only/exclude)/derivationRefs placeholder.

Where to persist in R1? Options:
(a) In-memory + persist R2 — risk: Exit Gate 3 "crash-window ordering + exactly-once attribution executable verification" — crash-window tests NEED durable persistence to verify what survived a crash. Without persistence, crash-window verification is impossible (or only tests the in-memory ordering). So R1 MUST persist, at least to the extent needed for crash-window verification.
(b) SQLite — but which store? There's the existing v12 context-store.sqlite (session-derived, keyed on pi entry seqs). The v13 direction moves away from session-derived context to identity-level contextLineageId. Should R1 write into a NEW store (runtime_events.sqlite / ledger store) or into the existing context store?

The v13 canonical chain: RuntimeEvent → Context ingest → ContextMessageUnit. The RuntimeEvent ledger is the INPUT side — it's the raw event log, before Context ingest. So it's a distinct concern from the Context store. R1 minimal: a runtime-event ledger table. Given crash-window verification (Gate 3) and "immutable ledger" trajectory, I recommend: persist in R1, in a dedicated minimal store — but WHICH file? 

Considerations:
- Reuse context-store.sqlite file with a new table? The v12 context-store is Session-derived and will be refactored/bypassed (Q5). Mixing the new immutable ledger into a store that's slated for migration risks coupling. But opening a second SQLite file adds connection/transaction management. Hmm.
- Actually there's a subtlety: the ledger is about Pi session entries (entryId/entrySeq) + event lifecycle, whereas the v12 store is about context lineages/m0/m1/LKG. They're different domains. The R2 trajectory: RuntimeEvent ledger → ContextMessageUnit ledger (identity-level). The R1 ledger is the seed of the R2 immutable ledger. So R1 should create the ledger schema that R2 extends — a dedicated `runtime_events` table + `session_commit_receipts` (or fold receipts into events). 

My recommendation: persist in R1 (Gate 3 demands it), in a NEW dedicated SQLite database `runtime-ledger.sqlite` (or a new table set in a new file) OWNED by the runtime module, with schema: 
- `runtime_events`: event_id (uuid/ulid, monotonic-ish), runtime_session_id, event_type (message_finalized|session_committed|tool_execution_committed|tool_result_committed|turn_committed|agent_settled|user_message_appended|...), entry_id (nullable), entry_seq (nullable), content_hash, context_seq (nullable, R2), disposition, derivation_refs_json (placeholder), created_at (monotonic), position/ordering token.
- Exactly-once attribution: a unique constraint on (event_type, entry_id) or a dedupe via content_hash + event position? Hmm — "exactly-once attribution" means each pi entry is attributed to exactly one RuntimeEvent and the ledger has no duplicates/gaps. Dedupe strategy: unique index on (event_type, entry_id, entry_seq) where applicable, plus an idempotency key column for receipt processing. Also a monotonic `position` (the pi entry_seq is a natural ordering key within a session — but RuntimeEvents from a single runtimeSessionId map to a single pi session? Actually runtimeSessionId is identity-level and may span multiple pi sessions across rollovers — so within R1, event ordering uses pi entry_seq + a local monotonic counter; cross-rollover ordering deferred to R2 with contextSeq).

Actually wait — is the ledger per pi-session or identity-level? v13: RuntimeEvent → Context ingest. Rollover does not migrate Context. The runtimeSessionId (identity-level) spans rollovers; each rollover creates a new pi session (bounded raw archive). R1: one runtime session, one pi session — the ledger can be keyed by runtimeSessionId with pi entry seqs as the ordering spine. R2 adds contextSeq and the ContextMessageUnit projection. So the R1 schema should include context_seq as nullable placeholder (as the user says) and derivation_refs placeholder. Good.

Store choice: I lean to a NEW dedicated store owned by the runtime module (e.g., `runtime-events.sqlite` or table in a `ledger` db), NOT the v12 context-store, because (a) v12 store is session-derived and slated for refactor, (b) the ledger is the input-side raw event log, not context state, (c) mixing would entangle Q5's bypass decision. BUT — there's an argument for writing into the existing db file to avoid a second connection: the existing v12 context-store is open anyway. Hmm. Let me think about what minimizes R1 effort without blocking R2: The R2 ContextMessageUnit ledger will itself be a new identity-level store (or new tables). The R1 RuntimeEvent table is the seed. If R1 puts RuntimeEvents into the v12 store's DB file as a new table, then R2 either keeps that file and adds ContextMessageUnit tables, or migrates. The v12 store is "Session-derived" — its schema keys context on pi entry seqs. The DB FILE itself isn't conceptually doomed, just its session-derived semantics. Adding a new `runtime_events` table to the existing file: cheaper (one connection, existing migration tooling, existing init/empty-db validation in place per AGENTS.md). But coupling: the file is owned by context module... cross-module ownership rules (AGENTS.md: each persistent state has one authoritative owner; cross-module access via narrow versioned contracts). If the runtime module needs to write events, and the context-store module owns the file — that's an ownership violation unless the runtime module owns the new table (which is fine: ownership is per-table/state, and the context-store code shouldn't touch it).

Decision: R1 persists, in a dedicated new table `runtime_events` (+ optional `session_commit_receipts`), created via the SAME sqlite infrastructure (whichever DB file, decide by ownership: put it in a NEW file owned by the runtime module — cleanest for ownership and R2 trajectory; the migration tooling exists). Actually, let me reconsider — the existing v12 context-store has migration infra. A new file means new migration wiring. Small cost. Ownership cleanliness: the runtime event ledger belongs to the runtime module (RuntimeCoordinator/harness side), not the context module. So new file `runtime-ledger.sqlite` (or `runtime-events.sqlite`) owned by runtime module. I'll recommend that, noting the alternative (table in existing file) as acceptable if the team wants to avoid a second connection, with the ownership caveat.

Hmm wait — but is there a simpler R1 answer? "Keep in-memory + persist R2" — rejected because Gate 3 crash-window verification is not executable without durability. Actually, could the crash-window test run against in-memory ledger by killing the process? No — in-memory dies with the process; crash-window tests need to verify what a RESTARTED process sees. Unless the crash test only verifies in-process ordering... Exit Gate 3 says "user/tool/assistant/crash-window ordering + exactly-once attribution executable verification". Crash-window = behavior across a crash/restart. Needs persistence. Decisive: persist in R1.

Schema details (R1 minimal, R2-ready):
```
runtime_events:
  event_id TEXT PK            -- ulid, monotonic
  runtime_session_id TEXT NOT NULL  -- identity-level, NOT pi session id
  pi_session_id TEXT          -- for traceability to raw archive (R1)
  event_type TEXT NOT NULL    -- enum: message_appended/receipt, message_finalized, session_committed, tool_call_committed, tool_result_committed, turn_committed, agent_settled, abort, ...
  entry_id TEXT               -- pi entry id
  entry_seq INTEGER           -- pi entry seq (ordering spine within pi session)
  content_hash TEXT           -- attribution
  context_seq INTEGER         -- NULL in R1
  disposition TEXT            -- include | reference_only | exclude
  derivation_refs TEXT        -- JSON placeholder, [] in R1
  created_at INTEGER          -- monotonic wall/epoch (for diagnostics)
  idempotency_key TEXT UNIQUE -- exactly-once processing key
```
Unique constraint for exactly-once: idempotency_key per (event_type, entry_id) dedupe. Also a unique index on (event_type, entry_id) where entry_id not null to enforce one event per entry per type — that enforces exactly-once attribution at the ledger level.

Ordering: within a pi session, entry_seq is the spine. The append semantics constraint: companion+UserMessage consecutive → companion.parentId === user entry id, adjacent entry_seq. So the ledger must preserve that adjacency — events carry entry_seq so ordering is reconstructable. Crash-window test: append user msg (receipt r1, seq 5), crash BEFORE tool_call commit; restart → ledger must show seq 5 present, tool event absent, and the harness must not synthesize a repair.

**Q4: R1 vertical slice shape**

Components:
- Mock provider (deterministic, scripted responses: fixed tool-call sequences, fixed completion) + opencode-go deepseek-v4-flash as the real non-thinking provider.
- The slice: user message → pi session append (receipt) → context from PI-015 controller (NOT buildContext) → provider → tool_call event → tool execution (mock tool registry) → tool_result commit → assistant finalized → turn committed → agent settled.
- Test matrix: contract tests driving the deterministic mock through scripted scenarios:
  1. Happy path: user → assistant (no tools) — ordering of events asserted: user_appended < message_finalized(user) < turn... wait, need to define the exact lifecycle. Order: user message appended+finalized → session_committed (after each append? or per turn?) → provider request → tool_call committed → tool_result committed → assistant message finalized → turn_committed → agent_settled.
  2. Tool loop: user → tool_call → tool_result → assistant → settled. Assert tool-loop contract: N iterations bounded, no synthetic repair.
  3. Tool loop limit/abort: tool loops capped (config), abort event fires, lifecycle reaches settled/abort without repair.
  4. Crash windows: kill/restart at each boundary — assert ledger contains exactly the committed prefix, no gaps, no synthetic assistant/ToolResult, attribution exact (each entry attributed once).
  5. Exactly-once: replay delivery of a receipt (simulated duplicate) → no duplicate ledger rows (idempotency key).
  6. Gate 1: buildContext spy-throws test on the real-provider vertical slice.
  7. Gate 2: native path (no controller) byte-compatible payload (golden comparison).
  8. Ordering invariant: companion/UserMessage adjacency — assert ledger preserves adjacent entry_seq for companion pairs.
- Crash-window boundaries: define the atomic commit points — the ledger write is the commit point; crash windows = (a) after append receipt but before provider request, (b) after tool_call committed before tool_result, (c) after assistant finalize before turn_committed, (d) mid-tool-execution. For each, restart and assert the invariant set.
- Structure: runMinimalSlice extended into a scenario-driven harness: scenario scripts (JSON) → assert expected event sequence. Mock provider is deterministic; real provider slice shares the same assert harness but with looser content assertions (structural assertions only: event types/order, attribution) — content assertions only for mock.

No synthetic repairs (Gate 4): the harness must not inject assistant messages or ToolResults that weren't produced; the test asserts absence: after any crash, the resumed turn does not fabricate a completion; if provider response is missing, the turn stays open (or is marked aborted) with the ledger showing the gap — never a fake entry.

**Q5: v12 Context code sequencing**

Options: (a) bypass v12 entirely, parallel minimal RuntimeEvent ledger path; (b) refactor v12 to consume RuntimeEvents.

v13 trajectory: identity-level ContextMessageUnit ledger, rollover does not migrate Context. The v12 store is Session-derived (represented_through_entry_seq keyed on pi entry seqs). Refactoring it to consume RuntimeEvents is essentially rewriting it into the v13 Context store — that's R2+ work. For R1, the smallest step that doesn't block R2: (a) bypass — build the RuntimeEvent ledger as the new minimal path; LEAVE v12 code in place untouched (it's migration material / historical); the R1 vertical slice uses the new path only. R2 then builds the identity-level ContextMessageUnit store consuming the RuntimeEvent ledger, and v12 gets deleted after R2 milestone when the Context History Read Port is done.

Key point: bypass must be a CLEAN bypass — the harness factory's static hook chain currently routes through the Iris Context Adapter (context-adapter.ts) which does transformContextMessages (input companion fold, filter iris_input_meta). That adapter is the v12 ingestion point. R1: the provider context controller replaces the adapter's role (controller provides messages directly, already folded/filtered, since the controller owns context construction). So the v12 context-adapter becomes unused in the Iris provider path. But careful: is the v12 Context still used for anything else in R1 (Historian projection is R2)? Yes — v13 says Historian projection is part of the dual projection, but that's not an R1 deliverable (R1 deliverables listed don't include Historian; Historian is listed as the second projection of Context, but R1 is about RuntimeEvent lifecycle + controller + slice). So R1: nothing consumes v12; keep it compiling and untouched; add a note/removal condition (delete when R2 ContextMessageUnit store lands and ContextHistoryReadPort reads from it).

Decision: (a) bypass, with the discipline that the bypass is structural (new path), not a flag toggle — don't create an "if v13 else v12" runtime switch; the new path replaces the old path's use in the harness, v12 remains as dead/migration code. Hmm — actually a toggle for one milestone could be OK for rollout safety, but better: replace wiring in harness-factory so the Iris path uses the controller; the v12 adapter stays as a module but unhooked. Test: existing R0 tests that exercise v12... do they exist and must they keep passing? R0 tests may test context-store directly. Keep them passing (v12 module intact), but the harness-level integration moves to the new path.

**Q6: Fork seam landing strategy**

Single PR vs split for PI-015+016+017 (+PI-018 minimal). 

Carried-patch policy: every carried patch needs generic rationale + tests + removal condition + upstream PR status.

Considerations: 
- PI-015 (controller) and PI-016/017 (receipts + event granularity) are independent features but they touch the same harness code region (createTurnState / harness lifecycle). Overlapping edits → merge conflicts if split across PRs in parallel; but if landed sequentially (one after another), splits are fine and each PR is smaller/reviewable.
- The fork governance (R0 merged) presumably defines the review process. Smaller PRs are easier to review and to keep "generic" (each patch's generic rationale is cleaner when scoped).
- The upstream PR status: earendil-works/pi is upstream. Upstream-first policy — the fork should first try to upstream these seams to earendil-works/pi. Realistically, PI-015 (context controller) is a plausible upstream feature (a context override hook is generic); PI-016 (append receipts) is generic; PI-017 (event granularity) is generic. PI-018 archive API is generic too. So the upstream PRs should be opened against earendil-works/pi regardless; the fork carries them until merged upstream, with removal condition = "upstream merged, fork rebased onto it, package bump".
- Sequencing on the dependency axis: iris_agent needs the seam CONTRACT to be stable. If all three land in one PR, the contract is defined once, and iris_agent's dependency bump happens once (0.82.1 → fork 0.83.0-dev pin). If split into 3 PRs, iris_agent could consume incrementally (bump after each) — but that's 3 dependency bumps. Single PR = one bump, one contract stabilization point, and the seams are cohesive (they're all "harness lifecycle seam" work). Risk of single PR: larger review surface; if one seam is contentious (e.g., PI-015's skip-buildContext semantics), it blocks the others.
- Given R1's gate dependencies (Gate 1 needs PI-015; Gate 3 needs PI-016/017), and the fact that the seams are cohesive, I recommend: **one carried-patch PR for PI-015+016+017** (the harness-lifecycle batch), with PI-018 minimal (archive close/sequenced reads) split OUT — because PI-018 is not needed by R1 gates (archive reads are R2's Historian/history port concern) and "explicit Session close, sequenced archive reads" IS in R1 deliverables... wait, re-read: "R1 deliverables (20%): ... explicit Session close, sequenced archive reads, settled/abort/tool-loop contracts". So sequenced archive reads ARE an R1 deliverable! Hmm. PI-018 is "Archive API: consistent forward sequenced reads, malformed-row semantics, explicit close, diagnostics."

So R1 deliverables include explicit Session close + sequenced archive reads. Is that the PI-018 fork seam or can iris_agent do it via existing session APIs? The pi Session already is an archive (JSONL). Sequenced reads + explicit close: the session store in pi — does it already support forward reads and close? PI-018 says "consistent forward sequenced reads, malformed-row semantics, explicit close, diagnostics" — this is a spec'd seam, implying current pi archive reading has gaps (maybe no explicit close, malformed-row behavior undefined). For R1, what does iris_agent need? The vertical slice's crash-window tests need to REOPEN a session after crash and read forward sequentially — that needs PI-018's guarantees. So PI-018 minimal (explicit close + forward sequenced reads + malformed-row semantics) IS in the R1 critical path for Gate 3.

Hmm, but does it need to be in the FORK, or can iris_agent implement archive reads on top of pi's existing session store APIs? The spec lists PI-018 as a fork seam requirement (PI-015~PI-019 "Pi fork seam requirements"). So the fork must provide it. But "minimal" — the diagnostics part can be deferred. So the batch: PI-015+016+017 in one PR; PI-018 minimal (forward sequenced reads + explicit close + malformed-row semantics; diagnostics deferred) either in the same PR (if it touches adjacent code — session storage is a different module from harness, so likely disjoint) or a second PR. Since session storage is likely a different code area than the harness lifecycle, a second PR for PI-018 is clean and can land in parallel. PI-019 (storage perf) — NOT R1; defer entirely (it's bounded cache + no full cache rollback copies; R2 concern; note it).

Decision: **two PRs**: PR-1 (harness lifecycle batch: PI-015+016+017), PR-2 (archive API: PI-018 minimal). PI-019 deferred to R2. Each patch carries: generic rationale (why earendil-works/pi itself benefits), tests (generic tests, not Iris-specific — e.g., PI-015's tests use a fake controller, PI-016 tests assert receipt shape), removal condition (upstream merge + fork rebase), upstream PR status (opened/merged/PR# — record the actual earendil-works/pi PR link; upstream-first means the fork patches should be submitted upstream FIRST and the fork tracks them).

Also note version/dependency: iris_agent bumps to fork pin once both PRs land (one bump), OR two bumps. One bump after both PRs → less churn. But PR-1 (harness lifecycle) is the hard dependency for Gate 1/3 — iris_agent can start consuming on PR-1 alone with PR-2 landing during the slice phase. Actually PI-018 is needed for crash-window REOPEN tests — those come late in the slice phase. So: bump once after PR-1 merges; PR-2 lands before the crash-window tests are finalized. Or single bump after both. I'll recommend: consume incrementally but minimize bumps — practical: one dependency bump after PR-1 (contracts for the ledger), PR-2 lands in the same fork milestone window before crash-window verification completes.

**R1 work breakdown phases:**

Phase 0 (Fork PR-1): PI-015 controller + PI-016 receipts + PI-017 lifecycle events. Deliverables: seam implementation + generic tests + upstream PRs opened (earendil-works/pi) + removal conditions recorded. Lands in blueforst/pi. Deps: none.
Phase 1 (Fork PR-2): PI-018 minimal archive API. Can run parallel with Phase 0. Lands in blueforst/pi.
Phase 2 (iris_agent dependency + contract adapter): bump iris_agent to fork pin; map PI-017 events + PI-016 receipts into RuntimeEvent ledger writes; map PI-015 controller as the Iris context source (systemPrompt from Persona/system, messages from Iris Context, tools from Tool System). Deliverables: RuntimeEvent adapter + ledger store (runtime-events table) + SessionCommitReceipt type. Lands in iris_agent. Deps: Phase 0.
Phase 3 (Ledger + lifecycle contracts): ledger schema/migrations + exactly-once dedupe + ordering invariants + settled/abort/tool-loop contracts wired into runtime-coordinator. Lands in iris_agent. Deps: Phase 2.
Phase 4 (Vertical slice + gates): mock deterministic baseline + real provider slice + contract test matrix + crash-window tests + Gate 1 (buildContext spy) + Gate 2 (byte-compat) + Gate 3 (ordering/attribution) + Gate 4 (no repair). Lands in iris_agent. Deps: Phase 3 + Phase 1 (for reopen).
Phase 5 (PI-019 note + R2 handoff doc): record deferral, define R2 entry conditions (identity-level ContextMessageUnit ledger consuming RuntimeEvents, Historian projection). Lands in iris_agent (docs) / roadmap.

Effort estimate: R1 is a 20% milestone; overall Medium-Large across repos. Fork PR-1: Short-Medium; PR-2: Short; iris_agent ledger+adapter: Medium; slice+gates: Medium.

**Risks & mitigations:**
1. Version drift / 0.82.1 → 0.83.0-dev breaks R0 lock: pin fork commit, run R0 regression suite + pi compatibility tests, gate the bump.
2. buildContext skip semantics: if pi's createTurnState uses buildContext output for OTHER internal purposes (session tree, save points, `context` event), skipping it entirely when the controller is present could break internal invariants → the seam must scope the skip: when controller present, buildContext may still be needed for the session tree/archive bookkeeping? Hmm — actually the session tree is built from entries (the archive), not from buildContext. buildContext produces the LLM context. The `context` OwnEvent fires with the context object — with a controller, it should fire with the controller's context (or be suppressed). Mitigation: contract test that runs a full turn with controller present and asserts no other harness subsystem breaks (session tree event still correct). This is the biggest technical risk of the seam. Wait — actually should the controller REPLACE buildContext or supplement? "before provider conversion, decide system/messages/tools completely; Iris path must not force Session.buildContext()" — force = the Iris path must not be forced to call it. So skip when controller present. But internal use: does anything else consume context.messages between createTurnState and streamSimple? before_provider_request fires and could. In the fork, the harness's own retry logic might use the context... risk area; mitigation: test.
3. companion/UserMessage adjacency constraint: Iris's companion bridge (before_agent_start companion) + input fold — the R1 controller produces messages; if iris needs companion entries in the pi archive for attribution, the adjacency constraint means Iris must append companion+user atomically (consecutive). The controller path changes where folding happens (in the controller, not the adapter). Risk: double-folding or missed folding → mitigation: contract test asserting the folded message set equals the transformContextMessages output on the same input (parity test between v12 adapter output and controller output for the same scripted turn). That's a nice parity test: byte-compare v12 adapter's transformed messages vs controller's messages for identical input fixtures → proves no regression in message semantics while the path changes.
4. Crash-window test flakiness in CI: process-kill tests are OS-sensitive (Windows dev box!) → use child-process crash simulation (spawn a subprocess that performs a scripted turn and exits at a signaled point, then assert ledger on restart) rather than SIGKILL timing races. Deterministic via injected crash points (test hook: "crash after committing event X").
5. Ledger store migration: new store needs empty-db init validation (AGENTS.md requirement) → include migration smoke test.
6. Real provider slice (deepseek-v4-flash) nondeterminism: structural assertions only for the live slice; content assertions only in the mock.
7. 23-event adapter (if someone pushes Option B): I'm recommending C so this is moot, but note the trap.

**Open questions for the orchestrator:**
1. Dependency mechanism: private registry/npm pack tarball vs git+https ref for the fork pin — does the team already have a mechanism for consuming fork packages (R0's fork governance merged — how did R0 consume? Actually R0 was governance-only? R0 complete = pi fork governance merged, production locks in place — the lock says npm 0.82.1, so R0 did NOT consume fork packages yet. So consuming fork packages is NEW → need decision on tarball/registry/link mechanism.)
2. Does buildContext() get called anywhere else in the harness beyond createTurnState (e.g., in save_point/session_tree/retry paths)? — needs a quick audit before PR-1 to scope the skip. (I can note this is verify-in-code.)
3. Exit Gate 2 "default Pi native path stays compatible" — is the acceptance an automated golden-payload regression in CI on the fork, or the upstream pi test suite? Which suite is authoritative?
4. Does R1 need the `context` OwnEvent to emit the controller's context (for observers/diagnostics), or should it be suppressed on the Iris path?
5. PI-018 diagnostics scope — defer fully or minimal (error messages only)?
6. Where does the real-provider slice run in CI (cost/network)? Mock in CI, live provider as an optional gated run?
7. RuntimeEvent event vocabulary: is `disposition` assigned at ingest (R1) or does it arrive from Context ingest (R2)? In R1, default include; confirm.

Let me also reconsider Q1 once more. The question says "Which order minimizes risk while satisfying Exit Gate 1". I chose C with fork-first ordering. Let me double-check the alternative reading: maybe B (adapter now) is actually lower risk for R1 because it doesn't touch the fork at all, and Gate 1 could be satisfied by overriding at before_provider_payload. But I argued the ledger durability semantics need real receipts. And the spec text itself (PI-015) mandates the seam; the Exit Gate 1 verification would be weak/cheaty under B (you'd be verifying "provider got overridden context" while buildContext still ran). Also, the "session-derived" v12 Context is exactly what Gate 1 wants to eliminate; overriding the provider payload while the harness internally still runs buildContext means the internal pipeline still constructs session-derived context (wasted + semantically wrong for Iris identity-level context), and any harness logic reading context.messages (retries, save points) would operate on session-derived context. So B is a dead-end that would need rework. A (land everything incl. PI-018/019) over-commits. C with ordering = fork PR-1 → consume → fork PR-2 (archive) before crash-window tests → gates. Decisive: C.

Actually, one more consideration on Q1 ordering: can iris_agent START work (mock baseline, contract definitions, ledger schema) BEFORE the fork PR lands? Yes — contract-first: define the RuntimeEvent/Receipt contracts as TypeScript types in iris_agent (mirroring the planned PI-016/017 shapes), build the mock-driven slice against a fake seam (a thin seam-adapter interface in iris_agent), and swap the real fork consumer in when PR-1 lands. This decouples the critical path from fork review latency. The seam adapter interface (e.g., `PiSeamPort`: `appendUserMessage(): Promise<Receipt>`, `onLifecycleEvent(cb)`, `buildProviderContext(controller)`) isolates the fork dependency. That's actually the key de-risking move: iris_agent defines the port, the fork provides the adapter. I should include this in the plan — it's the concrete way C minimizes risk.

Hmm, but careful: if the seam port is defined in iris_agent and the fork adapter maps to it, then the PI-016/017 shapes in the fork should match the port contract — define the contract shape ONCE (in the fork PR description / a contract doc), mirror in iris_agent types. Byte-exact matching needed. Fine.

Also: Exit Gate 1 wording "Iris normal Provider path does NOT construct Context from Session.buildContext()" — with the controller, the Iris path constructs Context from the RuntimeEvent ledger → Context ingest (or, in R1 minimal, from the controller's direct assembly). Wait — for R1, is Context already the ledger-ingested one, or does the controller assemble messages directly? R1 deliverables: "Provider Context Controller (full systemPrompt/messages/tools replacement BEFORE provider conversion)". So R1 = the controller is the context source; the ContextMessageUnit ledger ingest is R2. The controller in R1 reads from... the RuntimeEvent ledger (events → minimal context projection) — that's the "Context ingest" seed. So in R1, the controller's messages come from a minimal projection of the ledger (the canonical chain start: RuntimeEvent → Context ingest). Yes — that ties Q3/Q4 together: the vertical slice's context comes from ledger-derived projection, not session. Good, consistent.

One more Q5 detail: "smallest step that does not block R2's identity-level ContextMessageUnit ledger" — bypass (a), but ensure the RuntimeEvent ledger schema has context_seq nullable + derivation_refs placeholder (done in Q3) so R2 ingests without schema break. Also ensure the v12 context-store remains untouched so R0 regression tests pass. Also flag: the v12 context-adapter's transformContextMessages logic (companion fold + iris_input_meta filtering) must be REPLICATED into the R1 controller projection (parity test as mitigation). Good.

Now let me also sanity-check the vertical slice test matrix against Gates:
- Gate 1 test: buildContext spy-throws on live slice (real provider optional; mock suffices for the "never called" assertion, run on both).
- Gate 2 test: native path golden payload regression (fork-side CI).
- Gate 3 test: scripted ordering scenarios + crash-window boundaries + exactly-once replay dedupe (mock, deterministic).
- Gate 4 test: crash scenarios assert no synthetic assistant/ToolResult in ledger or resumed output.

Crash-window boundaries definition: the atomic units are ledger commits. Windows:
W1: after user append receipt, before provider request (crash → resumed turn must re-run provider from the same user msg, no duplicate append).
W2: after tool_call committed, before tool_result committed (crash → on resume, tool result missing; contract: do NOT synthesize a result; abort the tool or re-request provider — define: the turn must not fabricate; resume policy = re-run provider with the tool_call in context? Actually careful — no synthetic repair means: don't inject a fake ToolResult. The resume can legitimately re-issue the tool call (real execution) — is that "repair"? No — repair = fabricating content that wasn't produced. Re-execution is legitimate but must be exactly-once accounted: the ledger records the original tool_call; re-execution creates a NEW tool execution event (attributed). The key test: no ToolResult row appears unless a real execution produced it, and attribution (content_hash) matches.
W3: after assistant message finalized, before turn_committed (crash → assistant message exists, turn_committed missing; resume: turn must be finalized/committed without re-running the provider — else duplicate assistant messages; contract: turn_committed is idempotent).
W4: after session_committed (turn done) — crash → settled missing; resume: settled is derivable (idempotent event), no re-run.
Also W0: crash DURING append (between entry write and receipt) — receipt not returned → client must retry append; dedupe via idempotency (pi entry may or may not have been written; exactly-once attribution: if the entry exists, the retry returns the SAME entryId — requires pi append idempotency or content-hash lookup; this is a real risk area to flag: pi's append API needs an idempotent retry path or the ledger dedupes by content_hash. Flag in risks/open questions.)

Tool-loop contract: max iterations (config, e.g., 10), exceeded → abort event → turn aborted (not repaired). Abort contract: on user abort signal → in-flight provider request cancelled, lifecycle transitions to aborted, ledger records abort, no partial assistant message fabricated. settled contract: agent_settled only after all pending commits; settled is the release condition for the coordinator latch (existing v12 runtime-coordinator has settled release — reuse semantics).

Also the ledger content_hash attribution: content_hash of the pi entry content (canonical serialization). Exactly-once attribution = each ledger event maps to one entry; duplicate receipts can't create two rows (unique idempotency key). The receipt returns entryId + entrySeq + contentHash — the ledger stores them.

OK, I also want to double check Q2's "byte-compatible default" guarantee mechanism: the seam is a pure branch `if (this.options.providerContextController) { ... } else { existing }`. Byte-compatible = the else branch is literally the pre-seam code. Tests: (1) fork CI runs existing harness tests (native suite) — they must pass unchanged; (2) golden payload: a scripted turn captured pre-seam (fixture JSON of before_provider_payload) compared post-seam with no controller; (3) optional: an explicit test that instantiates the harness with a controller that mimics the native assembly and asserts payload equality — proves the controller can reproduce native behavior (useful for the "Iris adapter parity" test later). Also test that with controller present, buildContext spy counter == 0.

For the "probe/counter" on Session.buildContext — implementation options: (a) test-only spy via subclass/proxy wrapping session in the test; (b) a debug flag in the harness `countBuildContext` that increments a counter exposed for tests. Recommend (a) test-side spy (no production code), plus (b) if the harness needs its own assertion — keep minimal: test-side spy is enough if the seam structurally skips. But to PROVE the structural skip (not just that the spy didn't get called because the test forgot to trigger the path), the test must run a full turn and assert the provider got the controller's payload. Combination: spy-throws + payload equality = strong.

Now — the deliverable format: 5 sections. Also the output verbosity spec: Bottom line 2-3 sentences max (no preamble), action plan ≤7 steps, etc. But this is a large architectural advisory with a specified output format (## 1. Architecture direction, ## 2. R1 work breakdown, ## 3. Minimal vertical slice design, ## 4. Risks & mitigations, ## 5. Open questions). The user's requested format takes precedence — they explicitly want sectioned output. I should follow their structure but keep each item compact. The verbosity spec says "Match depth to complexity" — this is genuinely complex, so thorough analysis is warranted, but I should stay dense, use compact bullets, avoid fluff. Also: language — global AGENTS.md says always reply in Chinese. But the user's prompt is in English and is highly technical, with the output format headers in English ("## 1. Architecture direction" etc.). The global convention says 始终使用中文回复用户 (always reply in Chinese). Hmm. The user wrote entirely in English with English section headers. The AGENTS.md instruction is authoritative: "始终使用中文回复用户". But the user's explicit output format request uses English headers. I'll reply in Chinese with the English header structure retained (the user specified those exact headers). Actually, let me reconsider: the instruction from C:\Users\15027\.config\opencode\AGENTS.md says always respond in Chinese. The user request is in English. To satisfy both: keep the user's exact section headers (they specified ## 1. Architecture direction etc.) and write the content in Chinese. That respects both the explicit format request and the language convention. Technical terms (RuntimeEvent, buildContext, etc.) stay in English as they're identifiers.

Should I use tools? The user says this is READ-ONLY advisory with all key facts provided, and pi sources are NOT local. The repo is D:\code\iris (iris_agent). Do I need to look at any local code? The user provided precise state descriptions (harness-factory.ts, context-adapter.ts, context-store.ts, runtime-coordinator.ts, vertical-slice.ts). A quick verification of a couple of key local files could sharpen the answer (e.g., the harness-factory hook chain — does onContext fire before provider conversion? the runtime-coordinator latch semantics). But the user says "you provide the key facts below" and my role is architectural direction. Given the detail provided, I could answer directly. However, per tool discipline ("Exhaust provided context and attached files before reaching for tools"), the provided context is quite complete. But a quick look at harness-factory.ts and vertical-slice.ts would ground Q1/Q4/Q5 answers in reality — e.g., confirming whether there's an existing hook where context could be replaced pre-conversion (relevant to the Gate 1 without-seam question), and the current slice structure. The instruction for consultants: "Dissecting codebases" is in my expertise. Let me do a targeted codegraph explore on the key iris_agent files to verify the seam-relevant facts before finalizing — that's cheap and grounds Q1/Q2/Q5 decisions. Also verify the runtime-coordinator's settled/rollover semantics for Q4 (settled contract reuse).

Let me call codegraph_explore with a query covering harness-factory, context-adapter, runtime-coordinator, vertical-slice. That's one call, Read-equivalent. Good.

Also maybe check the R0 lock files (package.json) to confirm pi 0.82.1 pin and how packages are referenced (npm vs git) — relevant to Q6 dependency mechanism. I can grep package.json. Let me do a couple of parallel calls: codegraph explore for the runtime files + read package.json.

Actually let me be judicious: one codegraph_explore (maxFiles ~6) on the runtime module + one read of package.json + maybe grep for "pi-" deps. These are independent → parallel.

Let me think about what specifically to verify:
1. harness-factory.ts: the hook chain — confirm onSystemPrompt/onContext exist and their timing relative to provider conversion. Does the current path already allow replacing messages before conversion? This affects Q1's "can Gate 1 be satisfied without the seam" analysis.
2. vertical-slice.ts: runMinimalSlice structure — mock + live provider, what exists to extend for Q4.
3. runtime-coordinator.ts: settled release, rollover — for Q4's settled contract reuse and crash-window design.
4. context-adapter.ts: transformContextMessages — the parity test basis for Q5.
5. package.json: pi dependency refs.

Then write the final answer in Chinese with the requested English section headers, dense, decisive.

Let me also double-check the effort tags I'll use: Fork PR-1 (PI-015+016+017): Short–Medium (1-4h to 1-2d). PR-2 PI-018: Short. iris_agent ledger + seam adapter: Medium (1-2d). Slice + gates: Medium. Whole R1: Large (3d+) across repos. I'll tag per phase.

One more Q3 consideration — should I double check whether there's an existing "runtime" DB? The v12 context-store is SQLite. Let me check the repo structure for existing DB files/stores (glob for *.sqlite or db code). That informs "new file vs existing file". I'll glob src for store files. Add to parallel calls: glob "**/*store*" or grep. Let me just glob `src/**/*.ts` won't help. Use glob pattern "**/*.sqlite*" for actual DBs and check the src layout via read of src dir? Simpler: codegraph explore will surface the store files if I name context-store. And I can glob for migrations dirs.

OK let me finalize the tool plan:
- codegraph_codegraph_explore(query: "harness-factory createIrisHarness context-adapter transformContextMessages runtime-coordinator vertical-slice", maxFiles 6)
- read package.json (and maybe pnpm-workspace?) — just package.json.
- glob "**/*.sqlite*" — see if DB files exist in repo (probably data dir not committed; still informative).

These are independent → one parallel block.

After tools, write the final answer. Let me draft the structure now so the final message is crisp.

Structure (user-specified):
## 1. Architecture direction
Q1..Q6 each: DECISION + rationale + risks (compact).

Q1 DECISION: C — fork-first hybrid, via a contract-first seam port. Order: land PI-015/016/017 fork PR → iris_agent consumes; PI-018 lands in parallel before crash-window tests. Adapter-only (B) rejected: observer events can't provide awaited durability receipts → Gate 3's exactly-once attribution would be inferred, not verified; and overriding after buildContext ran fails Gate 1's spirit (session-derived context still constructed internally). A rejected: PI-018/019 not needed on critical path.

Q2 DECISION: optional `providerContextController` on harness options; seam between createTurnState's context assembly and createStreamFn; signature `(ctx: {session, model, resolvedDefaultSystemPrompt}) => Promise<{systemPrompt, messages, tools}>`; messages in pre-conversion pi message shape. Default-absent = literal unchanged native branch. Byte-compat proof: pure if/else + native fixture golden payload + existing pi harness suite. "Never calls buildContext" test: test-side spy that throws + full-turn payload equality.

Q3 DECISION: persist in R1 (Gate 3 crash-window verification is not executable without durability). New dedicated SQLite `runtime_events` table (owned by runtime module; new db file `runtime-events.sqlite` or table set — recommend new file for ownership cleanliness per AGENTS.md). Schema listed. idempotency_key unique → exactly-once. context_seq NULL + derivation_refs placeholder → R2-ready. Disposition default include.

Q4 DECISION: scenario-driven slice: mock deterministic provider + real non-thinking provider share one assert harness; structural assertions for live, content+structural for mock. Test matrix incl. 5 crash windows (W0 during-append, W1 post-receipt pre-provider, W2 post-tool_call pre-tool_result, W3 post-assistant pre-turn_committed, W4 post-session_committed pre-settled). Crash injection via child-process + signaled crash points, not SIGKILL timing. No-repair assertion in every crash scenario.

Q5 DECISION: (a) bypass — build RuntimeEvent ledger as the parallel minimal path; v12 store/adapter untouched (R0 tests keep passing); parity test (v12 transformContextMessages vs R1 controller projection on same fixtures) preserves message semantics; deletion condition = R2 ContextMessageUnit store + ContextHistoryReadPort lands.

Q6 DECISION: two PRs — PR-1: PI-015+016+017 (cohesive harness-lifecycle batch); PR-2: PI-018 minimal (archive reads/close/malformed rows; diagnostics deferred). PI-019 deferred to R2. Every patch: generic rationale, generic tests, removal condition (upstream merge + rebase), upstream PR status recorded (open against earendil-works/pi, upstream-first). iris_agent bumps dependency once (pin fork commit).

## 2. R1 work breakdown — phases P0..P5 with deliverables/deps/repo. 
## 3. Minimal vertical slice design — components, data flow, test matrix table-ish.
## 4. Risks & mitigations — top 6.
## 5. Open questions — 6 items.

Effort estimate overall: Large; per-phase tags.

Now the tool calls. Then write. Language: Chinese content, English headers and identifiers. Keep it dense.

Let me run the tools.

Good, the codegraph confirmed key facts. Let me note the important details:

1. `createIrisHarness` builds the hook chain via `harness.on(...)`:
   - `before_agent_start`: companion bridge
   - `context`: **this is the v12 Iris Context Adapter — it's a `context` event handler that REPLACES event.messages via transformContextMessages and returns `{ messages: result.messages }`**. CRITICAL INSIGHT: this is the seam point! The `context` event fires (in pi, before provider conversion — the `context` OwnEvent is one of the 23) and iris_agent ALREADY replaces messages there via `harness.on("context", ...)` returning `{ messages }`. So there IS an existing pre-conversion context replacement mechanism!
   
   Wait — but the harness-factory's `context` handler transforms the SESSION-derived messages (from buildContext) via transformContextMessages. The question: does the `context` event fire AFTER buildContext() ran? Yes — buildContext() is called in createTurnState, which happens before the `context` event. So currently, iris_agent DOES construct context via hooks after buildContext ran, then transforms it. That's the current v12 path.
   
   So for Q1: "can Exit Gate 1 be satisfied WITHOUT the fork PI-015 seam (e.g. by overriding the context before provider conversion through existing hooks)?" — There IS an existing `context` event handler that replaces messages pre-conversion. But buildContext() has ALREADY RUN (it's in createTurnState, unconditional). So:
   - Gate 1 letter: "Iris normal Provider path does NOT construct Context from Session.buildContext()" — if the `context` handler fully replaces messages, the provider payload ISN'T from buildContext. But the handler's REPLACEMENT (transformContextMessages) operates ON the buildContext output (it's a transform, not a full replacement). To fully replace, the handler would ignore event.messages entirely and construct from the ledger/controller. That works — but buildContext() still ran (wasted + the harness internally uses the session context for save points, retry context, session tree, `context` observers, and provider retry logic).
   - Gate letter satisfied-ish, spirit violated (still forced to call buildContext; still session-derived pipeline internally). And the spec PI-015 text says "Iris path must not force Session.buildContext()" — a fork requirement.
   - ALSO importantly: the `context` event in pi — does returning { messages } from the handler actually replace what goes to the provider, or just what observers see? The current code relies on it (transformContextMessages result is used by provider — presumably the harness applies returned messages to the provider payload). Since the current vertical slice works with this mechanism (it's the production path), returning { messages } from the `context` handler DOES change the provider payload. Good — so a full replacement IS possible via the existing hook.

   So my Q1 answer needs refinement: the honest analysis is:
   - Gate 1 CAN be satisfied without the PI-015 fork seam in the letter (replace messages fully in the existing `context` event handler, provider payload not from buildContext). But:
     a. buildContext() still runs → the harness's internal session-derived pipeline still constructs Context (wasted work, semantic wrongness, and the `context` event/message shape drives other internals like retries/save-points/tree). The verification "Iris path does not construct Context from buildContext" would only verify the provider payload, not the internal construction.
     b. The spec mandates PI-015 anyway ("must not force Session.buildContext()").
   - DECISION: still C — fork seam. But the sequencing insight: iris_agent can START R1 work today by replacing the `context` handler with a full replacement (ledger-driven), which de-risks and front-loads — while PI-015 makes the skip structural. Actually — hmm, if we fully replace in the `context` handler, do we still need PI-015 for Gate 1? The gate is executable verification. If the gate test is "provider payload == controller output AND buildContext spy throws during the turn", then WITHOUT PI-015 the spy test FAILS (buildContext is called). So the gate's executable verification (as the spec defines it — "does NOT construct Context from buildContext") requires the skip. Unless the gate is reinterpreted as "provider payload not from buildContext". I should flag this as an open question to the orchestrator: the exact executable form of Gate 1 determines whether PI-015 is strictly required or the `context`-handler replacement suffices. But my decisive recommendation: land PI-015 (skip), because the spec text mandates it and it's the only clean semantics.

2. The `context` handler also reveals the CURRENT tool_result flow: `tool_result` handler scans session entries to find the assistant entry + tool call ordinal, computes toolExecutionKey, and returns `details: { iris }`. This is v12-era "attribution" logic that the RuntimeEvent ledger will supersede. And there's the `before_provider_request` handler for the ToolResult-commit-to-next-provider-call crash window — the vertical slice ALREADY has crash-window machinery (`scripts/crash-worker.ts` — 4 callers of runMinimalSlice!). And the package.json has `crash:harness` and `crash:check` scripts. So crash-window testing infrastructure EXISTS in R0-era code. Great — Q4's crash-window design can build on existing scripts/crash-worker.ts + crash-harness/crash-check. That's a "leverage what exists" point.

3. `VerticalSliceResult` — "no covering tests found" per codegraph, but test/vertical-slice.test.ts exists (in test script list). Fine.

4. package.json confirms: pi deps pinned to exact 0.82.1 (no caret) — production lock. The `test` script includes context-store.test.ts, production-lock.test.ts, rollover.test.ts, vertical-slice.test.ts, runtime-coordinator.test.ts, opencode-go-provider.test.ts, context-golden.test.ts, crash:check. So there IS a rich R0-era test suite. And migration:smoke exists (AGENTS.md requirement honored). Also "test:context-golden" + "context-golden:generate" — golden fixture machinery exists for byte-compat testing! That's a strong precedent for Gate 2's byte-compatible default testing (fork side can use similar golden payload fixtures).

5. No .sqlite files in repo (data dirs are gitignored/local). So store layout: data-root resolved at runtime (resolveDataRootPaths). The context-store SQLite lives under dataRoot. So "new db file" is a runtime data-root path addition — consistent with epochRegistryDb pattern (RuntimeEpochStore uses paths.epochRegistryDb). So a new `runtimeEventsDb` path in data-root is a natural fit — there's already precedent for multiple DB files under dataRoot (epoch registry db + context store + session storage).

Let me quickly verify a couple more things:
- The `context` event handler return value semantic: does returning { messages } replace provider payload? Given the current slice passes tests (context-golden etc.), yes. I'll trust the code comment: "the context hook reflect the CURRENT input" and vertical slice's providerContextSnapshots capture messages at composeProvider onContext — those snapshots presumably equal the transformed messages. OK.
- scripts/crash-worker.ts usage of runMinimalSlice — 4 callers. Worth a quick look to understand existing crash-window mechanics for Q4. Let me do one more targeted explore: crash-worker, crash-harness, crash-check + runtime-coordinator (I didn't get runtime-coordinator source in the truncated output). Actually the output was truncated before runtime-coordinator. Let me explore runtime-coordinator + crash scripts.

That's one more codegraph call — worth it for grounding Q4 (settled contract, existing crash machinery) and Q1 (coordinator latch semantics — is there a queue?).

Then I'll write the final answer. Let me keep it tight after that.

The picture is now much richer than the user's summary. Key verified facts that change/refine my advice:

1. **The `context` event handler in createIrisHarness ALREADY replaces messages pre-conversion** (`harness.on("context", ...)` returns `{ messages: result.messages }` from transformContextMessages). So iris_agent ALREADY has a working pre-conversion context override seam. Exit Gate 1's LETTER could be satisfied by making this a full replacement (ignore event.messages, build from ledger/controller). But buildContext() still runs (createTurnState is unconditional in pi), so the SPIRIT + the PI-015 spec text ("must not force Session.buildContext()") requires the fork seam to skip. This is important nuance for Q1/Q2.

2. **The v12-era code is already "hook-based override" architecture** — the harness-factory is a static chain of harness.on(...) handlers. This is exactly the pattern a PI-015 controller would formalize. The current `context` handler is effectively a proto-provider-context-controller. So PI-015 in the fork generalizes what iris_agent already does in-harness. The transition is: iris_agent's `context` handler does transform-on-session-context today → becomes controller providing full replacement tomorrow. And transformContextMessages logic (companion fold, iris_input_meta filtering, pair verification, projectedUserText with source labels) must be REPLICATED into the R1 controller projection (parity test).

3. **`tool_result` handler computes toolExecutionKey by scanning session entries** — v12-era attribution via session archaeology (entries scan, assistantEntryId + toolCallOrdinal). This is exactly what RuntimeEvents + receipts should replace (the scan is fragile; the ledger makes attribution direct). PI-017's tool_execution_committed event gives this directly.

4. **Crash-window machinery already exists**: scripts/crash-worker.ts (4 callers of runMinimalSlice), crash:harness + crash:check scripts, fault-point injection pattern (`this.faultPoint === "..."` in host.ts: dispose_old, activate_rollover, cas_swap, construct_new). The fault-injection pattern is established — Q4's crash-window tests extend this existing pattern rather than inventing new machinery. The existing fault seams inject SYNCHRONOUS throws at named points; for R1's crash windows (process-level), the child-process + signaled crash-point approach builds on crash-worker.ts.

5. **Rollover/epoch machinery is mature**: beginRollover/activateRollover with 'creating' status + crash recovery (recoverCreating), settled-token authorization (settledTokenBox consumed exactly once), staged Capsule construction. The settled contract for R1: coordinator observes pi native settled → onSettledBoundary fires exactly once per invocation → Host releases + maybe rollover. This is the "agent settled" lifecycle piece that PI-017's event vocabulary must align with. Note: settledTokenBox authorization is based on coordinator observing native settled — R1's RuntimeEvent ledger should record agent_settled as the terminal event and the coordinator's token logic can read from the ledger rather than only observers.

6. **RuntimeCoordinator**: single-writer-ish (queuedInputs FIFO bounded 20), phases, runCompletion. The coordinator's settled release already exists. Good reuse for Q4.

7. **package.json**: exact pins 0.82.1, no caret. Production-lock test exists (test/production-lock.test.ts) — will need updating when bumping to fork packages; that's a concrete touchpoint for Q6. Also context-golden machinery (generate + test) — precedent for golden byte-compat testing → Q2's byte-compatible default test can use the same golden approach on the fork side.

8. **No .sqlite in repo** — DBs under dataRoot at runtime (resolveDataRootPaths gives sessionDb, epochRegistryDb, etc.). So adding a runtimeEventsDb path is precedented (epochRegistryDb precedent). Q3's "new file" recommendation is consistent.

Now, one thing I couldn't verify: pi's createTurnState ordering relative to the `context` event (whether buildContext runs before the context event) — the user stated it: createTurnState() calls buildContext() → context.messages. And the `context` OwnEvent fires during turn state creation or later? The comment in harness-factory says the context hook reflects current input per turn. The user says before_provider_payload fires after turn state built. The `context` event — in pi's own harness, the context event fires when the turn context is created (after buildContext). I'll state the assumption: `context` event fires after buildContext, before provider conversion — consistent with the current transform working. Since the user confirmed the current v12 path works, that's solid.

One more consideration for Q2's seam point: "between createTurnState and createStreamFn?" — but the `context` event is the natural existing seam. The cleanest PI-015 design: an optional harness option `providerContextController` that, when present, is invoked INSTEAD of buildContext + createContext assembly; when absent, byte-identical native path. The fork seam point: in createTurnState, branch before `await this.session.buildContext()`: if controller → messages = controller-provided (converted from controller's message shape), skip buildContext. The controller signature: `(params: { session, model, defaultSystemPrompt, tools }) => Promise<{ systemPrompt, messages, tools }>`. And the harness should still fire the `context` event with the controller's messages (so iris_agent's existing handlers/observers keep working) — important detail: keep the `context` OwnEvent emitting the final pre-conversion messages regardless of source.

Also note for Gate 2 (default native path compatible): since iris_agent ALREADY replaces messages via the context handler today, Gate 2 is about the FORK's default behavior with no controller = today's pi behavior (byte-compatible). The fork PR must not change the no-controller path. Golden approach: capture before_provider_payload for a scripted native turn pre-seam and post-seam, byte-equal.

Now let me also nail Q3 schema refinement with what I saw: there's an existing RuntimeEpochStore (runtime_epochs table, epochId/runtimeSessionId/status/creating recovery). The RuntimeEvent ledger is a NEW store. I'll recommend a `runtime_events` table in a new DB file `runtimeEventsDb` in dataRoot (precedent: epochRegistryDb), owned by the runtime module, with migration + empty-db init (AGENTS.md). Schema:

```
runtime_events (
  event_id TEXT PRIMARY KEY,          -- ulid (monotonic)
  runtime_session_id TEXT NOT NULL,   -- identity-level, NOT pi session id
  pi_session_id TEXT,                 -- traceability
  event_type TEXT NOT NULL,           -- user_message_appended | user_message_finalized | session_committed | tool_call_committed | tool_result_committed | assistant_message_finalized | turn_committed | agent_settled | abort | retry_scheduled | ...
  entry_id TEXT,                      -- pi entry id
  entry_seq INTEGER,                  -- ordering spine (adjacent for companion+user)
  content_hash TEXT,                  -- attribution
  context_seq INTEGER,                -- NULL in R1 (R2 ingest fills)
  disposition TEXT NOT NULL DEFAULT 'include',  -- include|reference_only|exclude
  derivation_refs TEXT NOT NULL DEFAULT '[]',   -- placeholder, R2 fills
  created_at TEXT NOT NULL,           -- ISO
  idempotency_key TEXT NOT NULL UNIQUE
)
CREATE UNIQUE INDEX ux_runtime_events_type_entry ON runtime_events(event_type, entry_id) WHERE entry_id IS NOT NULL;
```
Exactly-once: idempotency_key UNIQUE + the type/entry unique index. Ordering: entry_seq per pi_session; cross-rollover ordering in R2 via context_seq. 

Q4 test matrix — now with existing infrastructure:
- Extend scripts/crash-worker.ts pattern: child-process runs a scripted scenario with an injected crash point (env var CRASH_AFTER=event_type), parent asserts ledger prefix after restart.
- Fault-point precedent (faultPoint strings in host.ts) — synchronous fault injection; for R1 gates use BOTH: process-level crash windows (child process) AND synchronous fault seams where the window is intra-process.
- Test matrix (mock provider, deterministic):
  M1 happy path ordering; M2 tool loop (N=2) ordering + attribution; M3 tool loop limit → abort; M4 user abort mid-stream → abort contract; M5 crash windows W0-W4 (5 windows); M6 exactly-once replay (duplicate receipt); M7 Gate1 buildContext spy-throws (mock + live); M8 Gate2 native byte-compat (fork CI); M9 parity: controller projection == transformContextMessages on same fixtures (regression of v12 message semantics); M10 companion/user adjacency preserved in ledger (entry_seq adjacent); M11 settled contract: agent_settled terminal, coordinator token semantics unchanged.
- Real provider (opencode-go deepseek-v4-flash): M1 structural (event types/order/attribution), M7, no content assertions.

Also note: the existing `tool_result` handler's session-scan attribution (computeToolExecutionKey) becomes redundant once PI-017 tool_execution_committed exists — the ledger replaces the scan. R1 should keep the scan (it works) but the ledger becomes the source of truth for tests; R2 deletes the scan. Or R1 switches attribution to ledger-driven — smaller risk to keep both, assert they agree (the scan = oracle cross-check). I'll recommend: keep v12 handler as-is, add ledger writes alongside, and a cross-check assertion in tests (scan-derived key == ledger-attributed key) — that's a strong exactly-once verification without rewriting the working path. Actually that's a nice "no synthetic repair + exactly-once attribution" executable check: two independent attribution computations must agree.

Q5 with the new insight: the `context` handler IS the v12 adapter's ingestion point. R1 "bypass" concretely = replace the transform-on-session-messages in the `context` handler with a full controller replacement (ledger-projected), move transformContextMessages logic into the controller projection. Wait — but that's not "bypass" anymore, it's refactoring in place. Hmm. Let me re-frame: the v12 Context (context-store.ts, m0/m1/LKG, Session-derived) is separate from the context-adapter (transformContextMessages). The adapter is the message-transformation pipeline; the store is the durable context state. For R1:
- The adapter's transform LOGIC must live on (message semantics: companion fold, iris_input_meta filtering, source labels) — but relocated into the R1 controller projection (the provider-facing transform). Parity test guarantees equivalence.
- The v12 STORE (context_store.sqlite, m0/m1/LKG watermarks, deferred ops) is what R1 bypasses — the R1 path doesn't write context state to it; the RuntimeEvent ledger is the new durable spine. v12 store stays as migration material, R0 tests keep passing, deletion at R2 when ContextMessageUnit store + Historian land.
So decision (a) bypass with adapter-logic relocation + parity gate. That's the smallest step that doesn't block R2: it changes WHERE provider messages come from (controller/ledger) without building any new context state machinery.

Actually, hold on — does R1 even need the ledger → context projection, or does the controller read from prepareContextSources (PreparedContextSources — the existing prepared sources: canonicalSystemPrompt etc.)? Looking at the code: `prepareContextSources(input, runtimeSessionId, epochId, config, now)` returns PreparedContextSources with canonicalSystemPrompt. So there's already a "prepare" concept producing context sources from an input + session/epoch scoping. The R1 controller can compose: systemPrompt from prepared.canonicalSystemPrompt, messages from a projection (ledger-backed), tools from Tool System. The vertical slice already uses this. So the "Context ingest" seed in R1 = ledger-backed message projection in the controller. Good.

Effort estimates:
- P0 fork PR-1 (PI-015+016+017): Short–Medium (1-4h design + 1-2d impl+tests on fork).
- P1 fork PR-2 (PI-018 minimal): Short.
- P2 iris_agent dep bump + seam port + ledger store: Medium.
- P3 lifecycle contracts + coordinator alignment: Short–Medium.
- P4 slice + gates: Medium.
- P5 R2 handoff: Quick.
Overall R1: Large (3d+), realistically 1.5-2 weeks across two repos.

Open questions for orchestrator (final, ≤6):
1. Fork package consumption mechanism: npm overrides with git tarball vs private registry vs local pack+link — R0 locked npm 0.82.1, no precedent for consuming fork builds; needs decision (and production-lock.test.ts update).
2. Gate 1's executable form: is "provider payload not from buildContext" sufficient, or must buildContext be provably NOT CALLED (spy-throws)? Spec text says "must not force" → I recommend spy-throws; confirm.
3. Does pi's buildContext() get invoked anywhere in the harness beyond createTurnState (save_point/session_tree/retry)? Needs a fork-side audit to scope PI-015's skip correctly.
4. Should the `context` OwnEvent emit the controller's messages on the Iris path (keeps observers/diagnostics), and should `before_provider_payload` reflect them? (I recommend yes.)
5. Crash-window tests: process-level child-process kills (crash-worker pattern) accepted in CI on Windows dev box? Or synchronous fault seams sufficient for Gate 3 acceptance?
6. PI-018 diagnostics scope: defer beyond "error messages include row index + reason"?

Also a Q about where the real provider slice runs (CI cost) — merge into 5 or 6. I'll pick the most decision-critical 6.

Risk list (top, ≤7 to stay dense but this is complex — the spec says ≤3 for watch-outs but this is a full advisory with user-specified sections; I'll keep 6 crisp):
R1: dependency bump breaks R0 lock (0.82.1→0.83.0-dev drift) — pin fork commit, run full check suite + pi native harness suite on bump.
R2: PI-015 skip breaks internal consumers of buildContext output (retry/save_point/tree) — fork-side audit + full-turn test with controller present asserting session_tree/save_point still correct.
R3: transformContextMessages semantics lost in relocation — parity gate test (identical fixtures → byte-equal output).
R4: crash-window test flakiness — child-process + named crash points, no timing-based kills.
R5: companion/UserMessage adjacency broken by controller inserts — ledger writes preserve entry_seq adjacency; test M10.
R6: fork review latency blocks R1 — contract-first seam port in iris_agent decouples (mock seam adapter until PR-1 merges).
R7 (maybe): exactly-once during-append crash (entry written, receipt lost) — pi append needs idempotent retry or content-hash dedupe; open question. I'll fold this into open questions and a risk.

Now write the final answer in Chinese, with the user's English section headers. Dense, decisive, compact bullets. Let me draft.

Section 1: six decisions. Each: DECISION (bold), 2-4 bullet rationale, 1-2 risk bullets. Keep tight.

Q1 DECISION: C（混合，fork 优先序）——先落 PI-015/016/017 的 fork PR，iris_agent 以"契约先行 seam port"并行起步；PI-018 在其后、崩溃窗口测试前落地。B（纯适配器）否决：23 个 OwnEvent 是 fire-and-forget 观察者，无 awaited 持久化回执，Gate 3 的 exactly-once 归因只能靠推断、不可执行验证；且 buildContext 已在 createTurnState 内无条件执行，事后覆写违反 Gate 1 精神。A（全量 seam）过度承诺：PI-018/019 不在 R1 关键路径。
关键新证据（代码核实）：createIrisHarness 的 `context` 事件 handler 已是"provider 转换前替换 messages"的现有机制（返回 { messages: transformContextMessages(...) }）——所以 Gate 1 的"字面"可以不靠 fork seam 满足，但 buildContext 仍会被调用；PI-015 的意义正是把这个"事后替换"变成"结构上跳过"。Gate 1 的可执行形式决定 fork seam 是否严格必需（见开放问题 2）。

Q2 DECISION: harness 可选选项 `providerContextController?: (params: { session, model, defaultSystemPrompt }) => Promise<{ systemPrompt, messages, tools }>`，seam 点在 createTurnState 内 buildContext 之前分支：controller 存在 → 跳过 buildContext、直接用 controller 输出装配；不存在 → 原代码逐字节不变（纯 if/else，不重构原生分支）。messages 为转换前 pi 消息形状。Byte 兼容保证：(1) 原生分支文本不动；(2) fork CI 跑 pi 原生 harness 套件；(3) 黄金载荷（沿用 iris_agent 已有的 context-golden 模式）：seam 前后各录一份脚本化 turn 的 before_provider_payload，逐字节相等。"从不调用 buildContext"测试：测试侧 spy（包一层 session，调用即抛错）+ 全 turn 跑通 + provider payload 等于 controller 输出（结构跳过的证明）。注意保留 `context` OwnEvent 在 controller 路径下仍发射 controller 的 messages（现有 observers/诊断依赖它）。

Q3 DECISION: R1 就持久化（Gate 3 崩溃窗口验证离开持久化不可执行；纯内存方案在 R2 补是伪节省）。新建专用库文件（dataRoot 下 runtimeEventsDb，仿 epochRegistryDb 先例），runtime 模块独占所有——不写进 v12 context-store（该 store 是 Session 派生、R2 要迁移，且 ledger 是输入侧原始事件流，与 context 状态不同域）。Schema: ...（列出）。idempotency_key UNIQUE + (event_type, entry_id) 唯一索引 → exactly-once；entry_seq 为 pi 会话内排序主轴（companion+user 相邻约束原样保留）；context_seq NULL + derivation_refs '[]' 占位 → R2 无 schema 破坏。disposition 默认 include。附 migration + 空库初始化验证（AGENTS.md 要求）。

Q4 DECISION: 场景驱动 slice：mock 确定性 provider（脚本化回复序列）+ opencode-go deepseek-v4-flash 真实 provider 共用同一断言 harness（mock 断言内容+结构，live 只断言结构）。测试矩阵（见 §3）。崩溃窗口复用既有基建：scripts/crash-worker.ts 子进程模式 + host.ts 的 faultPoint 注入先例——R1 崩溃窗口用"子进程 + 命名崩溃点（CRASH_AFTER=event_type）"，不用 SIGKILL 时序。新增验证点：现有 tool_result handler 的会话考古式归因（computeToolExecutionKey）与 ledger 归因交叉断言一致——两条独立归因路径必须相等，这是 exactly-once + 无合成修复的最强可执行证明。

Q5 DECISION: (a) 旁路，但"适配器逻辑随迁"：v12 context-STORE（m0/m1/LKG、Session 派生）完整旁路不动（R0 测试全绿，R2 落地 ContextMessageUnit + ContextHistoryReadPort 后删除）；transformContextMessages 的消息语义（companion fold、iris_input_meta 过滤、source label）迁入 R1 controller 投影，以 parity 测试（相同 fixture → 逐字节相等）锁定语义不回归。具体动作：context handler 从"变换 buildContext 产物"改为"controller 全量替换"，store 写入路径在 R1 不接。

Q6 DECISION: 拆两个 PR：PR-1 = PI-015+016+017（同一 harness 生命周期区域，改动重叠，合并评审；一次依赖 bump 契约定型）；PR-2 = PI-018 最小（forward 顺序读 + 显式 close + malformed-row 语义，diagnostics 推迟）——存储模块与 harness 代码不相交，可与 PR-1 并行。PI-019 整体推迟 R2。每个 patch 携带：通用 rationale（对 earendil-works/pi 自身的价值，不引 Iris 认知语义）+ 通用测试（fake controller、回执形状断言，不依赖 Iris 概念）+ removal condition（upstream 合并并 rebase 后移除）+ upstream PR 状态（upstream-first：先向 earendil-works/pi 开 PR，fork 跟踪；记录 PR 编号/状态）。iris_agent 侧：一次依赖 bump（pin fork commit，更新 production-lock.test.ts），0.82.1 → fork 0.83.0-dev pin。

Section 2: phases P0-P5 table-ish. Repo per phase. Dependencies. Deliverables.

P0 (blueforst/pi): PR-1 PI-015+016+017. Deps: none. Del: seam + generic tests + upstream PRs.
P1 (blueforst/pi, parallel): PR-2 PI-018 minimal.
P2 (iris_agent, dep on P0): seam port (PiSeamPort interface: appendUserMessage→Receipt, onLifecycleEvent, controller invocation) + ledger store (runtime_events schema/migration) + dep bump. Contract-first: seam port types defined NOW against planned PI shapes so mock seam adapter lets work start pre-P0.
P3 (iris_agent, dep P2): lifecycle contracts（settled/abort/tool-loop 上限）+ coordinator 对齐（agent_settled 作为终态事件写 ledger；settledTokenBox 语义不变）+ exactly-once dedupe。
P4 (iris_agent, dep P3+P1): mock 基线 + live slice + 测试矩阵 M1-M11 + 崩溃窗口 + Gate 1-4 可执行验证。
P5 (iris_agent/docs): PI-019 推迟记录 + R2 交接（ContextMessageUnit ledger 入口条件）。

Section 3: minimal vertical slice design.
Components: scenario script（JSON：输入序列 + mock 回复脚本）→ runMinimalSlice 扩展 → 组件链（seam port → RuntimeEvent ledger writer → controller 投影 → provider → tool registry → settled）→ 断言 harness（预期事件序列）。
数据流：user input → append（receipt: sessionId/entryId/entrySeq/contentHash）→ ledger user_message_appended + session_committed → controller 装配（systemPrompt=prepared.canonicalSystemPrompt, messages=ledger 投影, tools=Tool System）→ provider → tool_call/tool_result committed（ledger）→ assistant finalized → turn_committed → agent_settled。
崩溃窗口 W0-W4 + 每窗口断言（重启后 ledger 前缀精确、无缺口、无合成条目）。
测试矩阵表 M1-M11（上文）。
Gate 映射：Gate1=M7+M8, Gate2=fork CI golden, Gate3=M1-M6+M10-M11, Gate4=M5 全窗口 + M6。

Section 4: risks (6) with mitigation, each 1-2 lines.
Section 5: open questions (6) for orchestrator.

Effort: 整体 Large（跨两仓库约 1.5-2 周）；P0 Short-Medium、P1 Short、P2 Medium、P3 Short-Medium、P4 Medium、P5 Quick。

Also drop tags §2§, §3§, §5§ after extracting. §2 and §5 are large tool outputs I've now processed. §3 is small (package.json) — keep? It's small; fine to drop too. Let me drop 2-5 (the outputs). Actually keep the essential facts — I've extracted them. Drop §2§, §3§, §5§. §4 was tiny glob (no files) — drop too. I'll drop 2-5.

Let me write it now, dense Chinese, user's English headers. Also per output spec: bottom line 2-3 sentences. I'll put a short 总览 right after the header — but user format starts with "## 1. Architecture direction". I'll add a one-line 总览 before section 1 to satisfy "bottom line" without breaking their format... Actually the user's format is explicit; I'll add a compact "总览" line under the top (not a section header), then their sections. Keep it to 2-3 sentences.

One correction on Q4 crash window list — the windows relate to the ledger commit points:
- W0: append 进行中（entry 已写但回执未返回）→ 重启后重试 append，dedupe 保证不重复归因
- W1: user 回执后、provider 请求前
- W2: tool_call 提交后、tool_result 提交前（恢复策略：不合成结果；重新真实执行或 abort——ledger 记录原始 tool_call，重执行是新的 tool execution 事件）
- W3: assistant finalized 后、turn_committed 前（恢复：turn_committed 幂等补记，不重跑 provider——否则重复 assistant 消息）
- W4: session_committed 后、agent_settled 前（settled 可推导、幂等）

Good. Write final.

核实完毕。几个关键新证据会直接影响决策：① `createIrisHarness` 的 `context` 事件 handler 已经是"provider 转换前替换 messages"的现有机制；② `tool_result` handler 目前靠"扫描 session entries 考古归因"（computeToolExecutionKey），这正是 ledger 要取代的；③ 崩溃窗口基建已存在（scripts/crash-worker.ts 子进程模式 + host.ts 的 faultPoint 注入先例）；④ package.json 对 pi 是精确 pin 0.82.1，且有 production-lock.test.ts 与 context-golden 机制。

---

**总览**：R1 采用"fork 最小 seam 先行 + iris_agent 契约先行并行"的混合路线——PI-015/016/017 一个 fork PR 定型全部运行时契约，PI-018 并行落地，PI-019 推迟；iris_agent 以 seam port 接口解耦 fork 评审延迟，ledger 在 R1 即持久化（Gate 3 崩溃窗口离开持久化不可执行），v12 Context store 整体旁路但适配器消息语义随迁并加 parity 门。整体投入 **Large**（跨两仓库约 1.5–2 周），关键路径风险集中在依赖 bump 与 PI-015 跳过语义。

## 1. Architecture direction

### Q1. RuntimeEvent 来源 —— **DECISION: C（混合，fork 优先序）**
- **顺序**：PI-015/016/017 fork PR 先落地定型契约 → iris_agent 消费；PI-018 在崩溃窗口测试前并行落地；PI-019 推迟 R2。
- **B（纯适配器）否决**：23 个 OwnEvent 是 fire-and-forget 观察者，无 awaited 持久化回执——Gate 3 的 exactly-once 归因只能靠推断，不可执行验证。且 `createTurnState` 内 buildContext 无条件执行，事后覆写无法满足 PI-015 规格原文"must not force Session.buildContext()"。
- **A（全量 seam）过度承诺**：PI-018/019 不在 R1 关键路径（R1 需要的是 archive 顺序读 + close，那是 PI-018 最小集，不是 PI-019 性能）。
- **关键修正**（代码核实）：现有 `context` 事件 handler 已能"转换前替换 messages"——所以 Gate 1 **字面**可不靠 fork seam 满足（handler 全量替换即可），但 buildContext 仍被调用、harness 内部管道仍基于 Session 派生上下文（retry/save_point/session_tree 都吃它）。Gate 1 的可执行形式决定 fork seam 是否严格必需 → 开放问题 2。

### Q2. PI-015 最小设计 —— **DECISION: harness 可选选项 + buildContext 之前纯分支**
- **Seam 点**：`createTurnState` 内 `await this.session.buildContext()` **之前**分支，不是 createStreamFn 前——后者只能"事后替换"，前者才是"结构跳过"。
- **API**：`providerContextController?: (params: { session, model, defaultSystemPrompt }) => Promise<{ systemPrompt, messages, tools }>`；messages 用转换前 pi 消息形状。
- **Byte 兼容默认**：controller 缺席 → 原生代码文本级不变（纯 if/else，禁止重构原生分支）；三重验证——(1) fork CI 跑 pi 原生 harness 套件，(2) 黄金载荷（复用 iris_agent context-golden 模式：seam 前后各录一份脚本化 turn 的 `before_provider_payload`，逐字节相等），(3) 用 mimic 原生装配的 fake controller 跑同一 turn 断言载荷相等。
- **"从不调用 buildContext" 测试**：测试侧 spy（包一层 session，调用即抛错）+ 全 turn 跑通 + provider payload 逐字节等于 controller 输出——抛错 spy 比计数器强，且 payload 相等证明"路径真的走到了 controller"而非测试没触发。
- **风险**：buildContext 产物若被 harness 其他内部环节消费（retry 上下文、save_point、session_tree、`context` 事件），跳过会破坏不变量 → fork 侧先审计（开放问题 3），且 controller 路径下 `context` OwnEvent 仍须发射 controller 的 messages（现有 observers/诊断依赖它）。

### Q3. Ledger 持久化 —— **DECISION: R1 即持久化，新建专用库文件，runtime 模块独占**
- 纯内存 + R2 补是伪节省：崩溃窗口验证（Gate 3）必须在重启后断言 ledger 前缀，无持久化不可执行。
- **存放**：dataRoot 下新增 `runtimeEventsDb`（仿 `epochRegistryDb` 先例——已有多个 DB 文件先例）；**不写进 v12 context-store**——该 store 是 Session 派生、R2 要迁移，且 ledger 是输入侧原始事件流，与 context 状态不同域（AGENTS.md 状态所有权：每张表单一 owner）。
- **Schema（R1 最小、R2 就绪）**：`runtime_events(event_id TEXT PK /*ulid 单调*/, runtime_session_id TEXT NOT NULL /*身份级，非 pi session*/, pi_session_id TEXT, event_type TEXT NOT NULL, entry_id TEXT, entry_seq INTEGER, content_hash TEXT, context_seq INTEGER /*R1 NULL*/, disposition TEXT NOT NULL DEFAULT 'include', derivation_refs TEXT NOT NULL DEFAULT '[]' /*占位*/, created_at TEXT, idempotency_key TEXT NOT NULL UNIQUE)` + 唯一索引 `(event_type, entry_id) WHERE entry_id IS NOT NULL`。
- **Exactly-once** = idempotency_key UNIQUE + type/entry 唯一索引双保险；**排序主轴** = pi entry_seq（companion+user 相邻约束原样保留）；跨 rollover 排序 R2 由 context_seq 补。附向前 migration + 空库初始化验证（AGENTS.md 要求）。

### Q4. 垂直切片 —— **DECISION: 场景驱动 + 复用既有崩溃基建 + 双路径归因交叉断言**
- mock 确定性 provider（脚本化回复序列）+ opencode-go deepseek-v4-flash 共用同一断言 harness；mock 断言内容+结构，live 只断言结构。
- 崩溃窗口**复用现有模式**：scripts/crash-worker.ts 子进程模式 + host.ts 的 `faultPoint` 注入先例 → R1 用"子进程 + 命名崩溃点（CRASH_AFTER=event_type）"，不做 SIGKILL 时序（Windows 开发机不可靠）。
- **新增最强验证**：现有 `tool_result` handler 的会话考古归因（computeToolExecutionKey，扫描 entries）与 ledger 归因**交叉断言必须相等**——两条独立归因路径一致 = exactly-once + 无合成修复的可执行证明，且不用重写当前可用路径。

### Q5. 与 v12 Context 的时序 —— **DECISION: (a) 旁路，但适配器消息语义随迁 + parity 门**
- v12 **context-store**（m0/m1/LKG、Session 派生、represented_through_entry_seq）完整旁路、代码不动，R0 测试全绿；删除条件 = R2 的 ContextMessageUnit store + ContextHistoryReadPort 落地。
- v12 **context-adapter 的 transformContextMessages 语义**（companion fold、iris_input_meta 过滤、pair 验证、source label 投影）**迁入 R1 controller 投影**，以 parity 测试锁定：相同 fixture → controller 输出与 transformContextMessages 输出逐字节相等。这是"最小步"——只改 provider 消息来源（handler 从"变换 buildContext 产物"改为"controller 全量替换"），不建任何新 context 状态机制，也不挡 R2。
- **不建运行时 v13/v12 开关**：直接替换 harness 接线，v12 以死代码/迁移材料形态保留。

### Q6. Fork seam 落地 —— **DECISION: 两个 PR，不拆三不合并**
- **PR-1 = PI-015+016+017**：同一 harness 生命周期区域、改动重叠，合并评审 + 一次依赖 bump 契约定型；PR-2 = **PI-018 最小**（forward 顺序读 + 显式 close + malformed-row 语义；diagnostics 推迟）——存储模块与 harness 代码不相交，可与 PR-1 并行；**PI-019 整体推迟 R2**。
- 每个 patch 携带：通用 rationale（对 earendil-works/pi 自身价值，不引任何 Iris 认知语义）+ 通用测试（fake controller、回执形状断言）+ removal condition（upstream 合并并 rebase 后移除）+ upstream PR 状态（upstream-first：先向 earendil-works/pi 开 PR，fork 跟踪记录 PR 编号/状态）。
- **依赖侧**：iris_agent 一次 bump（0.82.1 → fork commit pin），必须同步更新 `test/production-lock.test.ts`（R0 锁测试）。

## 2. R1 work breakdown

| Phase | Repo | 依赖 | 交付物 |
|---|---|---|---|
| **P0** | blueforst/pi | — | PR-1：PI-015 controller + PI-016 receipts + PI-017 生命周期事件；通用测试；upstream PR 开出。**Short–Medium** |
| **P1**（与 P0 并行） | blueforst/pi | — | PR-2：PI-018 最小 archive API。**Short** |
| **P2** | iris_agent | P0 | 契约先行 **seam port**（`PiSeamPort`：append→Receipt / onLifecycleEvent / controller 调用，类型按规划中的 PI 形状先定义，mock seam adapter 让工作不阻塞 P0）+ ledger store（schema + migration + 空库验证）+ 依赖 bump。**Medium** |
| **P3** | iris_agent | P2 | 生命周期契约（settled/abort/tool-loop 上限）+ coordinator 对齐（agent_settled 写 ledger 终态，settledTokenBox 语义不变）+ exactly-once dedupe。**Short–Medium** |
| **P4** | iris_agent | P3 + P1 | mock 基线 + live slice + 测试矩阵 M1–M11 + 崩溃窗口 + Gate 1–4 可执行验证。**Medium** |
| **P5** | iris_agent / docs | P4 | PI-019 推迟记录 + R2 交接（ContextMessageUnit ledger 入口条件、v12 store 删除条件）。**Quick** |

## 3. Minimal vertical slice design

**组件链**：场景脚本（JSON：输入序列 + mock 回复脚本）→ seam port → RuntimeEvent ledger writer → controller 投影（systemPrompt=prepared.canonicalSystemPrompt，messages=ledger 投影，tools=Tool System）→ provider → tool registry → settled。
**数据流**：user input → append（回执：sessionId/entryId/entrySeq/contentHash）→ ledger `user_message_appended`+`session_committed` → controller 装配（**不经过 buildContext**）→ provider → `tool_call_committed`/`tool_result_committed` → assistant finalized → `turn_committed` → `agent_settled`（coordinator 释放，settledTokenBox 语义不变）。

**测试矩阵（mock，确定性）**：
- M1 无工具 happy path 全序；M2 工具循环（N=2）顺序 + 归因；M3 工具循环超限 → abort（不修复）；M4 用户中止 → abort 契约（无半截 assistant 消息）
- M5 崩溃窗口 W0–W4（W0 append 中：重试 + dedupe 不重复归因；W1 回执后/provider 前；W2 tool_call 后/tool_result 前——不合成结果，重执行是新事件；W3 assistant finalized 后/turn_committed 前——turn_committed 幂等补记，不重跑 provider；W4 session_committed 后/settled 前——settled 可推导）
- M6 回执重放 → 无重复行（idempotency_key）；M7 Gate1 buildContext spy-throws（mock + live 双跑）；M8 Gate2 原生路径黄金载荷逐字节；M9 parity：controller 投影 ≡ transformContextMessages（同 fixture）；M10 companion/user entry_seq 相邻性保留；M11 双路径归因交叉一致（考古扫描 ≡ ledger）
- **live slice（deepseek-v4-flash）**：只跑 M1 结构断言 + M7，无内容断言
- Gate 映射：G1=M7+M9，G2=fork CI 黄金，G3=M1–M6+M10+M11，G4=M5 全窗口 + M6

## 4. Risks & mitigations

- **依赖 bump 破坏 R0 锁**（0.82.1→0.83.0-dev 漂移）：pin fork commit 为依赖 ref，bump 当次跑完整 `npm run check` + fork pi 原生套件，更新 production-lock.test.ts。
- **PI-015 跳过破坏 harness 内部消费者**（retry/save_point/session_tree）：fork 侧先审计 buildContext 产物的全部消费点（开放问题 3），controller 路径下 `context`/`before_provider_payload` 事件仍发射 controller 数据。
- **消息语义随迁丢失**：parity 门（M9）用同 fixture 逐字节相等锁死，不靠代码评审。
- **崩溃窗口测试不稳定**：命名崩溃点 + 子进程重启断言，禁止时序性 kill。
- **companion/user 相邻链被 controller 插入打破**：ledger 以 entry_seq 为唯一排序主轴，M10 常驻断言。
- **fork PR 评审延迟阻塞 R1**：seam port 契约先行 + mock seam adapter，P2/P3 与 P0 完全并行。

## 5. Open questions for the orchestrator

1. **fork 包消费机制**：git tarball + npm overrides vs 私有 registry vs 本地 pack+link？R0 锁的是 npm 0.82.1，无消费 fork 构建先例，需定夺。
2. **Gate 1 可执行形式**：接受"provider payload 非 buildContext 派生"，还是必须"buildContext 证明未被调用"（spy-throws）？规格原文"must not force"倾向后者——确认。
3. pi 的 buildContext 产物在 harness 内除 createTurnState 外还有哪些消费点（retry/save_point/session_tree）？需 fork 侧审计，决定 PI-015 跳过的精确作用域。
4. **W0 的 exactly-once 语义**：append 崩溃（entry 已写、回执丢失）后重试，pi 的 append 是否需要幂等重试路径或按 content_hash 去重？这是 Gate 3 最脆的窗口。
5. 崩溃窗口验收：子进程 kill 模式在 Windows 开发机 CI 上可接受，还是同步 fault seam（host.ts faultPoint 模式）即满足 Gate 3？
6. 真实 provider slice 是否进 CI（成本/网络）——还是作为可选 gated 运行，CI 只跑 mock？