# Feature 9/10 (R2) Host product-path Context pipeline — Spec/Correctness Review (round4) RE-REVIEW

## 审查元信息

| 项目 | 值 |
|---|---|
| Reviewer role | Host product-path Context pipeline spec/correctness reviewer（独立审查者，非实现者） |
| 原审查 HEAD | `a8b51585807c68cce33c80d64147dcbcf59f02ea` — "feat(context): Host product-path Context pipeline (R2 Feature 9)" |
| 原审查结论 | **BLOCKING**（F1 缓存身份写回错误 → HARD 永远；F2 representedThrough=headEnd → SOFT 永远；见 `feature-10-host-code-review.md`） |
| RE-REVIEW HEAD | `bdcc8bd1c151801abe7ff85d355f86ebe189963c` — "fix(context): pipeline review F1/F2 BLOCKING (SOFT+ reachability, cached identity)" |
| RE-REVIEW baseline | 父提交 `9a991c676d79eacdf88fc1361cd92729b8dd1a67`（R2 Feature 10 gate） |
| 审查日期 | 2026-08-04 |

提交变更：2 文件 `+96/-28`（`src/context/pipeline.ts` 72 行、`test/context-pipeline.test.ts` +52 行新增 1 端到端回归测试）。无迁移、无 schema 变更、无其他源码文件改动（git show --stat 已核实）。

## RE-REVIEW（bdcc8bd）— 2026-08-04

### 1. `git show bdcc8bd` — 已确认，diff 与 commit message 逐项一致

- F1：`materialize_m0` action 新增 `cachedM0SystemHash` / `cachedM0ModelKey` / `cachedM0ProviderProfileId` 三字段（携带**当前 pass 身份**），`applyContextPass` 持久化 `decision.action.cachedM0*` 取代原先回读 `lineage.cachedM0* ?? ""` 的错误写回。
- F2：`representedThroughEntrySeq` 由 `protectedTail.headEndEntrySeq` 改为 `projection.toEntrySeq`（materialize_m0 action L222、applyContextPass materialize_m1 L369 / materialize_m0 L400）。
- 代码审查 F1（minor）：`deriveTokenTarget` 删除平行公式，改调 authority 锁定的 `deriveProtectedTailTokenTarget`。
- 新增端到端回归测试 1 个（`pipeline: end-to-end round trip — pass 2 on identical materialized state is SOFT+`）。

### 2. F1 验证 — 当前 pass 身份持久化为缓存 authority（关闭原 BLOCKING）

**代码核对**（`src/context/pipeline.ts`）：
- L223-225：`cachedM0SystemHash: input.source.systemProjectionHash`、`cachedM0ModelKey: `${input.model.provider}:${input.model.modelId}``、`cachedM0ProviderProfileId: input.source.providerProfileId`。
- L397-399（applyContextPass materialize_m0）：`cachedM0SystemHash: decision.action.cachedM0SystemHash`，等等 —— 即**当前这次 HARD pass 的身份**落库。
- 对照 decidePass（pass-taxonomy.ts L92-96）：`hard.modelKey !== (lineage.cachedM0ModelKey ?? "")` → `model_change` HARD。修复前第一次 materialize 时 lineage.cachedM0ModelKey 为 null → 落库 "" → 第二次 pass 的 "opencode:model-a" !== "" → 永远 HARD。修复后第一次落库即 "opencode:model-a"，第二次 pass 相等 → 不再误判。

**运行时实测**（tsx 直跑，独立临时 DB；模拟回归测试同构流程）：
```
pass1.classification = HARD
F1  lineage.cachedM0ModelKey = "opencode:model-a"      <- 当前 pass 身份，非 ""
F1  lineage.cachedM0SystemHash = "sys-hash-1"
F1  lineage.cachedM0ProviderProfileId = "mock"
```

### 3. F2 验证 — representedThrough = projection.toEntrySeq（关闭原 BLOCKING）

