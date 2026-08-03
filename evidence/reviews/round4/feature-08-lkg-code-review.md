# Feature 7 (R2) LKG capture/validation/replay — Code/Recovery/Concurrency Review (round4)

## 审查元信息

| 项目 | 值 |
|---|---|
| Reviewer role | LKG code/recovery/concurrency reviewer（独立审查者，非实现者） |
| Reviewed HEAD | `6c4e6343ddfc115dfab01854e97ceb8a6c38ec93` — "feat(context): LKG capture/validation/replay (R2 Feature 7)" |
| Reviewed baseline | 父提交 `7513f4d`（Feature 6 双审记录）；context-store/迁移基线 `4cdf83d`（Feature 2） |
| OpenCode authority | `cortexkit/magic-context @ 48ab531d` (v0.33.0 release)，已核实本地 `git rev-parse HEAD = 48ab531d8fa98af2f463db2e4d9f8ffdd63d765e` |
| 审查日期 | 2026-08-04 |

提交仅含 2 个文件变更（`+1070`）：`src/context/lkg.ts`（633 行）+ `test/context-lkg.test.ts`（437 行，14 测试）。`context_lkg_slots` 表与 `ContextStore.captureLkgSlot/getLkgSlot` 为既有基线（Feature 2 时已落库，已用 `git show 6c4e634~1:...` 核实父提交已包含）。

## 审查的文件

- `src/context/lkg.ts`（全文 633 行）
- `test/context-lkg.test.ts`（全文 437 行，14 测试）
- `src/context/context-store.ts`（`open`/fail-closed/`captureLkgSlot`/`getLkgSlot`/`LkgSlot` 接口）
- `src/db/migrations/context/0001_bootstrap.sql`（`context_lkg_slots` DDL，PRIMARY KEY (runtime_session_id, slot_key)）
- `src/context/projection.ts` + `src/runtime/session-projection.ts`（LKG 消费的消息视图）
- 权威源 `lkg-replay.ts` + `lkg-slot.ts` @ 48ab531d（逐行对照）
- `@earendil-works/pi-ai/dist/types.d.ts`（UserMessage/AssistantMessage/ToolResultMessage 类型，L273–310）
- `@earendil-works/pi-agent-core/dist/harness/messages.d.ts`（CustomMessage 类型）
- `tsconfig.json`（`noUncheckedIndexedAccess: true` 已核实）
- `src/contracts/context.ts`（`IRIS_INPUT_META_CUSTOM_TYPE`）

## 验证命令与真实输出

### 1. `npx tsx --test test/context-lkg.test.ts` — 14/14 PASS

```
# tests 14   # pass 14   # fail 0   # skipped 0   # duration_ms 470.9571
```
14 项测试全部通过，逐项（1 捕获→回放 round-trip；2 anchor=最新真实用户；3 活跃 assistant 排除旧 user；4 model/provider 不匹配 fail-closed；5 id reshape fail-closed；6 内容变更 fail-closed；7 unsafe seam 拒绝；8 safe seam 通过；9 anthropic reasoning run 拒绝；10 digest 确定性；11 noteLkgEntry 派生；12 无安全 anchor 捕获 false；13 重复 id 返回 null；14 无 slot fail-closed）。实跑时长 470.96ms。

### 2. `npx eslint src/context/lkg.ts test/context-lkg.test.ts` — 无输出（clean）

### 3. `npx tsc --noEmit` — 无输出（clean）

### 4. `npm run check` — 全量门禁通过

- format:check ✓（prettier --check .）
- lint ✓（eslint .）
- typecheck ✓（tsc --noEmit）
- test：**150 项，148 pass + 2 skip**（skip = OPENCODE_GO_API_KEY 未设置的 2 个 live provider 用例），0 fail
- test:context-golden：**4/4 pass**
- test:context-migrations：**12/12 pass**
- migration:smoke：`"status": "idempotent"`（空库初始化 firstApplied [0001_bootstrap]，二次应用空）
- crash:check：**7/7 boundary ok**
- build ✓（tsc -p tsconfig.build.json + copy-migrations）
- test:subprocess：**3/3 pass**
- test:cli：**6/6 pass**
- dist:smoke：`{"status":"ok","epochDb":true,"ingressDb":true}`

