## Cross-project Boundary Decision — 2026-07-31

Iris Agent 本体与长期记忆正式拆分为两个独立项目：iris-agent 与 iris-memory。模块 Port 规则现在同时适用于跨仓库、跨进程和跨数据根边界。
iris-agent
owns Persona / Pi Runtime / Sessions / Context / Historian / Tools / Body
owns HistorianPublication + authoritative publication_outbox
contains only a stateless Memory Client Adapter

iris-memory
owns Publication acceptance / Evidence ledger / RecallDisposition
owns Graphiti ingestion / stable memoryRef / recall / reindex
owns Neo4j and all memory-service persistence
强制规则：

- Historian 留在 iris-agent，因为它从 Pi 历史、P5 与 invocation recall projection 派生 Publication 和 ContinuitySnapshot；
- Memory Router、Evidence Store、Graphiti Adapter 与 Recall API 全部迁入 iris-memory；
- iris-agent 不得链接或嵌入 Memory Router implementation，也不得打开其 SQLite/Neo4j；
- iris-memory 不得读取 Agent 数据根、Pi Session、Context 或 Historian 数据库；
- Memory Client 从 Host 内部 transport dispatcher 升级为跨项目 Adapter，但仍不拥有 outbox 或 delivery truth；
- 跨项目 DTO 由 iris-memory 发布的版本化 contract package/JSON Schema 唯一拥有，Agent 只消费固定版本；
- 网络或 IPC 失败不得转化为数据库直连 fallback。
  项目级详细边界见 08 Project Boundaries｜Iris Agent 与长期记忆双项目边界。
  本规范是 Iris 所有模块边界、状态所有权与跨模块 Port 的最高优先级契约。局部规格若与本页冲突，以本页为准。
  Pi 主回合运行边界的权威细则见 05 Pi Runtime Capsule Boundary｜Pi Harness 与 Iris 实现边界。凡涉及 model/tool loop、普通消息持久化、streaming、abort、settled、pending writes、Context hook 或崩溃恢复，必须同时遵守该边界页。

## Upstream Compatibility Precedence

Pi Harness、Magic Context 与 Graphiti 是 Iris 的三个直接技术上游，但权威维度不同：
Pi core AgentHarness/Session
→ runtime mechanism / lifecycle / persistence authority

Magic Context OpenCode main implementation
→ Context feature / algorithm / state-machine authority

Graphiti core
→ semantic graph engine authority
packages/pi-plugin 与其他 Agent 版 Magic Context 功能不完整，只是 host compatibility evidence，不是功能权威。
verified authority semantics
→ preserve both Pi lifecycle and OpenCode Context behavior
→ adapt Iris domain model / DTO / workflow
→ use existing public hook or configuration
→ add a thin Iris Adapter/facade
→ propose a generic upstream improvement for a proven common gap
→ temporary minimal locked patch with tests and removal conditions
→ otherwise explicitly defer the affected feature; never build a parallel core

## Upstream Investigation Gate

任何新的 bug、性能瓶颈、恢复缺口、Context 异常、历史膨胀、工具循环问题、记忆漂移或检索问题，在进入 Iris 方案设计前必须完成相关上游调查：
identify affected capability
→ inspect locked upstream source/tests
→ inspect current upstream source
→ search issues / PRs / release notes / known limitations
→ reproduce with upstream-native minimal case
→ classify: existing solution / misuse / integration gap / true upstream gap / Iris-only need
调查范围按问题类型至少覆盖：

- Pi：Harness、Session、storage、provider、tool loop、hooks、compaction；
- Magic Context：优先审查 OpenCode 主实现的 transform、m0/m1、deferred signals、LKG、cache invariants、reasoning/drop replay、Historian、protected tail、recomp/wrapup、emergency handling；Pi/其他 Agent plugin只补充host差异；
- Graphiti：Episode ingestion、group、entity/fact resolution、temporal edges、search/provider behavior。
  没有完成上游调查，不得新增 Iris repository、状态机、表、协议或后台 worker。调查结论必须进入设计依据或 compatibility record。
  强制规则：
