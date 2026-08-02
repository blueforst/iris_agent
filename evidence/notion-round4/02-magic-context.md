Iris authoritative adoption update — 2026-07-24
Magic Context 的功能、状态机与 provider-visible 算法权威固定为 released OpenCode TypeScript 主实现：packages/plugin/src/hooks/magic-context/ 及其 TypeScript shared core/storage。Rust module 只作为 parity oracle、故障夹具、可复用纯逻辑候选和未来显式迁移候选，不与 TypeScript 同时成为 Context writer。Iris 采用 OpenCode released 版本的逐次 transform、确定性 replay、稳定 m0 baseline、volatile m1 delta、live tail、SOFT+/SOFT/HARD taxonomy、LKG、protected tail、后台 Historian、recomp/wrapup 与 emergency handling 等已选机制。
packages/pi-plugin/ 与其他 Agent 适配功能不完整，只能用于观察 host seam、消息形态和兼容限制；它们不能定义 Iris 的 Magic Context 功能集合、缺失能力、失败策略、状态 schema 或 parity 标准。Iris 的正确接入顺序是：先以 OpenCode 主实现确定目标语义，再通过锁定的 core Pi AgentHarness + Session 适配这些语义。
OpenCode 中的 active branch/session/project/tag 等宿主身份不直接进入 Iris；在每个 Runtime Session 内，它们映射为 Session-local entrySeq、HistoryProjectionUnit、OpenCode 等价的 protected-tail boundary state 和有界 P5。跨 Runtime Session 不继承旧 message/tag/LKG identity，而通过 ContinuitySnapshot、previous-session overlap 与 Graphiti recall建立新 Session baseline。P0-P5 是 Iris 叠加的语义分层，不得删除或弱化 OpenCode 主实现的缓存与物化不变量。
参考项目：cortexkit/magic-context
源码核验基线：released OpenCode authority commit 48ab531d8fa98af2f463db2e4d9f8ffdd63d765e（release v0.33.0），复核日期 2026-07-26。当前 master audit snapshot 为 113f3e4824e0ea03a73f2c1e8a57a5ab0bbf7a09，比 release 多 24 个未发布 commits，只作为升级证据，不进入当前 golden authority。
在 Iris 中的采纳状态：以 OpenCode TypeScript released implementation作为唯一 provider-visible 功能基线，采纳稳定 baseline/delta、逐 pass byte-stable replay、LKG seam validation、缓存 bust taxonomy、受保护尾部、按量后台 Historian、single-flight 语义、recomp/wrapup、multi-Compartment output、稳定多档摘要、reasoning/drop replay、persistent-storage/schema-fence fail-closed 与“原文由宿主权威保存”等已选机制。v0.33.0 的 pressure-gated tool reclaim、Historian/transform hot-path 修复、threshold-clamp visibility 与 storage migration lessons 进入 parity/测试基线。可选 experimental.mural.enabled / Memory Mural 明确不纳入 Iris M1。Iris M1 不照搬 OpenCode 的跨进程 lease；在单一长期 Host 中，所有 Historian 工作映射到一个全局单 worker 队列。Pi/其他 Agent plugin 不作为功能基线。Rust transform/Historian 仍只作为 parity oracle、故障夹具和未来替换候选，不与 TypeScript 同时成为 writer。Iris 不直接复用 OpenCode 的 branch/project identity、tag/ordinal 外部 contract、project facts/memory、UI/RPC 或 coding-agent 特化对象；这些在当前 Runtime Session 内由 Iris Session-local History DTO与领域 Port重新映射。Runtime Session identity只用于状态分区和原始 provenance。

## Context Design Authority

Magic Context 源码确认以下机制是架构核心而非可选优化：

