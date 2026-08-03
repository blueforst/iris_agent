# Feature 8/9 (R2) reasoning/drop/mutation/invalidation replay 状态机 — Parity/Correctness Review (round4)

## 审查元信息

| 项目 | 值 |
|---|---|
| Reviewer role | Replay state-machine parity reviewer（独立审查者，非实现者） |
| Reviewed HEAD | `a2a57545d49a25cd765ac99f045259c4eb7f1971` — "feat(context): reasoning/drop/mutation/invalidation replay state machine (R2 Feature 8)" |
| Reviewed baseline | 父提交 `2580b48`（Feature 7 LKG 审查记录，git log --oneline -3 已确认） |
| OpenCode authority | `magic-context @ 48ab531d` (release v0.33.0)，已核实本地 `git rev-parse HEAD = 48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`（`git log --oneline -1` = "release: v0.33.0"），与 evidence/context-golden/provenance.md 及既有 round4 审查记录一致 |
| 审查日期 | 2026-08-04 |

提交仅含 2 个新文件（`+466`）：`src/context/replay.ts`（196 行）+ `test/context-replay.test.ts`（270 行，7 测试）。无迁移、无持久化、无生产调用点变更。

## 审查的文件

- `src/context/replay.ts`（全文 196 行 — runReplay / advanceWatermarks / classifyReplayFailure / ReplayWatermarks / replayHash）
- `test/context-replay.test.ts`（全文 270 行，7 测试）
- `src/context/projection.ts`（HistoryProjectionUnit：reasoning.entrySeq、tool_arc.entryRange.endEntrySeq 等投影单位定义，全文 485 行）
- `evidence/notion-round4/01-context-assembly.md`（Pass Taxonomy SOFT+/SOFT/HARD、Session Scope、LKG、Failure and Emergency Policy）
- `evidence/notion-round4/02-magic-context.md` + `07-roadmap.md`（R2 Exit Gate：SOFT+ byte-identical replay 通过；tag→entrySeq 映射规则 L22）
- 权威源 `drop-stale-reduce-calls.ts`（143 行）+ `emergency-drop.ts`（267 行）@ 48ab531d（逐行对照）
- `tsconfig.json`（`strict: true`、`noUncheckedIndexedAccess: true` 已核实）
- `package.json`（npm test 显式文件列表 — 见 Finding F1）

## 验证命令与真实输出

### 1. `npx tsx --test test/context-replay.test.ts` — 7/7 PASS

```
1..7
# tests 7   # pass 7   # fail 0   # cancelled 0   # skipped 0   # duration_ms 354.2071
```

逐项：1 无水印→无抑制/空 detect；2 cleared-reasoning 水印逐 pass 抑制（byte-identical，两次 runReplay 的 suppressed 列表与 replayHash 相等）；3 tool-reclaim 水印冻结抑制（重跑 hash 相等）；4 detect 边界（tail 之下 detect=1 条、defer pass=0 条、tail 内=0 条）；5 advanceWatermarks 单调幂等（小值重推进不回归）；6 classifyReplayFailure 全 5 组合（含 cache-busting 上 pendingDetect=ok）；7 空投影 no-op。

### 2. `npm run check` — 全量门禁通过

- format:check ✓（prettier --check .）
- lint ✓（eslint .）
- typecheck ✓（tsc --noEmit）
- test：**150 项，148 pass + 2 skip**（skip = OPENCODE_GO_API_KEY 未设置的 2 个 live provider 用例），0 fail
  - ⚠️ 注：该 150 项**不含** 7 个 replay 测试（见 F1），replay 测试仅由上面的显式命令执行
- test:context-golden：**4/4 pass**
- test:context-migrations：**12/12 pass**
- migration:smoke：`"status": "idempotent"`（空库初始化 firstApplied [0001_bootstrap]，二次应用空）
- crash:check：**7/7 boundary ok**
- build ✓（tsc -p tsconfig.build.json + copy-migrations，replay.ts 进入 dist）
- test:subprocess：**3/3 pass**
- test:cli：**6/6 pass**
- dist:smoke：`{"status":"ok","epochDb":true,"ingressDb":true}`

