本页固定 Iris 采用的 Pi 仓库、commit、package 版本、设计适配、必要补丁和 contract tests。兼容工作的首要原则是让 Iris 设计适应 Pi 的稳定原生语义；只有无法通过薄 Adapter 或领域设计调整满足的硬性需求，才考虑通用上游补丁。

## Current Status

compatibility_status = supported_with_iris_epoch_adapter
audit_date = 2026-07-26
production_lock = candidate_selected_pending_contract_tests

## Audit Baseline

### 2026-07-26 Version-drift decision

旧审计基线 7df73a00c6cf85c000bf1ce1594c9284067a92f0 / 0.82.0 到 0.82.1 release 之间共有 18 个 commits。AgentHarness、core Session 与 SQLite storage implementation 未发生实质语义变化；变动集中于 pi-ai provider/auth/model/error behavior、package release 与 eval harness。0.82.1 因此被选择为 R0 production candidate。当前 main snapshot 5bc1c2c0a6f07e00e8c240304182f213ab8d311f 只比 release commit 多一个添加 [Unreleased] 标题的 changelog commit，不包含新的运行时实现变化。
该静态复核只选择候选依赖，不宣称 Iris contract/crash tests 已通过。provider-visible payload、reasoning/tool replay、input companion、ToolResult details、settled ordering 与 crash windows 仍是进入 R1 前的执行门。
Magic Context feature parity is locked separately to the released OpenCode main implementation, not packages/pi-plugin:
magic_context_authority:
repository: cortexkit/magic-context
commit: 48ab531d8fa98af2f463db2e4d9f8ffdd63d765e
release: v0.33.0
authoritative_path: packages/plugin/src/hooks/magic-context
compatibility_only_paths: - packages/pi-plugin
current_master_audit_snapshot: 113f3e4824e0ea03a73f2c1e8a57a5ab0bbf7a09
unreleased_master_policy: evidence_only_until_released_and_reaudited
explicitly_not_adopted: - experimental.memory_mural
Pi/other Agent Magic Context adapters are incomplete and cannot be used to waive an OpenCode feature or contract test.

## Production Lock Candidate

lock_status: candidate_selected_pending_contract_tests
repository: earendil-works/pi
commit: b4f293684bba718d59cc1157679bcf6157b3a7f5
packages:
pi-agent-core: 0.82.1
pi-ai: 0.82.1
pi-storage-sqlite-node: 0.82.1
node_requirement: ">=22.19.0"
exact_node_runtime: pending_repository_toolchain_lock
patches: []
candidate_selected_at: 2026-07-26
validation:
static_source_drift_review: passed
package_version_alignment: passed
iris_contract_tests: pending
crash_window_tests: pending
provider_profile_tests: pending
This candidate becomes the accepted production lock only after the listed executable gates pass; failure changes the candidate or patch set rather than weakening the contracts.

## Required Patches / Upstream Contracts

## Static Harness Composition

Iris M1 不是通用插件平台。HarnessFactory 是 provider-visible hook chain 的唯一 composition owner，并以固定源码构造每个 Runtime Session 的新 AgentHarness：
prepared systemPrompt resolver
→ before_agent_start input companion bridge
→ one Iris Context Adapter
→ fixed Model Adapter request/payload normalization
→ Provider
M1 不提供动态 Extension/plugin loader、运行时 hook 注册、第三方 message/context/payload mutator 或原生 AgentHarness 访问入口。因此不新增 PI-015、handler registry、冲突检测器、注册表冻结或插件优先级协议。Telemetry 和 lifecycle observers 只能读取事件，不得修改 provider-visible state。
兼容测试验证静态构造后的最终行为，而不检查 Pi private handler map 或 handler 数量：相同 Session/source/provider profile 必须产生相同 hook 顺序与 provider payload；每次 rollover 后重新构造的 Harness 必须保持相同 composition。

## Contract Test Matrix

### OpenCode Magic Context Parity

Golden fixtures are generated from the locked OpenCode main implementation, never from packages/pi-plugin alone. At minimum compare:

- pass classification and deferred-signal consumption for SOFT+/SOFT/HARD;
- exact m0/m1 order, placeholder, fold, decay/re-tier and cache-byte replay;
- protected-tail boundary and cheap-gate/authoritative fallback behavior;
- pending operation replay, structural cleanup, user-turn boundary preservation and tool adjacency;
- LKG anchor/input-ID sequence, model/provider binding, reshape invalidation, tool/reasoning seam validation and unsafe-seam rejection;
- reasoning clearing, cleared sentinel replay, inline-thinking stripping and provider-specific merged-assistant handling;
- Historian single-worker queue, priority ordering, trigger thresholds, provisional suffix, repair, final-transaction publication sequencing, recomp and wrapup;
- high-pressure await/materialization and emergency fail-closed outcome;
- v0.33.0 pressure-gated tool reclaim: unrelated folds must not age-reclaim, newest todo/tool-state floors remain protected, and reclaim decisions replay deterministically;
- persistent storage failure and newer-schema fence must block the primary provider path loudly rather than unregistering Context hooks or falling back to native compaction;
- migration fixtures covering the v0.33.0 released schema range through v68, including open/migrate/replay/restart and rollback-from-copy behavior;
- experimental.mural remains disabled: no image mural carrier, cue-compression task or vision-dependent branch may enter the Iris provider payload;
- storage-unavailable behavior and persisted-state recovery.
  A Pi-specific mechanism may differ, but the observable state transition and provider-safe output must match the OpenCode golden contract. A feature absent from Pi plugin still remains required when adopted from OpenCode.

