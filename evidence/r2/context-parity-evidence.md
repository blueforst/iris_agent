# R1/R2 Milestone Evidence（Roadmap v13，2026-08-05）

本文件记录 v13 Roadmap R1（Native Runtime Seams & Vertical Slice）与 R2（Continuous Context & Magic Context Parity）两个里程碑的验收证据。对应 Roadmap Exit Gate 逐条核对，全部通过独立 subagent 审查（VERDICT 格式，见各 PR）。

## 合并历史（blueforst/iris_agent main）

| 里程碑 | PR | 分支 | main | 审查 |
|---|---|---|---|---|
| R1-P0（pi fork seam） | blueforst/pi #2 | agent/r1-pi-seams | pi main=079a52f | 双路 PASS（spec/code-ci） |
| R1（RuntimeEvent ledger + fork 接入 + Exit Gate 测试） | #11-#14 | agent/r1-* | 合并链 | 独立审查 PASS（40 tests） |
| R2-P0（ContextMessageUnit 语义 ledger） | #15 | agent/r2-context-units | 4eac46f2 | 双路 PASS + BLOCKING 修复复审 PASS |
| R2-P1（m0/m1/P5/LKG parity 状态机） | #16 | agent/r2-context-units | a0de04df | 双路 PASS + B1/N1 修复复审 PASS |
| R2-P2（v12 正常路径删除） | #17 | agent/r2-delete-v12-path | 0f4c4307 | 独立审查 PASS（worktree 验证） |
| R2-P3（有界 context.db 双级 cap） | #18 | agent/r2-bounded-context | a4cd3e36 | 双路 PASS |

## R1 Exit Gate（Roadmap v13）

1. **Iris 正常 Provider path 不从 Session.buildContext() 构造 Context** ✓
   - pi fork PI-015 Provider Context Controller（contextController option 存在时跳过 buildContext，缺省字节兼容原生路径）
   - Exit Gate 1 用 Session.buildContext spy-throws 验证（R1 Exit Gate 测试）
   - R2 起 contextController 从 context_units 投影（m0/m1/P5），完全不依赖 Session entries
2. **默认 Pi native path 保持兼容** ✓（fork contextController 为可选 option，缺省走原生 buildContext；CI 全绿）
3. **user/tool/assistant/crash-window 顺序与 exactly-once attribution 可执行验证** ✓
   - runtime_event_ledger 表（runtime-events.db 0001）：idempotency_key UNIQUE + ledger_event_seq，exactly-once（6 tests）
   - crash-window 注入（crash-worker.ts fault points）：7 边界全绿
4. **不生成 synthetic assistant/ToolResult repair** ✓（failure 契约：验证兼容 LKG 并 replay+current suffix，否则 throw；无合成修复）

## R2 Exit Gate（Roadmap v13）

1. **m0/m1/P5/LKG parity（SOFT+/SOFT/HARD 全端到端）** ✓
   - Provider Renderer（context-renderer.ts）：m0/m1 两个头部 synthetic user message + p5Tail + live delta
   - m0 = M0_EMPTY_BODY（`<session-history></session-history>`）或重建的 session-history；m1 = M1_EMPTY_PLACEHOLDER 或 session-history-since 渲染——与 magic-context v0.33.0（48ab531d）字节对齐（golden 测试）
   - SOFT+ 字节不变重放；SOFT m1 累积（B1 修复：watermark 只在 HARD 推进，未进 m0 单元不丢失）；HARD 重建 m0（model_change/system_hash/first_render 等）
   - unit-based LKG（lkg-units.ts）：capture/verify/fallback，无 synthetic repair
   - golden parity 测试 10 个（含 B1/N1 回归）
2. **有界 context.db** ✓
   - 双级 cap：软 cap（超限单元 disposition=exclude，provider 不可见，R3 裁剪候选）+ 硬 cap（2x，ContextBoundsExceededError → lineage emergency_fail_closed → slice fail-closed）
   - append-only 不变量（无 DELETE FROM context_units）
   - listUnits store 级默认过滤 exclude + disposition:"all"（R3 Historian 读全行）
3. **紧急态维持 fail-closed** ✓（既有 emergency machinery + R2-P3 硬 cap 接线）

## 实际执行检查（npm run check 全绿，主分支 a4cd3e36）

- format/lint/typecheck：0 错误
- npm test：242 tests / 240 pass / 0 fail / 2 skip（live provider 需 OPENCODE_GO_API_KEY）
- test:context-golden 12、test:context-migrations 12、migration:smoke idempotent、crash:check 7 边界、bench:context 200 turns、build、test:subprocess 4、test:cli 6、dist:smoke 全绿
- CI（GitHub Actions）：每个 PR 分支 head 全 success（ubuntu-latest）

## 已知缺口 / 未测试路径（如实记录）

- R2-P3 slice 层硬 cap 错误被 pi harness 包成 AgentHarnessError/AggregateError（emitRunFailure 重入）——typed 断言在 store/ingest 层；属 pi fork 行为，fail-closed 结果不变
- runMinimalSlice 的 live provider 纵切需真实 API key，CI 中 2 tests skip
- R3 Historian 裁剪 excluded 单元（物理回收）未实现（R3 范围）
- R2 无真实 provider 端到端 golden（OpenCode provider 全链路验证属 R3 Exit Gate 后续）

## 独立审查记录

- evidence/reviews/r0-p1/（R0 时代）
- R2-P0 BLOCKING（companion 邻接配对）修复复审 PASS
- R2-P1 B1（SOFT watermark 推进致内容丢失）/N1（mid-turn 双 HARD 丢 toolCall）修复复审 PASS（worktree 反证）
- R2-P3 双路 PASS（规格 25/25 + 代码 37/37）

## 需同步更新规格（Notion）

- R2 完成后 current_phase → R3；整体进度 40%；completed_milestones 3/8
- R2 的 m0/m1 parity 已按 magic-context v0.33.0 对齐——后续升级 magic-context 需重跑 golden