- 与 Pi 冲突时，先让 Iris 输入、Context、Tool 或 Session-history 投影适配 Pi 的真实 message/session/loop 语义；
- 与 Magic Context 冲突时，先让 Iris Context 的 source/materialization state 与 transform pipeline 兼容其缓存稳定和 Historian 不变量；
- 与 Graphiti 冲突时，先让 Router、Evidence projection、memoryRef 和 recall contract 适配 Graphiti 的真实 Episode/entity/fact/search 语义；
- 不得把 Iris 专属 Persona、P0–P5、Origin、Evidence、Router 或权限概念塞入 Pi/Graphiti 核心；
- 上游缺少的能力若不是通用缺口，只能留在 Iris Adapter 或延后，不能以 fork 重写为默认路径；
- 若适配会破坏 Iris 已确认的产品根不变量，应把该能力标记为 unsupported/deferred，并记录冲突，而不是同时维护两份真相。

## AIRI Reference Boundary

AIRI 不是技术上游。它只作为同类型 AI 伴侣/Agent 产品的观察对象，用于产品定位、交互形态、用户体验、功能覆盖和行业比较。不得以 AIRI 为依据设计 Iris 的模块 ownership、Port、runtime、Store、状态机、协议、角色卡、数据模型或 Adapter；也不得在技术问题调查中把 AIRI 排在三个直接上游之前。

## Context Reference Precedence

Context 的设计参考优先级固定为：
Magic Context OpenCode main implementation + shared core/Rust
→ map OpenCode host identities to the active Runtime Session's HistoryProjectionUnits
→ adapt complete adopted semantics to locked Pi core hooks
→ add Iris-specific P0-P5, Origin and Graphiti recall semantics
P0–P5 只是语义层。物理 prompt layout、每次 LLM call transform、稳定前缀、baseline/delta fold、deferred signals、LKG seam validation、缓存 bust taxonomy、reasoning/drop replay、protected tail、Historian lease/trigger/repair、recomp/wrapup与emergency handling以OpenCode主实现为权威；Pi只决定concrete seam。不得用Pi plugin功能缺失来发明简化状态机。

## Core System Shape

one long-lived Iris Host process
= one Iris data root
= one continuous Iris identity
= one Persona
= one ordered Runtime Session lineage
= one active locked Pi AgentHarness + Session + SQLite backend at a time
= one session-scoped ContextSourceSnapshot + m0/m1 materialization state
= closed-session history archives used read-only by fixed domain code
= one private semantic memory graph

many frontend clients
= CLI / Web / Desktop App / Mobile App connected to that Host
Iris 不提供多角色、多用户、用户可选择的 Conversation、Branch、Memory Scope 或权限 Profile 领域抽象。Runtime Session 作为内部、有界、单 active 的 Pi 运行 Epoch 正式存在，但不成为产品会话、身份、角色、权限或 memory scope。M1 明确运行在单一可信操作者、受信本地或私有部署假设下，但不把操作者建模为领域实体；M1 不开发主体认证、trigger admission 或工具授权。多个前端只代表多个交互表面，不代表多个 Iris 实例。不同智能体仍必须使用不同数据根或独立部署。

## Three-layer Core Boundary

Iris 核心必须区分三个不同层次，禁止因为都出现 context 或 agent 字样而合并实现：
Pi Runtime Capsule
= 当前 Runtime Session 中回合如何运行、消息如何追加、工具如何循环、何时 abort / settled

Iris Context
= 某次 provider call 中模型应看到什么；P0-P5 如何稳定投影

Iris Core
= 这个连续智能体是谁，以及 Persona、Memory、Tool capability、Body、provenance 的领域语义
严格规则：

