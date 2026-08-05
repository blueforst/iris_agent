# R3 Milestone Evidence（Roadmap v13，2026-08-05）

本文件记录 v13 Roadmap R3（Historian, Publications & Bounded Semantic Store）里程碑的验收证据。对应 Roadmap Exit Gate 逐条核对，全部通过独立 subagent 审查（VERDICT 格式，含 BLOCKING 修复复审）。

## 合并历史（blueforst/iris_agent main）

| PR | 分支 | main | 内容 | 审查 |
|---|---|---|---|---|
| #19 | agent/r3-historian-port | 72822b09 | R3-P0：从 agent/r2-product-parity-fix-r3-historian @ 5b94db7 port 完整 B1-B8 Historian 模块（11 源文件 + contracts + 3 migration + b1/b2 测试 + migrate fail-closed + data-root 注册） | 双路 PASS（15 文件零漂移，逐字节一致） |
| #20 | agent/r3-history-read-port | aa8a5a79 | R3-P1：ContextHistoryReadPort（getMaterializedBoundary VALUES-only）+ freeze eligibleThrough m0 掣钳（min(rawSafeSeam, lineage)）+ onMaterialized 接线 | 双路 PASS（8 项 MUST DO 全过） |
| #21 | agent/r3-compartment-assessment | 9268173f | R3-P2：b4/b7 测试 port + memory-contracts 契约 pin（manifestSha256 + historian-publication-v1 envelope + idempotencyKey） | 独立审查 PASS（19/19，逐字节忠实） |
| #22 | agent/r3-publication-outbox | f16cd47a | R3-P3：b5 publication/outbox 测试（原子事务/MAX+1/状态机/崩溃窗口）+ retry_wait 指数退避修复 | 独立审查 PASS（8/8） |
| #23 | agent/r3-wrapup-compaction | 26fe2b71 | R3-P4：compaction trigger（authorizePiCompaction/createCompactionAuthorizer）+ wrapup closing 状态机 + 单事务合并 + b6/b8/Exit Gate 测试 + B1 双轮修复（状态守卫 + queue 终结性任务胜出规则） | 双路 PASS + B1 双轮复审 PASS（确定性复现） |

## R3 Exit Gate（Roadmap v13）逐条核对

1. **持久化 Historian 状态机（active→closing→closed / closed_incomplete / corrupt）** ✓
   - enqueueWrapup 持久化 status="closing"（wrapup 入队即收尾，不可再接增量——B1 状态守卫）
   - runWrapup 转 closed / closed_incomplete；corrupt fail-closed 不可自动修复；recover 只重放 closed/closed_incomplete（low 优先级）
2. **rollover wrapup** ✓（previous-session overlap、ContinuitySnapshot、rollover 后新 session 全新 HistorianSessionState，不迁移 context）
3. **单 worker 优先级队列** ✓（highest=incremental / normal=wrapup / low=closed-retry / manual=recomp，single-flight，有界 drop——b2 测试）
4. **原子提交（Compartments+Segments+Evidence+MemoryAssessmentDeltas+ContinuitySnapshot+cursor+HistorianPublication+publication_outbox）** ✓
   - b5 原子事务测试 + b6/b8 + Exit Gate：wrapup 事务 commit=false 与 B5 事务合并为 ONE（runWrapup commit 选项）；失败=整体回滚，cursor 不推进、无 publication、无 outbox
5. **publicationSequence MAX+1 无预分配** ✓（SELECT MAX+1 在 BEGIN IMMEDIATE...COMMIT 事务内，同一连接；b5 测试严格递增）
6. **outbox 状态机（pending→delivering→delivered / retry_wait / quarantined）** ✓
   - claim lease（claim_leased_until）、崩溃恢复、exactly-once（publication_id/processing_key UNIQUE）
   - retry_wait 带指数退避 lease（1s→5min cap，R3-P3 修复热循环）；quarantined 不可认领
7. **只有进入 m0/m1 的 Compartment 才替换 raw P5** ✓
   - freeze eligibleThrough = min(rawSafeSeam, entrySeqOf(representedThroughContextSeq))（R3-P1 m0 掣钳）
   - compaction authorization：cut = min(protectedTailStart-1, lineageMaterializedEntrySeq)，lineage 未物化 → 0（R3-P4）；protected tail raw-inviolable
   - ContextHistoryReadPort VALUES-only（跨 DB 窄契约，无 context.db 句柄泄漏）
8. **有界语义存储** ✓（R2-P3 excluded 单元 R3 不可见；物理回收为 post-R3 follow-up——docs/r3-reclamation-followup.md）

## 实际执行检查（npm run check 全绿，main=26fe2b71）

- format/lint/typecheck：0 错误
- npm test：242+ 全绿（含 historian b1-b8 + r3-exit-gate 15 + memory-contracts-pin + context 全系）
- migration:smoke idempotent、crash:check 7 边界、bench、build、subprocess、cli、dist 全绿
- CI（GitHub Actions）：每 PR 全 success

## 已知缺口 / 未测试路径（如实记录）

- publicationId uuid-format 与 historian-publication-v1 契约的偏差由 delivery 层（R4 或后续）映射（memory-contracts-pin 测试显式记录）
- HistorianManager 未接入 Host 主循环（R3-P4 为 opt-in 接线；完整 Host 集成 + Pi Session compaction 触发属 R4/后续）
- enqueueRecomp 无状态守卫（standalone recomp on closing session 的 wedge 家族——queue 合并规则已防 merge 变体，standalone 变体留待后续）
- boundary_snapshots 生产路径未持久化（测试 saveBoundarySnapshot；Host 集成时 freeze 路径需落库）

## 独立审查记录

- R3-P0：双路 PASS（移植逐字节 + 4 适配点验证）
- R3-P1：双路 PASS（m0-clamp 不变量 + VALUES-only + 8 项 MUST DO）
- R3-P2：独立 PASS（19/19 + 契约 pin）
- R3-P3：独立 PASS（MAX+1 + 退避修复 + 崩溃契约）
- R3-P4：双路 PASS → B1 BLOCKING（closing 守卫缺失 + queue 单飞 priority wedge）→ 修复 + 复审 BLOCKING（fix 2 反方向 race，确定性复现）→ 终结性任务胜出规则 + 复审 PASS

## 需同步更新规格（Notion）

- R3 完成后 current_phase → R4；整体进度 65%（R0 10% + R1 20% + R2 20% + R3 15%）；completed_milestones 4/8
