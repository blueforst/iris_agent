# R2 Feature 2 — Context 领域模型 + SQLite 权威存储：代码审查报告

（SQLite / 崩溃恢复 / 并发 专项审查。独立 reviewer，非实现者。）

## 审查信息

| 项目 | 值 |
| --- | --- |
| Reviewer 角色 | SQLite / crash / concurrency reviewer（独立审查） |
| Reviewed baseline | `a43256b`（docs(evidence): record golden-fixture re-review PASS after F1 determinism fix） |
| Reviewed HEAD | `4cdf83d47e8d78ae7200c37ce7689f27470573af`（feat(context): Context domain model + SQLite authority (R2 Feature 2)） |
| 审查日期 | 2026-08-03 |
| 工作树状态 | clean（审查过程未修改任何源代码） |

## 审查文件

- `src/context/context-store.ts`（563 行）— ContextStore：open/fence/migrations、materializeM0/M1、deferred、LKG、emergency
- `src/db/migrations/context/0001_bootstrap.sql`（101 行）— context_lineages / context_deferred_operations / context_lkg_slots
- `src/db/migrate.ts`（78 行）— 共享 migration runner（checksum + forward-only + BEGIN/COMMIT/ROLLBACK）
- `test/context-store.test.ts`（409 行，12 个测试）
- `src/host/data-root.ts`（context.db 接入 initializeDataRoot）
- `package.json`（`test:context-migrations` 与 `check` 接线）
- `scripts/copy-migrations.mjs`、`tsconfig.build.json`（dist 构建时拷贝 .sql）

## 执行的测试与真实输出

### 1) `npx tsx --test test/context-store.test.ts` — 12/12 通过

```
# tests 12
# pass 12
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1466.4761
```

12 项全部 ok，含 corrupt DB（3.26ms）、newer schema fence、SIGKILL（762ms）。

### 2) `npx tsx --test --test-name-pattern "SIGKILL" test/context-store.test.ts` — 1/1 通过

```
# pass 1
# fail 0
# duration_ms 1334.3564
```

SIGKILL 测试隔离运行通过（真实子进程被 SIGKILL，见检查项 5）。

### 3) `npm run check`（完整 gate）— 全部通过

| 步骤 | 结果 |
| --- | --- |
| format:check | All matched files use Prettier code style! |
| lint (eslint) | 通过（无输出） |
| typecheck (tsc --noEmit) | 通过（无输出） |
| npm test | 115 tests：113 pass，2 skip（OPENCODE_GO_API_KEY 未设置，live 跳过），0 fail |
| test:context-golden | 4/4 pass |
| test:context-migrations | 12/12 pass |
| migration:smoke | idempotent（firstApplied 1，secondApplied 0） |
| crash:check | 7 个 boundary 全部 ok |
| build | tsc + copy-migrations.mjs 成功 |
| test:subprocess | 3/3 pass（含 second Host 被锁拒绝） |
| test:cli | 6/6 pass |
| dist:smoke | {"status":"ok","epochDb":true,"ingressDb":true} |

## 10 项检查清单逐项结论

### 1. SQLite 正确性 — PASS
- WAL：`ContextStore.open` 第 216 行与 `migrateDatabase` 第 15 行均执行 `PRAGMA journal_mode = WAL`（WAL 模式持久于 DB 文件，双方一致）。
- `foreign_keys = ON`：两处均设置（context-store.ts:217、migrate.ts:16）。该 pragma 为连接级，两个连接都显式设置；当前 schema 尚无 FOREIGN KEY 约束，属前瞻性设置。
- 参数绑定：ContextStore 全部 SQL 均为 `db.prepare(...)` + `?` 占位符 + 绑定参数；SQL 中唯一拼接的是静态列名列表与迁移文件名（来自文件系统，非用户输入）。未发现任何通过字符串插值注入用户值/标识符的路径。`migrateDatabase` 同样全部走 prepared statement。
- 结论：无 SQL 注入面，绑定方式正确。

