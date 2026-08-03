# Feature 10/11 (R2) Benchmark / migration / failure-gate 审查记录 — parity + capacity benchmark（round4）

## 审查元信息

| 项目 | 值 |
|---|---|
| Reviewer role | R2 benchmark/migration/failure-gate reviewer（独立审查者，非实现者） |
| Reviewed HEAD | `9a991c676d79eacdf88fc1361cd92729b8dd1a67` — "feat(context): R2 Feature 10 gate — parity, capacity benchmark (R2 final feature)" |
| Reviewed baseline | 父提交 `a8b5158`（R2 Feature 9 Host product-path Context pipeline），`git log --oneline -5` 已确认 |
| 审查日期 | 2026-08-04 |

提交变更（`git show 9a991c6 --stat` 与 `git diff a8b5158..9a991c6 --stat` 一致）：3 文件 `+451/-2`：
`package.json`（+bench:context、+parity-gate 接入 test、check 链插入 bench:context）、
`scripts/context-bench-smoke.ts`（新增 171 行）、`test/context-parity-gate.test.ts`（新增 277 行、5 测试）。
**未触碰任何 src/ 文件**——context-store.ts 的 LATEST_MIGRATION_VERSION / newer-schema fence / migrateDatabase 调用、crash-harness、migration-smoke 均未被本次提交改动（Feature 10 没有弱化既有 gate）。

## 审查的文件

- `scripts/context-bench-smoke.ts`（全文 171 行）
- `test/context-parity-gate.test.ts`（全文 277 行、5 测试）
- `package.json`（test 列表、bench:context、check 链）
- `scripts/migration-smoke.ts`、`scripts/crash-check.ts`、`scripts/crash-harness.ts`、`scripts/crash-worker.ts`
- `src/db/migrations/context/0001_bootstrap.sql`（context 迁移 fixture，101 行）
- `src/context/context-store.ts`（LATEST_MIGRATION_VERSION、open() 的 newer-schema fence、migrateDatabase 调用）
- `src/db/migrate.ts`（forward-only + per-file checksum 迁移器）
- `src/context/pipeline.ts`（runContextPass / applyContextPass 签名核对）
- `test/context-store.test.ts`（12 测试，含 corrupt/newer-schema fence 与 SIGKILL）
- `evidence/notion-round4/07-roadmap.md`（R2 Exit Gate）、`04-pi-compat.md`（v68 契约项）、`02-magic-context.md`、`08-project-boundaries.md`
- 既有审查记录：`feature-10-host-code-review.md`、`feature-03-context-storage-code/spec-review.md`、`feature-02-golden-review.md`

## 验证命令与真实输出（全部实际执行）

### 1. `npx tsx --test test/context-parity-gate.test.ts` — 5/5 PASS

TAP：`1..5 / # tests 5 / # pass 5 / # fail 0 / # skipped 0`（duration 336.68ms）。
逐项：SOFT+ byte-identical defer（reuse）、SOFT live-delta m1 re-render（materialize_m1）、HARD model-change m0 rebuild（materialize_m0）、empty-signal no-fold（SOFT+、didSuppress false）、ttl-idle no-fold（无显式信号时 pipeline 不 fold，fixture 记录 rematerialized=true，测试 NOTE 如实声明）。

### 2. `npx tsx scripts/context-bench-smoke.ts` × 2（结构数字一致）

Run 1：`turns 200 / rawEntries 600 / units 400 / classification HARD / decisionMsPerPass 5.744 / materializeMs 1.342 / m0BodyBytes 5731 / status ok`
Run 2：`turns 200 / rawEntries 600 / units 400 / classification HARD / decisionMsPerPass 6.157 / materializeMs 1.245 / m0BodyBytes 5731 / status ok`
结构数字（turns/rawEntries/units/classification/m0BodyBytes）两次完全一致；计时随墙钟波动（5.387–6.157ms / 1.245–1.342ms），符合 benchmark 预期。

### 3. `npm run migration:smoke` — idempotent

`firstApplied: ["0001_bootstrap"]`（空库初始化），`secondApplied: []`（已迁移库重跑幂等）。

### 4. `npm run crash:check` — 7/7 boundaries passed