- Pi Session.buildContext() 是从当前 Session path 构建 Pi message base 的机制，不是 Iris Context 模块；
- Pi context hook 决定 transform 的调用时机，Iris Context 决定 transform 的语义结果；
- 当前 invocation 的 assistant/tool-call/ToolResult delta 继续由 Pi 原生 loop 追加，Context 只能投影，不能接管或复制；
- Iris Core 可以向 Capsule 提供 Context、Tool、provenance 等窄 Port，但不能拥有 provider loop、phase、queue、pending writes、普通消息或 settled；
- Pi 可以构建完整的当前受限 Runtime Session context，但不得拼接 closed Session archives；若单个 Session 仍超过声明容量上限，优先 rollover，再评估通用 bounded-source 改进。

## Long-term Memory Boundary

长期记忆同样分为控制/可靠性边界和语义引擎边界：
Memory Router
= 是否接受、按什么顺序写、写到哪个 active group、如何重试/重建、如何暴露稳定引用

Graphiti
= Episode 进入后如何抽取实体与事实、去重与 resolution、时序失效、图保存与 hybrid search
Historian 拥有 committed Publication、Session-local processed cursor 与唯一权威 publication_outbox；这些状态在同一个 historian.db 事务中提交。Memory Client 是 Host 内无状态、可重建的 transport dispatcher，只通过 HistorianPublicationOutboxPort claim、标记失败或在 Router durable ACK 后标记 delivered；它不拥有数据库、第二份 outbox、Publication 副本或独立 delivery truth。端口方向固定为 Historian provides → Memory Client consumes；本页任何把 Historian 写成该 outbox Port consumer 的旧分配句均已废止。
Memory Router 拥有 accepted Publication/Evidence/Assessment ledger、跨 Runtime Session 的 ordered jobs/sourceSequence、active/building group lifecycle、stable memoryRef、RecallDisposition、Graphiti reconciliation、调用限额、group ownership verification 与 Recall DTO。Graphiti 拥有 Episode/Entity/Fact/Community 的语义图对象、实体与边解析、事实有效期和检索算法。Router 不重写 Graphiti 的 dedupe/resolution/invalidation；Graphiti 不决定 Iris 的写入资格、来源可信度、顺序、幂等、公开身份、Evidence 保留或召回安全处置。

## Core Invariant

跨模块协作必须经过窄 Port：
Consumer Module
→ Port Contract
→ Provider Adapter
→ Provider Module / Infrastructure
模块不得取得另一模块的 Service、Repository、数据库连接、ORM entity 或第三方 SDK object。
同一模块内部可以直接调用；只有跨模块、跨进程和跨基础设施边界需要 Port。

## Global Dependency Rule

Frontend Clients
CLI / Web / Desktop App / Mobile App
↓ Ingress/Admin API + streaming transport
Host / Composition Root
├─ constructs Domain Modules
└─ constructs Pi Runtime Capsule
├─ one locked pi-agent-core AgentHarness
├─ one active core Session for the current Runtime Epoch
├─ one pi-storage-sqlite-node SqliteSessionRepo
├─ Pi Models / Provider
├─ OpenCode-parity Iris Context Adapter + native hooks
├─ native tool-call loop / explicit compaction capability (unused in M1)
├─ streaming / abort / settled
└─ pending writes / phase / queues

Application / Orchestrator
↓ AgentRuntimePort
Pi Runtime Capsule
↓ consumes narrow Iris ports
Context / Tool / Telemetry

