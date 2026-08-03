# R2 Feature 7 LKG capture/validation/replay — 规格/状态机 parity 评审

## 评审角色

独立 LKG spec/state-machine parity reviewer（非实现者）。任务：核对 src/context/lkg.ts 与权威
magic-context lkg-replay.ts + lkg-slot.ts @ 48ab531d 的语义 parity、规格符合度、测试与证据真实性。

## 评审基线

- **权威源**：OpenCode magic-context `48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`（release v0.33.0）。
  本地 checkout `C:\Users\15027\AppData\Local\Temp\opencode\mc-authority\magic-context`
  实测 `git log --oneline -1` = `48ab531d release: v0.33.0`，与仓库 evidence/context-golden/provenance.md、
  test/context-golden.test.ts 内联常量一致。
- **规格**：`evidence/notion-round4/01-context-assembly.md` §LKG（221-234 行）、§HARD（156 行）、
  §Session Scope（37-46 行）。LKG 关键语义：安全恢复槽非跨 Session 连续性机制；绑定 runtimeSessionId、
  有序 logical-unit IDs、last safe real-user anchor、model/provider/profile、materialization IDs、
  reshape fingerprint、tool-arc seam、signed-reasoning seam、serializer/carrier version；
  Replay 验证 prefix 完整有序、anchor 位置不变、source/model/profile 兼容、splice seam 不切断
  tool arc / assistant structure / signed reasoning，验证失败即拒绝 LKG。

## 评审 HEAD

- commit `6c4e634` "feat(context): LKG capture/validation/replay (R2 Feature 7)"
- `git show --stat`：`src/context/lkg.ts`（+633）、`test/context-lkg.test.ts`（+437），共 2 文件。
- 注意：`context-store.ts` 的 `LkgSlot`/`captureLkgSlot`/`getLkgSlot` 与
  `src/db/migrations/context/0001_bootstrap.sql` 的 `context_lkg_slots` 表属此前 R2 Feature 2
  （4cdf83d）已提交内容，本 commit 未改动（`git diff 6c4e634~1 6c4e634 -- src/context/context-store.ts src/db/migrations/context/` 为空）。

## 评审文件

| 文件 | 角色 |
|---|---|
| src/context/lkg.ts | 被评审实现（633 行，全量阅读） |
| test/context-lkg.test.ts | 被评审测试（14 个，全量阅读） |
| src/context/context-store.ts | 持久化层（LkgSlot/captureLkgSlot/getLkgSlot，ON CONFLICT DO UPDATE） |
| src/db/migrations/context/0001_bootstrap.sql | context_lkg_slots 表结构 |
| src/runtime/session-projection.ts | ProjectedSessionMessage 类型来源 |
| evidence/notion-round4/01-context-assembly.md | 规格（LKG 章节全量阅读） |
| mc-authority lkg-replay.ts + lkg-slot.ts @ 48ab531d | 语义权威（全量阅读） |

## 测试执行（真实输出）

### test/context-lkg.test.ts（14/14 pass）

`npx tsx --test test/context-lkg.test.ts`

```
# tests 14
# suites 0
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 423.9509
```

逐项：
1. capture then replay on unchanged input returns prefix + pristine tail — ok
2. anchor is the newest real-user input (companion is synthetic, skipped) — ok
3. active assistant excludes a user message created before the invocation — ok
4. model/provider mismatch fails closed with lkg_model_mismatch — ok
5. reshaped id sequence fails closed with lkg_invalidated_reshape — ok
6. changed content fails closed with lkg_content_mismatch — ok
7. unsafe seam (prefix ends with unresolved tool call, tail starts with its result) is rejected — ok
8. safe seam passes when prefix ends with a completed assistant — ok
9. anthropic reasoning runs — multiple thinking blocks in one merged run are rejected — ok
10. digest is deterministic and content-sensitive — ok
11. noteLkgEntry derives entryInputIds + pristineTail from the window — ok
12. capture on a window without a safe anchor returns false — ok
13. buildLkgPrefix returns null on duplicate ids — ok
14. replay without a stored slot fails closed with lkg_invalidated_reshape — ok

