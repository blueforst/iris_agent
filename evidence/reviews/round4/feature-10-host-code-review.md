# Feature 9/10 (R2) Host product-path Context pipeline — Host integration / recovery / concurrency review (round4)

## 审查元信息

| 项目 | 值 |
|---|---|
| Reviewer role | Host integration code/recovery/concurrency reviewer（独立审查者，非实现者） |
| Reviewed HEAD | `a8b51585807c68cce33c80d64147dcbcf59f02ea` — "feat(context): Host product-path Context pipeline (R2 Feature 9)" |
| Reviewed baseline | 父提交 `ef405ea`（Feature 8 replay 审查记录），`git log --oneline -10` 已确认 |
| 审查日期 | 2026-08-04 |

提交变更：4 文件 `+844/-1`：`src/context/pipeline.ts`（新增 446 行）、`src/context/context-store.ts`（+33 行 persistWatermarks）、`test/context-pipeline.test.ts`（新增 364 行、6 测试）、`package.json`（test 脚本一行）。无迁移、无 schema 变更（watermark 三列已在 Feature 8 的 `0001_bootstrap.sql` 中存在：L63-65，已 grep 核实）。

## 审查的文件

- `src/context/pipeline.ts`（全文 446 行 — runContextPass / applyContextPass / renderProviderVisible / renderM0Head / classifyAction / deriveTokenTarget / assertReplayClean）
- `src/context/context-store.ts`（全文 601 行 — ContextStore.open fail-closed、materializeM0/M1 单行 UPDATE、persistWatermarks、setEmergencyState、migration fence）
- `test/context-pipeline.test.ts`（全文 364 行、6 测试）
- `src/context/projection.ts`（485 行）、`src/context/pass-taxonomy.ts`（186 行）、`src/context/protected-tail.ts`（389 行）、`src/context/replay.ts`（196 行）、`src/context/carriers.ts`（170 行）— 被组合的各能力层
- `src/contracts/context.ts`（M0_EMPTY_BODY / M1_EMPTY_PLACEHOLDER）
- `src/db/migrations/context/0001_bootstrap.sql`（watermark 列已存在）
- `src/runtime/session-projection.ts` + `src/runtime/context-adapter.ts`（投影输入侧，grep 无 Date.now/Math.random）
- `tsconfig.json`（`strict` + `noUncheckedIndexedAccess: true` + `exactOptionalPropertyTypes: true` 已核实）
- `package.json`（test 显式文件列表含 test/context-pipeline.test.ts）

## 验证命令与真实输出

### 1. `npx tsx --test test/context-pipeline.test.ts` — 6/6 PASS

```
1..6
# tests 6
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 467.076
```

逐项：1 首 pass HARD(first_render) + m0 carriers；2 同 lineage 同 entries → SOFT+ reuse（carriers undefined）；3 model_change → HARD；4 applyContextPass 持久化 + close/reopen 重载 m0Body/m0ContentHash/m0MaterializedAt；5 renderProviderVisible carriers + live tail、无 raw 消息泄漏；6 SOFT+ 不提交水印（nextWatermarks undefined、newlyReclaimed 0）。

### 2. `npx eslint src/context/pipeline.ts src/context/context-store.ts test/context-pipeline.test.ts` — clean（零输出）

### 3. `npx tsc --noEmit` — clean（零输出）

### 4. `npm run check` — **当前工作树 FAIL（format:check），但失败点不在被审提交内**（见 F6）

