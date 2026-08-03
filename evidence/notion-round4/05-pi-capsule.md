本页是 Pi Harness 与 Iris 实现职责划分的权威契约。凡涉及主回合执行、消息持久化、工具循环、streaming、abort、settled、崩溃恢复、Context hook、Tool System 或 Runtime Session history 投影的设计，必须先按本页判断所有权。

## Core Boundary

Pi Runtime Capsule
= how one native agent turn runs and persists inside the active Runtime Session

Iris
= what this continuous agent is, which Runtime Session is active,
what context it sees, what domain capabilities it exposes,
and how Pi state is projected across Session Epochs
Pi Runtime Capsule 不是 Iris 自研 runtime。M1 具体组合是锁定版本的 AgentHarness + Session + SqliteSessionRepo，并包含 Provider、当前 Runtime Epoch 的 active Session、原生 hooks、tool loop 与生命周期事件。每次 Session rollover 都重新构造一个新的 AgentHarness；不在运行中的 Harness 上替换 Session。coding-agent 高层 AgentSession 不属于 M1 边界。Iris 通过薄 Adapter 和 Port 接入，不在 Capsule 外复制运行状态。

## Conflict Resolution Precedence

这里有两个并列上游权威，不能把其中一个降级为另一个的插件子集：
Pi core AgentHarness/Session
= runtime mechanism, lifecycle, persistence and hook-contract authority

Magic Context OpenCode main implementation
= Context feature, algorithm and state-machine authority
发生冲突时：
preserve Pi core lifecycle/mechanism

- preserve adopted OpenCode Magic Context semantics
  → map OpenCode messages/tags/session state to Iris session-local HistoryProjectionUnits
  → use native Pi hook/config
  → thin Capsule Adapter
  → generic upstream improvement for a proven common gap
  → temporary minimal locked patch
  → otherwise explicitly defer the affected feature
  Pi/其他 Agent 的 Magic Context plugin 功能不完整，不能作为删减 OpenCode feature 的理由。
  不得为了实现 Iris 预先设想的 invocation、Context、Session history 或 tool-result grammar 而要求 Pi 改变原生 loop，也不得建立平行 runtime 作为“兼容层”。只有 bounded context source、sequenced cursor、bounded cache 等对通用 Pi 使用者同样成立的缺口，才允许进入上游改进评估。

## Three Different Meanings of Context

Pi 与 Iris 中存在三个容易混淆、但所有权完全不同的“Context”：
Pi Session context
= Session.buildContext() 从当前 Session path 投影出的 message/state base

Pi Harness context hook
= AgentHarness 在每次 provider call 前触发 transform 的执行 seam

Iris Context
= ContextSourceSnapshot + m0/m1 materialization + P0-P5 + provenance/budget/pass taxonomy 的领域语义
源代码级调用链是：
Runtime Coordinator calls prepareInvocationSources before prompt
→ Capsule binds immutable ContextSourceSnapshot + canonicalSystemPrompt + hash
→ AgentHarness.createTurnState()
→ Session.buildContext()
→ native systemPrompt resolver returns bound in-memory P0 bytes
→ before_agent_start appends input metadata companion only
→ create AgentContext(messages, tools, systemPrompt)
→ before each provider call: context hook(messages)
→ Iris Context Adapter renders m0/m1/live tail
→ Pi provider/tool loop continues
→ after each tool turn: Pi flushes pending writes and rebuilds turn state/systemPrompt
因此：

- Session.buildContext() 的路径读取、compaction transform、message projection 属于 Pi；
- systemPrompt resolver 与 context hook 的触发频率、当前 invocation messages、tool result 追加和下一轮重建属于 Pi；
- P0-P5 的选择、source snapshot、m0/m1 materialization、origin-aware 折叠、长期记忆召回和 token budget 属于 Iris Context；
- P0 在 preflight 中一次性渲染；原生 systemPrompt resolver 只跨 tool turns 重放 Capsule in-memory immutable string，不执行 DB/network/filesystem I/O；before_agent_start 不是稳定 P0 seam；
- Iris Context 只能返回模型可见 view，不能 append 普通消息、推进 phase、调用 provider、执行 tool loop 或保存 settled；
- Context 不得把第一次 hook 时的 messages 冻结成整个 invocation 的唯一输入。Pi 后续产生的 assistant/tool-call/ToolResult delta 必须在每次 hook 中重新纳入；
- M1 允许 Pi Session.buildContext() 读取完整的当前 Runtime Session，因为每个 Session 受 entry/token/SQLite/资源上限约束并会在 settled 后 rollover。禁止把多个 closed Session 拼接后交给 buildContext()。只有单个 Session 仍超过已声明容量上限时，才需要通用 bounded source 改进。