- transform 在每次 LLM round-trip 前运行；
- persistent mutation 必须在每次 pass 确定性 replay，以保持 provider prompt cache bytes 稳定；
- system + m0 + m1 是缓存敏感前缀，conversation tail 位于其后；
- m0 是累积稳定 baseline，m1 是自上次 fold 后的增量；
- SOFT+ 不改变 m0/m1，SOFT 只改变 m1，HARD 折叠 m1 并重建 m0；
- decay/re-tier 只能发生在 HARD fold；
- background Historian/dreamer 等 LLM 工作在 transform 外运行，transform 自身不调用 LLM；
- deferred publish/drop/mutation 搭乘下一次已经发生的 bust，不能单独破坏缓存；
- durable SQLite state 是可重建 transform 的权威，内存 cache 可以丢弃。
  Iris 对这些机制的修改只能是把 OpenCode 主实现语义适配到 Pi concrete seam，或增加 Origin/P0-P5/Graphiti recall 语义；不能因 Pi plugin 缺少某项能力就从 Iris 删除该能力，也不能反向设计成无 baseline/delta/LKG/protected-tail 的 Context。OpenCode tag-based reasoning/drop age 在 Iris 中映射为当前 runtimeSessionId 内的 HistoryProjectionUnit/entrySeq sequence；Pi Session 原文不被修改。rollover 后重新建立 reasoning/drop replay state，不把旧 Session 的 mutation ledger套用到新 Session。失败路径以 OpenCode LKG、seam validation 与 emergency fail-closed 为语义基线，再满足 Pi core 的 throwable hook hook contract；必须禁止会泄漏 provenance metadata 或无界 raw history 的 raw passthrough。P0 concrete seam 仍由 core Pi 决定：prompt 前准备 canonical system bytes，native systemPrompt resolver 只重放。

## Iris Mapping of Physical Layout

Magic Context system seam → Iris P0 + immutable P1 Persona + stable P2 guidance
Magic Context m0 → Iris current-Session folded P3 + latest ContinuitySnapshot + baseline P4 data
Magic Context m1 → Iris new current-Session P3 + additive/mutation P4 delta
Magic Context tail → bounded previous-session overlap + current-Session P5 + Pi invocation delta
Iris 直接保留 Magic Context OpenCode v2 的 content/p1/p2/p3/p4/importance/episodeType Compartment taxonomy，不再维护 long/medium/short/micro 别名或替代 schema。新 Compartment 以 P1 进入 m1；旧 Compartment 的 p1–p4 tier 选择只在 HARD fold 中由锁定 decay renderer 重算。Iris provenance 仅作为 CompartmentAttributionManifest sidecar；manifest 必须绑定 runtimeSessionId + Session-local range。

## 本次源码核验范围

### Authoritative OpenCode implementation

- packages/plugin/src/hooks/magic-context/hook.ts
- packages/plugin/src/hooks/magic-context/transform.ts
- packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts
- packages/plugin/src/hooks/magic-context/strip-content.ts
- packages/plugin/src/hooks/magic-context/lkg-replay.ts
- packages/plugin/src/hooks/magic-context/protected-tail-boundary.ts
- packages/plugin/src/hooks/magic-context/compartment-trigger.ts
- packages/plugin/src/hooks/magic-context/compartment-runner.ts
- packages/plugin/src/hooks/magic-context/inject-compartments.ts
- packages/plugin/src/hooks/magic-context/derive-budgets.ts
- packages/plugin/src/features/magic-context/compartment-storage.ts
- crates/mc-module/src/historian_validate.rs
- crates/mc-module/src/historian_producer.rs

### Compatibility-only material