- 被审提交的 4 个文件 `npx prettier --check` 全部通过（EXIT=0）。
- `git status --porcelain` 仅 2 个 **untracked** 文件：`scripts/context-bench-smoke.ts`、`test/context-parity-gate.test.ts`（创建时间 2026-08-04 02:02–02:04，晚于被审提交 02:00:10），内容为 Feature 10 parity-gate 并发工作，**不属于 a8b5158**，也不在 test 脚本中。
- 早于这两个文件出现的**首次全量运行**（同 session 内）整链通过，实测输出：npm test `1..192 / tests 192 / pass 190 / fail 0 / skipped 2`（2 skip = OPENCODE_GO_API_KEY 未设置的 live provider 用例）、test:context-golden 4/4、test:context-migrations 12/12、migration:smoke `"status":"idempotent"`、crash:check 7/7 boundary ok、build ✓、test:subprocess 3/3、test:cli 6/6、dist:smoke `{"status":"ok",...}`。
- 提交信息声称 "now 192: 190 pass + 2 live skip" 与实测精确一致；pipeline 的 6 个测试为 192 项中的 #52–#57。

## Checklist 逐项核对

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | Determinism（决策路径无 Date.now/random） | ✅ | grep：pipeline.ts 决策路径无 Date.now/Math.random/performance.now（仅 L86 docstring 出现）；projection.ts / session-projection.ts / context-adapter.ts 均无；decision 端到端为纯函数：projectLogicalUnits → deriveTokenTarget → resolveProtectedTail → decidePass → runReplay → classifyAction → renderM0Head → buildCarriers(**atMs: 0**)。唯一时间源是 applyContextPass 的 `nowMs` 参数（materializeM0/M1 的 atMs）与 store 内部 updated_at（不参与决策重建） |
| 2 | Crash/restart（无内存态依赖可重建决策） | ✅ | materializeM0 为单行 UPDATE（context-store.ts L382-418，changes!==1 throw）；测试 4 实测 close→ContextStore.open→getLineage 重载 m0Body/m0ContentHash/m0MaterializedAt=1000；runContextPass 的输入（entries、lineage、source、model）全部可持久化或可重导出，决策为 (输入) 的纯函数。水印崩溃窗口（materialize 已提交、persistWatermarks 未提交）自愈：replay.ts L104 `continue` 保证 newly-detected 弧恒为 endSeq > watermark，下一 cache-busting pass 重检测同一批弧并重算严格更大的 nextWatermarks |
| 3 | Concurrency（不引入第二 writer / 非原子多行序列） | ✅ | Host 单 writer；pipeline 每次持久化均为单行 UPDATE（materializeM0、materializeM1、persistWatermarks、setEmergencyState），无跨行事务序列；WAL + busy_timeout=5000 为纵深防御 |
| 4 | Index safety（noUncheckedIndexedAccess） | ✅ | pipeline.ts 对 projection.units 仅用 filter/map/for...of，无 `units[i]` 下标；unitEntrySeq/unitEndSeq 用判别联合 switch 收窄（"input"/"tool_arc"→entryRange，其余→entrySeq，穷尽无 `!`）；grep `!` 与 `as number`：5 处命中全部是 `!==` 比较，无 `as number`、无非空断言 |
| 5 | Type safety（exactOptionalPropertyTypes / 无 null 泄漏） | ✅ | resolveProtectedTail 传参用条件展开 `...(input.unitTokenCounts === undefined ? {} : {...})`、`...(input.usagePercentage === undefined ? {} : {...})`（L108-110）；MaterializeM0Input 12 字段全提供（cachedM0SystemHash/cachedM0ModelKey/cachedM0ProviderProfileId 均 `?? ""`，lastSafeUserAnchorEntrySeq `?? 0`）；MaterializeM1Input 5 字段全提供；tsc --noEmit clean。⚠️ renderProviderVisible 有 3 处 `as unknown as AgentMessage`（L429-430、L443），类型逃逸见 F3 |
| 6 | Fail-closed（缺 lineage 抛错 / failClosed→setEmergencyState / 无静默吞写） | ✅ | materialize_m0 分支：lineage===undefined → throw；materialize_m1 分支：m0Body null/undefined → throw；failClosed!=="none" → setEmergencyState（emergency_fail_closed / transform_unavailable 映射）；persistWatermarks/materializeM0/M1/setEmergencyState 均校验 changes!==1 → throw。注：materialize_m0 在 lineage 存在但 m0Body 为 null 时继续（正是 first_render 意图，createLineage 建行→HARD 填充）。failClosed 分支当前无测试覆盖（R2 恒为 "none"，见 F2） |
| 7 | Error paths（损坏 lineage 安全 / 部分 lineage 不崩） | ✅ | decidePass L83-84：m0Body null → HARD first_render，故 SOFT+ 与 m0-null 不可能同现；即使构造出 reuse 决策，applyContextPass reuse 分支为 no-op；部分 lineage（m0 非空、m1 null）→ HARD cached_m1_missing 干净重建；lineage.representedThrough 超出现有投影 → liveDelta=false → 无 HARD 信号则 SOFT+ reuse no-op；assertReplayClean 在 SOFT+ 上若产生 pending detect 则抛错（防御性，detect=false 下不可能触发） |
| 8 | Test isolation（独立 tmpdir + close→rmSync） | ✅ | 全部 6 测试用 `mkdtempSync(join(tmpdir(),"iris-pipeline-"))` 独立目录；finally 块先 `store.close()` 后 `rmSync(dirname(path), recursive, force)`；测试 4 嵌套 close/reopen 并二次 try/finally 包裹 close（already-closed 捕获）；EBUSY 模式（先 close 后删目录）全程遵守；测试 1 为纯函数不建 store |
| 9 | renderM0Head snapshot（仅 head 单位 / 空 head 返回 ""） | ✅ | L243-247：`projection.units.filter(unit => unitEntrySeq(unit) <= protectedTail.headEndEntrySeq)`，仅渲染 fold head；空投影/小会话 headEnd=0 → headUnits 空 → 返回 "" → buildCarriers 落 M0_EMPTY_BODY；与 head/live 无重叠无缝隙（head 按 start<=headEnd、live 按 start>=protectedTailStart=headEnd+1，判别式不相交） |
| 10 | Watermark advancement（仅 cache-busting + 严格单调） | ✅ | L161-171：nextWatermarks 仅在 `newlyReclaimedToolArcUnitIds.length > 0` 时构造（仅 HARD/SOFT 路径可达，SOFT+/reuse 早退 undefined）；值 `Math.max(watermark, newlyReclaimedMaxEndSeq)` 单调；applyContextPass L396-399 仅当 `>` 严格更大才 persistWatermarks；replay.ts `continue` 保证新检测弧 endSeq > 旧水印 → 严格更大恒成立，无冗余写 |