## Iris Core and Epoch Management Outside the Capsule

“Iris 本体”不是另一个 Agent runtime，而是 Capsule 外的领域系统：Identity/Persona、Runtime Session Epoch management、Context policy、Historian、Memory、Tool capability、Body、Origin/provenance 和 Host contracts。它通过窄 Port 给 Pi 提供语义与能力，并消费 Pi Session history 的 DTO 投影；它不拥有回合执行机制。
判定口诀：
mechanism and lifecycle → Pi Harness / Session
model-visible semantic view → Iris Context
continuous-agent identity and domain meaning → Iris Core

## Pi-owned Runtime Lifecycle

Pi 原生拥有：

- prompt/model invocation 与 provider streaming；
- user、assistant、tool call、ToolResult 的原生消息生命周期；
- tool-call/result sequencing 与下一轮模型迭代；
- Session append、SQLite transaction、pending writes 与 materialized runtime state；
- phase、内部 queues、usage、finish、abort 与 settled；
- 若被显式调用，Pi compact()、compaction entry 与默认 compaction-aware path transform 的原生机制；
- active Runtime Session 的创建/打开、持久化、重载与 Pi 原生崩溃恢复语义；
- 原生 Extension hook 和 tool registration 的调用时机。
  这些能力不得在 Iris 中形成平行实现。禁止新增：
  IrisAgentLoop
  IrisToolLoop
  IrisMessageQueue
  IrisSessionManager
  IrisPendingWriteRecovery
  IrisInvocationStateStore
  IrisResultStore
  IrisRuntimeEventLog
  Pi 的 settled 是单次 invocation 的运行时权威终点，也是正常 Runtime Session rollover 的唯一切换点。Iris 可以观察、投影并在其后关闭旧 Session、创建新 Session或触发后台工作，但不能维护另一份 completed/failed/settled 真相。

## Compaction Ownership and M1 Non-use

core AgentHarness 当前不实现 auto-compaction；compact() 是仅允许 idle 时显式调用的结构操作。Iris M1 的 provider-visible history reduction由 OpenCode Magic Context authoritative semantics 下的 Historian + m0/m1/P5承担，因此：

- M1 永不调用 AgentHarness.compact()，不追加新的 Pi compaction entry；
- 不安装第二个 compaction/context-rewrite plugin，不允许 operator 通过普通命令调用 Pi compact；
- Session.buildContext() 的默认 compaction transform 仍属于 Pi，但在线 Session history contract 要求没有 M1 新建的 compaction entry，因此正常路径是 no-op；
- Context 达到压力线时执行 SOFT/HARD/emergency fold；仍无法形成合法 provider payload 时，context hook 直接抛出稳定 IRIS_CONTEXT_TRANSFORM_UNAVAILABLE 或 IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED，发生在 convertToLlm() 与真实 Provider 调用之前；Harness 按原生失败路径写入 failure message、agent_end 与 settled，不回退到 Pi compaction；
- 导入含历史 Pi compaction entry 的旧 Session history 不属于直接兼容路径，必须经过独立 migration/replay，不能把 compaction summary 当作 Iris 原始历史或 Historian Evidence；
- Pi 未来若实现 auto-compaction，升级审计必须验证可以关闭；无法关闭时该版本不兼容 Iris M1。

## Iris-owned Domain Semantics

Iris 原生拥有：

