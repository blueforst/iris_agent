# Round 4 — Feature 01 — Issue #6 独立评审 A

## Reviewer Role

Reviewer #6-A：Pi Session raw-entry / parent-chain 规格与状态机评审员（SPEC + STATE-MACHINE review，非实现者）。

评审对象：fix(host): preserve raw Pi Session entry identity during ingress reconciliation（commit 441c329，fixes #6）。

## Reviewed Baseline / Head

- Reviewed baseline：59a85b8（Merge pull request #5 from blueforst/agent/r1-p2-long-lived-host-rollover）
- Reviewed HEAD：441c3298272cb50843572724d5c7342a407ee359（fix(host): preserve raw Pi Session entry identity during ingress reconciliation）
- Diff：`git diff 59a85b8...HEAD`（5 文件，+809/-24）

## Files Reviewed

- src/runtime/session-projection.ts（新增：ProjectedSessionMessage + projectSessionMessages）
- src/runtime/context-adapter.ts（新增 findInputPairsByProjection，保留 findInputPairs）
- src/host/host.ts（reconcileUncommitted 改用 projection）
- src/runtime/companion.ts（createInputMetaCompanion / derivePairKey / verifyCompanionLayoutHash）
- src/host/ingress.ts（markSessionCommitted 写入 pi_user_entry_id）
- src/contracts/context.ts（IRIS_INPUT_META_* 常量）
- src/runtime/pi-runtime-adapter.ts（resolveCommittedPair —— 仍使用旧压缩索引模式，见 FINDINGS）
- src/runtime/harness-factory.ts（before_agent_start 注入 companion）
- test/reconcile-raw-identity.test.ts（新增 612 行，13 个用例）

## Upstream / Spec Reviewed

- node_modules/@earendil-works/pi-agent-core/dist/harness/types.d.ts（SessionTreeEntry union L306、MessageEntry L246、CustomMessageEntry L286-292）
- node_modules/@earendil-works/pi-agent-core/dist/harness/messages.d.ts（CustomMessage L18-25）
- node_modules/@earendil-works/pi-agent-core/dist/harness/session/session.js（appendMessage/appendCustomMessageEntry/appendLabel parentId = getLeafId()；appendTypedEntry 后 leaf 更新）
- node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js（constructor 直接 set model/tools 不追加 entry；prompt 只追加 message 类 entry；setter 才追加 model_change/thinking_level_change/active_tools_change）
- node_modules/@earendil-works/pi-storage-sqlite-node/dist/sqlite/storage/shared.js（leafIdAfterEntry：非 leaf 类型 entry 落盘后 leaf = entry.id）
- node_modules/@earendil-works/pi-storage-sqlite-node/dist/sqlite/storage/index.js（getEntries 按 entry_seq 升序返回全部 entry）
- evidence/notion-round4/01-context-assembly.md（Pi Input and Provenance Projection 章节 L111-121）
- evidence/notion-round4/04-input-origin.md（Pi Harness and Runtime Session Persistence L177+、Native Details Contract L248-262、L114 隐藏 companion 紧随其后）
- issue #6 全文（goal command 中给出的修复要求）

## Tests Reviewed / Executed

- test/reconcile-raw-identity.test.ts：13/13 通过（实际执行：`npx tsx --test test/reconcile-raw-identity.test.ts`）
- 全量：`npm run test` → 102 tests，100 pass，0 fail，2 skipped
- `npm run typecheck` → 通过（tsc --noEmit，无错误）
- 上述命令均为本评审实际执行结果

---

## Checklist Verification（逐项）

### 1. Projection 保留 rawIndex / real entryId / parentId / raw entry type —— PASS

session-projection.ts L15-27 的 ProjectedSessionMessage 携带 rawIndex（原始 SessionTreeEntry[] 下标）、entryId（entry.id，从不从数组位置推导）、parentId（entry.parentId）、entryType（"message" | "custom_message"）。projectSessionMessages 直接遍历原始数组（L47 `for (let rawIndex = 0; rawIndex < entries.length; ...)`），非 message/custom_message entry 被跳过但其位置不擦除（rawIndex 仍指向原始下标），相邻性可验证。

### 2. Pi `message` 与 `custom_message` 均显式处理 —— PASS

- isMessageEntry / isCustomMessageEntry 两个类型守卫显式区分。
- message entry：直接保留 entry.message。
- custom_message entry：提升为 `{ role: "custom", customType, content, display, details?, timestamp }`，与 Pi CustomMessage 接口（messages.d.ts L18-25：role "custom"、customType、content: string | (TextContent|ImageContent)[]、display: boolean、details?、timestamp: number）逐字段匹配（details 仅在 defined 时展开；timestamp 由 ISO 字符串转 ms 数值）。role 置 "custom" 使 isInputMetaCompanion（context-adapter.ts L51-58：role==="custom" && customType===IRIS_INPUT_META_CUSTOM_TYPE && content===IRIS_INPUT_META_CONTENT && display===false）对两种持久化方式都生效。

