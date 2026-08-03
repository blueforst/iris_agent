# Reviewer D — 安全与溯源终审（final review，R2 Round 4）

> 角色：Reviewer D（security/provenance）— 四路径终审之一，本审查 gate git push。
> 分支：`agent/r2-magic-context-parity` vs `main`（27 commits，71 files，+13079/-45）
> 审查日期：2026-08-04
> 结论：**PASS（附 1 个非阻塞观察项）**

## 1. 审查范围

- 全部 27 个 commits（`git log --oneline main..HEAD`）：`441c329` → `e2f7c25`
- `src/context/`：context-store / projection / pass-taxonomy / protected-tail / lkg / replay / pipeline / carriers
- `src/runtime/`：session-projection / context-adapter / pi-runtime-adapter（变更面）
- `src/host/`：host.ts（iris_agent#6 身份修复）、data-root.ts（contextDb 接入）
- `src/db/migrations/context/0001_bootstrap.sql`
- `src/contracts/context.ts`、`scripts/`（context-golden/generate.ts、context-bench-smoke.ts）、`test/`（12 个新测试 + fixtures）、`evidence/`（provenance、notion-round4、reviews）

## 2. 逐项验证证据

### 2.1 密钥/真实数据泄露 — PASS（零命中）

对完整分支 diff（`git diff main..HEAD`，保存为临时文件后全文检索）执行：

| 模式 | 结果 |
|---|---|
| `sk-jMcM`（opencode-go 密钥前缀） | 0 命中 |
| `ntn_497981556856`（Notion PAT 前缀） | 0 命中 |
| `github_pat_` / `ghp_` | 0 命中 |
| `AKIA` / `aws_secret` / `client_secret` / `api_key` | 0 命中 |
| `BEGIN [A-Z ]*PRIVATE KEY` / `-----BEGIN` | 0 命中 |
| `Bearer [A-Za-z0-9]` / `Bearer` | 0 命中 |
| `password` / `secret =` / `token =`（值形态） | 0 命中（仅 `OPENCODE_GO_API_KEY` 环境变量**名**出现在 review 记录中，作为 live 测试 skip 原因，无值） |

- 分支历史无敏感文件：`git rev-list main..HEAD` 逐 commit `ls-tree` 全树扫描 `.env/.key/.pem/credential` → 0 文件。
- `git log --all --diff-filter=A --name-only` 敏感名 → 0 文件（无"先提交后删除"历史泄露）。
- 工作区 `.env` 仅含键名 `BLUEFORST_GH_PAT`；`.gitignore:10-12` 已忽略 `.env`/`.env.*`（仅放行 `.env.example`），`git ls-files` 与 untracked 候选均不含 `.env`，diff 中无该值。仓库卫生正常。
- 新增 12 个 fixture + constants.json 全为合成数据（`Alpha baseline`/`Bravo delta`/`Charlie delta`、`sys-v1`/`sys-v2`、`anthropic/opus|sonnet`、数值数组），无真实用户会话、无 provider 响应、无模型载荷。
- `scripts/context-bench-smoke.ts` 生成合成 200-turn 会话（`user turn N`/`assistant reply N`、`u-N/c-N/a-N` 生成 id），无真实数据。
- `test/` 无 test-only credentials（`fake_key/dummy/xxx/apiKey="…"/token="…"` 零命中）。
- `evidence/notion-round4/` 无邮箱/密钥/凭证模式（`@…com`、`sk-`、`ntn_`、`Bearer`、`PRIVATE` 零命中）。
- `evidence/README.md` 承诺不写入 secrets/prompt/reasoning/用户内容，与观察一致。

### 2.2 溯源完整性 — PASS

- `evidence/context-golden/provenance.json` + `scripts/context-golden/authority.json` 双重锁定：
  - 源仓库 `cortexkit/magic-context`，release `v0.33.0`，commit `48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`（released 版本）。
  - `evidence/notion-round4/02-magic-context.md` 明确：master audit snapshot `113f3e48` 仅作升级证据，**不进入** golden authority → 无 master-unreleased 内容静默采纳。
- **哈希实测**：对全部 12 个已提交文件（11 fixture + constants.json）独立计算 sha256，与 `provenance.json.outputHashes` 逐项比对 → **12/12 全部匹配，0 mismatch**。
- 生成器 `scripts/context-golden/generate.ts` 强制本地 authority HEAD == 锁定 commit 才可再生成（`execFileSync("git", ["-C", AUTHORITY_PATH, "rev-parse", "HEAD"])`，参数数组、无 shell 拼接），并声明"expected 值只来自权威源断言，永不从 Iris 自身实现推导（no self-certification）"。
- `test:context-golden` 4/4 通过（authority lock；fixture 完整+离线；expected 值权威一致；provenance 自洽含 constantsJson hash）。

