# Feature 5 (R2) — SOFT+/SOFT/HARD Pass Taxonomy 独立评审（Pass-state-machine parity reviewer）

## 评审人角色
Pass-state-machine parity reviewer（独立评审，非实现者）

## Reviewed baseline
e855367 fix(context): projection reuses ingress pairing predicate (reviewer F1/F2/F4)

## Reviewed HEAD
dfee088 feat(context): SOFT+/SOFT/HARD pass taxonomy (R2 Feature 5)

## 变更范围
- package.json（+1 行）：将 test/context-pass-taxonomy.test.ts 纳入 npm test 清单
- src/context/pass-taxonomy.ts（新增 184 行）：SOFT+/SOFT/HARD 分类纯函数模块（decidePass / projectPrefix / prefixFingerprint）
- test/context-pass-taxonomy.test.ts（新增 254 行，12 个测试，含 golden-fixture matrix）

## 审阅文件
- git show HEAD --stat 与 git show HEAD 全文 diff（dfee088）
- src/context/pass-taxonomy.ts（全文 184 行）
- test/context-pass-taxonomy.test.ts（全文 254 行，12 个测试）
- src/context/context-store.ts（ContextLineage 字段、materializeM0/materializeM1 原子写路径，第 382-444 行）
- evidence/notion-round4/01-context-assembly.md（Pass Taxonomy 章节，第 134-157 行）
- 权威源 inject-compartments.ts（mustMaterialize 第 1310-1422 行；M0HardSignals 第 592-606 行）
- 权威测试 m0m1-taxonomy.test.ts（全文 304 行）
- test/fixtures/context/opencode-v0.33.0/ 下 4 个 taxonomy fixture（softplus / soft / hard-model-change / empty-hard-signal）

## 实际执行的测试与输出

### 1) npx tsx --test test/context-pass-taxonomy.test.ts
结果：# tests 12, # pass 12, # fail 0, # skipped 0, duration_ms 289.5
12 个用例全部通过：first_render / cached_m1_missing / SOFT+ 字节一致重放 / SOFT live delta / model_change / system_hash / 空信号不折叠 / ttl_idle fold-once 幂等 / provider/serializer/carrier/persona/declaration HARD / tool result 不触发重建 / prefix 指纹 / golden fixture matrix。

### 2) npm run check（完整 gate，真实执行）
逐段通过：
- format:check（prettier）、lint（eslint）、typecheck（tsc --noEmit）
- npm test：150 unit → 148 pass + 2 SKIP（R1-P1 live vertical slice，OPENCODE_GO_API_KEY 未设置，声明为 live skip）
- test:context-golden：4/4
- test:context-migrations：12/12（含 SIGKILL 崩溃窗口）
- migration:smoke：idempotent（firstApplied: [0001_bootstrap], secondApplied: []）
- crash:check：7/7 boundaries ok（before_any_write 至 after_creating_epoch）
- build + copy-migrations：ok
- test:subprocess：3/3
- test:cli：6/6
- dist:smoke：ok

## Checklist 逐项核对

1. SOFT+（identity 不变、system/m0/m1 字节一致、仅 live delta、无新 drop/reasoning decision）— PASS。decidePass 仅在 wouldAdvanceLive=false 且全部 HARD guard 通过后返回 SOFT+（advancesMaterialization=false，pass-taxonomy.ts 第 175-179 行）；系统/m0/m1 字节一致重放由调用方传入同一 lineage 体现，projectPrefix/prefixFingerprint 提供身份指纹（测试 11 覆盖稳定与区分）。与权威 m0m1-taxonomy.test.ts 第 115-136 行 defer pass 断言一致（测试 3）。

2. SOFT（system/m0 不变、m1 重渲染、additive/mutation state 提交、deferred-signal ordering 保留）— PASS。wouldAdvanceLive=true 且无 HARD 信号 → SOFT（advancesMaterialization=true，第 171-176 行）。deferred-signal ordering 由 context-store 的 deferredSignalCursor 单调游标保证（context-store.ts 第 463-518 行；context-store 测试 6 覆盖顺序），本模块为纯分类函数不触碰该顺序。与权威第 138-153 行 exec pass 语义一致（测试 4）。

3. HARD（重建 m0、折叠 m1、decay/tier、更新 epoch、捕获新 LKG）— PASS。decidePass 返回 HARD + reason + advancesMaterialization=true；效果委托给既有 ContextStore.materializeM0（单行 UPDATE 原子写 m0_body/m1_body/m0_materialized_at/cached 标记，第 382-418 行），折叠 m1、更新 materialization epoch 与 LKG 捕获（captureLkgSlot，第 520-532 行）均为既有能力，本提交未重复实现。HARD reason 与权威 mustMaterialize（第 1310-1422 行）逐一对应：first_render / cached_m1_missing / model_change / system_hash / ttl_idle（测试 5/6/8/9）。