### npm run check（全门禁）

`npm run check` 全链路通过：format:check ✓、lint ✓、typecheck ✓、
`npm test` 150 tests（148 pass + 2 live skip，需 OPENCODE_GO_API_KEY 的 live 用例跳过）✓、
context-golden 4/4 ✓、context-migrations 12/12 ✓、migration smoke `status: "idempotent"` ✓、
crash:check 7 boundaries 全 ok ✓、build ✓、subprocess 3/3 ✓、cli 6/6 ✓、dist smoke ✓。
其中 context-store "LKG slots upsert and reload"（upsert 覆盖 + 重开重载 + slot_key 隔离）通过。

## Checklist 逐项核验

1. **Anchor 语义 — PASS**。`findLkgAnchor` 与权威逐行等价：从后向前找最新 assistant；
   active（finish==="tool-calls" || hasIncompleteTool）时跳过 `timeCreated <= assistantTime`
   （含 null 时间）的 real-user 消息；assistant 存在但无时间戳 → null；real-user = role user
   + 非 synthetic + 非空 id。Iris 仅在遍历中多加了 `message === undefined` 防御。
2. **buildLkgPrefix — PASS（见 F8）**。anchor 必须存在；ids 全部非空且唯一（Set 查重）；
   digests 覆盖 slice(0, anchorIndex+1) 且无 null；jsonPrefix = output 中非 post-anchor 消息
   （保留 anchor 及其之前全部）。直接 id 匹配行为与权威一致。
3. **entryIdsAreValid — PASS**。与权威逐行相同：inputIdSeq 非空；entryIds.length >= 长度；
   inputIdSeq 末元素 == lastInputMessageId；全量唯一；indexOf(lastInputMessageId) == 长度-1；
   prefix ids 与 inputIdSeq 精确一致。任一项失败即 fail-closed。
4. **entryContentIsValid — PASS**。与权威相同：entryDigests.length >= slot digests 长度；
   逐 index 相等。内容变更 → lkg_content_mismatch（test 6 实测）。
5. **replayLkg 失败映射 — PASS（见 F4/F5）**。7 个原因映射与顺序全部匹配权威：
   no slot / entry null / id reshape → lkg_invalidated_reshape；model/provider → lkg_model_mismatch；
   content → lkg_content_mismatch；jsonPrefix 解析失败 → lkg_seam_invalid；
   seam boundary → lkg_unsafe_seam；seam → lkg_seam_invalid；anthropic reasoning → 
   lkg_anthropic_reasoning_run_invalid；成功返回 prefix + pristineTail 顺序拼接。
6. **validateLkgSeam — PASS（范围内项；见 F1/F2）**。重复 id/callId/resultId 拒绝；
   non-assistant 携带 reasoning part 拒绝；boundary 先于 seam 校验（unsafe_seam 在 seam_invalid 前），
   顺序与权威一致。但权威另有两项检查未移植（F1），boundary 最后一项未移植（F2），方向 fail-open。
7. **validateAnthropicReasoningRuns — PASS**。按合并 run（连续 assistant 消息）per-part 计数
   thinking 块，拒绝 thinkingBlocks>1 或 thinking-after-content；part 类型识别
   thinking/reasoning/redacted_thinking 与权威一致。
8. **lkgContentDigest — PASS**。N/S/D/B/U/A/O/X 类型化递归编码、sha256 base64url、确定性；
   环引用 → throw → catch → null（不抛）。stableMessagePayload 覆盖 user/assistant/toolResult/custom
   的 role + content + timestamp（+ toolCallId/toolName/isError、stopReason、customType/display/details），
   EXCLUDES usage/cost/api/provider/model（运行时元数据）。与 checklist 契约一致（有意偏离权威的
   whole-message hash，由 checklist 明示背书）。