## Findings

### F1（NON-BLOCKING，moderate）— deriveTokenTarget 平行重实现 N，未复用 authority 锁定的 deriveProtectedTailTokenTarget

pipeline.ts L293-310 的 `deriveTokenTarget` 与 protected-tail.ts L98-123 的 authority 版 `deriveProtectedTailTokenTarget` 公式相似但**缺 ABS_CAP=96_000 上限钳制**（也未减去 headroom）。当 usable*0.4 > 96000（usable > 240K tokens，即 contextLimit×threshold > 24M 的巨型窗口）时两者分歧（例：limit=2M、threshold=65%、usage=0：pipeline N≈600K，authority N=96K）。在测试使用的 8K/128K 量级两者完全一致，故测试无法捕获。project 原则"默认优先让 Iris 适配已经验证的上游语义，不得自建平行的上游协议实现"——建议 pipeline 直接调用 `deriveProtectedTailTokenTarget`（protected-tail.ts 已导出），消除漂移。

### F2（NON-BLOCKING，minor）— advanceWatermarks / classifyReplayFailure（Feature 8 已审查模块）未被 pipeline 消费；failClosed 分支为死代码

replay.ts 导出的 `advanceWatermarks`（L145）与 `classifyReplayFailure`（L174）在 pipeline.ts 中零引用：nextWatermarks 用内联 Math.max 计算（语义一致），failClosed 恒为 "none"。ContextPassDecision.failClosed 字段与 applyContextPass 的 setEmergencyState 分支在 R2 不可达、无测试覆盖。commit message 诚实声明 "LKG invalidation escalation is the Feature 10 gate"，属 R2 边界内声明的暂留布线，不阻塞；但建议 Feature 10 落地时消费 classifyReplayFailure 并补该分支测试，避免死代码漂移。