4. HARD reasons 完整性 — PASS（含 1 项注意）。model_change、provider_profile_change、serializer_change、carrier_schema_change、persona_change、declaration_change（P2）、ttl_idle（cache epoch）、context_pressure、manual_maintenance 均由 decidePass 实际返回；spec 第 157 行合法 HARD reasons 清单全部获得映射。baseline_structural_change 仅在 HardReason 联合类型中声明，无代码路径返回（见 F1）。

5. 空当前 HARD 信号永不变更 — PASS。全部信号比较前置 `!== "" && !== undefined` 守卫，与权威第 1341/1344 行写法一致；空串/缺失信号跳过全部 HARD guard，不会产生虚假折叠。测试 7（SOFT+）与 empty-signal 场景（rematerialized=false）覆盖。

6. ttl_idle fold-once + 幂等 — PASS。判定门为 lastResponseTime > m0MaterializedAt（第 150-155 行），与权威第 1354-1360 行一致；自消费性由 materializeM0 把 m0_materialized_at 写为当前时刻保证（fold 后 lastResponseTime 不再大于 materializedAt，同一 turn 内重复信号不再折叠）。测试 8 显式验证 fold-once + 幂等（fold 后再次 pass 为 SOFT）。注意：Iris 在 hard.lastResponseTime 缺失时回退 lineage.lastResponseTime，与权威"仅用飞行信号"有偏差（见 F2）。

7. 普通 ToolResult 不触发 P0/P1/P2 重建 — PASS。wouldAdvanceLive=true + BASE_HARD（全部身份信号一致）→ SOFT，永不 HARD（测试 10）。与权威"new compartment 只是 m1 delta、折叠只发生在 HARD bust"的语义一致（m0m1-taxonomy.test.ts 第 138-153 行、inject-compartments.ts 第 1304-1308 行）。

8. Golden fixture matrix — 部分 PASS（empty-signal 项不成立，见 F3）。softplus（SOFT+ / rematerialized=false）、soft（SOFT / rematerialized=false）、hard-model-change（HARD / model_change / rematerialized=true）三个 fixture 与 decidePass 结果一致且测试断言两者相等。empty-hard-signal fixture 记录 passClassification 为 "SOFT"（对应权威 isCacheBustingPass=true 的 exec-pass 场景），而测试以 wouldAdvanceLive=false 驱动得到 "SOFT+"，且断言只分别检查 e.classification==="SOFT+" 与 empty.expected.passClassification==="SOFT"，从未断言二者相等——该 fixture 项并未真正验证 parity。

9. 权威 mustMaterialize reasons 映射 — PASS。first_render / cached_m1_missing / model_change / system_hash / ttl_idle 五个 R2 相关 reason 逐一映射到 Iris lineage 字段（m0Body / m1Body / cachedM0ModelKey / cachedM0SystemHash / m0MaterializedAt+lastResponseTime）。compartment_render_epoch、project_change、project_memory_epoch、max_mutation_id、upgrade_state 均为 R3/R4-boundary reason（依赖 project/workspace/memory/upgrade identity；ContextLineage 当前无对应字段，Iris 以 baseline_structural_change 成员预留给该族），按评审前提确认 R2 不要求实现，无被静默丢弃的已采纳权威 reason。Iris 侧新增 provider/serializer/carrier/persona/declaration 为 spec 明确要求的 P0/P2 身份信号。