### 2.3 Memory Mural 排除 — PASS

`grep -ri mural`（src/test/scripts/evidence/fixtures 全仓）11 个文件命中，**全部为负向排除**：

- `scripts/context-golden/generate.ts:507` `assertNoMural()`（`/mural/i` 命中即抛错）+ L20-21 禁令注释；
- `test/context-golden.test.ts:46` 对全部 fixture 断言 `doesNotMatch(/mural/i)`；
- `evidence/notion-round4/02-magic-context.md:7`、`04-pi-compat.md:24,78`、`07-roadmap.md:125`：`experimental.mural` 明确**不纳入** Iris M1 / explicitly_not_adopted；
- provenance.json / authority.json notes：mural 禁令条款；
- 已有 review 记录（feature-02 / feature-11）独立确认 fixtures 零 mural token。

fixture payload 中无任何 `mural` 字样。

### 2.4 沙箱 / 输入信任 — PASS

- `src/` 全量 grep：`eval` / `new Function` / `child_process` / `execSync` / `spawn` / 动态 `require(` / `import(` → **src 内 0 命中**（`src/runtime/context-adapter.ts:164`、`src/context/pipeline.ts:323`、`src/context/protected-tail.ts:106,157` 的命中均为 `executeThresholdPercentage` 参数名/注释，非执行）。
- 唯一 `child_process`（`scripts/context-golden/generate.ts:31,89`）是开发期生成器固定调用 `git rev-parse HEAD`，无 shell 拼接、输入为本地 authority 路径（`MC_AUTHORITY_PATH`），非 Pi session 数据。
- LKG 恢复为数据即数据：`replayLkg` 对存储 payload 逐字段形状校验、`entryIdsAreValid`/`entryContentIsValid` 严格比对、`validateLkgSeam`/`validateAnthropicReasoningRuns` 失败关闭（`lkg_invalidated_reshape`/`lkg_content_mismatch`/`lkg_unsafe_seam`…），`JSON.parse` 均包 try/catch 并 fail-closed（reviewer F5 已闭环）。
- entry id 仅用于内存 unitId 字符串拼接与 `contentHash`（sha256），**不参与文件路径、不参与 SQL**；`context-store.ts` 的 `dirname(contextDbPath)` 仅作用于配置派生路径（data-root resolve 到 dataRoot 内），`migrationsDirFor` 为静态 `import.meta.url` 相对路径。
- 消息内容在 provider-visible 输出中经 `projectedUserText` 投影为带 origin 标签的纯文本；未验证内容降级为 `[USER REQUEST | UNVERIFIED]`，无内容执行路径。

### 2.5 SQL 注入 — PASS

- `src/` 全部 SQL 位于 `src/context/context-store.ts`（新增）与既有 `src/runtime/epoch-manager.ts`，**所有语句均为 `db.prepare(...).get/all/run` + `?` 占位符**，无任何运行时值字符串拼接。
- `db.exec` 仅三处静态 PRAGMA（`busy_timeout`/`journal_mode`/`foreign_keys`），无用户输入。
- `0001_bootstrap.sql`（101 行）为静态 DDL：3 张表 + 2 索引 + emergency_state CHECK 约束，无动态值；migration 经 `migrateDatabase` 版本化 + 校验和，空库初始化与幂等由 `test:context-migrations` 12/12 验证。

### 2.6 供应商链 — PASS（零新增依赖）

- `git diff main..HEAD -- package.json`：**dependencies 区逐字节无变化**（main 与 HEAD 的 dependencies 块逐行相同，仍为 `@earendil-works/pi-agent-core 0.82.1` 等既有锁定依赖）。
- 全部变更为 `scripts` 字段：新增 `test:context-golden`、`test:context-migrations`、`context-golden:generate`、`bench:context`，`test`/`check` 追加 context 测试；`check` 增加 `test:context-golden`、`test:context-migrations`、`bench:context` 三段 gate。
- `lockfile`（package-lock.json）不在 diff 中 → 无依赖图变化。

### 2.7 文件权限 / 敏感路径 — PASS