### 2. 事务原子性 — PASS
- `materializeM0`（377-413 行）与 `materializeM1`（416-439 行）均为**单条 UPDATE 语句**。SQLite 保证语句级原子性（WAL 下由 journal 实现崩溃回滚），m0/m1 在同一条语句内同时更新，不可能出现「m0 已前进而 m1 陈旧」的可见状态。
- 缺失 lineage 时 `result.changes !== 1` 抛出（408、434 行），测试 5「materialization on a missing lineage fails closed」通过。`changes` 在 WHERE 无匹配行为 0，判定可靠。
- 测试 3（HARD 后 reopen 验证 m0/m1/represented 水印持久）与测试 4（SOFT 只动 m1、m0 字节不变）验证了语义正确。

### 3. Newer-schema fence — PASS
- fence 位于 `open()` 222-242 行：`SELECT MAX(version) FROM schema_migrations`，当 `maxVersion !== LATEST_MIGRATION_VERSION` 时再取排序后最后一行，若 `last !== LATEST` 则 `db.close()` 并 throw（fail closed）。
- 测试 9 插入 `'9999_newer'` 后断言 reopen 抛 `/newer than supported|fail closed/` — 通过，证明存在更新版本行时确实拒绝打开。
- 空库/相等情形：fresh DB 经 `migrateDatabase` 应用 0001 后 max === LATEST，fence 放行（测试 1、2 覆盖）；不存在「零行 applied 却带新版本」的中间态。fence 在 migrateDatabase 之后执行，checksum 漂移与更新 schema 两路都 fail closed。
- 边界：fence 分支内先 `db.close()` 再 throw，外层 catch（244-251 行）再次 close 已被 try/catch 包裹，无双关闭异常。

### 4. Corrupt DB fail closed — PASS
- 测试 8：写入非 SQLite 文本文件后 `assert.throws(() => ContextStore.open(path))` — 3.26ms 通过。`new DatabaseSync(path)` 打开非 SQLite 文件时报 SQLITE_NOTADB（`file is not a database`）；构造函数位于 try 之外（214 行），构造失败不会产生泄漏句柄。
- open() 的捕获路径（244-251 行）对后续步骤失败执行 `db.close()`，无资源泄漏。

### 5. SIGKILL 崩溃测试 — PASS（真实崩溃测试，含覆盖范围说明）
- **是真实测试，非 mock**：spawn 真实子进程 `node <tsx cli.mjs> <child.mjs> <db> <marker>`，子进程导入真实 ContextStore（TS 经 tsx），执行 createLineage + materializeM0 后写 marker，再 park 30s；父进程轮询 marker（15s 超时）后 `child.kill("SIGKILL")`，300ms 后 reopen 并断言 lineage 可读、m0 要么 `null` 要么 `"m0-after-crash"`（一致时连带校验 m1 与 entrySeq）。隔离运行通过（1026ms）。
- WAL 一致性：SIGKILL（进程被杀、OS 页缓存仍在）时 WAL 中已提交事务可恢复，reopen 触发 WAL 回放后数据完整——该测试证明此路径成立。
- **覆盖范围说明**：marker 在 materializeM0 **返回之后**写入，因此 kill 发生在所有写入提交之后，测试验证的是「已提交数据崩溃后不丢、可恢复」，并未直接制造「写入进行中被 kill」的半提交场景。原子性本身由 SQLite 单语句事务保证（推论成立），但该测试不直接命中 mid-write。属非阻塞覆盖缺口（FINDINGS-F1）。

### 6. Repeated open 幂等 — PASS
- 测试 2：第二次 `ContextStore.open(path)` 后查询 `schema_migrations` count === 1 — 通过。`migrateDatabase`（migrate.ts 30-55 行）用 applied map 跳过已应用版本，仅在 checksum 非空且漂移时抛错。
- migration:smoke 亦验证二次运行 `appliedVersions` 为空（idempotent）。