### 3. 不再存在从压缩数组位置推导 raw entry ID 的 reconcile 路径 —— PASS（reconcile 路径）/ 见 FINDINGS（resolveCommittedPair 残留）

- host.ts 已移除 `messages.indexOf` / `entries[` 模式：diff 显示旧代码 `entries[messages.indexOf(pair.userMessage)]` 与 orphan 段的 `messages.indexOf(message)` 全部替换为 projection 的 entryId。
- grep `messages.indexOf|entries\[messages|findInputPairs\(` 在 host.ts 中 0 命中。context-adapter.ts 的 findInputPairs 仅被 transformContextMessages 与 pi-runtime-adapter.ts 使用（非 reconcile 路径）。
- 残留问题：src/runtime/pi-runtime-adapter.ts L91-119 resolveCommittedPair() 仍为旧压缩-索引模式（`messages.indexOf(pair.userMessage)` → `entries[userIndex]`），且是 pi_user_entry_id 的第二个写入方（host.ts L468 settle 路径）。当前 Iris 运行流下 harness 在 prompt 中只追加 message 类 entry（agent-harness.js：constructor 直接赋值 model/tools 不追加；prompt 仅 message_end→appendMessage；model_change/active_tools_change 只在 setModel/setTools/setActiveTools 中追加，Iris 未调用），故该路径当前不被触发——为潜在缺陷（详见 FINDINGS F1）。

### 4. 配对规则对 Pi leaf 语义正确 —— PASS

Pi 语义验证：

- appendMessage/appendCustomMessageEntry/appendLabel 均 `parentId = await this.storage.getLeafId()`（session.js L146-153、L208-218、L220-231）。
- leafIdAfterEntry（shared.js L22-24）：非 leaf entry 落盘后 leaf 更新为 entry.id。
- 因此：UserMessage 后紧跟非 message entry（如 label）时，label 的 parentId=user，leaf=label；companion 再追加时 parentId=label ≠ user → 父子链断裂，rawIndex 也不相邻 → 排除。测试 #5 覆盖。
- 反之，companion 紧跟 UserMessage 时 parentId=user 且 raw_adjacent 成立；二者只要满足其一即接受，与"companion 紧随其后"（04-input-origin.md L114）的规格一致。
- parent_chain（companion.parentId===user.entryId 且不相邻）仅在 Pi 把 leaf 显式复位到 UserMessage（如 leaf entry / moveTo）时合法——该分支只放行权威 parentId 直连，不因中间隔了 label 而放行（label 会截获 leaf）。且即便进入 parent_chain，下游仍需 inputId/pairKey/layoutHash/envelope 全量内容校验才 promotion，不会误提。单元测试（L581-612）与路径测试 #5/#6 均验证正确排除分离配对。

### 5. 真实 UserMessage entry id 进入 markSessionCommitted → pi_user_entry_id —— PASS

host.ts L1121 `const userEntryId = pair.user.entryId`（projection 的 raw entryId，非数组位置推导）；L1217-1222 以 verified.userEntryId 调用 markSessionCommitted；ingress.ts L344-358 UPDATE ... SET pi_user_entry_id = ?。测试 #9 断言 pi_user_entry_id 精确等于真实 raw UserMessage entry id 且不等于 model_change id。

### 6. Orphan 检测使用 projected entry id —— PASS

host.ts L1166-1187：consumedUserEntries 以 verifiedPairs 的 userEntryId（projection entryId）构建；orphan 段遍历 projected，role==="user" 且未被 consumed 时以 projectedUser.entryId 记录。不再有压缩位置索引。

### 7. Fail-closed：duplicate / corrupt ordering / interleaved / broken parent chain —— PASS

- duplicate pair：L1129-1131 duplicateIdentities.push → ambiguous（测试 #8）。
- companion before user：配对循环只扫 (user, companion) 顺序，companion 在前的序列不形成 pair；orphan wire 匹配 → ambiguous（测试 #12）。
- interleaved message：中间夹了 assistant/其他 message 时 companion.parentId 指向中间 entry ≠ user → 不配对 → orphan → ambiguous（测试 #6）。
- broken parent chain：中间夹 label 时同理（测试 #5）。
- 全部以 not-ready/ambiguous 失败关闭，绝不静默 promote、绝不合成 companion、绝不 re-prompt（L1226-1233、L1242-1246）。

### 8. custom_message 作为一等 raw entry 识别 —— PASS

测试 #4 用真实 appendCustomMessageEntry 持久化 companion，reopen 后断言 entry.type==="custom_message"，并经 IrisHost.open 成功 session_committed 且 userEntryId 正确。提升形状与 Pi CustomMessageEntry 字段一一对应（见第 2 项）。

---

## Verdict

VERDICT: NON_BLOCKING

SPEC COMPLIANCE:

- 与 01-context-assembly.md "Pi Input and Provenance Projection"（L111-121：UserMessage + immediate companion → 一个 logical input projection；验证 pair key/content layout/hash/origin；缺/孤立/不一致时 fail-conservative）一致。
- 与 04-input-origin.md（L114 hidden companion 紧随其后；L177+ Pi Harness 直用原生 Session persistence；L248-262 Native Details Contract / pi_user_with_iris_meta_companion）一致。
- 修复彻底消除 reconcile 路径的压缩索引→raw 索引错位（issue #6 核心），pi_user_entry_id 现在绑定真实 raw UserMessage entry id。
- 唯一缺口：pi_user_entry_id 的另一个写入方（settle 路径 resolveCommittedPair）仍使用旧模式，当前不可触发但破坏"任何写入 pi_user_entry_id 的路径都保持 raw identity"的契约完整性。

CODE CORRECTNESS:

- projectSessionMessages 正确性：类型守卫 + 直接遍历原始数组，O(n)；对 undefined 元素防御（L49-51）。
- findInputPairsByProjection：raw_adjacent 与 parent_chain 两条接受规则与 Pi leaf 语义一致；内容级校验仍在 reconcile 下游把关；不会误收分离/错序/断链配对。
- 配对循环只遍历相邻 projected 对——raw_adjacent 配对必然相邻于投影数组，无漏配；其余情形正确排除。
- custom_message 提升形状逐字段匹配 Pi CustomMessage；details 可选展开。
- typecheck 通过；无任何测试失败。

RECOVERY/CONCURRENCY:

- 重启恢复（reconcileUncommitted）与运行期 settle（resolveCommittedPair）两个写入路径在"已存在 durable pair"时都保证不 re-prompt（L466-477 settle、L1214-1224 reconcile）。
- 失败关闭路径全部进入 ambiguous（not-ready）而非误 promote，符合 AGENTS.md 恢复语义。
- 并发层面无新增共享可变状态；projection 为纯函数。

TEST COVERAGE:

- 13 个新用例全部通过（实际执行）：model_change/active_tools_change/compaction 前置、custom_message companion、label 间隔（fail-closed）、parent chain 不一致（fail-closed）、同体多输入、duplicate pair（fail-closed）、pi_user_entry_id 精确断言、restart 不重提示、错序（fail-closed）、raw linkage 单元分类、parent_chain 单测。
- 全量 102 测试 100 pass 0 fail（2 skipped），typecheck 通过。
- 缺口：无覆盖"settle 路径（resolveCommittedPair）在 session 存在非 message entry 前置时"的用例（当前流程不可达，见 F1）；无覆盖 parent_chain 通过 leaf 复位合法触发时 reconcile 全链路（含 envelope 校验）的端到端用例（当前仅单测覆盖配对层）。

EVIDENCE ACCURACY:

- commit message 中"13 new product-path tests"属实；"reconcileUncommitted() 写入真实 raw UserMessage entry id"属实（该路径）。
- commit message 表述"never re-prompts an input whose durable pair exists"对 reconcile 路径属实。
- 注意：commit message 未提及 settle 路径（resolveCommittedPair）仍保留旧模式，作为对 pi_user_entry_id 全生命周期的表述略超范围，建议在后续提交中同步。

FINDINGS:

- F1（NON_BLOCKING，建议跟进）：src/runtime/pi-runtime-adapter.ts L91-119 resolveCommittedPair() 仍使用 `entries.map(message).filter(...)` 压缩 + `messages.indexOf(pair.userMessage)` → `entries[userIndex]` 的旧模式，且为 pi_user_entry_id 的第二个写入方（host.ts L468 settle 路径）。当前 Iris 流程中 Pi harness 在 prompt 期间只追加 message 类 entry（model_change/thinking_level_change/active_tools_change 仅在 setter 中追加，Iris 不调用；无 compaction/label/session_info 追加），因此当前不可触发错误绑定；但任何未来在活动 session 中追加非 message entry 的代码（label、session_info、compaction、model 切换）都会让该路径重蹈 issue #6 覆辙。建议将 resolveCommittedPair 迁移到同一 projection（projectSessionMessages + findInputPairsByProjection），并补一个含前置非 message entry 的 settle 路径用例，使"pi_user_entry_id 恒为真实 raw UserMessage entry id"成为两条写入路径的共同不变量。
- F2（观察，无需阻塞）：parent_chain 分支只验证 companion.parentId === user.entryId，未验证中间是否存在其它 user/assistant message（需 Pi 将 leaf 显式复位到 UserMessage 才可能出现，正常 append 语义下 leaf 恒被中间 entry 截获）。当前内容级校验（inputId/pairKey/layoutHash/envelope）已兜底，不会误 promote；若未来要求更严，可对 parent_chain 增加"中间 raw 段不含其它 message entry"检查。
- F3（观察）：projectSessionMessages 对 entry 含 undefined 的防御（L49-51）与 `userEntryId === ""` 防御（host.ts L1122）均为无害冗余，可保留。