**代码核对**：
- L222：HARD action `representedThroughEntrySeq: projection.toEntrySeq`；L400 持久化。
- L369：materialize_m1 `representedThroughEntrySeq: decision.projection.toEntrySeq`。
- runContextPass L126-127：`liveDelta = units.some(unit => unitEndSeq(unit) > representedThrough)`。修复前 = headEndEntrySeq（小会话 headEnd=0）→ 任何 tail 单位都算 live delta → 永远 SOFT；修复后 m0/m1 覆盖整个 projection → 相同 entries 的第二次 pass `liveDelta=false` → 无 HARD 信号 → SOFT+。

**运行时实测**：
```
pass2.classification = SOFT+ action = reuse        <- 完全相同 entries + 持久化 lineage
pass2b.classification (identical again) = SOFT+    <- 第三次完全相同仍 SOFT+
pass3.classification (model change) = HARD         <- 身份变化仍正确回到 HARD
new turn after SOFT+ -> SOFT                       <- 新内容正确 SOFT（m1 重渲染）
after SOFT materialize_m1: representedThrough = 4 === toEntrySeq? true
identical after SOFT -> SOFT+                      <- SOFT 物化后相同 pass 亦 SOFT+
```

### 4. authority SOFT+ 语义端到端可达 — 确认

- authority fixture `test/fixtures/context/opencode-v0.33.0/taxonomy-softplus-defer-identical.json`：`passes: [{isCacheBustingPass:false},{isCacheBustingPass:false}]` → expected `SOFT+`、m0/m1 `byte_identical`、`rematerialized:false`（源自 `m0m1-taxonomy.test.ts` @ `48ab531d`，已读源码确认：baseline isCacheBustingPass:true → HARD first_render，随后两个 defer pass 均 SOFT+ 且 byte-identical）。
- pipeline 端到端等价：pass1 HARD（= cache-busting baseline）→ pass2/pass2b 两个完全相同的 pass 均 SOFT+ reuse（上面实测），即 "isCacheBustingPass:false 两次 → 两次 SOFT+" 通过 pipeline **自身的持久化 lineage** 完整可达。parity-gate 测试（198 项中的 #40）用该 fixture 直接断言 pipeline 复现 SOFT+，随 npm run check 通过。
- 语义自洽性：m0/m1 为缓存的稳定前缀（R2 中 m1 为静态占位 delta，真实 delta 渲染属 R3 Historian），live tail 由 renderProviderVisible 从**相同的 projection** 发射 —— 相同 pass 的 provider-visible 字节完全相同，符合 01-context-assembly L82 "相同 source/materialization/provider profile 必须 byte-stable replay" 与 SOFT+ 定义（L136-141：identity 不变 + system/m0/m1 byte-identical + 只追加当前 invocation live delta）。

### 5. 代码审查 F1（minor）复核 — deriveTokenTarget 复用 authority（关闭）

L317-326 调 `deriveProtectedTailTokenTarget({contextLimit: input.contextLimit ?? 0, executeThresholdPercentage: input.executeThresholdPercentage ?? 0, usagePercentage: input.usagePercentage ?? 0}).N` —— 单一 N 来源，含 ABS_CAP=96_000 / FLOOR / headroom 全部钳制，原平行公式（缺 ABS_CAP）已删除。新增观察见 Finding R2（`?? 0` 与 authority 缺省值语义的边界）。

### 6. 验证命令与真实输出

**a. `npx tsx --test test/context-pipeline.test.ts` — 7/7 PASS**
```
1..7
# tests 7
# pass 7
# fail 0
# cancelled 0
# skipped 0
# duration_ms 489.5755
```
新增回归测试（第 7 个，L366-416）断言：`lineage.cachedM0ModelKey === "opencode:model-a"`（F1）、`lineage.representedThroughEntrySeq === pass1.projection.toEntrySeq`（F2）、pass2 `SOFT+` + `reuse`、pass3（model 改为 model-NEW）`HARD`。

