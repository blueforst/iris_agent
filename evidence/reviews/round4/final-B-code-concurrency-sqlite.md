# R2 Round 4 最终评审 B — Code / Concurrency / SQLite（final-B-code-concurrency-sqlite.md）

## Reviewer 角色

Reviewer B：代码 / 并发 / SQLite 专项评审员（FINAL 多路径评审之一，独立于实现者与其它 reviewer，非橡皮图章）。

## 评审范围

- 分支：`agent/r2-magic-context-parity` vs `main`（27 commits，71 files，+13079/-45）
- 评审对象 commit 区间：`main..HEAD`（HEAD = e2f7c25）
- 工作树状态：clean（评审全程未修改任何源代码；仅新增本证据文件）

## 评审文件

- `src/context/context-store.ts`（601 行）— ContextStore：open fail-closed、newer-schema fence、busy_timeout、WAL、单行 UPDATE 物化、水印、LKG upsert
- `src/context/projection.ts`（485 行）— P0–P5 逻辑单元投影（issue #6 身份保留）
- `src/context/protected-tail.ts`（389 行）— 保护尾 + 工具弧栅栏（authority 常量锁定）
- `src/context/replay.ts`（196 行）— REPLAY/DETECT 状态机
- `src/context/lkg.ts`（656 行）— LKG capture/replay fail-closed
- `src/context/carriers.ts`（170 行）— m0/m1 载体 + 规范 JSON 哈希
- `src/context/pipeline.ts`（462 行）— runContextPass / applyContextPass / renderProviderVisible
- `src/context/pass-taxonomy.ts`（186 行）— SOFT+/SOFT/HARD 决策
- `src/runtime/context-adapter.ts`（278 行）— findInputPairsByProjection（raw_adjacent / parent_chain）
- `src/runtime/session-projection.ts`（85 行）— 身份保留投影（rawIndex / entryId / parentId）
- `src/runtime/pi-runtime-adapter.ts`（253 行）— resolveCommittedPair（issue #6 settle 路径）
- `src/host/host.ts`（1268+ 行）— reconcileUncommitted、单写者 pump、启动/关停资源纪律
- `src/db/migrate.ts`（78 行）— 前向迁移 + per-file checksum + BEGIN/COMMIT/ROLLBACK
- `src/db/migrations/context/0001_bootstrap.sql`（101 行）— context_lineages / context_deferred_operations / context_lkg_slots
- `src/host/data-root.ts` — initializeDataRoot 接入 context.db 迁移
- `src/contracts/context.ts`、`tsconfig.json`（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
- 测试：test/context-store.test.ts（12）、test/context-pipeline.test.ts（7）、test/reconcile-raw-identity.test.ts（14）、test/context-replay/lkg/projection/protected-tail/pass-taxonomy/carriers/parity-gate/golden
- 既有审查证据：evidence/reviews/round4/*.md（17 份，逐一核对 PASS 声明）

## 证据核对（既有 round4 审查记录的 PASS 声明）

- 全部 17 份审查记录结论：feature-01（issue-6）A/B 复审 PASS、feature-02 golden 复审 PASS、feature-03 storage 双审 PASS、feature-04 projection PASS、feature-05 carrier PASS、feature-06 taxonomy PASS（复审）、feature-07 protected-tail 双审 NON_BLOCKING（复审后 PASS）、feature-08 lkg 双审 NON_BLOCKING（F5 修复后复审 PASS）、feature-09 replay 复审 PASS（F1 BLOCKING 已由 353c702/e3591c8 关闭）、feature-10 host code/spec PASS（原 F1/F2 BLOCKING 已由 bdcc8bd 修复）、feature-11 parity/benchmark gate PASS。
- 交叉验证：feature-10 指出的 deriveTokenTarget 平行公式缺陷（缺 ABS_CAP 钳制）已在 bdcc8bd 的 diff 中确认改为复用 `deriveProtectedTailTokenTarget`；其 F3（3 处 `as unknown as AgentMessage`）与 F4（live-tail 注释不一致）在 HEAD 仍在（见本评审 Findings）。feature-03 的 F2（无 busy_timeout）已在 context-store.ts:220 修复为 `PRAGMA busy_timeout = 5000`。feature-09 的 F1（测试未接入 npm test）已修复，npm test 显式列表现含全部 context 测试文件。
- 所有「BLOCKING」均已关闭，无遗留 BLOCKING 项。

## 执行的验证命令与真实输出

### 1) `npx eslint src test scripts` — clean（零输出，EXIT 0）

### 2) `npx tsc --noEmit` — clean（零输出，EXIT 0）

### 3) `npm run check`（完整 gate，全部步骤真实执行）

- format:check：`All matched files use Prettier code style!`
- lint：clean；typecheck：clean
- npm test：`1..198 / # tests 198 / # pass 196 / # fail 0 / # skipped 2`（2 skip = OPENCODE_GO_API_KEY 未设置的 live provider 用例）
  - 含 context-store 12、context-pipeline 7（含 bdcc8bd 新增的「pass 2 identical → SOFT+ reuse」端到端回归）、context-replay 7、context-lkg 17、protected-tail 12、projection、pass-taxonomy、parity-gate 5、reconcile-raw-identity 14（含 settle 路径 #178）
- test:context-golden：4/4 pass
- test:context-migrations：12/12 pass（含 corrupt DB fail closed、newer-schema fence、SIGKILL crash）
- migration:smoke：`"status": "idempotent"`（firstApplied [0001_bootstrap]，secondApplied []）
- crash:check：7/7 boundaries ok
- bench:context：`200/600/400/HARD/6.363ms/1.377ms/5731B/status ok`
- build（tsc -p tsconfig.build.json + copy-migrations）成功
- test:subprocess：3/3 pass；test:cli：6/6 pass
- dist:smoke：`{"status":"ok","epochDb":true,"ingressDb":true}`

### 4) `npx tsx --test test/context-store.test.ts` — 12/12 PASS

`1..12 / # pass 12 / # fail 0 / # skipped 0 / duration_ms 1548.66`
含：空库初始化、重复 open 幂等（schema_migrations count=1）、m0+m1 原子物化持久化、SOFT 只动 m1、missing lineage fail closed、deferred 顺序、LKG upsert、corrupt DB fail closed（3.5ms）、newer schema fence（9999_newer 注入）、emergency 持久化、rollover 隔离、SIGKILL 子进程真实 kill 后 reopen 一致（m0 全有或全无，823ms）。

## 检查清单逐项结论

### 1. SQLite 正确性 — PASS
- WAL：ContextStore.open（:221）与 migrateDatabase（migrate.ts:15）均 `PRAGMA journal_mode = WAL`；foreign_keys=ON 两处均设。
- busy_timeout：ContextStore.open 在 WAL 之前设 `PRAGMA busy_timeout = 5000`（:220）。**migrateDatabase 自开连接未设 busy_timeout**（见 Findings F2）。
- 单行事务：materializeM0（单条 UPDATE 同时写 m0/m1/content hash/represented/水位，:382-418）、materializeM1（:421-444）、persistWatermarks（:468-494）、setEmergencyState（:446-461）全部为单条 UPDATE + `result.changes !== 1` 抛错。SQLite 语句级原子性保证不可能出现「m0 前进而 m1 陈旧」的可见中间态。
- ON CONFLICT upsert：captureLkgSlot 用 `ON CONFLICT (runtime_session_id, slot_key) DO UPDATE`（:556-561），changes===0 抛错。
- 无多行非原子序列破坏不变量：唯一跨语句序列是 applyContextPass 的（materialize → persistWatermarks），崩溃窗口自愈（见并发节）。deferred 的（INSERT op → 推进 cursor）两语句非原子（见 Findings F3）。
- 全部 SQL 走 prepared statement + `?` 绑定；无字符串拼接注入面。

### 2. 并发 — PASS
- Host pump 单写者：pumpLoop 逐条消费 FIFO（host.ts:385-405），Coordinator 闩锁拒绝并发 prompt（runtime-coordinator 测试「rejects a second prompt while an invocation is active」通过）；data-root 排他锁全程持有，第二 Host fail-fast（host.test.ts「second host fails fast」+ subprocess 测试 2 通过）。
- ContextStore 无第二写者：R2 生产路径仅 initializeDataRoot 对 context.db 执行迁移（data-root.ts:63），无任何生产代码实例化 ContextStore 或调用 applyContextPass（grep src/ 零命中，仅测试引用）；ContextStore 仅在测试内使用独立 tmpdir，互不干扰。单进程内模块级无可变共享状态。
- 崩溃恢复：SIGKILL 真实子进程测试（context-store.test.ts:312-408，spawn + marker + kill）证明已提交数据在 WAL 下可重开且 m0 全有或全无；水印崩溃窗口（materialize 已提交、persistWatermarks 未提交）自愈：runReplay 的 `continue` 守卫（replay.ts:104）保证 DETECT 只报告 endSeq > 当前水印的弧，下一 cache-busting pass 重检测同一批弧并写严格更大的水印，m0/m1 与水印最终一致。
- 失败路径 fail-closed 而非损坏：物化/水印/emergency 写入失败均抛错，`failStop` 语义使 rollover 故障仅可重启恢复（host.ts）。

### 3. 确定性 — PASS
- runContextPass 决策路径纯函数：grep src/context 的 Date.now/Math.random/performance.now/hrtime 仅命中（a）lkg.ts:415 `args.capturedAt ?? Date.now()`（captureLkgSlot，R2 无生产调用点）；（b）carriers.ts:163 `lineage.m0MaterializedAt ?? Date.now()`（buildCarriersFromLineage，R2 无生产调用点）——两者均不在决策路径，且不参与内容哈希（canonicalCarrierJson 不含 timestamp）。物化时间戳由调用方 `nowMs` 注入（pipeline.ts applyContextPass），决策层零时间源。
- projection/replay/protected-tail/pass-taxonomy 均纯：sha256 + 固定键序 JSON.stringify；canonicalCarrierJson 排序键保证字节级稳定；projectionHash 对有序 unit id+hash 取哈希。
- 跨运行验证：bench:context 结构数字（200/600/400/HARD/5731B）3 次一致；golden fixtures（authority v0.33.0 锁定，含 m0/m1 byte-identical 断言）4/4；parity-gate 5/5。

### 4. 类型安全 — PASS
- tsconfig：`strict` + `noUncheckedIndexedAccess: true` + `exactOptionalPropertyTypes: true` + `noImplicitOverride` + `noFallthroughCasesInSwitch` 已核实。
- grep src/context：`as number`、非空断言 `!`、`@ts-ignore`、`@ts-nocheck`、`@ts-expect-error` 零命中。
- 下标访问：projection.ts:225/:420 均 `!== undefined` 守卫；pipeline 用 for...of/filter；harness-factory.ts:158 的 `entries[index]` 为 raw 数组直接倒扫 + entry.type/role 校验后取真实 entry.id（合法直接遍历，非「压缩下标→raw 下标」映射，前轮已核实）。
- 已知类型逃逸：renderProviderVisible 3 处 `as unknown as AgentMessage`（前轮 F3，维持 NON_BLOCKING，纯类型卫生问题，tsc clean）。

### 5. Fail-closed — PASS
- newer-schema DB 拒绝打开：fence（context-store.ts:227-247）在 migrateDatabase 后查 schema_migrations MAX(version)，非 LATEST 则取有序末行，`last !== LATEST` 时 close + throw「refusing to open (fail closed)」；测试 9 注入 9999_newer 实测抛 `/newer than supported|fail closed/`。fence 前先 close 再 throw，外层 catch 双重 close 有守卫。
- 缺失 lineage 物化抛错：materializeM0/M1、persistWatermarks、setEmergencyState、enqueueDeferred 全部 `changes !== 1` 抛错（测试 5 通过）。**例外：setDeferredSignalCursor 不校验 changes**（见 Findings F1）。
- LKG 失效 reshape 失败为类型化错误：replayLkg 对 model/provider 不匹配 → lkg_model_mismatch；id 序列移位 → lkg_invalidated_reshape；内容变更 → lkg_content_mismatch；seam/形状损坏 → lkg_seam_invalid / lkg_unsafe_seam / lkg_anthropic_reasoning_run_invalid（测试 26-39 全过，含 F5「corrupt payload shape」不抛 TypeError）。
- emergency 升级：setEmergencyState 持久化 emergency_state（DB CHECK 约束 'ok'/'transform_unavailable'/'emergency_fail_closed'）；applyContextPass 的 failClosed 分支映射 setEmergencyState（R2 恒 "none"，前轮已文档化为 R3 布线，store 层测试 10 覆盖持久化与重读）。

### 6. Issue #6 修复正确性 — PASS
- 身份保留端到端：projectSessionMessages（rawIndex/entryId/parentId 直接来自原始 SessionTreeEntry）→ findInputPairsByProjection（raw_adjacent=rawIndex+1 或 parent_chain=parentId===user.entryId）→ reconcileUncommitted（pi_user_entry_id = pair.user.entryId，host.ts:1217-1222）→ resolveCommittedPair（pi-runtime-adapter.ts:95-111，与 reconcile 共用同一投影）→ markSessionCommitted。两个 pi_user_entry_id 写入方共享「恒为真实 raw UserMessage entry id」不变量。
- 回归测试 #178（settle 路径 + model_change 前置 + 原始 entry 复核）：旧代码必失败，实测通过；#9（reconcile 路径 pi_user_entry_id 精确断言）、#5/#6（label 间隔/断链 fail-closed）、#12（错序 fail-closed）全过。
- 无 filtered-array 索引推断：grep `messages.indexOf`、`entries[.*index]`、`.map().filter()` 后映射仅剩上述合法直接遍历；压缩数组路径 findInputPairs 仅被 transformContextMessages 使用（不写 entry id，与 issue #6 无关）。

### 7. 资源管理 — PASS
- 全部 context 测试用 mkdtempSync 独立目录，finally 内先 `store.close()` 再 `rmSync(dirname, {recursive, force})`（context-store/pipeline/lkg/carriers 测试已核实）；SIGKILL 测试父进程在 reopen.close() 后 rmSync。
- ContextStore.open 失败路径全回收：构造失败无句柄泄漏；exec/migrate/fence 失败进 catch close；fence 先 close 再 throw 无双关闭。
- migrateDatabase 自带 finally close；198 项测试连续 open/close 无句柄堆积（全部通过）。
- 崩溃窗口重开干净：SIGKILL 后 reopen 可读、watermark/m0 一致（测试 12 实测）。

### 8. 分支构建与 commit 声明 — PASS
- 27 commits 与任务描述精确一致；工作树 clean。
- bdcc8bd（pipeline F1/F2 BLOCKING 修复）diff 已核实：representedThroughEntrySeq 由 headEndEntrySeq 改为 projection.toEntrySeq；cachedM0* 由 lineage 值改为当前 pass 身份；deriveTokenTarget 复用 authority 版。其 commit 声称「full check 198 (196 pass + 2 live skip)」与本评审实测精确一致。
- commit 数字全部吻合：npm test 198、golden 4、migrations 12、smoke idempotent、crash 7、bench ok、subprocess 3、CLI 6、dist ok。
- 观察（非缺陷）：R2 生产代码未实例化 ContextStore / 未调用 runContextPass（context hook 未接线，属文档化 R3 布线范围；feature-10-host-spec-review 已 PASS）。「Host product-path Context pipeline」应读作「产品路径就绪的决策管线（R3 接线）」。

## Findings

- F1（NON_BLOCKING，minor）`setDeferredSignalCursor`（context-store.ts:544-551）不校验 `result.changes !== 1`，缺失 lineage 时静默 no-op，与其姊妹单行更新（全部 fail closed）不一致。R2 无生产调用点，建议 R3 统一。
- F2（NON_BLOCKING，加固）`migrateDatabase` 自开的第二个连接未设 `PRAGMA busy_timeout`（migrate.ts:15-16 仅 WAL + foreign_keys）。ContextStore.open 的连接已设 5000ms，且生产单写者由 Host 排他锁保证，风险可接受；仅诊断工具绕锁场景缺等待语义。
- F3（NON_BLOCKING，R3 布线关注）`enqueueDeferredOperation`（INSERT op）与 `setDeferredSignalCursor`（推进 cursor）非同一事务；其间崩溃会在旧 cursor 上重放已入队 op。R2 无生产调用点，但 R3 接线时必须保证 op 执行幂等或把「入队+cursor 推进」做成单事务。
- F4（NON_BLOCKING，doc）renderProviderVisible 注释「strictly after the protected tail start」与实现门 `>=` 不一致（前轮 F4，未修复）；语义正确（边界单位受保护），仅注释精度。
- F5（NON_BLOCKING，doc）classifyAction 的 HARD 分支为占位返回（representedThrough:0 + 空 cached 身份），立即被 runContextPass 的真实 HARD 构造替换，不可观测；注释已说明，建议删除占位以避免漂移。
- F6（NON_BLOCKING，覆盖缺口，前轮已承认）SIGKILL 测试的 marker 在物化提交之后写入，未直接制造 mid-write 崩溃；「never partial」在该时序下恒真。原子性依赖 SQLite 单语句事务保证，属可接受缺口。
- 前轮遗留 NON_BLOCKING 项确认仍在：renderProviderVisible 3 处 `as unknown as AgentMessage`；replayHash 不含 mutationReplayWatermark（无决策影响）；parity modelKey 斜杠/冒号格式映射未显式文档化；bench 为冷写单测未消 WAL/cold-cache 效应。全部可接受。

## 结论块（固定格式）

VERDICT: PASS
CODE CORRECTNESS: 全部物化/水印/emergency 写为单条 UPDATE + changes!==1 抛错（fail closed），LKG upsert 用 ON CONFLICT；无 SQL 注入面；决策路径纯函数、哈希确定（sha256 + 排序键规范 JSON）；noUncheckedIndexedAccess/exactOptionalPropertyTypes 全程遵守，src/context 零 `as number`/非空断言/@ts-ignore；issue #6 的两个 pi_user_entry_id 写入方共享 raw-entry 投影不变量并有回归测试。#6 验证全绿。唯一瑕疵为 setDeferredSignalCursor 不校验 changes（F1）与 3 处 `as unknown as AgentMessage` 类型逃逸（F4 前轮，均 NON_BLOCKING）。
CONCURRENCY: Host pump 单写者（Coordinator 闩锁 + data-root 排他锁，第二进程 fail-fast 实测）；ContextStore 在 R2 无第二写者（仅测试实例化）；水印崩溃窗口自愈（replay continue 守卫保证重检测严格更大）；SIGKILL 真实子进程测试通过（已提交数据可重开、m0 全有或全无）；rollover 故障 fail-stop 仅可重启恢复。
SQLITE INTEGRITY: WAL 双连接一致、busy_timeout=5000 已落地（前轮 F2 已修复）；m0/m1 单语句原子；newer-schema fence 对 9999_newer 实测 fail closed（测试 9）；corrupt DB fail closed（测试 8）；迁移幂等（schema_migrations count=1，migration:smoke idempotent）。migrateDatabase 连接缺 busy_timeout 为纵深防御缺口（F2）。
TYPE SAFETY: strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes 已核实且 tsc --noEmit clean；下标访问全部守卫；唯一类型逃逸为 renderProviderVisible 的 3 处双断言（NON_BLOCKING）。
FAIL-CLOSED: 更新 schema 拒开；缺 lineage 物化抛错（setDeferredSignalCursor 例外，F1）；LKG 失效全类型化错误（reshape/model/content/seam/anthropic 六类）；emergency 状态持久化 + CHECK 约束；缺 lineage/deferred 路径均 throw。R2 生产路径未接线 context 事件属文档化 R3 边界（spec 双审 PASS）。
FINDINGS: F1 setDeferredSignalCursor 不校验 changes（minor）；F2 migrateDatabase 连接缺 busy_timeout（加固）；F3 deferred 入队+cursor 推进非原子（R3 布线关注）；F4 live-tail 注释与实现门不一致（doc）；F5 classifyAction HARD 占位可移除（doc）；F6 SIGKILL 未覆盖 mid-write（已承认缺口）；前轮遗留 NON_BLOCKING 项全部确认可接受。无 BLOCKING 项，4 个 reviewer 维度中本维度结论为 PASS。

<!-- OMO_INTERNAL_INITIATOR -->
