# AGENTS.md

本文件是仓库内所有开发 Agent 的工作契约。开始任务前必须先读取本文件，并在整个任务中遵守其中的权威来源、项目边界、验证和交付要求。

## 1. 权威来源

Iris 的 Notion 知识库是架构、规格和实现 Roadmap 的权威来源。

开始实现前，必须通过可用的 Notion MCP 或连接器读取与任务相关的当前规格正文。不得仅根据页面标题、旧聊天摘要、缓存内容或历史设计演化页推测规格。

主要入口：

- 设计根页：https://app.notion.com/p/3a4b98338da58121b863edb88e824edd
- 模块边界与状态所有权：https://app.notion.com/p/3a5b98338da581018d36c47276cb4358
- Roadmap 与已接受进度：https://app.notion.com/p/3a9b98338da5819a8380f10dfb60932b
- Agent 与长期记忆项目拆分：https://app.notion.com/p/3aeb98338da581538acedc7ca9da57b9
- Pi 兼容性清单：https://app.notion.com/p/3a7b98338da58164888ad211bb08ca98

`00–06` 下的当前规格页定义有效设计，`07 Roadmap & Implementation Status` 记录经过审查后接受的实现进度。设计演化和迁移归档只作为历史证据，不能覆盖当前规格。

若 Notion 无法访问，而任务需要作出架构、持久化、公开契约或状态所有权决策，应暂停该部分工作并明确报告缺失访问；不得猜测后继续实现。不依赖该信息的其他工作可以继续。

## 2. 本仓库职责

本仓库负责：

- Persona、Host、Ingress/Admin API 和客户端；
- Pi Runtime Capsule 与 Runtime Session Epoch；
- Context 与 Magic Context parity；
- Historian、ContinuitySnapshot、HistorianPublication 和权威 `publication_outbox`；
- Tool System 与 Body Adapter；
- 无状态 Memory Client 集成边界。

本仓库不得：

- 打开 Memory Router 数据库；
- 直接连接 Neo4j；
- 暴露或依赖 Graphiti SDK 对象；
- 实现稳定 `memoryRef`、图内实体/事实 resolution、RecallDisposition 存储或 reindex 内部逻辑；
- 手写复制跨项目长期记忆 DTO，而不消费其版本化契约；
- 保存第二份普通 Agent 会话历史。

长期记忆服务的内部实现属于独立的 `iris_memory` 项目。

## 3. 开始任务前

修改代码前依次完成：

1. 阅读本文件；
2. 读取相关的当前 Notion 规格；
3. 检查仓库现状、已有实现和测试；
4. 任务涉及 Pi、Magic Context、Graphiti 或 Numen 时，检查锁定版本与必要的上游源码和测试；
5. 确认对应 Roadmap 里程碑和 Exit Gate；
6. 在新增状态 owner、数据库、协议、后台 worker 或公开契约前，先识别是否与现有规格冲突。

默认优先让 Iris 适配已经验证的上游语义。不得自建平行的 Agent runtime、Context engine、图引擎或上游协议实现。

## 4. 实现规则

- 每种持久状态只能有一个权威 owner；
- 跨模块和跨项目访问必须使用窄、版本化的契约；
- 不得直接访问其他模块的数据库、Repository、ORM entity 或具体 Adapter；
- 数据库结构变化必须提供向前 migration，并验证空数据库初始化；
- 公开契约变化必须提供兼容性测试；
- 不得为了宣称完成而降低 Roadmap Exit Gate；
- 只有 mock 的行为必须明确标记为 mock；
- 未实际执行的测试或命令不得宣称已通过；
- 不得提交凭证、真实用户 Session 数据、模型载荷、私有日志或用户内容；
- 不得把空目录、占位接口或 smoke test 表述为对应能力已经完成。

## 5. 验证要求

提交或更新 PR 前，运行当前受影响区域已有的检查，至少包括：

- 格式、语法或 lint 检查；
- 存在类型化工具链时运行 typecheck；
- 相关单元测试；
- 相关契约测试；
- 修改持久化时运行 migration smoke test。

当对应 Roadmap Exit Gate 要求集成测试、崩溃窗口测试或 benchmark 时，必须执行并保留可复现结果。

测试文件存在不等于测试已经通过。PR 中必须记录真实执行的命令和结果。

## 6. Git 与 Pull Request

每个边界清晰的工作项使用独立分支。达到可审查节点时，将工作推送到 GitHub 并创建或更新 Draft PR。

PR 描述必须包含：

- Roadmap 里程碑与 Exit Gate；
- 实际查阅的 Notion 页面和章节；
- 实现内容摘要；
- 持久状态、migration 或公开契约影响；
- 实际执行的命令和检查结果；
- 已知缺口、mock、失败项和未测试路径；
- 是否需要同步更新规格。

开发 Agent 可以在 PR 中声明完成情况，但不得自行提高 Notion 中已接受的正式进度。正式进度只在审查 diff、CI、测试证据和 Exit Gate 后更新。

## 7. 暂停条件

仅暂停受影响的工作，适用情况包括：

- 必需的 Notion 内容无法访问；
- 必需的仓库、环境或凭证缺失；
- 将引入尚未解决的跨项目状态所有权冲突；
- 操作涉及破坏性、付费、外部发布或不可逆影响；
- 当前规格存在无法根据既有优先级规则裁决的根冲突。

存在不相关且不受阻的工作时，应继续推进，不要让单个阻塞停止整个任务。