## Checklist 逐项核对

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | Determinism | ✅ | `buildLkgPrefix`/`noteLkgEntry`/`findLkgAnchor`/`lkgContentDigest` 均为输入纯函数；`lkg.ts` 中无 `Date.now()`/`random`（已 grep 全文）。`capturedAt = args.capturedAt ?? Date.now()` 仅作为元数据进入 `payload.capturedAt` 与 `lkg_json` 的序列化副本，**不进入 digest/prefix**——回放验证只读 `jsonPrefix/inputIdSeq/inputContentDigests/lastInputMessageId/modelKey/providerKey`，不比较 `capturedAt`。编码形状（S/D/B/O/A/K/N/U/X 标签、`O{n}{` 顺序）与权威源一致；输入域为稳定投影（见 Finding F4） |
| 2 | Crash/restart | ✅ | slot 落库 `context_lkg_slots`（WAL + 单语句 autocommit），`captureLkgSlot` 返回即已持久。`replayLkg` 只经 `store.getLkgSlot` 读取，无内存态。已有 `context-store` 测试 59（SIGKILL 后 DB 可重开）与测试 54（LKG slots upsert and reload 跨重开验证）佐证持久性机制 |
| 3 | Concurrency | ✅ | 单条 `INSERT ... ON CONFLICT (runtime_session_id, slot_key) DO UPDATE`（context-store.ts L520–532）原子幂等；表主键 `(runtime_session_id, slot_key)` 保证冲突目标唯一；WAL + `busy_timeout=5000` + Host 数据根锁兜底，无部分写入窗口 |
| 4 | Fail-closed | ✅ | `replayLkg` 11 条路径全部返回 typed reason，无 throw/fall-through：slot 缺失→`lkg_invalidated_reshape`；JSON 解析失败/非对象→`lkg_seam_invalid`；model/provider 变更→`lkg_model_mismatch`；entry 为 null→`lkg_invalidated_reshape`；anchorIndex 错位或 id 序列不符→`lkg_invalidated_reshape`；digest 不符→`lkg_content_mismatch`；prefix 解析失败→`lkg_seam_invalid`；boundary 失败→`lkg_unsafe_seam`；seam 失败→`lkg_seam_invalid`；anthropic reasoning 无效→`lkg_anthropic_reasoning_run_invalid`。所有 JSON 解析均被 try/catch 包裹，`lkgContentDigest` 内部 catch 返回 null 并在上游被拒绝 |
| 5 | Index safety | ✅ | `noUncheckedIndexedAccess: true` 已核实。`validIds[anchorIndex]`（lkg.ts L362）与 `projected[anchorIndex]`（L360、L552）均已替换为显式 `=== undefined` 检查（不再使用 `!`）；`findLkgAnchor`/`validateAnthropicReasoningRuns`/`latestAssistant`/`validateLkgSeamBoundary` 均做 undefined 守卫。全文 grep 无 `!` 非空断言、无 `as number`（lkg.ts 与测试文件均为 0 处） |
| 6 | Resource handling | ✅ | 14 个测试中 6 个使用 ContextStore（test 1/4/5/6/12/14），全部 `try/finally { store.close(); rmSync(dirname(path), {recursive, force}) }`，close 在 rmSync 之前（规避 EBUSY）；其余 8 个为纯函数测试无 DB。无句柄泄漏 |
| 7 | Seam validation order | ✅ | `replayLkg` L617 先 `validateLkgSeamBoundary`（`lkg_unsafe_seam`），L620 后 `validateLkgSeam`（`lkg_seam_invalid`），与权威源 L507–514 顺序一致。注：`validateLkgSeam` 内部再次调用 `validateLkgSeamBoundary`，属无害重复 |
| 8 | Pi type mapping | ✅ | `stableMessagePayload` 对 assistant 只读 `role/content/stopReason/timestamp`（`?? null/[]` 防御），**不假设 api/provider/model/usage 存在也不读取**；toolResult 读 `toolCallId/toolName/content/isError/timestamp`；custom 读 `customType/content/display/details/timestamp`。与 pi-ai `Message` 联合类型逐字段对照一致 |
| 9 | `partIsAnthropicThinkingPart` fix | ✅ | 按 part 计数（thinking/reasoning/redacted_thinking），单条含两个 thinking block → false（test 9 bad）；thinking+text 跨相邻 assistant 消息合并处理正确（test 9 good：先 thinking 后 text → true；text 在 thinking 前则 false）。与权威源 L372–394 逐行一致 |
| 10 | Test isolation | ✅ | 每测试独立 `mkdtempSync` + 独立 store，finally 清理；14 测试 hermetic（无共享全局态，无 `resetLkgSlotsForTest` 之类跨用例清理需求——slot 均按 runtimeSessionId 隔离） |

