# Feature 03 — Context 存储规格审查（R2 Feature 2: Context domain model + SQLite authority）

## 审查者角色

Context-storage spec reviewer（独立审查者，非实现者）。本审查聚焦 **SPEC + STATE-MACHINE 合规性**：以 Iris Notion 规格（`evidence/notion-round4/` 导出的 01-context-assembly、00-module-boundaries、02-magic-context、05-pi-capsule、07-roadmap）与 OpenCode v0.33.0 authority 语义（`mc-authority/magic-context` 的 storage-db.ts / migrations.ts）为基准，不复制其 schema。

## 审查基准（Reviewed Baseline）

- `a43256b` docs(evidence): record golden-fixture re-review PASS after F1 determinism fix

## 审查对象（Reviewed HEAD）

- `4cdf83d47e8d78ae7200c37ce7689f27470573af` feat(context): Context domain model + SQLite authority (R2 Feature 2)
- 工作树干净，无未提交改动。

## 审查文件

| 文件 | 用途 |
|---|---|
| `src/db/migrations/context/0001_bootstrap.sql` | context.db 权威 schema（context_lineages / context_deferred_operations / context_lkg_slots） |
| `src/context/context-store.ts` | ContextStore：fail-closed open、newer-schema fence、单行事务化 materialize、LKG/紧急态/延迟操作 API |
| `src/host/data-root.ts` | context.db migration 接线（initializeDataRoot） |
| `test/context-store.test.ts` | 12 个存储测试（含 SIGKILL 崩溃一致性） |
| `src/contracts/context.ts` / `src/contracts/runtime.ts` | 既有契约类型（ContextSourceSnapshot、PreparedContextSources、TransformMessagesInput 等） |
| `src/db/migrate.ts` | migrateDatabase（forward-only + 每文件 sha256 checksum） |
| `evidence/notion-round4/01-context-assembly.md` | Context Layers / ContextSourceSnapshot / Physical Layout / Pass Taxonomy / LKG / Failure & Emergency Policy |
| `evidence/notion-round4/00-module-boundaries.md` | Context 模块 ownership、上游兼容优先级、Core Invariant |
| `evidence/notion-round4/02-magic-context.md` | OpenCode 权威语义采纳范围（deferred signals、LKG、fail-closed） |
| `evidence/notion-round4/05-pi-capsule.md` | IRIS_CONTEXT_TRANSFORM_UNAVAILABLE vs IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED |
| `evidence/notion-round4/07-roadmap.md` | R2 Exit Gate |
| `C:\Users\15027\AppData\Local\Temp\opencode\mc-authority\magic-context\packages\plugin\src\features\magic-context\storage-db.ts` | OpenCode session_meta / m0_mutation_log / 部署 schema-fence（LATEST_SUPPORTED_VERSION、enforceSchemaFence、busy_timeout） |
| `C:\Users\15027\AppData\Local\Temp\opencode\mc-authority\magic-context\packages\plugin\src\features\magic-context\migrations.ts` | OpenCode 版本化迁移框架、deferred-signal（m0_mutation_log）语义 |
| `C:\Users\15027\AppData\Local\Temp\opencode\mc-authority\magic-context\packages\plugin\src\hooks\magic-context\lkg-replay.ts` | OpenCode LkgSlot 语义（anchor/inputIdSeq/model/provider 绑定、seam 验证） |

## 审查清单逐项核对

### 1. 所有 identity 与 watermark 是否包含 runtimeSessionId —— 合规