**b. `npm run check` — 全量门禁通过（真实输出已捕获）**
- format / lint / typecheck ✓
- npm test：**1..198，tests 198，pass 196，fail 0，skipped 2**（2 skip = OPENCODE_GO_API_KEY 未设置的 live provider 用例）
- test:context-golden：4/4；test:context-migrations：12/12
- migration:smoke：`"status": "idempotent"`；crash:check：7/7 boundary ok
- bench:context：`{"turns":200,"rawEntries":600,"units":400,"classification":"HARD","decisionMsPerPass":4.82,"materializeMs":1.129,"m0BodyBytes":5731,"status":"ok"}`
- build ✓；test:subprocess：3/3；test:cli：6/6；dist:smoke：`{"status":"ok","epochDb":true,"ingressDb":true}`

与任务预期（7/7 pipeline、198: 196 pass + 2 skip、4 golden、12 migrations、3 subprocess、6 CLI、bench:context）逐项吻合。

### 7. 环境核实

HEAD = `bdcc8bd`；`git status --porcelain` 仅 3 个 untracked evidence 审查文件（feature-10-host-code-review.md、feature-11-*.md），无源码改动。pipeline 在 src/ 中仍无生产调用点（R2 边界：Host `context` 事件接线属 Feature 10 gate，当前仅测试消费）。

## RE-REVIEW Findings

- **F1（原 BLOCKING）→ 已关闭**。materialize_m0 落库当前 pass 身份（modelKey/systemHash/providerProfileId），实测 `cachedM0ModelKey="opencode:model-a"`（非 ""），第二次相同 pass 不再误判 model_change。regression 测试第 390 行显式断言。
- **F2（原 BLOCKING）→ 已关闭**。representedThroughEntrySeq = projection.toEntrySeq（m0/m1 双路径），实测 pass1 后 `representedThrough=3===toEntrySeq`，pass2/pass2b 均 SOFT+ reuse；SOFT 物化后相同 pass 亦 SOFT+。authority "isCacheBustingPass:false 两次 → 两次 SOFT+" 经 pipeline 自身持久化状态端到端可达（parity-gate #40 + 回归测试 + 独立运行时脚本三重证据）。
- **F3（代码审查 F1 minor）→ 已关闭**。deriveTokenTarget 复用 `deriveProtectedTailTokenTarget`，单一 N authority。
- **R1（NON-BLOCKING，info）— classifyAction 的 HARD 占位分支为死代码**：L247-257 返回 `representedThroughEntrySeq: 0` + 空 cached 身份，但 runContextPass L207-231 总是以真实值重建 HARD action，占位结果从不被消费（注释已声明）。当前安全；若未来重构 classifyAction 返回值被复用，占位 0/"" 会注入错误值 —— 建议删除或改为永不返回 m0 action。
- **R2（NON-BLOCKING，info）— `deriveTokenTarget` 的 `?? 0` 与 authority 缺省值语义存在边界漂移**：authority `deriveProtectedTailTokenTarget` 对**缺失**（非有限）executeThresholdPercentage 默认 65，对 **0** 则按 0% 处理 → usable=1 → N 退化到 ~1（fold-nothing 保守行为）。pipeline 传 `input.executeThresholdPercentage ?? 0`，当 Host 未提供该信号时 N≈1，与原公式默认 65 分歧。fail-conservative（折叠更少，无安全风险），且当前无生产调用点（Feature 10 接线时需传递真实信号或显式默认 65），故不阻塞；接线时建议仅在该字段已定义时才传给 authority，或显式传权威默认。
- **R3（NON-BLOCKING，info）— R2 m1 占位边界**：SOFT materialize_m1 仍写静态占位 delta（真实 delta 渲染属 R3 Historian），新内容由 live-tail surface 承载；representedThrough=toEntrySeq 是 byte-stable replay 的水印契约而非 m1 字节包含 delta 的声明，与 01-context-assembly L75-82 一致，非回归。

## 最终结论块（RE-REVIEW 后生效）