## Checklist 逐项核对

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | REPLAY semantics 无条件 | ✅ | reasoning：`unit.entrySeq <= watermarks.clearedReasoningThroughTag`（L96）与 tool_arc：`endSeq <= watermarks.toolReclaimWatermark`（L104）均在 detect 分支之前无条件执行，detect=false 时同样抑制 → defer pass byte-identical |
| 2 | DETECT semantics | ✅ | newlyReclaimed 仅 `detect && endSeq < protectedStart`（L112）时产生；arc end ≥ protectedStart（跨入或落在 tail 内）永不 detect；detect=false 时恒为空（测试 4 三组断言）。detect 位于 REPLAY `continue` 之后 → 只对"高于水印且低于 tail 起点"的 arc 生效，与权威源 `!inFrozen && i < protectedStart` 一致 |
| 3 | Byte-identical defer passes | ✅ | replayHash = sha256(JSON.stringify({clearedReasoningThroughTag, toolReclaimWatermark, suppressedReasoningUnitIds, reclaimedToolArcUnitIds}))：键序固定、数组有序、纯 sha256，相同 (projection, watermarks) 恒得相同 hash 与相同 suppressed 列表（测试 2/3 双重 runReplay 断言）。注：mutationReplayWatermark 未入 hash（F2） |
| 4 | advanceWatermarks monotonic | ✅ | 三字段均 `Math.max`（L156–166），单调且幂等（测试 5 小值重推进断言不回归）；toolReclaimWatermark 接受 newlyReclaimedMaxEndSeq（runReplay L114 为新增弧的 **max endEntrySeq**），是 END 序列值而非计数 |
| 5 | classifyReplayFailure 映射 | ✅ | lkgInvalid+defer → emergency_fail_closed（L182）；lkgInvalid+非defer → transform_unavailable（L188）；pendingDetect+defer → defer_blocked（L191）；否则 ok（L195）。测试 6 覆盖全部 5 个组合，含"cache-busting 上 pendingDetect=ok"。lkgInvalid 分支先于 pendingDetect（fail-closed 优先级正确） |
| 6 | Fail-closed philosophy | ✅ | 前两个分支穷尽全部 lkgInvalid 组合 → lkgInvalid 时永不返回 ok；defer pass + pendingDetect → defer_blocked 永不 ok |
| 7 | R2 boundary | ✅（见 F1） | grep src/ 无任何 replay.ts 消费点（仅文件内定义）；模块仅依赖 node:crypto + projection.js type-only import；7 测试全过。commit message 与文件头声明"transform wiring is the R3 Historian integration"诚实。⚠️ 测试文件未进入 npm test 显式列表（F1） |
| 8 | Mapping vs authority | ✅ | dropStaleReduceCalls REPLAY/DETECT split → runReplay 同构；protectedCount → protectedTailStartEntrySeq（权威按 message index、Iris 按 entrySeq，同为"仅检测 tail 起点之下"）；"无稳定 id 不检测"→ projection 保证 tool_arc unitId=`arc-${callId}` 恒存在（结构性满足）；emergency-drop same-input-sample latch / fixedFloor / tier 明确声明为 R3 应急路径，R2 保留 watermark 语义 + fail-closed escalation（defer_blocked 即"defer pass 不提交 detect 结果"的闩锁语义）— 无已采纳语义被静默删除；"watermark 越过每个 dropped tag"→ toolReclaimWatermark=max endSeq（幂等单调），符合 02-magic-context.md L22 的 tag→entrySeq 映射 |
| 9 | Determinism | ✅ | grep 全文无 Date.now/Math.random/performance.now/hrtime；三个函数均为输入纯函数；sha256 + 固定键序 JSON.stringify |
| 10 | Type safety | ✅ | tsconfig `noUncheckedIndexedAccess: true` 已核实；replay.ts 决策循环 `for...of` 零下标访问；测试用 `?.`/`??` 收窄；依赖的 projection.ts 以 `!== undefined` 守卫 `entries[index]` |

