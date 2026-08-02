Context 模块决定每次 Provider 调用时模型实际看到什么。它以 Magic Context OpenCode 主实现为功能、算法和状态机权威，并适配到锁定的 Pi core AgentHarness + Session 生命周期。
本页采用 Runtime Session Epoch 模型后的唯一方案：Pi 原生 Session.buildContext() 读取完整但受容量上限约束的当前 Runtime Session；Iris Context 在每次 provider call 前，把这份当前 Session message base 确定性投影成 system + m0 + m1 + live tail。closed Sessions 不进入 buildContext()，只通过 ContinuitySnapshot、previous-session overlap 和 Graphiti recall 提供跨 Session 连续性。

## Authority and Scope

Pi Session.buildContext()
→ current Runtime Session 的原生 message/state base

Pi AgentHarness context hook
→ 每次 provider call 前执行 transform 的 seam

Iris Context
→ P0-P5、m0/m1、LKG、protected tail、provenance、token budget 与 pass taxonomy
Pi core 决定消息从哪里来、hook 何时执行、tool turn 如何追加和失败如何进入原生 lifecycle；Magic Context OpenCode 主实现决定稳定前缀、baseline/delta、SOFT+/SOFT/HARD、LKG、reasoning/drop replay、Historian、protected tail、recomp/wrapup 与 emergency 语义。Pi/其他 Agent 的 Magic Context plugin 只用于 host compatibility，不定义功能上限。
Context 不保存原始 Pi 消息，不追加普通消息，不执行工具，不调用 Provider，不拥有 Runtime Session 激活、Persona、Evidence 或 Graphiti。

## Runtime Session Source Boundary

M1 直接接受 Pi 的当前行为：
AgentHarness.createTurnState()
→ Session.buildContext()
→ read complete active Runtime Session path
→ systemPrompt resolver returns prepared immutable system bytes
→ before_agent_start injects initial input companion
→ context hook projects provider-visible messages
强制规则：

- Session.buildContext() 只读取 active runtimeSessionId；
- closed Session entries 永不拼接进当前 Pi Session context；
- Epoch Manager 必须在 entry、estimated token、Session-owned payload bytes、latency 或资源阈值前请求 rollover；
- Context transform 可以裁剪 provider-visible raw history，但不声称减少 Pi 已发生的当前 Session path read 成本；
  -若单个受限 Runtime Session 仍无法满足资源目标，再评估通用 Pi bounded-source 改进；它不是 M1 当前接入方案。
  Context 不控制下一次 storage read，也不在 Session.buildContext() 前替换 Pi 的当前 Session 数据源。

## Session Scope

每个 Runtime Session 拥有独立的：

- ContextSourceSnapshot lineage；
- m0/m1 materialization state；
- LKG slots；
- protected-tail boundary；
- reasoning/drop/cleanup replay state；
- QueryRecallDecision；
- P5 represented boundary。
  所有 identity、水位和 mutation key 必须包含 runtimeSessionId。rollover 后建立 fresh lineage，不直接继承旧 Session 的 message IDs、m0/m1、LKG 或 mutation state。
  正常跨 Session 连续性只接受三种输入；另有一个仅用于不完整工具弧恢复的窄 RuntimeRecoveryNotice 例外：
  ContinuitySnapshot → P3 叙事交接
  previous-session overlap → P5 有界原文引用
  Graphiti recall → P4 长期事实/实体/关系

## Context Layers

P0 System / Safety / runtime invariants
P1 PersonaSnapshot
P2 stable declarations: tools / skills / body / runtime
P3 current-Session Compartments + accepted ContinuitySnapshot + optional RuntimeRecoveryNotice for an incomplete predecessor Epoch
P4 stable memory pool + bounded query recall
P5 current Runtime Session transcript projection + bounded previous-session overlap + current invocation/tool delta
P0-P5 是 Iris 语义 taxonomy，不等同于 Pi message 类型或固定物理 slot。

## Physical Layout

system
= P0 + immutable P1 + stable P2

m0 stable baseline
= folded P3 through baseline watermarks

- baseline P4

m1 volatile delta
= new committed P3/P4 after m0