VERDICT: PASS
SPEC COMPLIANCE: 两项 BLOCKING spec 违例已修复并通过端到端验证。01-context-assembly Pass Taxonomy 的 SOFT+ 语义（identity 不变 + system/m0/m1 byte-identical replay + 只追加 current invocation live delta，L136-141）现可经 pipeline 自身持久化 lineage 完整到达：缓存 authority 记录当前 pass 身份（cachedM0SystemHash/ModelKey/ProviderProfileId），representedThrough=projection.toEntrySeq 使相同 pass 无 live delta → SOFT+ reuse；authority fixture（isCacheBustingPass:false 两次 → SOFT+ 两次，m0m1-taxonomy.test.ts @ 48ab531d）被 parity-gate #40 与新增回归测试同时复现。HARD 原因集（model_change/system_hash/provider_profile）判定路径与 authority mustMaterialize 语义一致，模型变更仍正确回到 HARD。R2 边界声明（m1 占位 delta、Historian 折叠属 R3）诚实。唯一残留为 R2（info，无生产调用点下的 `?? 0` 缺省值边界）与 R1（死代码占位），均不构成 spec 偏差。
CODE CORRECTNESS: 修复实现精确对应两个根因：F1 的写回改为 `decision.action.cachedM0*`（当前 pass 身份），F2 的 representedThrough 在 m0/m1 双路径统一为 projection.toEntrySeq；决策保持纯函数（applyContextPass 以调用方 nowMs 落时间戳）。deriveTokenTarget 复用 authority 单一 N 来源（ABS_CAP/floor/headroom 钳制齐全）。fail-closed（缺 lineage throw、changes!==1 throw）、水印单调、判别联合穷尽收窄均保持。瑕疵仅 R1 死代码占位与 R2 缺省值边界（NON-BLOCKING）。
RECOVERY/CONCURRENCY: 持久化仍为单行 UPDATE（materializeM0/M1 原子提交），无新并发面；HARD 后 lineage 完整落库，reopen 重载决策可重建（回归测试 + 既有测试 4 验证）。SOFT+ 为 no-op 不写库、不推进水印（测试 6 断言），身份/水位状态在 defer pass 上不被破坏；模型变更可随时从 SOFT+ 稳定态回到 HARD（pass3 实测）。
TEST COVERAGE: 7/7 pipeline 测试通过（含新增端到端回归：pass1 HARD → applyContextPass → pass2 相同 SOFT+ reuse → pass3 模型变更 HARD，显式断言 F1 的 cachedM0ModelKey 与 F2 的 representedThrough）；npm run check 全链路 198（196 pass + 2 live skip）、golden 4、migrations 12、smoke idempotent、crash 7、subprocess 3、CLI 6、bench:context ok、dist ok。独立运行时脚本额外验证了 SOFT+ 重复（pass2/pass2b）、SOFT→materialize_m1→SOFT+ 闭环。残留未覆盖：failClosed/setEmergencyState 分支（R2 恒 "none"，Feature 10 接线时补）；`?? 0` 缺省值路径（无生产调用点，接线时补契约测试）。
EVIDENCE ACCURACY: 全部声明与实测一致 —— `git show bdcc8bd`（2 文件 +96/-28）与 commit message 逐项吻合；7/7 pipeline、198(196+2 skip)、golden 4、migrations 12、subprocess 3、CLI 6、bench:context 与任务描述及实测输出完全一致；HEAD=bdcc8bd、工作树仅 untracked evidence 文件；authority fixture 与源码（m0m1-taxonomy.test.ts @ 48ab531d）已逐行复核。无虚构测试结果。
FINDINGS: 原 F1/F2（BLOCKING）均已修复并三重证据关闭（代码核对 + 回归测试 + 独立运行时实测）；代码审查 F1（minor，deriveTokenTarget 平行公式）已关闭。新增：R1（info）classifyAction HARD 占位为死代码（representedThrough:0/空 cached 身份，从不被消费，建议删除防漂移）；R2（info）deriveTokenTarget 的 `?? 0` 使缺失 executeThresholdPercentage 时 N 退化为 ~1（fold-nothing 保守，无安全影响；Feature 10 接线时应传真实信号或显式权威默认 65）；R3（info）R2 m1 占位 delta 边界（非回归，规格一致）。以上全部不阻塞，**VERDICT: PASS**。

<!-- OMO_INTERNAL_INITIATOR -->