## Findings

### F1（重要，NON-BLOCKING，建议尽快修复）— replay 测试未接入 `npm test` 显式文件列表

`package.json` 的 `test` 脚本是显式文件列表，**未包含 `test/context-replay.test.ts`**（也不含 `test/context-lkg.test.ts`，属仓库既有模式）。因此 `npm run check` 的单元测试门禁（150 项）**不执行**这 7 个 replay 测试；它们在 CI 中只被 prettier/eslint/tsc 覆盖，运行时回归不会触发门禁失败。本次已显式运行并通过（7/7），commit message 未声称它们属于 npm test，故不阻塞；但建议把该文件（连同 context-lkg.test.ts）加入 `test` 脚本，避免 R3 布线期对 replay.ts 的改动悄悄回归。

### F2（NON-BLOCKING，minor）— replayHash 未覆盖 mutationReplayWatermark

hash 只含 clearedReasoningThroughTag + toolReclaimWatermark + 两个 suppressed id 列表，docstring 所称 "the watermark snapshot" 少了一个字段。当前 mutationReplayWatermark 无任何决策影响（R2 无 mutation units，runReplay 不读取它），defer-pass byte-identity 不受影响，replayHash 作为"已应用决策的指纹"仍自洽；但若 R3 将其作为持久化状态的一部分参与回放，应在 hash 中纳入该字段或明确把 replayHash 文档化为"仅决策指纹"（内容完整性已由 LKG digest + projectionHash 承担，见 F4）。

### F3（NON-BLOCKING，info）— 测试 4 注释与实现门不完全一致

测试注释写 "protectedStart <= arc start 则不被 detect"，实现实际门为 `endSeq < protectedStart`（arc 的 **END** 决定是否受保护）。实现语义正确且比按 start 判定更保守（跨入 tail 的 arc 永不回收，与权威源按 message index 判定一致）；该 fixture 中两种表述结果相同，断言成立，仅注释表述不精确，建议改注释为 "protectedStart <= arc end"。

### F4（通过项确认）— replayHash 不覆盖 projection 是有意设计，职责分离正确

replayHash 只指纹"抑制决策 + 驱动决策的水印"，不覆盖投影内容/tail 增长：SOFT+ 契约允许 live tail 增长而 system/m0/m1 字节不变，决策层稳定性正是 replayHash 的职责；投影内容完整性由 LKG digest（Feature 7）与 projectionHash（Feature 4）承担。分层正确，无缺口。

### F5（通过项确认）— R2 scope 声明准确

提交仅新增 2 文件，无迁移/持久化/调用点变更；replay state 的持久化（水印落库）与 transform 布线明确声明为 R3 Historian（Feature 9/10 gate），与 07-roadmap R3 里程碑"Historian & Cross-session Continuity"一致。authority 的 tier/fixedFloor/TIERS/输入样本闩锁均显式标注为 R3 应急路径，未静默丢弃任何 R2 声明采纳的语义。R2 阶段"不生成新 drop/reasoning decision + 提交 additive/mutation state"由本模块（决策层）+ Feature 5/6（carriers/pass-taxonomy 执行层）共同支撑，SOFT+ byte-identical replay 的决策层部分已由测试 2/3 证明。

