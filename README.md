# Iris Agent

Iris Agent 是 Iris 的主体运行时与连续身份项目，负责 Host、Pi Runtime Capsule、Runtime Session Epoch、Context、Historian、工具系统、机体适配、客户端以及 Memory Client 边界。

当前有效架构与实现路线图维护在 Iris 的 Notion 知识库中。修改代码前必须先阅读 [`AGENTS.md`](./AGENTS.md)。

## 项目边界

本仓库**不负责**长期记忆服务内部实现，包括 Memory Router 数据库、Neo4j、Graphiti 内部对象、稳定 `memoryRef`、RecallDisposition 持久化以及图重建与 reindex。

这些能力属于独立的 `iris_memory` 项目。两个项目只能通过版本化的长期记忆契约交互，`iris_agent` 不得直接访问 `iris_memory` 的数据库或具体实现。

## 当前状态

项目处于仓库初始化阶段。目录、占位代码和最小 smoke test 不代表 Roadmap 里程碑已经完成，也不会自动增加正式实现进度。

## 本地检查

```bash
npm ci
npm run check
```

要求 Node.js `22.19.0` 或更高版本。