- `context_lineages`：`runtime_session_id TEXT PRIMARY KEY`，行级权威身份即 Session。ContextSourceSnapshot 各字段、materialization_id、m0/m1 状态、represented_through_entry_seq、protected_tail_start_entry_seq、last_safe_user_anchor_entry_seq、cleared_reasoning_through_tag、tool_reclaim_watermark、mutation_replay_watermark、deferred_signal_cursor、emergency_state 全部位于该 Session 行内。
- `context_deferred_operations`：`runtime_session_id TEXT NOT NULL` + `(runtime_session_id, seq)` 索引，会话内有序消费。`seq` 为全局 AUTOINCREMENT 主键 —— 与 OpenCode `m0_mutation_log(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL)` 的全局 id + session 列模式一致，不构成违规。
- `context_lkg_slots`：`PRIMARY KEY (runtime_session_id, slot_key)`，LKG slot 严格按 (session, slot) 隔离。
- 结论：符合规格 "所有 identity、水位和 mutation key 必须包含 runtimeSessionId"。

### 2. Rollover 后 fresh lineage，不继承旧状态 —— 合规

- 每个 Runtime Session 在 `context_lineages` 恰有唯一一行；新 Session 由 `createLineage` 新建，m0/m1 初始为 NULL、watermarks 显式初始 0（schema DEFAULT 0 兜底）、emergency_state 初始 'ok'。
- 测试 `separate runtime sessions keep fully isolated lineages (rollover)`（test 11）验证新 Session 不继承 A 的 m0、represented_through_entry_seq、LKG slot。
- deferred ops / LKG 均以 runtime_session_id 为键，天然隔离；replay 类 watermark（cleared_reasoning_through_tag / tool_reclaim_watermark / mutation_replay_watermark / deferred_signal_cursor）由构造保证从 0 起步。
- 结论：符合规格 "rollover 后建立 fresh lineage，不直接继承旧 Session 的 message IDs、m0/m1、LKG 或 mutation state"。

### 3. Schema 覆盖必需状态 —— 合规（含两处需后续 feature 补充的缺口）

| 规格要求 | Schema 落点 |
|---|---|
| ContextSourceSnapshot lineage | context_source_snapshot_id / epoch_id / persona_snapshot_id / declaration_version / continuity_seed_id / runtime_recovery_notice_id / stable_memory_pool_version / provider_profile_id / canonical_system_prompt / system_projection_hash / prepared_at |
| materialization identity | materialization_id |
| m0/m1 状态 | m0_body / m1_body / m0_content_hash / m1_content_hash / m0_materialized_at / m1_updated_at |
| represented watermarks | represented_through_entry_seq |
| protected-tail boundary | protected_tail_start_entry_seq / last_safe_user_anchor_entry_seq |
| deferred operations | context_deferred_operations（op_kind / op_payload / consumed_after_cursor） |
| mutation/reasoning/drop replay state | cleared_reasoning_through_tag / tool_reclaim_watermark / mutation_replay_watermark |
| LKG slots | context_lkg_slots（lkg_json / captured_at，bounded 每 (session, slot_key) 一行） |
| provider/serializer/carrier versions | provider_profile_id / context_serializer_version / carrier_schema_version / cached_m0_provider_profile_id |
| emergency/failure state | emergency_state（CHECK 三值）/ last_transform_error |

缺口（NON_BLOCKING，见 Findings F1/F8）：`CreateLineageInput` 未暴露 continuitySeedId / runtimeRecoveryNoticeId / stableMemoryPoolVersion（列存在、无写路径，R3 接 ContinuitySnapshot 时需扩展）；InvocationMemoryRecallProjection 与 QueryRecallDecision 持久化不在本 feature 范围（schema 为 forward-only，后续 migration 可追加）。

### 4. 不保存第二份原始 Pi 消息 —— 合规

- 三张表均无 transcript/message 副本：只存派生状态（m0/m1 物化载体字节、content hash、水位、版本、LKG 前缀 JSON、延迟操作负载）。
- `canonical_system_prompt` 是 prepareInvocationSources 产出的 P0 系统字节（派生/不可变投影），属 Context 合法 owned state，非 Pi 原文。
- 符合 00-module-boundaries："Context 不保存原始 Pi 消息，不追加普通消息" 与 05-pi-capsule："Iris 持久状态只能保存 Iris 领域事实或派生状态，不能复制 Pi 已经拥有的普通消息、tool result、phase、settled 或 pending write 状态"。

