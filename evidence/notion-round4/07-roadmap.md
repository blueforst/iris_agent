本页是 Iris 实现计划、里程碑状态、阻塞项和实现证据的唯一权威入口。架构、需求、接口与不变量仍以 00–06 规格正文为准；本页不得用进度便利性反向覆盖规格。

## Execution Authorization

用户已授权按本 Roadmap 一次性、连续推进完整实施。进入实现后，默认从当前未完成里程碑开始，按依赖顺序自动推进到后续里程碑，不要求用户在 R0–R7 之间逐阶段批准，也不因阶段完成而暂停等待确认。
执行规则：

- 在已确认规格、已连接工具和现有权限范围内，自主完成设计翻译、编码、迁移、测试、基准、修复、文档同步与进度更新；
- 遇到普通技术分歧时，依据 00–06 规格、上游兼容优先级和测试证据自行选择可逆方案；
- 某一子项受阻时，优先完成不依赖该阻塞项的其他工作，不把整个 Roadmap 人为停住；
- 只有缺少必要仓库/运行环境/凭证、需要用户承担费用、需要不可逆或高影响外部操作、规格出现无法自行裁决的根冲突，或平台明确要求人工确认时，才暂停并报告；
- 中间状态更新只用于告知进展和暴露真实风险，不构成继续推进所需的批准请求；
- 不得把“已获得连续推进授权”解释为可以绕过安全边界、伪造测试证据、虚报完成率或执行未授权的外部发布/付费/破坏性操作。

## Current Status

overall_implementation_progress = 0%
roadmap_version = 3
status_date = 2026-07-31
current_phase = R0 Production Baseline & Repository Bootstrap
current_phase_status = in_progress
completed_milestones = 0 / 8
implementation_evidence = source-version audit recorded; no code/test evidence yet
当前已经完成大量设计工作，但设计完成度不计入实现进度。只有代码、数据库迁移、可执行契约、自动测试、基准测试或可运行纵切具备可验证证据后，才增加本页的实现百分比。

## Progress Accounting

状态只使用：
not_started
in_progress
blocked
complete
deferred
总体进度按里程碑权重计算：
overall progress
= Σ(milestone weight × verified milestone completion ratio)
计数规则：

- 文档设计、讨论和 Roadmap 调整本身不增加实现进度；
- 每个完成项必须绑定 commit、PR、测试报告、benchmark、migration 或可复现运行记录中的至少一种证据；
- 仅创建空目录、占位接口、mock-only 测试或未接入真实上游的演示，不视为对应能力完成；
- 一个里程碑只有满足其 Exit Gate 后才可标记 complete；
- 发生设计变更时，已经通过的实现证据必须重新评估，不自动保留百分比；
- 阻塞项单独记录，不通过降低验收标准制造进度。

## Two-project Progress Model — 2026-07-31

Iris Agent 本体与长期记忆现在是两个独立项目：
blueforst/iris_agent → Agent 本体 Roadmap
blueforst/iris_memory → 长期记忆独立 Roadmap
本页继续作为总体 Iris 集成 Roadmap，但进度必须保留项目归属：

- R0–R3、R5–R7 主要属于 iris-agent；
- Memory Router、Evidence、Graphiti、Recall 与 reindex 的内部实现属于 iris-memory，不得计入 Agent 仓库自身完成率；
- Agent 侧 R4 只计算 contract consumption、Memory Client、Publication delivery、recall integration、degraded behavior 和端到端兼容验证；
- 总体进度可以聚合两个项目的 accepted evidence，但必须分别列出 repo、commit/PR、CI 和 Exit Gate；
- 一个项目完成不能替代另一个项目的验收。
  项目边界见 08 Project Boundaries｜Iris Agent 与长期记忆双项目边界。

## M1 Roadmap

## R0 Production Baseline & Repository Bootstrap — 10%

目标：把设计规格翻译为冻结依赖、可编译契约和可持续验证的工程骨架。
主要交付：