## 结论块

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 10 项 checklist 全部通过。Pass Taxonomy 的 SOFT+（"byte-identical replay system/m0/m1"、"不产生新的 drop/reasoning decision"）与 SOFT（"提交新的 additive/mutation state"）在决策层语义上完全实现：REPLAY 无条件抑制（growth-invariant）、DETECT 仅 cache-busting pass 且受 protected tail 限制、水印单调提交。fail-closed 分类（emergency_fail_closed / transform_unavailable / defer_blocked / ok）与 01-context-assembly 的 LKG 验证 + Failure and Emergency Policy 对齐。与权威源 drop-stale-reduce-calls.ts 的 REPLAY/DETECT split 与 protectedCount 语义逐项映射一致。
CODE CORRECTNESS: replay.ts 质量高 — 三个纯函数、显式 undefined/默认值收窄（detect??false、protectedStart??+Infinity）、fail-closed 优先级正确（lkgInvalid 先于 pendingDetect）、newlyReclaimedMaxEndSeq 只在未冻结弧上累计（REPLAY continue 排除）。无死代码、无 ! 断言、无 unsafe 下标访问。唯一代码级瑕疵为 F2（hash 字段不全，当前无影响）。
RECOVERY/CONCURRENCY: 本模块为无状态纯决策层，无并发/持久化面；水印演进单调幂等（Math.max），重复推进不回归；detect 结果只在 cache-busting pass 提交（defer_blocked 闩锁），语义上不可能在 defer pass 破坏缓存前缀。崩溃恢复与落库属于 R3 布线范围，本模块不提前承诺。
TEST COVERAGE: 7/7 通过（显式运行）。覆盖：byte-identical defer 双重 runReplay（hash+列表相等）、detect 边界三态（之下/defer/tail 内）、水印单调幂等、failure 分类全 5 组合、空投影 no-op。缺口：F1 — 7 个测试未接入 npm test 门禁（CI 运行时回归不被捕获）；未覆盖 lkgInvalid+deferPass+pendingDetect 三真组合（代码按 fail-closed 优先级返回 emergency_fail_closed，未显式断言）；无 detect 连续两 pass 后水印提交的端到端演练（依赖 R3）。
EVIDENCE ACCURACY: 全部声明与实测一致 — 7/7 replay 测试、`npm run check` 全量通过（148+2 skip、golden 4、migrations 12、smoke idempotent、crash 7/7、subprocess 3、CLI 6、dist ok）；commit stat（2 文件 +466）与 git show 相符；权威源基线 48ab531d 已核实 = v0.33.0 release；replayHash/水印/分类行为与代码逐行核对一致。
FINDINGS: F1（重要，NON-BLOCKING）test/context-replay.test.ts 未加入 npm test 显式文件列表，7 个测试只在显式命令下运行，CI 运行时回归不被捕获 — 建议与 context-lkg.test.ts 一并接入；F2（minor）replayHash 漏 mutationReplayWatermark，docstring "watermark snapshot" 与实现不一致，当前无影响，R3 布线时应纳入或明确文档化为决策指纹；F3（info）测试 4 注释 "protectedStart <= arc start" 应改为 "protectedStart <= arc end"（实现门为 endSeq < protectedStart，语义正确且更保守）；F4/F5 为通过项确认（hash 职责分层正确；R2 scope 声明诚实，无已采纳 authority 语义被静默删除）。以上均不阻塞 R2 门禁，但 F1 建议在 R3 布线前修复。

<!-- OMO_INTERNAL_INITIATOR -->


## RE-REVIEW（353c702）— 2026-08-04

上一轮将 F1（replay/LKG 测试未接入 `npm test` 显式文件列表）标记为 BLOCKING。实现者提交 `353c702` "fix(test): wire context-lkg + context-replay tests into npm test"，随后又提交 `e3591c8` "fix(test): also wire context-protected-tail tests into npm test"。本轮逐项复核。

### 1. `git show 353c702` — 已确认

- diff 仅改 `package.json` 一行：`test` 脚本文件列表加入 `test/context-lkg.test.ts` 与 `test/context-replay.test.ts`（20 个文件）。
- 实测测试声明数：`test/context-lkg.test.ts` = **17** 个 `test()`（commit message 所称 "16" 不精确 — Feature 7 的 F5 fix 2580b48 追加了 "corrupt payload shape fails closed" 用例）；`test/context-replay.test.ts` = **7** 个。
- 150（原列表）＋ 17（LKG）＋ 7（replay）＝ **174**，与任务预期数字精确吻合。
- 后续 `e3591c8`（同 session 内落地，diff 同样仅改 package.json 一行）又把 Feature 6 的 `test/context-protected-tail.test.ts`（12 个测试，同类遗漏）接入。现 HEAD = e3591c8。