- packages/pi-plugin/PARITY.md
- packages/pi-plugin/**：只用于理解 Pi host 差异、Session-scoped Adapter 与可借鉴机制，不用于定义功能完整性。

## Source Authority Hierarchy and Pi Adaptation Boundary

1. released OpenCode TypeScript implementation = feature / algorithm / state-machine authority
2. TypeScript shared core/storage = active reusable implementation authority
3. Rust module = parity evidence + future migration candidate
4. Pi/other Agent plugins = compatibility evidence only
5. Iris core-Pi Adapter = host-specific mapping, proven against OpenCode golden behavior
   Magic Context 的 Pi plugin 面向 @earendil-works/pi-coding-agent，且功能不完整；Iris M1 使用 core @earendil-works/pi-agent-core，每个 Runtime Session 新建一套 Harness + Context lineage。因此：

- 不直接安装或 fork Pi plugin 作为 Iris Context；
- 不得以“Pi plugin 没实现”为理由删减 OpenCode 已有的 adopted feature；
- 可以直接复用 TypeScript shared core；Rust 纯逻辑只有在逐 fixture parity 证明等价且不引入第二 writer 时才可复用。host-specific 部分通过 native systemPrompt resolver、current bounded Session buildContext()、context hook、context-hook failure boundary、tool hooks 与 Session-scoped read facade 接入；closed Sessions不拼接进入 active Harness；
- OpenCode 的 messages/parts/tag/session identity 映射为 Iris runtimeSessionId + session-local EntrySeq + HistoryProjectionUnit + context.db state；不建立跨 Session HistoryExchangeUnit；
- Iris parity 必须以 OpenCode golden traces/fixtures 为比较对象，而不是 Pi plugin E2E；Pi plugin tests 只能补充 host-specific edge cases；
- OpenCode LKG 的 anchor、input ID sequence、model/provider binding、reshape invalidation、tool/reasoning seam validation 必须保留其语义，不能缩减为简单“缓存一段 m0/m1”；
- OpenCode reasoning/drop/sentinel 的目标语义必须保留；具体 Pi wire representation由 Pi/provider compatibility 决定，不能把 Pi plugin 的特殊表示当作产品语义；
- Pi core throwable hook hook contract由 Iris Adapter 满足，但 failure outcome仍需等价于 OpenCode 的 LKG/emergency fail-closed，不得 raw passthrough；
- 上游未来若提供对 core AgentHarness 的完整 OpenCode-parity Adapter，优先替换 Iris seam Adapter。

## 真实运行路径（OpenCode authoritative）

OpenCode 主实现把 Context 逻辑挂在每次 experimental.chat.messages.transform：
OpenCode message transform
→ load/replay durable state
→ tag / pending ops / drop / reasoning / structural cleanup
→ classify defer/execute/materialize pass
→ cheap compartment trigger gate
→ protected-tail + eligible-head inspection
→ optionally start leased background compartment agent
→ inject/replay system + m0 + m1 + live tail
→ capture/validate LKG and run emergency checks
Historian/compartment agent 是 transform 外运行的后台任务，但 trigger、await-at-pressure、pending publication drain、recomp/wrapup ownership 与 materialization signals 都由 OpenCode hook/transform state machine 协调。Iris 必须移植已采纳的完整状态语义，而不是按 Pi plugin 当前子集重建一条简化路径。

## Trigger 的实际实现

### 1. Single-flight 由持久状态门控制

checkCompartmentTrigger() 首先读取 sessionMeta.compartmentInProgress。已有 Historian 运行时直接返回 shouldFire=false，防止同 Session 并发 folding。
这不是通用任务队列，只是 OpenCode 上游实现中的 Session 级 single-flight 门。Iris 保留“同一原始范围不得并发处理”的语义，但 M1 的 concrete mapping 更简单：一个 Host 内只有一个全局 Historian worker，因此所有 Session 的 incremental、wrapup、retry 与 recomp 都天然串行，不需要 Session lease 或跨进程 ownership marker。

### 2. Cheap gate 与 authoritative inspection 分层

低压力时不会每次都全量读取原始历史。Trigger 先用已持久化 tag token 上界，加上未标记的内存 tail 估计，判断是否可能达到任何 size trigger。
cheap conservative upper bound
< triggerBudget
→ skip expensive raw-tail inspection
Cheap gate 失败时必须回退到 authoritative inspection，不能改变语义。这体现了 Magic Context 的优化原则：
优化可以漏掉“快速跳过机会”，不能漏掉真正应该触发的 Historian。

### 3. 热路径优先使用已锚定的内存 tail

buildTriggerInMemoryTail() 尝试从当前 transform 的 messages 构造绝对 ordinal RawMessages。只有能找到上一个 Compartment 的真实 boundary anchor 时才使用；无法证明对齐则回退 provider/DB 路径。
这说明其边界策略是 fail-conservative：无法证明消息与持久边界一一对应时，不猜 ordinal。

### 4. Protected Tail 是 trigger 与 runner 共享的快照

CompartmentTriggerResult 可以携带 boundarySnapshot。同一 transform pass 启动 Historian 时，应把该 snapshot 传入 runner，避免 trigger 判断后再次计算出另一条 protected boundary。
Iris 对应的不变量是：HistorianBoundarySnapshot 冻结 runtimeSessionId、eligibleThroughEntrySeq、protectedTailStartEntrySeq、true-raw/narratable token estimates 与 source hash；runner 只能处理该快照中的 eligible cold range，发布前再验证 range endpoints 和 hash，不能在运行中扩大输入范围。Pi settled 只用于唤醒检查，不是持久处理边界。

## 两类 token 轴

源码明确区分：

- trueRawEligibleTokens：包含大型工具输出，衡量真实 wire/context occupancy；
- chunk.tokenEstimate：U:/A:/TC: 规范化内容，衡量 Historian 真正可叙述的材料。
  tail_size 只依据 TC-chunked narratable estimate。源码注释记录：若直接用 true-raw，工具密集会话会因几次文件读取过早 firing，产生极碎 Compartment，实测跨度由约 155 条消息降到约 27 条。
  因此 Iris 应保留两轴：
  true raw → pressure / protected-tail safety
  narratable → normal background firing

## 实际触发规则

源码常量：
PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2
POST_DROP_TARGET_RATIO = 0.75
MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE = 6000
MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12
TAIL_SIZE_TRIGGER_MULTIPLIER = 3
FORCE_COMPARTMENT_PERCENTAGE = 80
FORCE_MATERIALIZE_PERCENTAGE = 85
BLOCK_UNTIL_DONE_PERCENTAGE = 95
checkCompartmentTrigger() 依次处理：

1. force_80：上下文达到 80%，且预计 drop 后仍不足以回到目标；
1. commit_clusters：可选的 coding-work-phase trigger；
1. tail_size：TC-chunked 内容达到 triggerBudget × 3 或扫描预算耗尽且仍有更多；
1. projected_headroom：接近 execute threshold，现有 drop 无法恢复足够空间。
   Iris M1 只采纳 tail_size / projected_headroom / force_pressure / manual / backfill 的语义。具体阈值、调用时机和 mid-turn 判断必须重新映射到 core Harness 当前 messages/usage seam，并通过 contract tests；不采纳 commit cluster。

## Trigger Budget 与 Chunk Budget 的源码公式

derive-budgets.ts 明确把旧的单一静态预算拆成两种 scaling basis：
triggerBudget =
clamp(mainContextLimit × executeThreshold × 5%, 5K, 50K)

historianChunkTokens =
clamp(historianContextLimit × 25%, 8K, 50K)
前者回答“何时运行”，后者回答“一次读多少”。Historian model 无法解析时使用 128K 的保守 fallback context limit。

## Historian Runner 的实际步骤

OpenCode compartment-runner.ts、incremental/recomp/wrapup runners 与 Rust producer/validator 共同定义：

1. 读取已有 Compartments 与 facts；
1. 验证已有边界；
1. 计算上次 Compartment 后、protected tail 前的 eligible chunk；
1. 读取 RawMessage chunk；
1. 构造 Historian prompt；