### 7. 并发 — PASS（单进程内无共享可变状态；多进程由 Host 排他锁兜底）
- 进程内：ContextStore 所有状态为实例字段（`db`、`closed`），模块级仅有 const `LATEST_MIGRATION_VERSION` 与纯函数。**无任何模块级可变共享状态**，单进程内多实例互不干扰。
- 多进程：WAL 单写者；Host 在 `initializeDataRoot` 之前通过 proper-lockfile 获取排他 data-root 锁（host.ts:819 → 827，`os_exclusive_fail_fast`）。测试 30「second host fails fast (lock held)」与 subprocess 测试 2 均验证第二进程被锁拒绝。context.db 由单进程 Host 独占，安全。
- 说明：`ContextStore.open` 本身不取锁（锁属 Host 职责）。绕过锁直接多进程打开 context.db 的工具（如未来诊断脚本）会立即 SQLITE_BUSY，因连接未设置 `busy_timeout`（FINDINGS-F2）。

### 8. close() 幂等 / 双关闭安全 — PASS
- `close()`（254-260 行）以 `closed` 标志守卫，第二次调用直接返回。测试 1/3/7/10 均出现 close 后 reopen 再 close 的模式，未报错。
- `open()` 的 catch 路径对已关闭连接再次 close 有 try/catch 保护（244-249 行）；fence 抛错路径（236 行先 close 再 throw）不会二次 close 异常。

### 9. 资源管理 — PASS
- `new DatabaseSync(contextDbPath)`（214 行）位于 try 之前：构造失败（corrupt）时无句柄泄漏；构造成功后的所有失败路径（exec、migrateDatabase、fence）均进入 catch 并 close（244-251 行）。
- `migrateDatabase` 内部自带 `finally { db.close(); }`（migrate.ts 71-73 行），与 ContextStore.open 持有的连接为同一文件的第二个连接，两者均正确关闭。
- corrupt 路径与 fence 路径均无句柄泄漏（多轮测试进程内无堆积）。

### 10. Migration 目录解析（src/ 与 dist/ 双路径）— PASS
- src/（tsx）：`migrationsDirFor`（context-store.ts 558-563 行）用 `fileURLToPath(new URL("../db/migrations/context", import.meta.url))`，从 `src/context/` 解析到 `src/db/migrations/context` — 12 个测试全部在 tsx 下通过即证明。
- dist/（构建）：`scripts/copy-migrations.mjs` 将 `src/db/migrations` 整体拷贝至 `dist/db/migrations`（已在 dist 下确认存在 `context/0001_bootstrap.sql` 与编译产物 `context/context-store.js`）；dist 下 `../db/migrations/context` 解析路径与 data-root.ts 的 `../db/migrations` 模式结构一致，而后者已被 dist:smoke 证明在 dist 下工作。
- Windows 路径：`fileURLToPath` 对 `file:///D:/code/iris/...` 正确转换为 `D:\code\iris\...`，`readdirSync` 正常。npm run check 的 build + dist:smoke 全链路通过。

## 发现（Findings）