### 2. `npm test` — 实测 186 tests（184 pass + 2 live skip，0 fail）

当前 HEAD（e3591c8）实测输出（TAP 尾部）：

```
1..186
# tests 186
# pass 184
# fail 0
# skipped 2
```

- 构成：150（原）＋ 17（LKG）＋ 7（replay，no watermarks / cleared-reasoning 抑制 / tool-reclaim 冻结 / detect 边界 / advance 单调 / classify 全 5 组合 / empty no-op）＋ 12（protected-tail）。
- 2 个 skip 为 OPENCODE_GO_API_KEY 未设置的两个 live provider 用例（既有行为，非新增）。
- 在 353c702 单独存在、e3591c8 未落地时，npm test 恰为 174（150+17+7），与任务描述一致；e3591c8 是范围扩大而非计数错误。

### 3. `npm run check` — 全量门禁通过（真实输出已捕获于临时日志）

- format:check ✓（prettier --check .）
- lint ✓（eslint .）
- typecheck ✓（tsc --noEmit）
- npm test：**1..186，tests 186，pass 184，fail 0，skipped 2**
- test:context-golden：**1..4，pass 4**
- test:context-migrations：**1..12，pass 12**
- migration:smoke：`"status": "idempotent"`
- crash:check：**7/7 boundary ok**（before_any_write / after_user_append / after_companion_append / after_epoch_created / after_settled / after_tool_result_commit / after_creating_epoch）
- build ✓（tsc -p tsconfig.build.json + copy-migrations）
- test:subprocess：**1..3，pass 3**
- test:cli：**1..6，pass 6**
- dist:smoke：`{"status":"ok","epochDb":true,"ingressDb":true}`

`npm run check` 用 `&&` 串接，dist:smoke（最后一步）成功输出即证明此前所有步骤零失败。

### 4. NON-BLOCKING findings 复核 — replay.ts @ HEAD 与 a2a5754 逐字节一致，两提交均未触碰源码

- **F2（replayHash 不含 mutationReplayWatermark）— 维持**：replay.ts L121–128 复读确认 hash 仅含 clearedReasoningThroughTag、toolReclaimWatermark、suppressedReasoningUnitIds、reclaimedToolArcUnitIds。决策循环（L94–117）从不读取 mutationReplayWatermark，该字段无决策影响；投影内容完整性由 LKG digest（Feature 7）+ projectionHash（Feature 4）承担，replayHash 定位为"已应用决策的指纹"。行为无缺口，R3 布线时应纳入该字段或明确文档化。
- **F3（didSuppress 排除 newly-reclaimed）— 维持**：L92–117 确认 didSuppress 仅在 REPLAY 两个抑制分支置真（L98 reasoning、L106 tool_arc 冻结），DETECT 分支（L112–115）不置真。与 docstring "True if any suppression applied this pass" 一致 —— suppression/detection 语义分离，detect 结果只在 cache-busting pass 提交，不会在 defer pass 误报抑制。设计正确。
- **detect 边界按 arc END 保守判定 — 维持**：L103 取 endSeq = entryRange.endEntrySeq；REPLAY 门（L104）`endSeq <= toolReclaimWatermark`；DETECT 门（L112）`detect && endSeq < protectedStart`。跨入或落在 protected tail 内的 arc（start < protectedStart <= end）永不 detect，比按 START 判定更保守，与权威源 drop-stale-reduce-calls.ts protectedCount（按 message index，"仅检测 tail 起点之下"）语义逐项一致。测试 4 三态断言随 186 项 npm test 通过。

### 5. 状态修正