### F3（NON-BLOCKING，minor）— renderProviderVisible 3 处 `as unknown as AgentMessage` 类型逃逸

L429/L430（carriers m0/m1）与 L443（live tail synthetic message）。CustomMessage<unknown> 在结构上应可满足 AgentMessage 联合（carriers.ts 的 IRIS_CONTEXT_CARRIER_CUSTOM_TYPE 类型即为其成员），建议以精确类型替代双断言。tsc --noEmit clean 表明现有断言成立，纯类型卫生问题。

### F4（NON-BLOCKING，info）— live-tail 注释与实现门不一致

L432-435 注释写 "every unit strictly after the protected tail start"，代码实际为 `if (unitEntrySeq(unit) < protectedTailStartEntrySeq) continue`，即发射 entrySeq **>=** 边界（含边界单位）。语义正确（边界单位即受保护锚点，head 用 <= headEnd 与其不相交），仅注释表述应改为 "at or after"。

### F5（NON-BLOCKING，info）— 测试 4 未直接演练"重载 lineage 后重跑决策"

测试 4 验证了持久化的 lineage 在 reopen 后可见，但未对重载 lineage 重跑 runContextPass 断言决策重建（同实例内的 SOFT+ 重建由测试 2 覆盖）。代码审查确认决策为 (entries, lineage, source, model) 的纯函数、重建可行；此为覆盖增强建议，非缺口。

### F6（环境/证据，必须报告）— `npm run check` 在当前工作树失败，但失败点不在被审提交

format:check 失败于 2 个 **untracked** 文件：`scripts/context-bench-smoke.ts`（02:02:48 创建）、`test/context-parity-gate.test.ts`（02:03:28 创建/02:04:37 修改），均晚于被审提交（02:00:10），是同一工作区内并发的 Feature 10 parity-gate 工作，未提交、不影响被审提交。审查期间工作树仍在被并发改动：`git status --porcelain` 从"仅 2 个 untracked 文件"变为"2 个 untracked 文件 + M package.json"，package.json 的 test 列表在审查中途被加入了 `test/context-parity-gate.test.ts`（git diff 已核实）——进一步证实这些是并发 Feature 10 活动的产物，不属于 a8b5158。首次全量运行（并发改动出现前）整链通过（192 tests/190 pass/2 skip、golden 4、migrations 12、smoke idempotent、crash 7、subprocess 3、CLI 6、dist ok）；被审提交的 4 个文件 prettier/eslint/tsc/测试全部干净。结论：**被审提交自身门禁干净**，当前树的全量门禁失败为环境并发产物。

## 结论块