9. **持久化 — PASS**。context_lkg_slots 表（PK (runtime_session_id, slot_key)、lkg_json TEXT、
   captured_at TEXT）与 store LkgSlot 一致；重新捕获 ON CONFLICT DO UPDATE 覆盖（context-store
   upsert 测试实测）；单 slot 24 MiB 预算（LKG_SINGLE_SLOT_BYTES）超限返回 false；capture 对
   no-safe-anchor / duplicate ids / null digest / oversized 返回 false。权威的 64 MiB 总量预算 +
   LRU 驱逐未移植（SQLite 每会话一行，合理适配，记录备查）。
10. **R2 边界 — PASS（见 F7）**。src/ 全量 grep：captureLkgSlot/replayLkg/buildLkgPrefix/
    findLkgAnchor/lkgContentDigest/LKG_SLOT_KEY 仅出现在 lkg.ts 与 context-store.ts（store 定义）。
    projection.ts:106、pass-taxonomy.ts:16 为注释；contracts/tool.ts:60 为 contextIntegrityMode
    联合类型字符串成员。无生产调用点；模块自包含 + 14 测试通过；R2 声明（capability layer +
    SQLite 持久化 + 测试，接线为 R3 Historian）诚实。

## 结论

VERDICT: NON_BLOCKING

R2 Feature 7 作为 capability 层验收合格：全部 10 项 checklist 范围内核验通过，14/14 测试与全门禁
通过，R2 声明诚实（无生产调用点）。但独立 parity 发现 5 项与权威的语义偏差（其中 2 项方向
fail-open），必须在 R3 Historian 接线前修复。

## Findings

- **F1（fail-open，R3 前必修）**：validateLkgSeam 未移植权威两项检查：
  (a) providerKey !== "anthropic" 时拒绝空 text/reasoning part（text === ""）；
  (b) assertOpenAiCompatAdjacency 角色邻接校验 + wire tool_calls 重复 id 校验。
  Iris 对这些 seam 放行（权威拒绝）。
- **F2（fail-open，R3 前必修）**：validateLkgSeamBoundary 未移植权威最后一项：
  prefix 末条含未完成 tool part（state.status !== "completed"）即判 unsafe；Iris 仅在
  tail 首条为 toolResult 或携带 last call id 时拒绝。已测用例（tail 以结果开头）正确拒绝；
  "tool call 悬挂、结果缺失"场景 Iris 放行。R3 前补齐。
- **F3（fail-closed 方向，建议对齐）**：noteLkgEntry 用 findLkgAnchor 重新推导 anchor，权威
  noteEntry 用 slot.lastInputMessageId 在窗口内 indexOf。正常窗口结果一致；active-assistant
  时间戳异常窗口下 Iris 更严格（更多 reshape 拒绝）。方向 fail-closed，无安全风险；R3 建议对齐
  权威定位语义。
- **F4（行为差异，R3 定策略）**：权威每次校验失败调用 dropSlot（slot 失效，此后 replay 返回
  lkg_invalidated_reshape）；Iris 保留 SQLite slot，重复 replay 返回同一 typed reason。
  fail-closed 不变；store 亦无 dropLkgSlot 方法。R3 需定义 retry/recapture 策略。
- **F5（防御性缺口）**：replayLkg 对"可解析但形状非法"的 payload（如缺 inputIdSeq）会在
  entryIdsAreValid 内对 undefined.length 抛 TypeError，而非返回 typed failure。SQLite 单行
  原子写使该路径实际不可达；建议补 payload 形状校验。
- **F6（测试覆盖）**：lkg_seam_invalid 无任何测试覆盖；lkg_unsafe_seam 与
  lkg_anthropic_reasoning_run_invalid 仅 validator 层直接测试，未经 replayLkg 端到端触发
  （commit message"all 6 failure reasons"实际 4/6 端到端）。另缺：anchor `<=` 排除分支、
  cyclic→null、usage/cost 排除、24 MiB 拒绝、captureLkgSlot duplicate-ids。