## 发现项
- F1（非阻塞，前向预留/声明精确性）：HardReason 联合类型含 cache_epoch 与 baseline_structural_change 两个成员，decidePass 无任何分支返回它们；commit message 将二者列为已实现 reason，表述略过度。语义上 cache epoch 由 ttl_idle 承担（provider cache TTL），baseline_structural_change 预留给 R3/R4-boundary 的 max_mutation_id/project_change/compartment_render_epoch 族。建议删除这两个成员，或在注释中明确标注"保留给 R3/R4 边界"。
- F2（非阻塞，与权威的防御性偏差）：ttl_idle 分支 `hard.lastResponseTime ?? lineage.lastResponseTime ?? 0` 在飞行信号缺失时回退到持久化 lastResponseTime；权威只使用当前飞行信号并要求 >0（inject-compartments.ts 第 1354-1360 行）。若调用方传 cacheExpired:true 而不带当前 lastResponseTime，Iris 可能基于陈旧持久值折叠，而权威不会。当前测试均显式传入信号故未暴露；建议改为要求当前非零信号（hard.lastResponseTime !== undefined && hard.lastResponseTime > 0）以与权威一致。
- F3（非阻塞，测试保真度）：golden fixture matrix 的 empty-hard-signal 项未验证 parity——fixture 记录 SOFT（exec-pass 场景），测试驱动 wouldAdvanceLive=false 得到 SOFT+，且断言从不比较二者相等。正确复现权威该用例应使用 wouldAdvanceLive=true（得到 SOFT，与 fixture 一致）并显式断言相等；当前写法下 checklist 第 8 项对 empty-signal 项不成立。
- F4（信息性，尚未接线）：src/ 全库 grep 确认 decidePass / pass-taxonomy 无任何生产消费者（仅模块自身与测试引用）。本提交交付的是分类决策引擎及其测试，尚未接入任何 transform/hook 调用点；接线时必须保证 HARD→materializeM0、SOFT→materializeM1、SOFT+→不写库的映射，并补一条端到端集成测试。

## 结论
VERDICT: NON_BLOCKING（核心权威语义全部保留；发现项为测试保真度、防御性偏差与前向预留表述问题）

## 固定结论块

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 与 spec 01-context-assembly Pass Taxonomy 章节（SOFT+/SOFT/HARD 定义与合法 HARD reasons 清单）及权威 mustMaterialize 语义对齐：SOFT+ 仅在 wouldAdvanceLive=false + 无 HARD 信号时返回；SOFT 在 wouldAdvanceLive=true + 无 HARD 信号时返回；HARD reasons 覆盖 spec 要求的 model/provider/profile、serializer/carrier、Persona/P2、cache epoch(ttl_idle)、context pressure、manual maintenance 全部映射，baseline_structural_change 以联合类型成员预留 R3/R4 边界（R2 不要求）；空当前 HARD 信号永不折叠；普通 ToolResult 仅推进 live delta 时为 SOFT，绝不触发 P0/P1/P2 重建。
CODE CORRECTNESS: decidePass 为确定性纯函数，全部信号比较带空值守卫，与权威逐行语义一致；HARD 效果委托既有 materializeM0（单行原子 UPDATE）与 captureLkgSlot，无重复实现、无新状态写入；prefixFingerprint 使用 sha256 对 (system, m0, m1) 定界拼接，稳定且区分。偏差：ttl_idle 的 lineage.lastResponseTime 回退与权威"仅飞行信号"不一致（F2，非阻塞）；cache_epoch/baseline_structural_change 声明但永不触发（F1，非阻塞）。
RECOVERY/CONCURRENCY: 本模块为无副作用的纯分类函数，不引入任何新持久状态、后台任务或并发共享；崩溃/恢复路径完全由既有 ContextStore 单行事务（materializeM0/materializeM1 fail-closed）承担，context-migrations 12/12 与 crash:check 7/7 验证。无新并发面。
TEST COVERAGE: 专用测试 12/12 通过，覆盖三种分类、全部实际触发 HARD reasons、空信号、ttl fold-once 幂等、tool-result-SOFT、prefix 指纹；npm run check 全绿（150 unit: 148 pass + 2 live skip；4 golden；12 context-migrations；3 subprocess；6 CLI；migration:smoke idempotent；crash:check 7/7；dist:smoke ok）。缺口：golden fixture matrix 的 empty-hard-signal 项未真正断言与 fixture 分类一致（F3）；无生产调用点集成测试（F4）。
EVIDENCE ACCURACY: commit message 声称的测试数字与实际输出逐项吻合（150 unit: 148 pass + 2 live skip、4 golden、12 migrations、3 subprocess、6 CLI），本评审所有命令均为真实执行并记录输出；唯一偏差是 commit message 将 cache_epoch/baseline_structural_change 表述为已实现 reason，而二者仅存在于联合类型声明（F1）。
FINDINGS: F1 联合类型中 cache_epoch/baseline_structural_change 无触发路径，建议删除或标注 R3/R4 预留（非阻塞）；F2 ttl_idle 回退 lineage.lastResponseTime 与权威"仅飞行信号"语义偏差，建议要求当前非零信号（非阻塞）；F3 golden matrix 的 empty-signal 项以 SOFT+ 驱动但 fixture 记录 SOFT 且未断言相等，建议改为 wouldAdvanceLive=true 并显式断言 parity（非阻塞）；F4 decidePass 尚未接入任何生产 transform/hook 调用点（信息性，接线时需保证 HARD→materializeM0、SOFT→materializeM1、SOFT+→不写库）。
<!-- OMO_INTERNAL_INITIATOR -->