Domain Modules
↓ outbound ports
Infrastructure Adapters
↓ database / SDK / network / filesystem
依赖必须单向、无环。Pi 内部强耦合运行链路作为一个 Capsule 保持原生协作，不在 AgentHarness、Session、SqliteSessionRepo、Provider、compaction 和 tool loop 之间插入 Iris Port。Pi Runtime Capsule 只是边界名称，其实现直接复用真实 Pi runtime，不允许 Iris 重写 agent loop。
禁止：
Persona ↔ Memory
Context ↔ Historian direct repository access
ToolRegistry ↔ Orchestrator implementation access
MemoryClient ↔ Context database access
Body ↔ Persona
Domain Module → Host
Domain Module → concrete Adapter
允许 Context 同时消费 Persona、History、CommittedCompartmentReadPort 与 Memory 的只读 Port，但这些 provider 不得反向调用 Context。Context 与 Historian 必须共用 Capsule 的 runtimeSessionId + HistoryProjectionUnit + OpenCode-equivalent protected-tail boundary DTO，不得各自重新推导 UserMessage/companion、assistant/tool-result或一次 prompt/tool-loop 的边界。Projection unit ordinal 与 entrySeq 均为 Session-local。

## Module Ownership Matrix

### Host / Composition Root

拥有唯一长期后端进程、配置装配、依赖构造、Ingress/Admin 服务端点、输入 origin 规范化、trigger 路由、管理命令分流和优雅退出。任意已接入 Host/Adapter 来源都可以形成 AgentInput；管理命令直接调用 Admin Port，不进入模型主回合。M1 Host 不执行主体认证、权限判断或按用户来源准入，因为其支持范围固定为单一可信操作者的受信本地或私有部署；这种分流只保持运行语义。Host 不得读取其他模块业务表或在装配后绕过 Port。

### Frontend Clients

CLI、Web、Desktop App 与 Mobile App 是 Host 客户端。它们可以持有 endpoint、连接状态、显示缓存、草稿和未提交 UI state，但不得：
-打开 Iris data root 或任何业务 SQLite；
-加载 agent.json 并构造领域模块；
-创建 RuntimeSessionEpochManager、Pi Session、AgentHarness、Context、Historian、Memory Client 或 Tool System；
-维护另一份 active Session、assistant result、runtime event truth 或 Context；
-把前端进程生命周期解释为 Iris identity 生命周期。
多个前端连接统一进入 Host 的有界 ingress 和同一个 Runtime Coordinator。

### Persona

拥有 soul.md、Persona Proposal/Revision/Selection/Snapshot 与 persona.db。提供 Persona snapshot 读取和显式 Persona 管理能力。不得访问 Memory、Evidence、Graphiti、Pi Runtime Session history/archive 或 context.db。

### Pi Runtime Capsule

直接拥有 Compatibility Manifest 锁定的 pi-agent-core AgentHarness + Session、pi-storage-sqlite-node SqliteSessionRepo/SqliteSessionStorage、主模型 Provider、当前 Runtime Epoch 的 active Pi Session identity、原生 systemPrompt resolver 与 hooks、普通消息持久化、显式 compaction capability（M1禁用）、tool-call loop、streaming、abort、pending writes、phase 与 queues。coding-agent AgentSession 不属于 M1 runtime。
Iris Capsule Adapter 以锁定 OpenCode主实现为golden authority，承载其完整adopted Context语义；接收Coordinator预先准备的ContextSourceSnapshot，通过原生systemPrompt resolver提供稳定P0；输入 bridge 把 AgentInput 映射为普通 Pi UserMessage + 同 prompt batch 的隐藏 iris_input_meta CustomMessage companion，companion 的 details.iris 保存 entry/block provenance。Context hook 验证并折叠这对消息，渲染 m0/m1/live tail，并为 Iris tool result 保存 provenance details。Capsule 不复制或重写 Pi 的 agent loop、消息队列、tool loop、compaction、SessionManager 和 Session persistence。Iris 不是通用插件平台：HarnessFactory 以固定源码静态组装 systemPrompt、input companion、Context 和 Model Adapter hooks，不提供动态 Extension/plugin loader、运行时 hook 注册或原生 Harness 访问入口。优先使用零源码改动的原生扩展点；Iris 侧 Adapter 优先于修改 Pi；确需上游补丁时只能修复 bounded cache、sequence cursor、metadata persistence 等通用能力，不得加入 Iris 专属运行语义。
对外提供：