## Findings

### F1（重要，NON-BLOCKING，R3 布线前必须处理）— growing-window 回放与权威源语义不一致

`noteLkgEntry`（lkg.ts L543）用 `findLkgAnchor`（**当前窗口**最新真实用户）定位 anchor；权威源 `noteEntry`（lkg-slot.ts L144–164）用 `entryInputIds.indexOf(slot.lastInputMessageId)`（**已捕获 slot** 的锚点 id）定位 anchor。

实际影响（已用探针复现）：捕获窗口 `[u-1,c-1,a-1]`（anchor=u-1）后，会话增长为 `[u-1,c-1,a-1,u-2,c-2,a-2]` 再回放 → 本实现返回 `lkg_invalidated_reshape`；权威源在该场景会成功返回 `prefix + pristineTail`（新消息进入 tail）。这是 LKG 的核心恢复场景（崩溃后会话已前进），而本实现把它当作 reshape 拒绝。

- 与本模块自述契约冲突：docstring 定义 reshape 为"ids shifted / contents changed / model/provider changed"，追加消息不属任何一类。
- 与权威源 parity 声明冲突：commit message 声称 port 权威语义。
- 测试覆盖缺口：14 个测试中**没有**一个"捕获后窗口增长再回放"的用例；回放成功用例（test 1）只覆盖完全相同的窗口。

修复方向（对齐权威源）：`noteLkgEntry` 按 slot `lastInputMessageId` 定位 anchor（或 replayLkg 内部先取 slot 再算 note），`entryIdsAreValid` 只校验前缀段、允许 tail 增长。R2 阶段无生产调用点，行为仍 fail-closed（安全），故不阻塞本门禁。

### F2（NON-BLOCKING）— `partIsReasoning` 为死代码，偏离权威源

lkg.ts L219–226 的 `partIsReasoning(message)` 先要求 `role === "assistant"` 才检查 part，而调用点 L536 `message.message.role !== "assistant" && partIsReasoning(message)` 的组合**恒为 false**（role 非 assistant 时函数早退返回 false；role 为 assistant 时左半为 false）。权威源（lkg-replay.ts L354–358, L441）的对应检查是"非 assistant 消息携带 type=reasoning part 则 seam 无效"。

实际影响：当前 Pi 类型下非 assistant 消息（UserMessage/ToolResultMessage）的 content part 只能是 text/image，无法携带 reasoning part，故该偏差在类型层面不可达。但代码具有误导性，建议改为 part 级谓词（与 `partIsAnthropicThinkingPart` 一致）再进入 R3。