before_any_write / after_user_append / after_companion_append / after_epoch_created / after_settled / after_tool_result_commit / after_creating_epoch 全部 ok；invocationDb/resultDb 全程 false（无 synthetic repair 工件）。

### 5. `npm run check`（完整门禁）— 全绿

- `npm test`：`1..197 / # tests 197 / # pass 195 / # fail 0 / # skipped 2`（2 skip = OPENCODE_GO_API_KEY 未设置的 live provider 用例；parity-gate 5 项为 #40–#44）
- `test:context-golden`：4/4
- `test:context-migrations`（context-store.test.ts）：12/12，含 #8 corrupt DB fail closed、#9 newer schema fence、#12 SIGKILL crash consistency
- `migration:smoke`：idempotent（firstApplied [0001_bootstrap]）
- `crash:check`：7/7
- `bench:context`：`200/600/400/HARD/5.387/1.297/5731/ok`
- `build` ✓、`test:subprocess` 3/3、`test:cli` 6/6、`dist:smoke` `{"status":"ok","epochDb":true,"ingressDb":true}`

与 commit message 声称的数字（197/195+2 live skip、4 golden、12 migrations、migration:smoke、crash:check、bench:context、3 subprocess、6 CLI）逐项精确吻合。

## Checklist 逐项核对

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | Benchmark 有效性 | ✅ | (a) 纯 pipeline 决策成本：`runContextPass` 5 pass 取平均（L103-124），决策路径纯函数、lineage=undefined 恒 HARD；(b) store materialization round-trip：`applyContextPass(store, sid, decision, 1)` 实测计时（L145-147），4 参 nowMs=1 与 pipeline.ts L322 签名一致，HARD→materializeM0 单行 UPDATE 真实落库。确定性：`buildSession(200)` 固定输入（固定 id/timestamp/usage=0）、固定 runtimeSessionId，unit 计数恒 400。tmpdir 隔离（mkdtempSync）、`store.close()` 后 `rmSync` 清理（L127-150）。**离线可运行**：仅 import 本地 src/context/*、src/contracts/context.js 与 `@earendil-works/pi-agent-core` 的纯类型（编译期擦除），零 fixture 依赖、零网络，接入 npm run check 即证明离线成立 |
| 2 | Benchmark 诚实性 | ✅ | 输出 JSON 含全部 7 个字段（turns/rawEntries/units/classification/decisionMsPerPass/materializeMs/m0BodyBytes/status），实测数字与 commit message "decision ~5ms/pass、materialize ~1.3ms" 一致。坏路径会大声失败：L144 `decision===undefined` 抛错；L152-154 m0 未持久化抛错；applyContextPass 对 missing lineage/materialize 失败均 throw；且 bench:context 以 `&&` 串入 check 链，任何 throw 直接拉红门禁 |
| 3 | Migration gate | ✅ | migration-smoke 证明空库初始化（first 应用 0001_bootstrap）+ 前向迁移幂等（second 零应用），脚本断言 `firstApplied.length===0` 与 `secondApplied.length!==0` 均抛错。注意：该 smoke 针对 runtime-epochs.db；context.db 的迁移幂等由 context-store.test.ts 的 empty-DB init（test 1）与 repeated-open 幂等（test 2）覆盖，两者都已接入 npm test 与 test:context-migrations |
| 4 | Newer-schema fence | ✅ | context-store.test.ts test "newer schema version fails closed (fence)"（L236-256）注入 `9999_newer` 到 schema_migrations 后断言 reopen 抛 `/newer than supported|fail closed/`，实测 ok（npm test #103 / context-migrations #9）。fence 逻辑（context-store.ts L227-247）未被 Feature 10 触碰，`LATEST_MIGRATION_VERSION="0001_bootstrap"` 未变。Feature 10 零 src/ 改动，未弱化 |
| 5 | Crash/failure gate | ✅（附注见 F2） | crash:check 7/7 实测通过：SIGKILL 后 reopen 断言 epoch 可读、单 active、Session 历史 head/entry 可读、无 synthetic assistant/ToolResult repair、无 invocation/result.db 工件。**精确事实**：crash-harness 覆盖 epoch + ingress/session 崩溃窗口，未直接写 context.db（crash-worker.ts 仅 import contracts/context.js 常量）；ContextStore 路径的 SIGKILL 一致性由 context-store.test.ts 末测试（#106/#12，child 写入 m0 后 SIGKILL → reopen 断言 m0 全有或全无）覆盖，已接入 npm test 与 test:context-migrations。R2 gate 总体覆盖 epoch+ingress+context 崩溃恢复 |
| 6 | "through v68" 规格项 | ✅（附注见 F1） | roadmap L124 "released schema migration fixtures through v68" 指 **authority（OpenCode Magic Context）的 schema 迁移区间**，04-pi-compat.md L77 将其列为契约对照项。Iris 的 context.db 是独立 session-scoped SQLite authority（0001_bootstrap），不消费 authority 的 schema 迁移文件。commit 声明 "migration fixtures through 0001_bootstrap with newer-schema fail-closed"——即 Iris 侧 fixture + 对新 schema 的 fail-closed 边界，**未宣称采纳 v68**；fence 使任何 authority-schema（含 v68）写出的 DB 被拒绝打开，静默采纳不可能发生。既有 feature-03 审查已把 fence 语义与 OpenCode `enforceSchemaFence` 对齐记录在案 |
| 7 | Benchmark 证据接入 | ✅ | `bench:context` 已接入 `npm run check` 链（package.json L32，位于 crash:check 之后 build 之前），实测在 check 内执行并输出 `status ok`。这是 provisional Session capacity limits 的首轮证据（200 turns/600 raw entries/400 units，决策 ~5ms/pass、materialize ~1.3ms、m0 5.7KB） |
| 8 | 无 Memory Mural | ✅ | Feature 10 仅改动 3 文件，grep `mural|experimental.mural` 在 package.json / context-bench-smoke.ts / context-parity-gate.test.ts 零命中。全仓 .ts 中仅 context-golden.test.ts（L46 `doesNotMatch(/mural/i)`）与 scripts/context-golden/generate.ts（L507 守卫）含该词，均为既有的 fixture 禁令守卫，非 payload 内容 |
| 9 | 测试接入 | ✅ | parity-gate 已在 npm test 文件列表（L20），实测为 #40–#44；bench:context 已在 npm run check（L32），实测执行 |
| 10 | 证据可复现 | ✅ | bench 独立跑 2 次 + check 内 1 次共 3 次：结构数字（200/600/400/HARD/5731）完全一致，计时波动正常。parity-gate 独立跑与 check 内跑均 5/5 |

## Findings

### F1（NON-BLOCKING，info）— "through v68" 边界值得一句显式文档化

R2 声明本身诚实：commit 未声称采纳 authority 的 v68 迁移，Iris 侧 fixture（0001_bootstrap）+ newer-schema fail-closed fence 已明确声明，且 fence 使任何 v68-schema DB 被拒开，不存在静默采纳路径。但仓库内没有任何一处**逐字**写清"roadmap 的 'released schema migration fixtures through v68' 属于 authority 的 schema；Iris 使用自己的 context.db 存储，不采纳 OpenCode 迁移文件"这一边界映射。建议在证据记录或 commit message 中补一行，把该 deliverable 的映射固化，避免后续轮次误读为缺口。

### F2（NON-BLOCKING，info）— ContextStore 崩溃路径不在 crash-harness 内，而在 context-store.test.ts

crash:check（crash-harness）覆盖 epoch + ingress/session 崩溃窗口，context.db 的 SIGKILL 一致性由 context-store.test.ts 末测试覆盖（已接入 npm test 与 test:context-migrations，实测通过）。R2 gate 整体覆盖 epoch+ingress+context 恢复，Feature 10 未弱化任何路径；但若要求"crash harness 本身覆盖 ContextStore"，当前是"测试套件覆盖、harness 未覆盖"的拆分。建议在 R3 将 context.db 边界纳入 crash-harness 或至少在证据中记录该拆分。

### F3（NON-BLOCKING，info）— parity ttl-idle 用例断言方向与 fixture 相反（如实声明）

第 5 个 parity 测试断言 pipeline **不**因 ttl 折叠（R2 未向 pipeline 喂入 lastResponseTime/cacheExpired 调用方信号），并断言 fixture 记录 rematerialized=true。测试内 NOTE 已如实说明"ttl 分类由 pass-taxonomy 层直接演练、pipeline 此处验证 absence→no-fold"。这是诚实的范围声明而非缺口。另 feature-02-golden-review 已记录 ttl fixture 内嵌 `Date.now()` 破坏 fixture 字节级确定性——该已知项随 fixture 沿用，不属于本 gate 引入。

### F4（NON-BLOCKING，info）— bench materialize 为冷写单测

materializeMs 只测 `applyContextPass` 的写路径（HARD 首 render 冷写），不含 open+migrate 开销；WAL/cold-cache 效应未消除。作为首轮 provisional 证据可接受（commit 声明"~1.3ms"与实测 1.245–1.342ms 一致），建议后续轮次记录 warm/cold 差异以支撑 capacity 更新。

## 结论块

VERDICT: PASS
SPEC COMPLIANCE: R2 Feature 10 gate 全部满足。parity-gate 5/5 以锁定 golden fixtures 端到端复现 authority 的 SOFT+/SOFT/HARD/empty-signal/ttl 语义；bench:context 提供首轮 capacity 证据并接入 check；commit 的 R2 声明（无 raw-message passthrough、rollover fresh lineage、migration fixtures through 0001_bootstrap + newer-schema fail-closed、Historian/Compartment/Publication 留 R3）与代码及实测一致。"released schema migration fixtures through v68" 属 authority 侧 schema 契约项（04-pi-compat.md L77），Iris 以自有存储 + fail-closed fence 兑现该 deliverable 的边界语义，未宣称也未静默采纳 v68（见 F1，仅建议显式记录一句）。
CODE CORRECTNESS: 被审 3 文件质量良好。context-bench-smoke.ts 确定性强（固定合成输入、5-pass 平均、tmpdir 隔离、close→rmSync 清理、m0 缺失抛错、decision 缺失抛错），applyContextPass 四参签名与 pipeline.ts 一致；parity-gate 使用真实 fixture expected 值断言且对 ttl 用例如实注明断言方向；package.json 的 check 链以 && 串接使任何 gate 失败即拉红。Feature 10 未触碰 src/，fence/migration/crash 代码未被弱化。
RECOVERY/CONCURRENCY: 未引入新持久状态、新后台任务或新并发面。崩溃恢复证据：crash:check 7/7（epoch+ingress/session）、context-store SIGKILL 测试（#106/#12）通过（context.db 可重开、m0 全有或全无）；migration:smoke 幂等；newer-schema fence 对 `9999_newer` 实测 fail closed。crash-harness 未直接覆盖 context.db（见 F2，覆盖在测试套件内且已接线）。
TEST COVERAGE: parity-gate 5/5 接入 npm test（实测 #40–#44）；context-store 12/12 接入 test:context-migrations（含 corrupt/fence/SIGKILL）；bench:context 接入 check。已知缺口：ttl 折叠在 pipeline 层的正路径（R2 未布线 lastResponseTime，如实注释）；crash harness 不覆盖 context.db（F2）。
EVIDENCE ACCURACY: commit message 数字与实测逐项吻合——npm test 197（195 pass + 2 live skip）精确一致；4 golden、12 migrations、migration:smoke idempotent、crash:check 7/7、bench:context 200/600/400/HARD（5.387–6.157ms / 1.245–1.342ms / 5731B）、3 subprocess、6 CLI、dist:smoke ok 全部真实复现；bench 结构数字 3 次运行一致（可复现）。无伪造、无虚报。
FINDINGS: F1（info）v68 边界建议补一行显式文档化（当前诚实但未逐字写明映射）；F2（info）ContextStore SIGKILL 覆盖在 context-store.test.ts 而非 crash-harness 内，建议 R3 记录或纳入 harness；F3（info）ttl parity 用例断言 absence→no-fold，范围声明诚实，ttl fixture 的 Date.now() 确定性已知项随 fixture 沿用；F4（info）bench materialize 为冷写单测，未消 WAL/cold-cache 效应，建议后续记录 warm/cold 差异。以上均不阻塞，**VERDICT: PASS**。
<!-- OMO_INTERNAL_INITIATOR -->