- 原 **F1（BLOCKING）→ 已关闭**。353c702 修复 LKG + replay 接线；e3591c8 将同类遗漏（protected-tail，Feature 6）一并清除。本仓库已无"测试文件存在但不在 npm test 列表"的实例。
- 原结论块中"单元 150 项（148+2 skip）"已过时：现为 **186 项（184 pass + 2 live skip）**。
- commit message 中 "16 LKG" 为计数瑕疵（实为 17），但总数 174 与实测一致，不影响证据效力。

## 最终结论块（RE-REVIEW 后生效）

VERDICT: PASS
SPEC COMPLIANCE: 10 项 checklist 全部保持通过。SOFT+ byte-identical replay（REPLAY 无条件抑制、growth-invariant）、SOFT additive/mutation 提交（DETECT 仅 cache-busting pass + protected tail 限制、水印单调提交）在决策层语义完整；fail-closed 分类（emergency_fail_closed / transform_unavailable / defer_blocked / ok）与 01-context-assembly 的 LKG 验证 + Failure and Emergency Policy 对齐；与权威源 drop-stale-reduce-calls.ts 的 REPLAY/DETECT split、protectedCount 语义映射一致。R2 声明（纯决策层、无迁移/持久化/调用点、transform 布线属 R3 Historian）诚实且经 git 复核（a2a5754 起 4 个提交均未触碰 src/context/replay.ts）。
CODE CORRECTNESS: replay.ts 保持高质量 —— 三纯函数、detect??false 与 protectedStart??+Infinity 默认值收窄、fail-closed 优先级正确（lkgInvalid 先于 pendingDetect）、newlyReclaimedMaxEndSeq 仅在未冻结弧上累计（REPLAY continue 排除）；无死代码、无 ! 断言、无 unsafe 下标。F2（hash 漏 mutationReplayWatermark）为唯一代码级瑕疵，无当前影响，维持 NON-BLOCKING。
RECOVERY/CONCURRENCY: 无状态纯决策层，无并发/持久化面；水印 Math.max 单调幂等（重复推进不回归）；detect 结果只在 cache-busting pass 提交（defer_blocked 闩锁），defer pass 不可能破坏缓存前缀。崩溃恢复/落库属 R3 布线，本模块未提前承诺。
TEST COVERAGE: 从"7/7 仅在显式命令下运行"升级为全部接入 CI 门禁：npm test = 186（184 pass + 2 live skip），其中 LKG 17、replay 7、protected-tail 12 均随门禁执行。覆盖：byte-identical 双重 runReplay（hash+列表相等）、detect 边界三态、水印单调幂等、failure 分类全 5 组合、空投影 no-op。已知未覆盖项仅剩：lkgInvalid+deferPass+pendingDetect 三真组合（代码按 fail-closed 优先级返回 emergency_fail_closed，未显式断言）；detect 连续两 pass 后水印提交的端到端演练（依赖 R3 布线）。
EVIDENCE ACCURACY: 全部声明与实测一致 —— 353c702 diff 仅改 package.json 且含两个测试文件（git show 已核实）；npm test 实测 1..186（184 pass + 2 skip）；npm run check 全链路绿色（unit 186、golden 4、migrations 12、smoke idempotent、crash 7、subprocess 3、CLI 6、dist ok），真实输出已捕获；replay.ts 与 a2a5754 逐字节一致，三类 NON-BLOCKING 结论均复读源码确认。唯一表述瑕疵：353c702 commit message 写 "16 LKG" 实为 17，不影响总数精确性。
FINDINGS: F1（原 BLOCKING）已由 353c702 修复，e3591c8 进一步修复 Feature 6 的同类遗漏（protected-tail 12 测试接入）；F2（NON-BLOCKING, minor）replayHash 未纳入 mutationReplayWatermark，当前无决策影响，R3 布线时应纳入或文档化为"仅决策指纹"（内容完整性由 LKG digest 承担）；F3（NON-BLOCKING, info）测试 4 注释 "protectedStart <= arc start" 建议改为 "protectedStart <= arc end"（实现门 endSeq < protectedStart 语义正确且更保守）；F4/F5 通过项确认维持。全部已消除或可接受，**VERDICT: PASS**。