- AgentRuntimePort；
- RuntimeSessionHistoryReadPort；
- RuntimeSessionHistoryDiagnosticsPort。
  不得向外泄漏 Pi Session、SessionTreeEntry、AgentMessage、Provider 或 Repository 类型。RuntimeSessionHistoryReadPort 是模块解耦接口，不是物理不可变或安全隔离边界；其 Adapter 可以在 Capsule 内临时打开 Pi Session 完成读取，但 Historian 和普通 maintenance 代码不能取得可写 concrete object。

### Orchestrator

拥有一次 invocation 的极薄 Capsule 外协调与精确取消：检查单写者状态、冻结 triggerOrigin、生成或投影进程内 correlation invocationId、在调用 Pi Harness 前执行 prepareInvocationSources() 并把 prepared source 绑定到 Capsule、调用原生 Pi Harness、转发原生 runtime events，并在观察到 Pi settled 后释放 Context invocation state 与 active invocation。它不得维护第二套 phase 状态机、消息队列、模型循环、工具循环、消息持久化、pending-write 恢复、durable invocation outcome、assistant result store 或 provider delta event log，也不得访问业务数据库。
M1 Orchestrator 不拥有 Agenda、Goal Graph、WaitingCondition、持久 WorkItem、Active Activity、Scheduler 或跨 invocation 的目标选择状态。用户、Host、Body 和未来 Scheduler 都只能作为受控 trigger producer 接入；未来自主任务模块不得取得 Orchestrator implementation、Journal writer、Context repository 或 Tool repository。

### Model

拥有 Historian 等辅助模型、tokenizer、context-window resolver 与模型错误翻译。主 Agent provider/stream 属于 Pi Capsule。不得与 AgentHarness 争夺主回合控制权。

### Context

拥有 P0-P5 语义组装、origin-aware 内容投影、Context source snapshot、P0 system-prompt projection、OpenCode Magic Context-authoritative stable m0、volatile m1、deferred signal/LKG/replay/emergency state、committed Compartment projection、PassiveRecallPool/P4、live P5 tail、pass taxonomy 与 context.db。Context transform 在每次 Pi provider call 前运行，必须确定性重放已物化前缀，并把 Pi 当前 invocation 的新 assistant/tool-call/ToolResult delta 纳入尾部。
Context 以 Magic Context OpenCode主实现为功能权威：transform本身不调用LLM；Historian 后台运行并由 Host 内唯一全局单 worker 队列串行调度；新Compartment/recall/pending ops只在合法pass消费；LKG验证anchor/entry sequence/model/provider/reshape/tool-reasoning seam；reasoning/drop/structural mutation每pass确定性replay；recomp/wrapup与emergency outcome保持等价；Compartment decay/re-tier只在HARD fold重算；SOFT+必须byte-stable。Pi plugin不定义此能力清单。P5 boundary 由 m0 + m1 已表示的最后一个 committed Compartment endEntrySeq 决定，Context 不读取 Historian processedThroughEntrySeq 作为裁剪边界。
所有进入运行链路的输入共用同一套 P0-P5，不按 principal、channel 或 InteractionContext 生成第二套 Persona/P3/P4/P5，也不拥有工具授权逻辑。Context 必须区分 request、notice 与 external data，不能通过 Prompt 投影改变 authority；不得读取 Pi 内部表、Historian store 或 Graphiti 实现。

### Historian

拥有 origin-aware eligibility/exclusion 分类、归因规则、Magic Context 风格的 protected-tail boundary、有限 Journal snapshot、Publication/Segment/Compartment、provisional-last 验证、unprocessedFromEntrySeq、内部 processed watermark、durable single-flight state、local ledger 与 historian.db。它是唯一允许把 Runtime Session history/archive 原文转化为持久语义产物的模块，但不得把外部声明或模型陈述静默升级为可信世界事实。Historian processed watermark 仅用于处理与恢复，不直接改变 Context P3/P5 boundary。
