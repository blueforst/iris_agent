# R1 Native Runtime Seams & Vertical Slice — Evidence

Roadmap v13, R1（2026-08-05 完成）。本文件记录 R1 交付与 Exit Gate 验证证据。

## 交付清单逐项

| R1 交付 | 状态 | 位置/证据 |
| --- | --- | --- |
| stable RuntimeEvent lifecycle | 完成 | fork PI-017（message_finalized/turn_committed/tool_execution_committed）+ iris seam（`src/runtime/runtime-event-seam.ts`） |
| SessionCommitReceipt | 完成 | fork PI-016（receipt 挂 message_finalized）；ledger 持久化 entryId/entrySeq/contentHash |
| Provider Context Controller | 完成 | fork PI-015（`contextController` option）；iris `createIrisHarness` 接线（harness-factory.ts） |
| explicit Session close | 完成 | `closeSessionStorage(repo)` = `repo[Symbol.asyncDispose]()`（0.83.0 连接所有权） |
| sequenced archive reads | 完成 | ledger `listBySession(afterEventId)`（event_seq 排序）+ pi `getEntries()` |
| settled/abort/tool-loop contracts | 完成 | seam 映射 settled→agent_settled、abort、tool_execution_committed |
| mock deterministic baseline | 完成 | `runMinimalSlice(provider:"mock")`（预存在）+ ledger 集成 |
| 真实 non-thinking provider 纵切 | 完成 | `runMinimalSlice(provider:"live")` opencode-go deepseek-v4-flash 实测（2026-08-05） |

## Exit Gate 逐条

| Gate | 状态 | 证据 |
| --- | --- | --- |
| 1. Iris 正常 Provider path 不从 Session.buildContext() 构造 Context | PASS | `test/r1-exit-gates.test.ts` gate1：Session.buildContext spy 抛错，纵切仍成功（contextController 路径不触发）；fork 源码确认 buildContext 仅 createTurnState 的 non-controller 分支调用 |
| 2. 默认 Pi native path 保持兼容 | PASS | fork `packages/agent/test/harness/runtime-seams.test.ts`（默认路径仍调 buildContext）+ fork CI 全绿 |
| 3. user/tool/assistant/crash-window 顺序与 exactly-once 可执行验证 | PASS | gate3 测试（首事件 message_finalized、末位 agent_settled、toolCallId/toolName attribution、幂等键唯一、重开持久化）；crash:check 7 boundaries；live 纵切 9 事件序列 |
| 4. 不生成 synthetic assistant/ToolResult repair | PASS | gate3 ALLOWED_LEDGER_TYPES 仅 seam 类型；seam 无合成事件 |

## 执行命令与结果（2026-08-05，本地 Windows + mcp-remote）

- `npm run check` → 全绿（217 tests / 215 pass / 2 skip；crash 7 boundaries；build/subprocess/cli/dist）
- `npx tsx --test test/r1-exit-gates.test.ts` → 3 pass（Gate 1/3/4）
- live 纵切（真实 opencode-go，deepseek-v4-flash）→ 9 ledger 事件序列：
  `[message_finalized, message_finalized, message_finalized, tool_execution_committed, message_finalized, turn_committed, message_finalized, turn_committed, agent_settled]`；5 session entries；assistant 真实响应
- CI（PR #13 head d6ef1de）→ success（双 checkout + pi build + 完整 check）

## 独立审查记录

- R1-P0（fork seam）：`blueforst/pi` `docs/iris-fork/reviews/`（R0-P0 双审 + R1-P0 双审）
- R1-P1a/b（ledger）：`evidence/reviews/r0-p1/`（双审 PASS + 复审）
- R1-P1d（fork file: 接入）：双审 PASS（记录于 PR #12）
- R1-P1e/f（seam/controller/gates）：双审 PASS（记录于 PR #13）

## 已知缺口（不阻塞 R1）

- `receipt.entrySeq` 当前 fork 发射恒缺席（可选字段，seam 条件处理）
- 非 message 事件幂等键依赖 fork 单次发射（fork 语义保证；message_finalized 按 entryId 真正可重放）
- vertical-slice 的 prompt 抛错路径 ledger 不关闭（crash 场景由 SIGKILL 覆盖；失败路径进程级泄漏，可接受）
- PI-018 fork archive API 未实现（sequenced reads 由 ledger 层满足；R1-P2 评估）
- R2 ContextMessageUnit/contextSeq 分配未做（R1 的 contextSeq 列为 NULL 预留）