- stable empty placeholder when no delta

live tail
= current Session logical units not represented by m0/m1

- previous-session overlap projection
- current Pi invocation delta
  system + m0 + m1 是缓存敏感前缀。相同 source/materialization/provider profile 必须 byte-stable replay。live tail 随当前 tool loop 追加，但不得反向改写已经物化的前缀。
  Pi host carrier固定为两个 ephemeral hidden CustomMessage：
  interface IrisContextCarrierDetails {
  irisContext: {
  schemaVersion: number;
  runtimeSessionId: string;
  surface: 'm0' | 'm1';
  materializationId: string;
  contentHash: string;
  };
  }

const M0_EMPTY_BODY = '<session-history></session-history>';
const M1_EMPTY_PLACEHOLDER =
'<session-history-since>(no new content since last materialization)</session-history-since>';
它们只由 context hook 返回，不追加到 Pi Session。顺序固定为 m0、m1、live tail。

## ContextSourceSnapshot

prepareInvocationSources() 必须在 AgentHarness.prompt() 前完成：
interface ContextSourceSnapshot {
contextSourceSnapshotId: string;
runtimeSessionId: string;
epochId: string;
personaSnapshotId: string;
declarationVersion: string;
continuitySeedId?: string;
runtimeRecoveryNoticeId?: string;
stableMemoryPoolVersion?: string;
providerProfileId: string;
canonicalSystemPrompt: string;
systemProjectionHash: string;
preparedAt: string;
}
同一 invocation 中，systemPrompt resolver 只返回已经绑定的 canonicalSystemPrompt，不得重新访问 DB、文件、网络或动态渲染。P0/P1/P2 在 invocation settled 前保持不变。
后台 Persona、declaration、Historian 或 Memory 变化只形成 pending version；能否进入当前 m1/m0 由 pass taxonomy 和 mid-turn gate 决定。

## Pi Input and Provenance Projection

一个普通 AgentInput 在 Pi 中持久化为：
normal UserMessage

- immediate iris_input_meta CustomMessage(details.iris)
  → one logical input projection
  context hook 必须：

1. 验证 pair key、content layout、hash 与 origin；
1. 折叠成一个 model-visible logical input；
1. 在 convertToLlm() 前过滤 companion；
1. 缺 companion、孤立 companion 或 hash 不一致时使用固定 fail-conservative omission projection，不补造历史。
   ToolResult 使用 Pi 原生 details.iris。previous-session overlap 只读取 closed Session archive 中的完整 HistoryProjectionUnit，携带 source Session/range/hash，不追加到新 Session，也不重新进入 Historian/Evidence/Graphiti。这里不要求物理 seal；closed 状态与固定 read facade 已足够。

## Pass Taxonomy

### SOFT+

- source 与 materialization identity 不变；
- byte-identical replay system/m0/m1；
  -只追加当前 invocation live delta；
  -不产生新的 drop/reasoning decision。

### SOFT

- system 与 m0 保持不变；
  -安全地更新 m1；
  -提交新的 additive/mutation state；
  -保留 OpenCode deferred-signal ordering。

### HARD

-在合法原因下重建 m0；
-折叠 m1；
-重新执行 decay/tier rendering；
-更新 serializer/provider/materialization epoch；
-捕获新的兼容 LKG。
合法 HARD reasons 包括 model/provider/profile、serializer/carrier、Persona/P2、cache epoch、context pressure、manual maintenance 和 baseline structural change。不得因普通 tool result 自动重建 P0/P1/P2。

## Historian and P3 Boundary

Historian 面向 Context 的 P3 输出仍只有已验证的 Session-scoped Compartments 与 ContinuitySnapshot；MemoryAssessmentDelta 随 Publication 交给 Router，不由 Context 直接读取。Context 只能读取 committed P3 状态和经 Router disposition 处理后的 MemoryRecall DTO。
只有已经安全进入当前 Session m0/m1 的 Compartment 才能替换对应 raw P5。必须分别记录：
committed Compartment head
represented Compartment head
current Session P5 start boundary
新 committed Compartment 先成为 pending materialization；在合法 SOFT/HARD pass 成功提交前，原始 P5 仍保留。