### F3（NON-BLOCKING）— `validateLkgSeamBoundary` 省略权威源的"incomplete tool part"拒绝分支

权威源 L405–415 在 prefix 末条消息带未完成 tool part（state.status !== "completed"）时返回 unsafe（无论 tail 首条是什么）；本实现只拒绝"tail 首条是 toolResult 或引用了末条 dangling callId"两种形态。

实际影响：经探针验证，构造 `prefix=[u-1,c-1,a-1(toolUse, 未完成)]、tail=[u-2,c-2]` 时本实现 boundary 返回 true。但该形态无法从标准 capture→replay 流程自然产生——标准流程下 prefix 恒以 anchor（user 消息）结尾，dangling toolCall 只会出现在 prefix 内部而非 seam 处。因此属权威 parity 缺口而非可达缺陷。同样建议 R3 布线前补齐或显式记录为 scope 决策。

### F4（NON-BLOCKING，信息）— digest 输入域与权威源不同（自文档化）

本实现 `lkgContentDigest` 对**稳定投影** `{role, content, stopReason, timestamp}` 等字段哈希（编码形状一致），权威源对整个 MessageLike 对象哈希。docstring 已明确说明（"runtime metadata excluded"）。R2 自洽性 OK（捕获/回放同一代码路径），但 digest 值与权威源**不可跨实现比对**——若未来需要跨项目/跨实现 LKG 校验需注意。

### F5（NON-BLOCKING，scope 说明）— `validateLkgSeam` 省略权威源的非 anthropic 空 text/reasoning part 拒绝与 OpenAI-compat wire adjacency 检查

本实现 `validateLkgSeam` 无 `providerKey` 参数，未移植权威源 L443–466 的 empty-text 拒绝（非 anthropic provider）与 `assertOpenAiCompatAdjacency` + wire tool_calls 去重检查。Pi 类型下空 text part 是可能出现的，wire adjacency 检查依赖 OpenCode 的 `tool_calls` 结构。建议在 R3 布线时明确决策：移植或记录为 scope 缩减。

### F6（通过项确认）— 无生产调用点

grep `src/` 下无任何 `from "..." lkg` 导入，与 commit message 声明的 "R2 scope: capability layer + SQLite persistence + tests; transform wiring is R3" 一致。

## 结论块

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 10 项 checklist 全部通过；模块契约（determinism/fail-closed/幂等持久化/seam 顺序/类型映射/thinking 计数/索引安全/资源清理/测试隔离）均满足。与权威源存在 3 处语义偏差（F1 anchor 定位方式、F2 死代码、F3 boundary 分支），其中 F1 影响核心恢复场景，需在 R3 布线前对齐或显式记录为 scope 决策。
CODE CORRECTNESS: lkg.ts 整体质量高——纯函数哈希、显式 undefined 收窄、所有失败路径 typed fail-closed、无 `!`/`as number` 隐藏不安全访问。F2 死代码与 F3 未达分支为代码质量/parity 缺口（类型层面不可达）。eslint + tsc 均 clean。
RECOVERY/CONCURRENCY: 崩溃恢复路径正确——slot 单语句原子落库（ON CONFLICT DO UPDATE 幂等），SIGKILL 后重开可读，replay 只读 store。失败关闭语义完备。唯一恢复语义缺口为 F1（窗口增长被误判 reshape）。
TEST COVERAGE: 14/14 通过，覆盖 6 种 failure reason、anchor 规则、digest 确定性、seam 安全、reasoning 拒绝。缺口：无 growing-window 回放用例（F1）、无"捕获后追加真实用户消息"用例、无跨进程/并发 capture 用例（幂等性仅靠 SQL 语义论证）。
EVIDENCE ACCURACY: 全部声明与实测一致——14/14 单元测试、eslint/tsc 零输出、`npm run check` 全量通过（148 pass + 2 skip、golden 4、migrations 12、smoke idempotent、crash 7/7、subprocess 3、CLI 6、dist ok）；权威源基线 48ab531d 与 commit 声明一致；父提交已含 lkg 表与 store 方法，与 commit 只新增 2 文件的 stat 相符。
FINDINGS: F1（重要）growing-window 回放被误判 lkg_invalidated_reshape，偏离权威源 noteEntry 的 lastInputMessageId anchor 语义且无测试覆盖——R3 布线前必须对齐；F2 `partIsReasoning` 死代码（与权威源非 assistant+reasoning part 检查不符）；F3 `validateLkgSeamBoundary` 省略 incomplete-tool-part 拒绝分支（标准流程不可达）；F4 digest 输入域为稳定投影，与权威源 digest 不可跨实现比对（已文档化）；F5 `validateLkgSeam` 省略非 anthropic 空 text 与 wire adjacency 检查（scope 决策待记录）。以上均不影响 R2 门禁（无生产调用点，行为均 fail-closed/安全），但 F1/F2/F3 须在 R3 Historian 集成（Feature 9/10）前解决。