### 5. Fail-closed：newer-schema fence / storage unavailable / corrupt DB —— 合规

- newer-schema fence：`ContextStore.open` 在 migrateDatabase 之后检查 `schema_migrations` 的 lexicographic MAX(version)，不等于 `LATEST_MIGRATION_VERSION = "0001_bootstrap"` 即拒绝打开并 throw（test 9 以注入 `9999_newer` 验证）。语义与 OpenCode `enforceSchemaFence`（persistedVersion > LATEST_SUPPORTED_VERSION → refuse）一致。
- corrupt DB：`new DatabaseSync` + 首次 exec 抛错，open 的 catch 关闭句柄后重新 throw（test 8 以非 SQLite 文件验证）。
- storage unavailable：open/migration 失败沿 try/catch 上抛，无吞错路径（mkdirSync 的 catch 仅针对 "." 目录的恒可创建情形）。
- 结论：符合 02-magic-context / 07-roadmap 的 persistent-storage/schema-fence fail-closed。

### 6. 事务化 materialization —— 合规

- materializeM0 / materializeM1 均为**单条 UPDATE 语句**，SQLite 对单语句原子提交；m0+m1+hash+watermark+cached markers 在一次语句内整体更新，崩溃不可能留下"m0 已前进、m1 未同步"的中间态。
- lineage 缺失时 `result.changes !== 1` → throw（test 5 验证），fail-closed on missing lineage。
- SIGKILL 崩溃测试（test 12）：真实 child kill 后重开，m0 要么完整提交要么完全缺失，绝不部分。
- 结论：符合 "a failed write must never partially advance m0/m1"。

### 7. 与 OpenCode 语义对齐 —— 合规（允许适配，未删除已采纳特性）

- **m0 = stable baseline / m1 = volatile delta**：`m0_body` ↔ OpenCode `session_meta.cached_m0_bytes`，`m1_body` ↔ `cached_m1_bytes`；SOFT 只改 m1（test 4 验证 m0 byte-identical）、HARD 重建 m0+折叠 m1（test 3 验证整体持久化）。
- **HARD-bust markers**：`cached_m0_system_hash` / `cached_m0_model_key` / `cached_m0_provider_profile_id` ↔ OpenCode `cached_m0_system_hash` / `cached_m0_model_key` / `cached_m0_project_identity`。provider_profile_id 为 Iris 自有维度，属合法适配。
- **deferred-signal ordering**：`context_deferred_operations` + 每 Session 单调 `deferred_signal_cursor` ↔ OpenCode `m0_mutation_log`（bust pass 才消费的 deferred mutation）+ `pending_ops` 顺序语义；test 6 验证按 seq 有序、cursor 独立推进。
- **LKG slots**：`context_lkg_slots` 每 (session, slot_key) 一行、upsert 覆盖（test 7），承载 lkg_json；语义对应 OpenCode `lkg-replay.ts` 的 LkgSlot（runtimeSessionId + ordered logical-unit IDs + last safe anchor + model/provider binding + reshape fingerprint + tool/reasoning seam），验证逻辑由后续 replay feature 承载。
- **persistent mutation 确定性 replay**：mutation_replay_watermark / cleared_reasoning_through_tag 列在位，与 "persistent mutation 必须在每次 pass 确定性 replay" 对齐。
- 结论：规格 02-magic-context "不能因 Pi plugin 缺少某项能力就从 Iris 删除该能力" —— 未发现删除或简化已采纳特性。

### 8. Emergency 状态分类 —— 合规

- `emergency_state CHECK IN ('ok','transform_unavailable','emergency_fail_closed')` 精确映射 05-pi-capsule 双路径：
  - `transform_unavailable` ↔ ordinary context-hook fail-closed（无安全 LKG 时抛 IRIS_CONTEXT_TRANSFORM_UNAVAILABLE）；
  - `emergency_fail_closed` ↔ OpenCode emergency（抛 IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED，不发送 provider 请求）；
  - `ok` ↔ LKG 正常可用、current suffix 验证通过（不进入降级）。
