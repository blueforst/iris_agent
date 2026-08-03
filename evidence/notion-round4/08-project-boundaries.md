Iris M1 从一个代码项目拆分为两个独立项目。这里的“本体”指 Iris Agent 主体，不是知识图谱 ontology。

## Project A — iris-agent

建议仓库：blueforst/iris_agent
职责：

- Persona、Host、Ingress/Admin、客户端；
- Pi Runtime Capsule、Runtime Session Epoch、History Archive；
- Context、Magic Context parity、P0–P5；
- Historian、ContinuitySnapshot、HistorianPublication、authoritative publication_outbox；
- Tool System、Body、运行保障；
- Memory Client Adapter。
  禁止：
- 直接打开 Memory Router 数据库；
- 直接连接 Neo4j 或操作 Graphiti SDK object；
- 自行实现 stable memoryRef、图内事实 resolution、RecallDisposition ledger 或 reindex。

## Project B — iris-memory

建议仓库：blueforst/iris_memory
职责：

- Publication acceptance API、幂等与版本验证；
- accepted Publication/Evidence/Assessment ledger；
- ordered ingestion、sourceSequence 与 Graphiti jobs；
- Graphiti/Neo4j profile、active/building group、reindex；
- stable memoryRef、RecallDisposition、provenance expansion；
- recall/search/expand API；
- 独立迁移、备份、恢复、可观测性和容量治理；
- 发布跨项目契约包和 JSON Schema。
  禁止：
- 读取 Pi Session、Runtime Epoch、Context、Historian、Persona、Tool 或 Body 数据库；
- 参与 Agent provider/tool loop；
- 决定 P0–P5 或当前 invocation 的 Context；
- 保存第二份 Iris 普通会话历史。

## Cross-project contract

iris-agent Historian
→ durable publication_outbox
→ Memory Client
→ versioned Publication API
→ iris-memory acceptance receipt
→ Agent ACKs outbox

iris-agent Context / Tool
→ versioned Recall request
→ iris-memory Recall/Expand API
→ stable Memory DTO
跨项目契约只能有一个权威来源。推荐由 iris-memory 发布 @iris/memory-contracts（或同等生成物），包含：

- HistorianPublication envelope；
- acceptance receipt 与 idempotency conflict；
- RecallRequest / RecallCard / Expansion DTO；
- health/capability/version handshake；
- JSON Schema/OpenAPI 与兼容性测试 fixtures。
  iris-agent 固定依赖精确 contract version，不复制手写 DTO。Agent 内部 iris-contracts 只包含本体内部 Port 和领域类型。

## Availability and failure semantics

- Memory service 不可用时，Publication 保留在 Agent outbox 并重试；不回滚 Historian 已提交状态。
- Recall 不可用或超时时，Agent 可以按显式 degraded policy 继续；结果必须标记 memory_unavailable，不得伪装为“没有相关记忆”。
- 重复 Publication 必须按 idempotency key 返回同一 acceptance result。
- Contract major version 不兼容时双方 fail closed；不得猜测字段含义。
- Memory service 可以独立重启、升级和重建 Graphiti，不影响 Iris Agent 的连续身份和 Runtime Session。

## Deployment and data roots

iris-agent process + data root
iris-memory process + data root
Neo4j/Graphiti belongs to iris-memory deployment
两项目允许同机部署，但必须拥有独立进程、独立配置、独立迁移、独立 CI/CD 和独立版本。备份恢复要分别执行，再通过 publication sequence、receipt 和 contract version 做一致性检查。

## Progress ownership

- iris-agent Roadmap 记录本体实现与跨项目集成进度；
- iris-memory 使用自己的 Roadmap、PR、CI 和 evidence；
- 总体 Iris 状态可以聚合展示，但不得用一个项目的完成率代替另一个项目；
- R4 在 Agent Roadmap 中改为“Memory Service Integration”，Memory Router/Graphiti 的内部实现进度归 iris-memory 项目。