---

## RE-REVIEW (5563620)

### 复审元信息

| 项目 | 值 |
|---|---|
| 复审 commit | `5563620` — "fix(context): LKG review F2/F3 (reasoning-part seam check, incomplete-tool boundary)" |
| 复审 HEAD | `5563620`（`git log --oneline -5` 确认为当前 HEAD，父提交 `6c4e634` 即原审查基线） |
| 变更范围 | 仅 2 文件：`src/context/lkg.ts`（约 20 行净变更）+ `test/context-lkg.test.ts`（+52，2 个新回归测试），stat 与 `git show 5563620` 一致 |
| 复审日期 | 2026-08-04 |
| 工作区状态 | `git status --short` 仅两个未跟踪 review 文件（本文件 + spec-review），无源码改动 |

### 验证命令与真实输出

1. `npx tsx --test test/context-lkg.test.ts` — **16/16 PASS**（原 14 + 新 2），duration 435.35ms。逐项：test 9 = F3 回归（prefix 末条 toolCall call-1 + tail 无任何 call-1 result → `validateLkgSeamBoundary` false）；test 10 = F2 回归（user 消息 content 携带 reasoning part → `validateLkgSeam` false）。
2. `npx eslint src/context/lkg.ts test/context-lkg.test.ts` — 无输出，exit 0。
3. `npx tsc --noEmit` — 无输出，exit 0。
4. 边界探针（临时脚本，已清理）：tail 中间位含 call-1 result → boundary true；tail 末位含 result → true；空 tail → true（早退行为不变）；tail 无 result → false（复现 test 9）；assistant 自身携带 reasoning part 的合法 seam → true（F2 分支不误伤）。
5. `grep partIsReasoning\(`（全仓 .ts）— 0 命中，旧死代码函数已完全删除。

### F2 修复验证（原 F2：`partIsReasoning` 死代码）— 已修复

- 旧实现 `partIsReasoning(message)` 先要求 `role === "assistant"` 再检查 part，与调用点 `role !== "assistant"` 组合恒为 false。
- 新实现：`partIsReasoningPart(part)`（lkg.ts L219–223）改为 per-part 谓词；`validateLkgSeam`（L541–547）先守卫 `if (role !== "assistant")`，再对 content part 数组 `content.some(partIsReasoningPart)`，命中即拒绝——与权威源语义（非 assistant 消息携带 type=reasoning part 则 seam 无效）一致。
- 回归测试 test 10 覆盖 user+reasoning part → false；探针 E 确认 assistant 携带 reasoning part 的合法 seam → true（无误伤）。死代码路径已完全移除。

### F3 修复验证（原 F3：boundary 省略 incomplete-tool 拒绝分支）— 已修复

