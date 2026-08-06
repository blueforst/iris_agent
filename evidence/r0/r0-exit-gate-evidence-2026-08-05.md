# R0 Exit Gate Evidence — 2026-08-05(Feature 1/2 修复轮后)

Roadmap v13 R0(Production Baseline & Pi Fork Bootstrap)Exit Gate 复验。
本文件只记录真实执行的命令输出;未执行项明确标注 NOT VERIFIED。
架构变更使 2026-08-01 旧 evidence 失效,以本文件为准。

## 0. 验证环境

- 日期:2026-08-05
- 主机:Linux(clean clone 验证在 /tmp/r0-clean 独立目录执行)
- Node.js v22.23.2(npm ci 时 EBADENGINE 警告,要求 22.19.0;不影响结果)
- 关键修复:依赖未按锁安装导致的历史误报 — `npm ci` 后 Agent typecheck 49→0、lint 312→0

## 1. 三仓库精确依赖锁(Exit Gate:production lock 无 TBD)

| 仓库                  | 锁文件                                  | schemaVersion | 状态                                           |
| --------------------- | --------------------------------------- | ------------- | ---------------------------------------------- |
| blueforst/pi          | docs/iris-fork/production-lock.json     | 2             | acceptedRuntime 单一权威,无 TBD                |
| blueforst/iris_agent  | src/contracts/pins/production-lock.json | 2             | seamCommit/acceptedRuntime 与 Pi lock 交叉验证 |
| blueforst/iris_memory | contracts manifest.json                 | 0.1.1         | 14 schemas / 30 fixtures,manifestSha256 固定   |

验证命令与输出(Agent 侧,test/production-lock.test.ts 19/19 全绿):

```
$ npx tsx --test test/production-lock.test.ts
# tests 19
# pass 19
# fail 0
```

- 无 TBD/TODO/unknown 占位符:test "r0: production lock contains no TBD/TODO/unknown placeholder" 通过
- Pi 侧 validator 50/50(含 --verify-git 模式):

```
$ node --test scripts/check-iris-fork-baseline.test.mjs   # 清掉 proxy 环境变量
# tests 50
# pass 50
# fail 0
$ node scripts/check-iris-fork-baseline.mjs --verify-git
OK: iris fork baseline manifests are valid (git-verified)
```

## 2. 三仓库 clean clone / build / test / CI(Exit Gate:干净环境独立构建)

在 /tmp/r0-clean 独立目录从 ceyirelehe47 fork 全新 clone(与 CI 同源):

### iris_memory(uv)

```
$ uv sync --locked                    → Resolved 7 packages
$ uvx ruff format --check .           → 28 files already formatted
$ uvx ruff check .                    → All checks passed!
$ uvx mypy                            → Success: no issues found in 17 source files
$ uv run --with pytest==9.1.1 --with jsonschema==4.26.0 pytest
                                      → 69 passed in 12.55s
```

### pi(npm)

```
$ npm ci --ignore-scripts             → added 131 packages
$ npm run build                       → exit 0
$ npm run check                       → exit 0(tsgo 0 error,iris fork gate OK)
```

### iris_agent(npm + 相邻 ../pi)

```
$ npm ci                              → file: 依赖指向 ../pi(0.83.0)
$ npm run check                       → exit 0(含 production-lock gate、r1 gates、migration、crash、bench)
```

关键:clean clone 验证 production-lock gate 19/19、r1-exit-gates 5/5、bootstrap-pi-checkout OK。

## 3. Migration 初始化与升级路径(Exit Gate:migration bootstrap)

### iris_memory(migrations 9/9)

```
$ pytest tests/test_migrations.py -v
test_empty_database_initializes_and_is_idempotent                PASSED
test_failed_migration_rolls_back_atomically                     PASSED
test_old_0002_schema_upgrades_to_0003_and_consumes_alternate_key PASSED
test_migration_checksum_fails_closed_when_applied_migration_changes PASSED
test_migration_failure_rolls_back_atomically                    PASSED
test_migration_reapply_is_idempotent_across_restart             PASSED
test_legacy_empty_checksum_is_backfilled_from_release_manifest  PASSED
test_legacy_empty_checksum_without_release_manifest_fails_closed PASSED
test_legacy_baselines_backfill_all_checksums_in_one_apply       PASSED
```

### iris_agent(migration smoke)

```
$ npx tsx scripts/migration-smoke.ts
{ "secondApplied": [], "status": "idempotent" }
```

## 4. Pi accepted runtime identity(Exit Gate:#41 单一权威)

- Pi production-lock.json `acceptedRuntime` = {commit: e209e5616, tree: 771b1634}(iris_agent#40 修复链 HEAD)
- Agent pin `seamCommit` = 5e93510b9(tree 5a16381b),`acceptedRuntimeCommit` = e209e5616(tree 771b1634)
- 交叉验证(Agent gate 机械断言):
  - ../pi HEAD == seamCommit、HEAD tree == seamTree
  - ../pi lock acceptedRuntime == Agent pin acceptedRuntime
  - acceptedRuntimeCommit 是 seamCommit 与 ../pi HEAD 的祖先(merge-base --is-ancestor)
  - CI checkout ref 由 read-pi-pin.mjs 派生,无硬编码 SHA(fetch-depth: 0 提供完整历史)
- 独立 subagent 审查:Feature 1 三轮(BLOCKING×2 → 修复 → PASS)、Feature 2 两轮(flaky BLOCKING → handshake 修复 → PASS)+ 跨仓库集成 PASS

## 5. Memory contract 精确 pin

- package: iris-memory-contracts@0.1.1,manifestSha256 2cb22deb5efded5a112dbb38c19506e6185ad328a973f7a96d9e66faf59a761b
- Agent test/memory-contract-gate.test.ts 实际重算 SHA-256 验证(在 npm run check 中通过)
- iris_memory contract asset 测试全部通过(69 passed 含 test_contract_assets / test_artifact)

## 6. 无 TBD / 浮动 ref / 无法复验的手工状态

- 所有 SHA 均为完整 40 位 hex,由 gate 强制
- acceptedRuntime 为不可变 commit + tree,拒绝浮动 main
- validator 拒绝占位符、零 SHA、父对象缺失
- 无 NOT VERIFIED 项(除下节明确说明)

## 7. NOT VERIFIED / 说明

- GitHub Actions 真实 CI 运行:本次验证在本地 clean clone 等价复现 CI 步骤(unshallow + gate),但未触发 GitHub 实际 runner;CI 配置已由 subagent 用浅克隆模拟验证(fetch-depth: 0 修复)
- Pi 完整 npm test(全量 vitest):依赖模型数据 hydrate,clean clone 验证中未重跑全量;harness 套件 274 passed 已在开发环境连续 5 次复验