- 单一 Identity、Persona ledger 与 PersonaSnapshot；
- RuntimeSessionEpochManager、active Epoch CAS、settled 后 rollover、closed-session archive 与 ContinuitySnapshot binding；
- OriginEnvelope、内容块 provenance、content hash 与来源投影规则；
- P0-P5、ContextSourceSnapshot、ContextMaterializationState、OpenCode-parity LKG/pass state、Compartment projection 与 PassiveRecallPool；
- Historian、Publication、Evidence、Memory Client/Router 与 Graphiti binding；
- ToolDescriptor、ToolRegistry、具体 capability Adapter、参数规范化、运行前置条件、timeout、外部副作用幂等与 outcome_unknown；
- Body connection、observation、primitive、event 与 Adapter state；
- Host ingress/control routing、配置装配、健康检查和优雅退出；
- 薄 Runtime Coordinator 的单写者门闩、进程内 correlation 与精确 abort 转发；
- 对 Pi entries/details 的验证后 Runtime Session history/archive DTO 投影；
- 单 active Runtime Session、Session 内线性 append、Session 容量上限、settled 后 rollover、closed archive 与 continuity handoff 等 Iris 采用约束与 contract tests。
  Iris 持久状态只能保存 Iris 领域事实或派生状态，不能复制 Pi 已经拥有的普通消息、tool result、phase、settled 或 pending write 状态。

## Shared Seam: Input

输入边界固定为：
Host / Adapter / Body
→ create origin-aware AgentInput
→ Iris input bridge validates and maps metadata
→ Pi native input/message facility appends input
→ Pi native turn lifecycle begins
Host/Adapter 拥有 transport-specific parsing、inputId、Origin 与 block layout。输入映射适配 Pi 的现有能力：正常 UserMessage 保存正文，before_agent_start 在同一 prompt batch 中追加隐藏 iris_input_meta CustomMessage companion 保存 details.iris。Context hook 验证配对并投影成一个模型可见逻辑输入。真正的 append、turn trigger 和后续消息生命周期仍属于 Pi。
Pi core 的 steer/followUp/nextTurn 不触发 before_agent_start，因此 M1 不把外部 origin-aware 输入直接送入这些裸队列 API；新输入应在 Host 中有界排队，并在 settled 后作为下一次普通 prompt 进入。
Iris 不提供普通消息公共 append Port，也不要求 Pi 新增任意-message prompt API。companion 是 Pi 原生 custom message 的受限使用，不是第二套消息历史。
inputId 与 invocationId 可以作为 details.iris correlation metadata，但它们本身不授权 Iris 建立持久 invocation ledger。HTTP exactly-once、客户端重试去重和 durable ingress queue 属于未来 Host delivery reliability 设计，不属于 Pi agent loop，也不进入 M1 核心状态。

## Shared Seam: Context

Context 边界固定为：
before AgentHarness.prompt: Iris prepares ContextSourceSnapshot + canonicalSystemPrompt
→ Capsule binds them
→ Pi createTurnState calls native systemPrompt resolver, which returns the bound P0 string
→ before_agent_start injects input companion only
→ before every provider call Pi reaches native context hook
→ Iris ContextRuntimePort reads bounded domain projections
→ Iris returns cache-stable m0/m1/live-tail message materialization
→ Pi owns provider call and subsequent tool loop
Iris Context 的功能与状态机以 Magic Context OpenCode 主实现为权威，决定 P0-P5 语义、system + m0 baseline + m1 delta + live tail、SOFT+/SOFT/HARD、deferred signals、LKG seam validation、reasoning/drop replay、protected tail、Historian trigger/repair/publication semantics、recomp/wrapup 与 emergency outcome；Pi 决定 hook何时被调用、消息如何进入原生 model/tool loop，以及本轮 assistant/tool delta如何追加。
OpenCode Magic Context 不改变 Pi ownership：Iris 把其完整 adopted semantics适配到 Pi messages/context/tool hooks，不能复制 OpenCode SessionManager/UI，也不能要求 Pi core认识m0/m1。packages/pi-plugin 与其他 Agent版只用于兼容参考，不能定义feature parity。
M1 的 provider-visible hook chain 由 HarnessFactory 以固定源码静态组装。Iris 不是通用插件平台，不提供动态 Pi Extension loader、运行时 hook 注册、第三方 message transform 或原生 Harness 访问入口。
prepared systemPrompt resolver
→ before_agent_start input companion bridge
→ one Iris Context Adapter
→ fixed Model Adapter request/payload normalization
→ Provider
Iris Context Adapter 是唯一生成 provider-visible message replacement 的步骤，其状态转换必须通过 OpenCode golden parity。before_agent_start 只注入 metadata companion，不覆盖 systemPrompt；Model Adapter 只执行受信、版本化的 provider wire adaptation，不重新解释 P0-P5。Telemetry/event subscribers 只读观察，不修改 messages、system prompt、request options 或 provider payload。
ordinary failure 先尝试 compatible LKG；没有安全 LKG 时，context hook 直接抛出 IRIS_CONTEXT_TRANSFORM_UNAVAILABLE。OpenCode emergency 直接抛出 IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED。两者都发生在 convertToLlm() 和真实 Provider 调用之前，任何路径都禁止 raw-message passthrough。
因为不存在动态注册入口，M1 不实现 handler 枚举、冲突检测、registry freeze 或插件优先级协议；正确性通过 HarnessFactory 构造测试和最终 provider payload golden fixtures 验证。不得把 Magic Context Pi/coding-agent plugin、auto-compaction plugin 或第二个 message transform 纳入产品 composition。
Iris 不得让 Pi 加载多个 Runtime Session 的 lifetime archive 后再丢弃冷历史。当前 Session 可以使用 Pi 原生 buildContext()；Session Epoch Manager 必须在容量阈值前请求 rollover。若单个受限 Session 仍无法满足资源上限，再评估通用 bounded source 改进，不得重写 Harness。