- `last_transform_error` 持久化最近一次失败原因（test 10 验证持久化与回读）。

## 实际执行的测试与输出

### 1. `npx tsx --test test/context-store.test.ts`

```
# tests 12
# pass 12
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1422.6889
```
12/12 通过：empty-DB init、幂等重开、HARD/SOFT materialization durability、missing-lineage fail closed、deferred ordering、LKG upsert、corrupt DB fail closed、newer-schema fence、emergency persistence、rollover fresh lineage、SIGKILL crash consistency。

### 2. `npm run check`（完整门禁，全部通过）

| 阶段 | 结果 |
|---|---|
| format:check | PASS |
| lint | PASS |
| typecheck | PASS |
| npm test（单元） | 115 tests：113 pass / 2 skip（live provider 因 OPENCODE_GO_API_KEY 未设置而跳过，符合预期）/ 0 fail |
| test:context-golden | 4/4 PASS |
| test:context-migrations | 12/12 PASS |
| migration:smoke | idempotent（runtime-epochs.db 0001_bootstrap 首启、二次无新迁移） |
| crash:check | 7/7 boundaries 全部 ok |
| build + copy-migrations | PASS |
| test:subprocess | 3/3 PASS |
| test:cli | 6/6 PASS |
| dist:smoke | ok（epochDb/ingressDb 就绪） |

提交信息声称 "115 unit (113 pass, 2 live skip) + 4 golden + 12 context-migrations + 3 subprocess + 6 CLI" —— 与实际输出完全一致。

## 结论与 Findings

<results>
<files>
- D:\code\iris\src\db\migrations\context\0001_bootstrap.sql - context.db 权威 schema，三表覆盖 checklist 全部必需状态
- D:\code\iris\src\context\context-store.ts - ContextStore：fail-closed open、newer-schema fence、单语句事务化 materializeM0/M1、emergency/LKG/deferred API
- D:\code\iris\src\host\data-root.ts - context.db 迁移接线（initializeDataRoot 第 63 行）
- D:\code\iris\src\db\migrate.ts - forward-only + 每文件 sha256 checksum 迁移框架
- D:\code\iris\test\context-store.test.ts - 12 个存储测试（含真实 SIGKILL 崩溃一致性）
- D:\code\iris\src\contracts\context.ts - ContextSourceSnapshot 契约（CreateLineageInput 未覆盖其全部可选字段）
</files>

<answer>
审查结论：PASS。提交 4cdf83d 的 Context 存储权威实现满足 Notion 规格与 OpenCode v0.33.0 语义的全部 8 项检查：identity/watermark 全部按 runtimeSessionId 作用域化、rollover 建立 fresh lineage、schema 覆盖 ContextSourceSnapshot lineage / materialization identity / m0/m1 / represented watermarks / protected-tail / deferred ops / replay state / LKG slots / 版本 / emergency state、context.db 只存派生状态不存 Pi 原文、newer-schema fence 与 corrupt/storage 故障均 fail-closed、materialization 为单语句原子提交、m0/m1/HARD-bust markers/deferred-signal 顺序/LKG slot 与 OpenCode 语义对齐、emergency 三态精确映射 IRIS_CONTEXT_TRANSFORM_UNAVAILABLE 与 IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED。测试 12/12 通过，完整门禁 npm run check 全绿，提交声明的测试数量与实际输出一致（证据准确）。
</answer>

<next_steps>
按 findings 处理：F1 的 CreateLineageInput 扩展与 F8 的 recall projection 持久化属于后续 feature（R3/R2 其余交付），在对应 milestone 时补齐并新增 migration；F2–F7 为可选加固。无需阻塞。审查文档已写入 evidence/reviews/round4/feature-03-context-storage-spec-review.md，未修改任何源代码。
</next_steps>
</results>