- 分支新增文件无 `.env`/`.key`/`.pem`/`credentials` 目录。
- `.gitignore` 覆盖 `.env`、`.env.*`、`*.sqlite`、`*.sqlite3`、`*.log`、`.iris-data/` 等运行时敏感路径。
- `.prettierignore`（新增 12 行）仅用于保护 byte-exact fixture/provenance/Notion 快照不被格式化器改动，无异常内容。

### 2.8 完整 gate（`npm run check`）— PASS

本次审查实测执行 `npm run check` 全链路通过：

| 步骤 | 结果 |
|---|---|
| format:check（prettier --check .） | 全绿 |
| lint（eslint .） | 通过（exit 0） |
| typecheck（tsc --noEmit） | 通过（exit 0） |
| npm test | **198 tests / 196 pass / 0 fail / 2 skip**（skip = OPENCODE_GO_API_KEY 未设置的既有 live provider 用例） |
| test:context-golden | 4/4 PASS |
| test:context-migrations | 12/12 PASS（含 SIGKILL 崩溃窗口） |
| migration:smoke | `"status":"idempotent"` |
| crash:check | 7/7 崩溃窗口边界通过 |
| bench:context | ok（200 turns，decisionMsPerPass ≈ 4.94ms） |
| build（tsc -p tsconfig.build.json + copy-migrations） | 通过 |
| test:subprocess | 3/3 PASS |
| test:cli | 6/6 PASS |
| dist:smoke | `{"status":"ok",...}` |

## 3. FINDINGS

- **F1（非阻塞，观察项 / 功能面移交）**：`runContextPass`/`applyContextPass`/`renderProviderVisible`（Feature 9）在 `src/` 中仅有定义与内部注释引用，调用方仅为 `scripts/context-bench-smoke.ts` 与 `test/context-pipeline.test.ts`/`test/context-parity-gate.test.ts`；`a8b5158` 的提交面只有 package.json / context-store.ts / pipeline.ts / 测试，`host.ts` 产品路径仍未接线 runContextPass（当前 host context 变换仍走 `context-adapter.ts` 的 `transformContextMessages`，`materializationIdentity: "mock-m0m1-v1"`，为明确标记的 mock）。安全角度无风险；建议由功能 reviewer 与实现者确认该接线状态是否为已知的 Feature 10/后续范围，避免将"Host product-path"表述为已接线。
- **F2（非阻塞，提示）**：工作区根目录存在 `.env`（含 `BLUEFORST_GH_PAT` 键名）。未被 git 跟踪、被 `.gitignore` 覆盖、不在 diff 中——无泄露；仅提醒维持该卫生（勿提交）。

## 4. 结论

安全与溯源维度全部检查项通过：无任何密钥/真实数据泄露；溯源锁定 released v0.33.0 @ 48ab531d 且 12/12 fixture 哈希实测匹配；无 master-unreleased 静默采纳；Mural 全程排除；输入仅作为数据处理、无执行/路径遍历面；SQL 全参数化；供应商链零新增依赖；无敏感文件入库；`npm run check` 全量 gate 实测通过。

VERDICT: PASS
SECRETS/DATA LEAKAGE: PASS — 分支 diff 对 sk-jMcM / ntn_497981556856 / github_pat_ / AKIA / BEGIN PRIVATE / Bearer / password 等模式零命中；fixtures 与 bench 全合成；.env 未跟踪且被 gitignore 覆盖；分支历史无敏感文件
INPUT TRUST: PASS — src 无 eval/exec/spawn/动态 require；LKG 恢复全 fail-closed 校验；entry id 不参与路径与 SQL；唯一 execFileSync 为生成器固定 git rev-parse HEAD（无注入面）
SQL INJECTION: PASS — 全部 prepare + ? 占位符（context-store.ts 与既有 epoch-manager.ts）；无字符串拼接运行时值；PRAGMA/DDL 均静态
SUPPLIER CHAIN: PASS — package.json dependencies 区零变化，仅 scripts/test 追加；lockfile 不在 diff
MURAL EXCLUSION: PASS — 全仓 mural 命中均为负向排除（生成器断言、测试 doesNotMatch、spec explicitly_not_adopted）；fixtures 无 mural token
FINDINGS:
- F1（NON_BLOCKING / 功能面观察）：Feature 9 runContextPass 产品路径尚未在 host.ts 接线，当前仅 test 与 bench 调用；建议功能 reviewer 确认该状态（安全无影响）
- F2（NON_BLOCKING / 提示）：工作区 .env 存在但未跟踪、被 gitignore 覆盖，维持现状即可