## Shared Seam: Context Integrity Guards

Context failure映射分成两个Pi-native路径：

### ordinary context-hook fail-closed

context hook throws stable IRIS_CONTEXT_TRANSFORM_UNAVAILABLE
→ Harness normalizes the hook error before convertToLlm/provider network call
→ no normal tool call is generated; any unexpected tool wrapper entry returns a no-side-effect terminate result
→ AgentHarness follows its native failure path after current turn
→ Pi emits agent_end / settled

### OpenCode emergency_fail_closed

transformContext context hook throws stable IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED
→ Harness normalizes the hook error before convertToLlm/provider network call before models.streamSimple
→ AgentHarness catches and emits native assistant error / agent_end / settled
→ no provider payload or network request occurs
ordinary MinimalSafe是Iris因provenance/bounded-history不能使用OpenCode raw passthrough而作出的更严格host adaptation；emergency path必须保持OpenCode“不发送请求”的语义。两者都不是身份权限、risk policy或human confirmation。LKG正常可用且current suffix验证通过时不进入降级。

## Shared Seam: Tools

工具边界固定为：
Pi model emits native tool calls
→ every registered Iris AgentHarnessTool declares `executionMode='sequential'`, so Pi processes the batch in assistant ordinal order
→ Pi invokes registered Iris ToolExecutionPort
→ Iris validates descriptor/schema/runtime state/idempotency
→ Iris capability Adapter performs external operation
→ Iris returns normalized ToolResult content + details
→ Pi persists ToolResult and continues native loop
Pi 拥有工具调用顺序、tool result message 生命周期和下一轮模型迭代。audited core AgentHarness.createLoopConfig() 未向 Harness options 暴露全局 toolExecution，M1 因此要求每个注册的 Iris AgentHarnessTool 声明 executionMode='sequential'；任一 active tool 缺少该标记时 Host not-ready。Iris 不实现并行/保序 scheduler。Iris Tool System 拥有工具的领域语义、Adapter 执行、timeout、abort 响应、外部副作用幂等和不确定结果判断。
ToolResult 为空、不完整或在崩溃后缺失时，Iris 不补造消息、不定义 transcript repair，也不阻止后续模型重试。下一次普通 Pi 模型调用可以根据可见上下文自行决定重试、改参、换工具或询问用户。Tool System 可以保存最小 ToolExecutionRecord 以实现 capability 自身的幂等，但该记录不得改写 Pi Session history 或接管模型决策。

## Shared Seam: History

Runtime Session history/archive 的写入权威是 Pi SessionStorage：
Pi native entry/message content + details
→ single authoritative raw runtime history
→ Iris RuntimeSessionHistoryReadPort validation/projection
→ Context / Historian / diagnostics consumers
Iris 可以在 details.iris 中保存 provenance、input/invocation correlation 和 block hashes，并可以维护有界 materialized read indexes；这些只能是同一 Session history 的 metadata 或可重建投影，不能成为第二份消息历史或 invocation outcome ledger。
最终回复、工具结果、abort/error 与 compaction 是否已经持久化，应以 Pi Session history 和 Pi 原生恢复语义为准。M1 不额外追加 InvocationOpened / InvocationOutcome，也不追加 synthetic assistant / ToolResult 来闭合自定义回合 grammar。Pi-native 的不完整 transcript 本身就是历史事实。

## Shared Seam: Runtime Coordinator

Runtime Coordinator 只拥有：
