# R0 Production Baseline & Pi Fork Bootstrap — Evidence

Roadmap v13, R0（2026-08-04 审查）。本文件是 agent 仓库侧的 R0 证据汇总；
pi / memory 仓库各自维护独立证据（`blueforst/pi` `docs/iris-fork/`、
`blueforst/iris_memory` `docs/r0-status.md` / `docs/production-locks.toml`）。

## 1. Pi fork bootstrap（blueforst/pi）

- fork 基线：`blueforst/pi` main = `ab5f8d88`（fork point，upstream head 2026-08-04）
- upstream base：`earendil-works/pi@e741cb05`（reviewed snapshot 2026-08-04，immutable）
- upstream audit baseline：`b4f2936 / 0.82.1`（Notion 05 页，保留为 audit baseline）
- 治理交付（PR blueforst/pi#1，merged，main=`6aa2ef22`）：
  - `docs/iris-fork/README.md`（ownership / sync 流程 / patch 生命周期 / release 诚实性）
  - `docs/iris-fork/production-lock.json` + `carried-patches.json`（patches 为空）
  - `scripts/check-iris-fork-baseline.mjs`（fail-closed validator）+ 40 项测试
  - CI gate step（`Iris fork provenance gate`，独立且靠前）
- 验证证据：
  - 独立审查 2 份：`docs/iris-fork/reviews/r0-p0-spec-review.md`（Reviewer A，PASS）、
    `r0-p0-code-ci-review.md`（Reviewer B，PASS）；审后 40/40 测试
  - GitHub Actions `CI` run on `14de2103`：**success**（build + check + test，GitHub runner）
  - 本地：`npm run check:iris-fork` → `OK: iris fork baseline manifests are valid`；
    `node --test scripts/check-iris-fork-baseline.test.mjs` → 40 pass / 0 fail
  - 本地 `npm ci` → added 335 packages（无错误）
  - 说明：本地 `npm run build` 因服务器无法访问 models.dev（generate-models 拉模型数据）
    失败；该步骤由 GitHub CI 覆盖（runner 可访问），本地以 `build:offline` 的
    check-model-data 验证受限（模型数据 gitignored，需 hydrate），故构建证据以 CI 为准。

## 2. iris_agent 干净环境验证

- 验证对象：origin/main `dc248ff`（v13 迁移素材基线），干净环境（mcp-remote 全新 clone + npm ci）
- `npm ci` → 成功
- `npm run check`（14 步：format:check → lint → typecheck → test → test:context-golden →
  test:context-migrations → migration:smoke → crash:check → bench:context → build →
  test:subprocess → test:cli → dist:smoke）→ **全绿，0 错误**
  （test 汇总：206 tests / 204 pass / 2 live-provider skip / 0 fail；subprocess 6 pass；cli 6 pass）

## 3. iris_memory 干净环境验证（mcp-remote）

- `uv sync --locked` → Resolved 7 packages
- `uvx ruff==0.15.22 format --check .` → 28 files already formatted
- `uvx ruff==0.15.22 check .` → All checks passed
- `uvx mypy==2.3.0` → Success: no issues found in 17 source files
- `uv run --with pytest==9.1.1 --with jsonschema==4.26.0 pytest` → **69 passed in 12.86s**
- lock 文件 `docs/production-locks.toml`：graphiti-core `0.29.2`（candidate）、neo4j driver min
  `5.26.0`、python `3.12`、uv `0.11.32`；grep 无 TBD/TODO/unknown

## 4. Exit Gate 逐条核对（R0）

| Gate | 状态 | 证据 |
| --- | --- | --- |
| production lock 无 TBD | PASS | pi `production-lock.json`（validator fail-closed + 40 测试）；agent `src/contracts/pins/production-lock.json`（`test/production-lock.test.ts` 8 项 gate，含占位符扫描）；memory `production-locks.toml`（grep 无 TBD/TODO/unknown） |
| 三个仓库可在干净环境独立构建 | PASS | pi：CI success（build+check+test）；agent：干净环境 `npm run check` 全绿；memory：uv sync + ruff + mypy + 69 pytest |
| 每项 Pi 差异有通用理由、测试、removal condition | PASS（vacuous） | `carried-patches.json` patches=[]（fork 目前无 runtime 差异，仅治理文件 + CI gate + validator；validator 本身 40 测试）；R1 seam 落地后按 README §4 全字段登记 |
| contracts/schema 只有一个权威来源 | PASS | memory 契约 artifact `iris-memory-contracts@0.1.1`（manifest.json，manifestSha256 `2cb22deb…`）为唯一跨项目权威；agent `test/memory-contract-gate.test.ts` 实际重算 SHA-256 并逐 schema/fixture 验证（已随 `npm run check` 通过）；agent 不保存第二份 memory DTO |

## 5. 独立审查记录

- R0-P0（pi fork）：2 份独立 subagent 审查（规格 A / 代码-validator-CI B），均 PASS，记录于
  `blueforst/pi` `docs/iris-fork/reviews/`
- R0-P1（agent production lock）：2 份独立 subagent 审查，记录于 `evidence/reviews/r0-p1/`

## 6. 已知缺口（不阻塞 R0）

- pi fork 落后 upstream 6 commits（同步为 follow-up，按 README §3 manual_review_gate 流程执行）
- fork 包身份沿用 upstream 包名（`inherits_upstream_package_names`，如实记录，发布前必须决策）
- Graphiti/Neo4j 为 candidate lock（R4 实现时锁定并验证）
- agent 对 pi fork 的 adoption 计划于 R1 seam 可用时切换（当前消费 npm release 0.82.1）