### Context Carrier and Input Provenance

- ContextRuntimePort.prepareInvocationSources() completes and the prepared source is bound before AgentHarness.prompt() calls its first createTurnState().
- every context pass filters iris_input_meta before Pi convertToLlm(); metadata is never emitted as provider-visible user text.
- m0 and m1 are ephemeral hidden Pi CustomMessage carriers produced by the context hook, converted by core Pi to two consecutive provider user messages at array head, and never appended to Session;
- order is exactly m0 then m1; m0 empty bytes equal <session-history></session-history> and m1 empty bytes equal <session-history-since>(no new content since last materialization)</session-history-since>;
- carrier omission, slot collapse, placeholder wording drift, role drift or persistence into Session fails parity.
- carrier customType/order/content/details/timestamp are deterministic functions of materialization identity, contextSerializerVersion, carrierSchemaVersion and the locked Pi/provider profile.
- repeated SOFT+ passes produce byte-identical provider payload prefixes for the tested provider adapters.
- changing provider adapter/profile, Pi message serializer or carrier schema forces a HARD rebuild and rejects the previous LKG.
- prepareInvocationSources() renders canonicalSystemPrompt once before prompt and Capsule binds it with contextSourceSnapshotId/systemProjectionHash;
- the native systemPrompt resolver performs no I/O or rendering and returns that same in-memory string on the first turn and every later tool-turn rebuild; tests compare exact bytes/object value and fail if before_agent_start changes only the first-turn system prompt.
- before_agent_start does not own P0 and injects only the initial metadata companion/one-time startup adaptation; the statically composed Iris handler returns no systemPrompt override, and HarnessFactory installs no second system-prompt mutator.
- A single AgentInput maps to one normal Pi UserMessage plus one hidden iris_input_meta CustomMessage companion in the same prompt batch.
- the companion does not duplicate the input body and binds to the UserMessage through inputId + contentHash + deterministic pair key.
- Context projection merges the pair into one model-visible logical input and filters the companion.
- trigger origin, IrisContentLayoutV1 frame/part manifest, ordered block origins, content hashes and layout hash survive close/open.
- ToolResult details.iris survives close/open and context conversion.
- malformed UTF-8 frame length, wrong content-part index, corrupted/missing companion metadata or layout hash uses the fixed fail-conservative provenance path without rewriting Pi history.
- external Host/Body inputs received during an active run remain in the bounded Host queue and are started as new prompts after settled; no bare steer/followUp/nextTurn entry appears without provenance.

### Ordering and Commit

- user entry is committed before provider execution begins.
- final assistant entry is committed before its tool calls execute.
- each ToolResult entry is committed before the next provider turn begins.
- settled occurs only after pending Pi session mutations and awaited agent_end handlers finish.
- SQLite append atomically advances entry, sequence, materialized state and active leaf.

### Crash Windows

Run each test by killing the process at the named boundary and reopening the same SQLite database:

1. before initial input append;
1. after UserMessage append, before iris_input_meta companion append;
1. after complete input pair append, before provider request;
1. during provider streaming, before assistant message_end;
1. after assistant tool-call entry commit, before tool execution;
1. during tool execution, before external side effect;
1. after external side effect, before ToolResult entry commit;
1. after ToolResult commit, before next provider request;
1. during next provider streaming;
1. after agent_end, before settled observer completion;
1. after settled.
   For every window assert:

- Runtime Session history/archive head and entry sequence remain readable according to Pi-native semantics;
- Iris startup does not append synthetic assistant or ToolResult messages;
- Iris compatibility code does not automatically replay a tool or provider request;
- a UserMessage without companion is projected as a fixed untrusted omission anchor; raw body is not sent, no companion is synthesized, and Historian excludes it；
- a standalone/invalid companion is always filtered and reported；
- incomplete, empty or unmatched tool-result states are preserved for the model to interpret on a later invocation;
- when the locked Pi/provider profile proves the unmatched tool arc provider-safe, a later model invocation can retry, change strategy or request clarification through the ordinary Pi loop;
- when it is not provider-safe, the old Epoch becomes closed_incomplete, a fresh Session is created, and only a bounded uncertainty-preserving RuntimeRecoveryNotice crosses the Epoch boundary;
- Tool Adapter idempotency remains a capability-level concern and does not create a Runtime Session history/archive repair protocol;
- no Iris invocation/result ledger is required.

### Reasoning Projection

- OpenCode strip-content.ts golden behavior is the semantic authority; Pi plugin representation is not the baseline;
- recent/current signed reasoning remains provider-native according to the locked provider profile;
- old reasoning is marked as durable cleared state only on execute/materializing passes and replayed on every pass;
- cleared state uses OpenCode [cleared] semantics, then a provider-specific Pi Adapter converts it to a wire-safe sentinel/empty/literal representation; no one universal Pi shape is assumed;
- user messages remain structural turn boundaries; cleanup never drops them merely because content became empty;
- inline thinking stripping and consecutive-assistant reasoning merge rules match OpenCode golden fixtures;
- Anthropic index-0/at-most-one signed thinking and interleaved/openai-compatible requirements are tested separately;
- Runtime Session history/archive/Evidence/Graphiti retain no rewritten reasoning projection;
- provider/profile/serializer policy changes invalidate reasoning state/LKG until a HARD rebuild succeeds.

### Pi Compaction Non-use

- M1 never calls core AgentHarness.compact() and never intentionally appends a Pi compaction entry.
- no auto-compaction or second context-rewrite plugin is installed.