VERDICT: PASS
SPEC COMPLIANCE: 通过。8 项检查全部合规；唯一偏差为 CreateLineageInput 写路径未覆盖 ContextSourceSnapshot 的 continuitySeedId/runtimeRecoveryNoticeId/stableMemoryPoolVersion（schema 列已存在，R3 需扩展），以及 InvocationMemoryRecallProjection/QueryRecallDecision 持久化留待后续 feature。
CODE CORRECTNESS: 通过。ContextStore.open 的 try/catch 资源安全（失败关闭句柄后 rethrow）；newer-schema fence 逻辑正确（对当前 4 位零填充版本命名成立）；materializeM0/M1 用 changes!==1 判空 fail-closed；LKG upsert 用 ON CONFLICT DO UPDATE。
RECOVERY/CONCURRENCY: 通过。WAL + 单语句原子写保证 SIGKILL 后可重开且 m0/m1 无部分态（真实 child kill 验证）；rollover 不继承旧 Session 状态。注意：未设置 busy_timeout（OpenCode authority 设为 5000ms），依赖单 Host + iris.lock 单写者约束，属可接受偏差（F2）。
TEST COVERAGE: 良好。12 个存储测试覆盖 init/幂等/durability/fail-closed/fence/emergency/rollover/crash；rollover 隔离测试未显式断言 deferred ops 与 replay watermark 隔离，但由构造（新行默认 0）保证（F7）。
EVIDENCE ACCURACY: 准确。提交声称的 "115 unit (113 pass, 2 live skip) + 4 golden + 12 context-migrations + 3 subprocess + 6 CLI" 与 npm run check 实测输出逐项一致；无虚构测试结果。
FINDINGS:
- F1 (NON_BLOCKING): CreateLineageInput 缺少 continuitySeedId / runtimeRecoveryNoticeId / stableMemoryPoolVersion，createLineage 硬编码 NULL；schema 列已就位，R3 ContinuitySnapshot 接入时需扩展输入并补契约测试。
- F2 (NON_BLOCKING): ContextStore.open 未设 `PRAGMA busy_timeout`（OpenCode authority 在 WAL 前设 5000ms）。单 Host + iris.lock 下单写者成立；若未来允许多进程访问 context.db，需补 busy_timeout 与并发冷启动测试。
- F3 (NON_BLOCKING): newer-schema fence 依赖版本字符串字典序；后续迁移文件必须保持等宽零填充前缀（0001、0002、…），建议在 0001 注释或迁移指南中固化该约定。
- F4 (NON_BLOCKING): context_deferred_operations.op_kind 为无约束 TEXT；OpenCode m0_mutation_log.mutation_type 有 CHECK 约束。Iris 的 op 域（publish/drop/reasoning/mutation）更宽，可接受，但建议在 schema 注释固化合法取值。
- F5 (NON_BLOCKING): deferred ops / LKG slots 未声明 FOREIGN KEY 指向 context_lineages；API 层有 lineage 存在性检查（enqueue 前置 getLineage），raw() 暴露下为 defense-in-depth 缺口，可选加固。
- F6 (NON_BLOCKING): setEmergencyState 不阻断 emergency_fail_closed 下的 materialize 写入；阻断逻辑属 transform 状态机（后续 feature）职责，存储层保持哑存储正确。
- F7 (NON_BLOCKING): rollover 隔离测试未覆盖 deferred ops / replay watermark 的跨 Session 隔离断言；由新行默认值构造保证，建议后续补充显式断言。
- F8 (NON_BLOCKING): InvocationMemoryRecallProjection（不可变持久化）与 QueryRecallDecision 持久化不在本 feature；01-context-assembly P4 Memory Boundary 与 Session Scope 要求其持久化，需在对应 R2/R3 交付时通过新增 migration 落地，勿在最终 parity 声明前遗漏。