- 旧实现只拒绝"tail 首条是 toolResult"或"tail 首条引用末条 dangling callId"两种形态，`prefix=[a-1(toolUse, 未完成)], tail=[u-2,c-2]` 时返回 true。
- 新实现（lkg.ts L508–516）：在既有首条检查之后，收集 tail 全部 toolResult id 到 `tailResultIds`，返回 `lastCalls.every((callId) => tailResultIds.has(callId))`——prefix 末条 assistant 的每个 open call 必须在 tail 中某处有匹配 result，否则 seam unsafe（dangling tool_use 不会到达 wire）。
- 回归测试 test 9 覆盖"tail 无 result"→ false；既有 test 8（text assistant 结尾）仍 true；探针确认 result 位于 tail 中/末位时 boundary 保持 true（无回归）、空 tail 早退行为未变。
- 注：实现形态与权威源"末条 tool part state.status !== completed"不同（本实现改为"tail 中是否存在匹配 result"），但 wire 安全语义等价；标准 capture→replay 流程 prefix 恒以 anchor（user 消息）结尾，此检查实际不触发，属防御性加固，可接受。

### F1 确认（growing-window 回放 vs 权威源 noteEntry lastInputMessageId anchor）

- 本 commit 未触碰 `noteLkgEntry`/`findLkgAnchor`/`entryIdsAreValid` 相关路径，F1 保持原状。
- 按评审约定确认：F1 被实现者明确 acknowledge 并 defer 到 R3 Historian 集成（Feature 9/10 门）布线时处理。R2 阶段无生产调用点（`src/` 下无 lkg 导入，grep 复核），行为 fail-closed（typed `lkg_invalidated_reshape`，安全），维持文档化 NON_BLOCKING。接受此 defer。

### 结论块（RE-REVIEW）

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: F2/F3 两处权威源语义偏差已修复并附回归测试，与锁定权威源（cortexkit/magic-context @ 48ab531d）语义对齐；F1（noteLkgEntry anchor 派生 vs 权威源 lastInputMessageId 查找）确认 acknowledge 并 defer 至 R3 布线，接受为文档化 NON_BLOCKING；F4/F5 scope 说明维持原判。checklist 全部通过。
CODE CORRECTNESS: F2 重构为 part 级谓词并将 role 守卫外移到调用点，消除死代码，语义正确且不误伤合法 assistant reasoning（探针 E）；F3 新增 `lastCalls.every(callId => tailResultIds.has(callId))` 正确覆盖"末条 toolCall 永无结果"形态，边界行为经探针验证无回归（tail 中/末位含 result 仍 true、空 tail 早退不变）。eslint + tsc 均 clean（exit 0）。
RECOVERY/CONCURRENCY: 持久化/幂等/重开可读路径未触碰，原判定维持。F3 修复进一步保证重放前缀在 wire 层不可能携带悬空 tool_use，恢复安全加固成立。
TEST COVERAGE: 16/16 通过（原 14 + F2/F3 各 1 回归），新测试精确命中两次修复路径。既有覆盖缺口（growing-window 回放、跨进程并发 capture）随 F1 一并 defer 至 R3。
EVIDENCE ACCURACY: 全部声明与实测一致——16/16 单元测试、eslint/tsc exit 0、探针 5 项边界行为与代码阅读一致、grep 确认死代码移除、commit stat（2 文件，+72/-9）与 `git show` 相符；commit message 中"16/16 pass"属实。
FINDINGS: F1（重要，NON-BLOCKING，R3 布线前必须处理）本 commit 未修复——noteLkgEntry 用当前窗口 findLkgAnchor 而权威源用已捕获 slot 的 lastInputMessageId 定位 anchor，窗口增长场景被误判 lkg_invalidated_reshape，且缺 growing-window 回放测试；F2 已修复（partIsReasoningPart + role 守卫外移，test 10 覆盖）；F3 已修复（lastCalls.every → tailResultIds，test 9 覆盖）；F4/F5 scope 说明维持原判。R2 门禁不受影响。