VERDICT: PASS
SPEC COMPLIANCE: 10 项 checklist 全部通过。决策流水线（projection → pass taxonomy(SOFT+/SOFT/HARD, representedThrough live-delta) → protected-tail → replay(REPLAY 恒开, DETECT 仅 cache-busting) → materialization action → carriers）与 01-context-assembly 的 Pass Taxonomy / Session Scope / R2 Exit Gate（SOFT+ byte-identical replay、无 raw passthrough）语义一致；renderProviderVisible 只发射 carriers + 投影 live tail，实测无 raw 消息泄漏（测试 5）。commit message 中 "R2 boundary: Historian head folding / Compartment LLM / publication 属 R3、LKG invalidation escalation 为 Feature 10 gate" 与代码一致（failClosed 恒 "none"，classifyReplayFailure 未消费）。唯一 spec 侧偏差：F1 — deriveTokenTarget 平行重实现 N 并缺失 ABS_CAP 钳制，与 protected-tail 模块锁定的 authority 公式在巨型上下文窗口下分歧（NON-BLOCKING）。
CODE CORRECTNESS: pipeline.ts 质量高 —— 决策纯函数化、判别联合穷尽收窄（零 `!`/`as number`）、exactOptionalPropertyTypes 条件展开、fail-closed 抛错路径完整（materialize_m0/m1、persistWatermarks、setEmergencyState 均校验 changes）、水印 Math.max 单调 + 严格更大守卫。瑕疵：F3 的 3 处 `as unknown as AgentMessage` 类型逃逸、F4 注释与代码不一致、F2 的未消费辅助函数（advanceWatermarks/classifyReplayFailure）与不可达 failClosed 分支。均 NON-BLOCKING。
RECOVERY/CONCURRENCY: Host 单 writer 假设未被破坏 —— 每次持久化均为单行 UPDATE（materializeM0/M1、persistWatermarks、setEmergencyState），无第二 writer、无非原子多行序列；WAL + busy_timeout 纵深防御。崩溃恢复：materialize 单行原子提交 + lineage 落库持久化，reopen 重载完整（测试 4 实测），决策重建零内存态依赖；水印崩溃窗口自愈（replay.ts `continue` 保证重检测严格更大弧，下一 cache-busting pass 补写）。测试 3/4/6 实测验证了崩溃/重启与单调水印语义。
TEST COVERAGE: 6/6 通过（显式运行），且已接入 npm test（192 项中的 #52-57，commit message 计数与实测精确一致：192 tests / 190 pass / 2 live skip）。覆盖：首 pass HARD、SOFT+ reuse、model-change HARD、持久化+reopen（测试 4）、no-passthrough（测试 5）、SOFT+ 不提交水印（测试 6）。缺口：failClosed/setEmergencyState 分支无测试（R2 恒 "none"，Feature 10 布线时补）；无"两次 cache-busting pass 后水印单调提交"的端到端演练；测试 4 未重跑决策重建（F5）；大上下文窗口的 N 漂移无测试（F1 根因）。
EVIDENCE ACCURACY: 提交声明与实测一致 —— pipeline 6/6、eslint clean、tsc clean、npm test 192(190 pass + 2 live skip) 精确吻合、golden 4、migrations 12、smoke idempotent、crash 7、subprocess 3、CLI 6、dist ok（首次全量运行捕获）。commit stat（4 文件 +844/-1）与 git show 一致。⚠️ 必须如实报告：当前工作树 `npm run check` 在 format:check 失败，失败源为 2 个 untracked 并发文件（scripts/context-bench-smoke.ts、test/context-parity-gate.test.ts，02:02-02:04 创建，晚于被审提交），且审查期间 package.json 的 test 列表又被并发加入 test/context-parity-gate.test.ts（git diff 已核实），均不属于 a8b5158、不影响其门禁结论；被审提交自身 4 文件 prettier 全部通过。
FINDINGS: F1（moderate, NON-BLOCKING）deriveTokenTarget 平行重实现 authority N 公式并缺 ABS_CAP=96_000 钳制，巨型上下文窗口下 N 分歧（测试量级一致故未被捕获），建议复用 protected-tail.ts 已导出的 deriveProtectedTailTokenTarget；F2（minor）replay.ts 的 advanceWatermarks/classifyReplayFailure 未被 pipeline 消费、failClosed 分支 R2 不可达无测试（Feature 10 gate 声明诚实，建议届时消费并补测）；F3（minor）renderProviderVisible 3 处 `as unknown as AgentMessage` 类型逃逸；F4（info）live-tail 注释 "strictly after" 应改为 "at or after"（实现门 >= 边界，语义正确）；F5（info）测试 4 未重跑决策重建断言（确定性分析证实可行，覆盖增强建议）；F6（环境）当前树 `npm run check` 因 2 个 untracked 并发文件在 format:check 失败，与被审提交无关，首次全量运行整链通过。以上均不阻塞 R2 门禁，**VERDICT: PASS**。

<!-- OMO_INTERNAL_INITIATOR -->