- **F7（规格绑定列表）**：规格 LKG"至少绑定"列表（materialization IDs、reshape fingerprint、
  serializer/carrier version、profile 等）仅实现 model/provider 子集 —— 与权威一致，R2 声明诚实；
  R3 接线需补齐其余绑定。
- **F8（synthetic output 折叠）**：outputMessageIsPostAnchor 对"不在 input map 的 custom 输出"
  无条件折叠进 prefix；权威先解析 linked id（sourceMessageId/ownerMessageId/anchorMessageId/
  messageId）再归类 post-anchor。direct id 匹配行为一致；该偏差仅在 output 含 input 之外的
  synthetic 消息时出现，且 replay 路径由 validateLkgSeam 重复 id 拒绝兜底（fail-closed）。

## 固定结论块

VERDICT: NON_BLOCKING

SPEC COMPLIANCE:
- 规格 LKG 语义（安全恢复槽、fail-closed replay、anchor 语义、provider-visible recovery prefix）满足；
  checklist 10 项范围内全部 PASS。
- 规格"至少绑定"完整列表（materialization IDs / serializer-carrier version / reshape fingerprint）
  仅实现权威同款子集（model/provider/ids/anchor/runtimeSessionId）；R3 接线补齐（F7）。

CODE CORRECTNESS:
- findLkgAnchor / buildLkgPrefix / entryIdsAreValid / entryContentIsValid /
  validateAnthropicReasoningRuns / lkgContentDigest / captureLkgSlot 与权威 48ab531d 逐行等价。
- 6 项偏差：F1/F2（seam 校验缺权威检查，fail-open）、F3（noteLkgEntry anchor 推导，fail-closed）、
  F4（失败不 drop slot）、F5（非法 payload 抛 TypeError）、F8（synthetic output 折叠）。
  F1/F2 为 R3 前必修。

RECOVERY/CONCURRENCY:
- replay 全程 typed fail-closed，7 个失败原因映射与顺序匹配权威；成功路径 prefix+pristineTail 有序。
- 持久化单行原子 upsert（ON CONFLICT DO UPDATE），WAL + busy_timeout + 5s 写锁防御已有（F2 基座）。
- F4/F5 为 R3 恢复策略输入，不影响 R2 fail-closed 属性。

TEST COVERAGE:
- 14/14 专用测试通过；全门禁 148 pass + 2 live skip 通过。
- 缺口：lkg_seam_invalid 零覆盖；lkg_unsafe_seam / lkg_anthropic_reasoning_run_invalid
  未端到端过 replayLkg；anchor `<=` 分支、cyclic→null、usage/cost 排除、24 MiB 拒绝、
  capture duplicate-ids 未测（F6）。

EVIDENCE ACCURACY:
- 权威 checkout 实测位于 48ab531d（v0.33.0），与仓库 provenance 一致。
- commit message "14 tests"、"6 failure reasons"：14/14 属实；6 reasons 中 4 个端到端、
  2 个仅 validator 层、1 个（lkg_seam_invalid）零覆盖 —— "all 6 failure reasons" 表述过强（F6）。
- 本评审所有命令真实执行并记录输出；未修改任何源代码。

FINDINGS:
- F1（fail-open）validateLkgSeam 缺空 text part 拒绝与 OpenAI-compat 邻接校验 —— R3 前必修。
- F2（fail-open）validateLkgSeamBoundary 缺"末条未完成 tool part"检查 —— R3 前必修。
- F3 noteLkgEntry anchor 推导与权威不同（更严，fail-closed）—— 建议对齐。
- F4 校验失败后 slot 不失效（无 dropSlot），重复 replay 返回同一 reason —— R3 定策略。
- F5 非法 payload 形状可致 TypeError 而非 typed failure —— 建议补形状校验。
- F6 测试覆盖缺口（lkg_seam_invalid 零覆盖等）。
- F7 规格完整绑定列表未实现（与权威一致），R3 补齐。
- F8 synthetic output 折叠逻辑与权威 linked-id 解析不同，duplicate-id 兜底 fail-closed。