## P4 Memory Boundary

P4 分为：

- stable pool：可以进入 m0/m1；
- query recall：针对本次 meaningful input 计算一次，绑定该 projected user message，不在 tool turns 中重复查询或进入 stable prefix。
  所有 recall 只查询 Iris 的一个 private active Graphiti group。Recall score 只是相关性，不是 authority 或事实可信度。Context 不把 recall 结果重新发布成 Evidence。

### P5 + Memory Recall Analysis Projection

Historian 对一段历史的语义处理输入由两部分组成：Capsule 验证后的 P5 HistoryProjectionUnit，以及这些 invocation 中实际进入 provider-visible P4 的长期记忆投影。后者由 Context 在正常组装过程中生成，但它是一个稳定的数据契约，不代表 Historian 取得 Context Service、materialization state 或 repository。
Context 必须持久化不可变 InvocationMemoryRecallProjection，同时覆盖 P4 stable pool 与 query recall。它只回答“处理这段 P5 时，模型上下文中出现过哪些既有 memoryRef”，供 Historian 将新原始 Evidence 与旧记忆建立支持、纠正、限定或反驳关系。
interface InvocationMemoryRecallProjection {
projectionId: string;
invocationId: string;
runtimeSessionId: string;
queryRecallDecisionId?: string;
stableMemoryPoolVersion?: string;
items: Array<{
memoryRef: string;
objectKind: 'entity' | 'fact' | 'episode';
sourceSurfaces: Array<'stable_pool' | 'query_recall'>;
providerCallOrdinals: number[];
canonicalTextHash: string;
semanticKind: string;
attributionClass: string;
sourceTrust: string;
recallDispositionAtProjection: string;
evidenceSetIds: string[];
validAt?: string;
invalidAt?: string;
}>;
createdAt: string;
projectionHash: string;
}
规则：

- 只包含成功 Context transform 后实际进入 provider-visible P4 的 stable/query-recall 条目，不包含未采用候选、Persona、P3 Compartment 或普通摘要；
- 同一 invocation 的多次 provider call 采用集合并集语义；同一 memoryRef 去重并累积受控 sourceSurfaces + providerCallOrdinals；
- Projection 是 Context 派生分析数据，不是 Pi message、Evidence、Episode、Compartment 或事实来源；
- sourceTrust 只描述原始来源性质，Context 与 Historian 都不得就地改写；
- Projection 本身不能支持或反驳任何事实，也不能增加独立证据数；
- Historian 只能把它用于定位评估目标；事实依据必须来自与这些 invocation 对应的新 P5 原始 Evidence；召回文本、模型复述或摘要不得成为 basis；
- releaseInvocation() 只释放内存绑定，不删除已持久化 Projection；Projection 在 Historian 处理水位越过关联 P5 range 并满足保留策略后才可 GC；
- Context 通过窄只读 Port 暴露投影；Historian 不读取 Context materialization、m0/m1/LKG 或其他 context.db 表。
  interface InvocationMemoryRecallProjectionReadPort {
  getByInvocationIds(input: {
  runtimeSessionId: string;
  invocationIds: string[];
  }): Promise<InvocationMemoryRecallProjection[]>;
  }
  这形成跨时间的版本化数据反馈：Historian 的 committed P3/P4 输出可被未来 Context 使用，Context 产生的 recall projection 又可被 Historian 与后续 P5 联合分析；任何一次调用都不得同步回入正在运行的 Context transform 或 Historian transaction。

## LKG

LKG 是 provider-visible transform 的安全恢复槽，不是跨 Runtime Session 连续性机制。
LKG 至少绑定：
runtimeSessionId
ordered logical-unit IDs
last safe real-user anchor
model/provider/profile
ContextSourceSnapshot/materialization IDs
input reshape fingerprint
tool-arc seam
signed-reasoning seam
serializer/carrier version
Replay 必须验证 captured prefix 仍完整有序、anchor 位置不变、source/model/profile 兼容、splice seam 不切断 tool arc、assistant structure 或 signed reasoning。验证失败即拒绝 LKG。

## Failure and Emergency Policy
