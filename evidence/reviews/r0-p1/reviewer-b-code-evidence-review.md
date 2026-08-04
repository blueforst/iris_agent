# R0-P1 代码、验证与证据真实性审查记录（Reviewer B）

## 元信息

- 审查日期：2026-08-05
- 审查对象：R0-P1 production lock 工作包（分支 `agent/r0-production-lock`，HEAD `4323d03`，基于 `dc248ff`，工作树干净，2 个 commit：4288618 feat + 4323d03 evidence）
- 审查者：独立 subagent（Reviewer B，代码/验证/证据真实性）
- 最高权威：Roadmap v13 R0 Exit Gate（production lock 无 TBD、三仓库干净构建、Pi 差异治理、contracts 单一权威）

## Reviewed files

- `src/contracts/pins/production-lock.json`（46 行，全量）
- `src/contracts/production-lock.ts`（73 行，全量）
- `test/production-lock.test.ts`（101 行，全量）
- `docs/pi-production-lock.md`（25 行，全量）
- `evidence/r0/production-baseline-evidence.md`（67 行，全量）
- `package.json`（test script 含 `test/production-lock.test.ts`）
- `src/contracts/index.ts`（`export * from "./production-lock.js"`）
- 交叉引用：`src/contracts/memory-pin.ts`、`src/contracts/pins/memory-contracts.json`、`test/memory-contract-gate.test.ts`

## Executed commands (with actual outputs)

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test test/production-lock.test.ts` | **8 pass / 0 fail / 0 skip**（TAP: `1..8`, `# pass 8`, `# fail 0`） |
| `npx tsc --noEmit` | **exit 0** |
| `npx eslint src/contracts/production-lock.ts test/production-lock.test.ts` | **exit 0，无错误** |
| `npx prettier --check src/contracts/pins/production-lock.json src/contracts/production-lock.ts test/production-lock.test.ts docs/pi-production-lock.md` | **"All matched files use Prettier code style!"，exit 0** |
| 独立 PowerShell 递归字符串扫描（pin JSON，26 个字符串值） | **无 TBD/TODO/unknown 命中** |
| SHA 校验（目视 + 正则） | 4 个 commit SHA 均 40 位 hex；manifestSha256 64 位 hex |
| `git diff dc248ff..HEAD` | 7 文件 +311/−18；`git status` 干净 |
| `evidence/reviews/r0-p1/` 目录存在性 | **不存在**（仅 `evidence/reviews/round4/`） |

## Findings

### BLOCKING: 1

1. **`evidence/r0/production-baseline-evidence.md:60` — 声称的审查记录目录不存在**
   > "R0-P1（agent production lock）：2 份独立 subagent 审查，记录于 `evidence/reviews/r0-p1/`"

   该目录在仓库中不存在（`evidence/reviews/` 下仅有 `round4/`）。AGENTS.md 要求"未实际执行的测试或命令不得宣称已通过"；证据文档把尚未落地为可检索记录的审查记为已发生。若两份审查已完成，必须补入 `evidence/reviews/r0-p1/`；若尚未完成，删除该行。这是证据真实性问题，修复为文档/文件操作，成本极低。

### NON-BLOCKING

1. **`evidence/r0/production-baseline-evidence.md:34` — "14 步"与实际 check 链不符**。`package.json` 的 `check` 为 13 个命令（format:check/lint/typecheck/test/context-golden/context-migrations/migration:smoke/crash:check/bench:context/build/subprocess/cli/dist:smoke）。证据文档自身括注也只列了 13 项。数字应改为 13。
2. **证据 206 测试数是对 `dc248ff` 基线测的**。`git show dc248ff:package.json` 不含 `production-lock.test.ts`，故 206 tests/204 pass 未含本 gate 的 8 项。文档明确限定"验证对象：origin/main dc248ff"，属如实申报，但 R0 门禁证据依赖的 8 项 gate（本审查已验证 8/0 pass）二者各自成立，仅需在文档中把两处数字关系写清（当前分支全量约 214/212/2skip）。
3. **`production-lock.ts:3` — `export const PRODUCTION_LOCK = pin` 导出共享引用**。`PRODUCTION_LOCK` 与 `readProductionLock()` 内部读取的是同一个模块级导入对象；若外部代码误改 `PRODUCTION_LOCK.toolchain.*` 会污染后续所有读取。当前无代码如此使用，且 `readProductionLock()` 本身深拷贝正确（嵌套对象均 spread、数组用 `[...]`），故不阻塞。可选加固：导出只读类型或仅导出 reader。
4. **`test/production-lock.test.ts` 注释为英文**。AGENTS.md 要求代码注释用中文；但仓库既有测试（如 `memory-contract-gate.test.ts`）同样全英文注释，新文件与现有惯例一致，属轻微约定张力，不阻塞。

### 审计要点确认（均通过）

- **占位符扫描**：`walkStrings` 递归遍历 string/array/object 全部值，作用于 `readProductionLock()` 的完整结构，无遗漏（独立脚本二次验证 26 个字符串值 0 命中）。
- **package.json 交叉检查**：双向——lock 内每个 pi 包必须在 dependencies 中精确匹配，且 `@earendil-works/pi-*` 依赖必须全部被 lock 覆盖，任何一侧漂移都会失败。
- **memory pin 交叉检查**：测试使用 `readContractPin()`（`memory-pin.ts` → `pins/memory-contracts.json`），与全库 gate（`memory-contract-gate.test.ts` 等）同一 pin，4 字段逐项比对，非手写副本。
- **类型保真**：`with { type: "json" }` 导入；无 `as` 强转、无 `any`；`readProductionLock()` 返回全深拷贝；tsc 通过证明接口与 pin 结构一致。
- **JSON pin**：`schemaVersion: 1`；全部 SHA 满长度（4×40 hex + 1×64 hex）；无占位符；与 `docs/pi-production-lock.md` 表格逐值一致（含 0.82.1、v0.33.0、manifestSha256 前缀等）。
- **文档可复现性**：`memory-contract-gate.test.ts` 确实重算 manifest SHA-256（已读源码确认）；docs 中文；`index.ts` 导出正确；git 工作树干净。

## Final verdict

**BLOCKING**

代码、测试与门禁全部真实通过（8/0，tsc/eslint/prettier 全绿），占位符扫描与双向交叉检查设计有效。但证据文档宣称的 `evidence/reviews/r0-p1/` 审查记录目录在仓库中不存在，违反 AGENTS.md 证据真实性要求。此为纯文档缺口，补入两份审查记录文件（或如实删除该行）后即可重新评审，预计 **Quick（<1h）**。