- **F1（非阻塞，测试覆盖）**：SIGKILL 测试在 marker 写入（所有写入已提交）之后才 kill，实际验证「已提交数据的 WAL 崩溃恢复」；「never partial」断言在该时序下恒真。真正的 mid-write 崩溃原子性未被直接制造，依赖 SQLite 单语句事务保证。建议后续补一个在跨行事务（如 deferred 入队 + cursor 推进）中途 kill 的用例。
- **F2（非阻塞，加固建议）**：两处连接均未设置 `PRAGMA busy_timeout`。多进程绕过 Host 锁直接访问 context.db 时会立即 SQLITE_BUSY 而非等待。当前由 proper-lockfile 排他锁保证单写者，风险可接受。
- **F3（非阻塞，消息精度）**：fence 错误消息统一为 "newer than supported"，但触发条件实际是 `MAX(version) !== LATEST`（理论上也覆盖字典序更小的异常状态）。因 migrateDatabase 会在 fence 前补齐缺失版本，实践中只有「更新版本」能到达该分支，失真概率极低；建议改为 "mismatched schema" 更精确。
- **F4（非阻塞，观察）**：`ContextStore.open` 每次 open 都会再跑 `migrateDatabase`（对同一文件开第二个连接）。正确但略冗余；好处是每次 open 都重新校验既有迁移 checksum（防篡改）。
- **F5（非阻塞，观察）**：`raw()` 暴露的 DatabaseSync 在 `close()` 之后继续使用会抛「database is not open」。属 fail-loud 行为，无静默损坏风险，未加守卫属可接受设计。

## 结论块

VERDICT: PASS

SPEC COMPLIANCE:
- context_lineages / context_deferred_operations / context_lkg_slots 与 R2 规格要点一致：每条身份与水位均按 runtime_session_id 作用域；rollover 生成全新 lineage、不继承旧会话状态（测试 11 验证）；context.db 不存原始 Pi 消息副本（仅派生状态）；forward-only + per-file checksum 迁移；newer-schema fail closed。与 commit message 声明逐条相符。
- Host 接线正确：`initializeDataRoot` 对 context.db 执行迁移（data-root.ts:63）；`npm run check` 已纳入 `test:context-migrations`。

CODE CORRECTNESS:
- 全部 SQL 走 prepared statement，无注入面；m0/m1 为单语句原子写 + `changes !== 1` 缺失行 fail closed；fence 对 `9999_newer` 真实 fail closed，空库与相等情形放行；close() 幂等、open 失败路径句柄回收正确；src/dist 双路径 migration 解析均验证成立。

RECOVERY/CONCURRENCY:
- WAL + 单语句事务保证崩溃一致性；真实 SIGKILL 子进程测试通过并验证已提交数据可恢复；单进程内无共享可变状态；多进程由 Host proper-lockfile 排他锁兜底（host.ts:819，测试 30 与 subprocess 测试 2 验证锁拒绝）。

TEST COVERAGE:
- 12/12 context 测试通过（含 corrupt、fence、SIGKILL 隔离运行）；npm run check 全链路通过（115 单测 113 pass/2 有据跳过、4 golden、12 context、migration:smoke idempotent、7 crash boundaries、3 subprocess、6 CLI、dist:smoke ok）。SIGKILL 用例存在「仅覆盖已提交后崩溃」的覆盖缺口（F1），不影响正确性判定。

EVIDENCE ACCURACY:
- commit message 声称「115 unit (113 pass, 2 live skip) + 4 golden + 12 context-migrations + 3 subprocess + 6 CLI」与实际运行输出完全一致；「12 tests」与实际一致；「SIGKILL crash consistency (real child kill)」经隔离运行证实为真实子进程测试。未发现声称与实际不符之处。

FINDINGS:
- F1（非阻塞）SIGKILL 测试 kill 发生在写入提交之后，未直接制造 mid-write 崩溃；原子性依赖 SQLite 单语句事务保证。建议补跨行事务崩溃用例。
- F2（非阻塞）无 busy_timeout；多进程绕过锁时立即 SQLITE_BUSY。当前由 Host 排他锁兜底，可接受。
- F3（非阻塞）fence 错误消息对「更旧异常状态」措辞不精确（实践中不可达）。
- F4/F5（非阻塞观察）每次 open 重复跑 migrateDatabase（正确、略冗余）；close() 后 raw() 使用会 fail-loud。

<!-- 审查未修改任何源代码；工作树 clean；所有声明基于实际命令输出（context-store 12/12、SIGKILL 隔离 1/1、npm run check 全绿）。 -->