- 填写 Pi Production Lock：仓库、commit、包版本、Node 版本、patches 与选择日期；
- 冻结 Magic Context OpenCode golden baseline；
- 填写 Graphiti/Neo4j production dependency lock；
- 初始化 blueforst/iris_agent 与独立 blueforst/iris_memory 两个项目，并分别建立 toolchain、CI、migration 和证据目录；
- 在 iris-agent 建立本体内部 iris-contracts；
- 在 iris-memory 建立并发布跨项目 memory contract package、JSON Schema/OpenAPI 与兼容性 fixtures；
- 明确跨项目依赖方向：Agent 只能消费 memory contracts/API，不能依赖 Memory Router implementation；
- 建立配置 schema、SQLite migration 体系和测试 fixture 目录；
- 建立 CI：format、typecheck、unit、contract、migration smoke test；
- 创建最小 benchmark/crash-test harness。
  Exit Gate：
- 所有生产依赖 lock 不再含 TBD；
- contracts package 可以独立编译和版本化；
- 空数据根可以通过 migration 初始化；
- CI 在干净环境完成安装、编译和最小测试；
- 依赖方向与 00 Module Boundaries & Ports 一致。

## R1 Pi Runtime Capsule Vertical Slice — 20%

目标：先验证 Iris 最危险的上游 seam，而不是铺开完整业务模块。
最小纵切：
iris serve
→ acquire iris.lock
→ open/create Pi SqliteSessionRepo
→ create one Runtime Epoch + Session + AgentHarness
→ accept one origin-aware AgentInput
→ persist UserMessage + iris_input_meta companion
→ prepare immutable system prompt
→ run minimal Context hook
→ execute one sequential read-only tool
→ persist ToolResult details.iris
→ reach native settled
→ restart and reopen the same Session
→ rollover after settled into a fresh empty Session
Exit Gate：

- input companion append/reload/pairing 通过契约测试；
- systemPrompt resolver、context hook 和 provider/tool-turn 调用顺序有可执行测试；
- ToolResult details.iris 可恢复；
- single-writer、abort、settled 和 queued-input 行为通过；
  -关键 startup、input append、tool side-effect、ToolResult commit 和 rollover crash windows 通过；
- 未生成 synthetic assistant 或 ToolResult repair。

## R2 OpenCode Magic Context Parity — 20%

目标：在 Pi 原生 lifecycle 上实现已采纳的 OpenCode Magic Context 行为，而不是只实现近似摘要系统。
主要交付：

- OpenCode v0.33.0 golden fixture generator；
- P0–P5 source projection；
- deterministic m0/m1 carriers 与 stable placeholder；
- SOFT+、SOFT、HARD、deferred signals；
- protected-tail boundary、HistoryProjectionUnit 与 tool-arc fences；
- LKG capture/replay/seam validation；
- reasoning/drop replay、mutation ledger 和 serializer/provider invalidation；
- v0.33.0 pressure-gated tool reclaim 与 threshold-clamp observability；
- ordinary failure、persistent-storage/schema-fence blocking 与 emergency fail-closed；
- released schema migration fixtures through v68；
  -明确验证 Memory Mural / experimental.mural 不进入 M1 payload；
- Context storage recovery 和 capacity benchmark。
  Exit Gate：
  -锁定 fixture 集上的 provider-visible output 与状态转换通过 parity gate；
- SOFT+ byte-identical replay 通过；
- raw-message passthrough 不存在；
- rollover 后建立 fresh Context lineage；
- provisional Session capacity limits 获得首轮 benchmark 证据并更新。

## R3 Historian & Cross-session Continuity — 15%

目标：把有界 Runtime Session 原文转化为可验证的 P3、Publication、Evidence 和跨 Session 连续性。
主要交付：

- RuntimeSessionHistoryReadPort 与 SequencedSessionEntry；
  -单进程全局 Historian worker queue；
- protected-tail trigger、finite batch 与 pure validation；
- Compartment、Segment、EvidenceSet；
- ContinuitySnapshot 与 previous-session overlap；
- MemoryAssessmentDelta；
- publicationSequence 与权威 publication_outbox 原子事务；
- wrapup、retry、recomp 和 crash recovery。
  Exit Gate：
