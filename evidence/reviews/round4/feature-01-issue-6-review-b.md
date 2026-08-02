# Round 4 — Feature 01 — Issue #6 独立评审 B

## Reviewer Role

Reviewer #6-B：Recovery / Idempotency / Duplicate-Delivery / Test Quality 评审员（恢复、幂等、重复投递与测试质量评审，非实现者）。

评审对象：fix(host): preserve raw Pi Session entry identity during ingress reconciliation（commit 441c329，fixes #6）。

## Reviewed Baseline / Head

- Reviewed baseline：59a85b8（Merge pull request #5 from blueforst/agent/r1-p2-long-lived-host-rollover）
- Reviewed HEAD：441c3298272cb50843572724d5c7342a407ee359（fix(host): preserve raw Pi Session entry identity during ingress reconciliation）
- Diff：`git diff 59a85b8...HEAD`（5 文件，+809/-24）

## Files Reviewed

- src/runtime/session-projection.ts（新增：ProjectedSessionMessage + projectSessionMessages，85 行）
- src/runtime/context-adapter.ts（新增 findInputPairsByProjection，raw_adjacent / parent_chain 配对）
- src/host/host.ts（reconcileUncommitted 改用 projection，pi_user_entry_id 写入真实 raw entry id）
- src/host/ingress.ts（recoverUncommitted 只取 accepted 行；markSessionCommitted 写入 pi_user_entry_id 并从队列移除；rewindToAccepted 测试缝；loadEnvelopeVerified 为唯一信封读取路径）
- src/runtime/companion.ts（createInputMetaCompanion / derivePairKey / verifyCompanionLayoutHash / encodeInputFrames）
- src/runtime/harness-factory.ts（before_agent_start 注入 companion）
- src/runtime/pi-runtime-adapter.ts（resolveCommittedPair —— 仍保留旧压缩索引模式，见 FINDINGS F1）
- src/contracts/context.ts（IRIS_INPUT_META_CUSTOM_TYPE / IRIS_INPUT_META_CONTENT）
- src/db/migrations/ingress/0001_bootstrap.sql（pi_user_entry_id 列）
- test/reconcile-raw-identity.test.ts（新增 612 行，13 个用例）
- test/host.test.ts（A1 L486-539、review-pass2 #1 L541-589、review-pass3/4/6/7 相关用例）
- package.json（test 脚本纳入 reconcile-raw-identity.test.ts）

## Upstream / Pi Storage 语义 Reviewed

- node_modules/@earendil-works/pi-agent-core/dist/harness/session/session.js（appendMessage / appendCustomMessageEntry / appendLabel 均 parentId = getLeafId()）
- node_modules/@earendil-works/pi-storage-sqlite-node/dist/sqlite/storage/shared.js（leafIdAfterEntry：非 leaf 类型 entry 落盘后 leaf = entry.id）
- node_modules/@earendil-works/pi-storage-sqlite-node/dist/sqlite/storage/index.js（appendEntry 事务写入 + leaf 更新；getEntries 按 entry_seq 升序返回全部 entry）
- node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js（prompt 期仅追加 message 类 entry；model_change/active_tools_change 仅在 setter 中追加；before_agent_start 返回 messages 追加在 user 之后）
- node_modules/@earendil-works/pi-agent-core/dist/harness/types.d.ts（SessionTreeEntry union；custom_message entry timestamp 为 ISO 字符串）

## Tests Reviewed / Executed（均为本评审实际执行）

1. `npx tsx --test test/reconcile-raw-identity.test.ts` → **13/13 pass，0 fail**（duration 4574ms）。输出摘要：13 个用例全部 ok（#1 model_change 前置、#2 active_tools_change 前置、#3 compaction 前置、#4 custom_message companion、#5 label 间隔 fail-closed、#6 parent chain 不一致 fail-closed、#7 同体双输入、#8 duplicate pair fail-closed、#9 pi_user_entry_id 精确断言、#10/#11 restart 不重提示、#12 错序 fail-closed、raw linkage 单测、parent_chain 单测）。
2. `npm test` → **102 tests，100 pass，0 fail，2 skipped**（skipped 为需要 OPENCODE_GO_API_KEY 的 live provider 用例）。issue-6 的 13 个用例已并入聚合（测试 #70-82 全部 ok）。
3. `npm run lint` → 通过。
4. `npm run typecheck`（tsc --noEmit）→ 通过。
5. `npm run migration:smoke` → idempotent，通过。
6. `npm run crash:check` → 7 个崩溃窗口边界全部通过（before_any_write / after_user_append / after_companion_append / after_epoch_created / after_settled / after_tool_result_commit / after_creating_epoch）。
7. `npm run build` → 通过。
8. `npm run test:subprocess` → 3/3 通过。
9. `npm run test:cli` → 6/6 通过。
10. `npm run dist:smoke` → ok。
11. `npm run check`（聚合门禁）→ **仅 format:check 失败**：`prettier --check .` 报 9 个 `evidence/notion-round4/*.md` 文件存在代码风格问题。已验证：该目录在基线 59a85b8 与 HEAD 441c329 的 git 树中均不存在（`git ls-tree` 两处均为空），属本地工作区未跟踪文件（`git status` 显示 `?? evidence/notion-round4/`），与提交 441c329 无关。提交涉及的 5 个文件（src/runtime/session-projection.ts、src/runtime/context-adapter.ts、src/host/host.ts、test/reconcile-raw-identity.test.ts、package.json）经 `npx prettier --check` 单独验证全部通过。其余所有代码相关门禁步骤均通过。

---

## Checklist Verification（逐项）

### 1. 幂等性：restart 后完整 durable pair 恰好提升一次，绝不 re-prompt —— PASS

- 测试 #10/#11 与 host.test.ts A1（L486-539）双路径验证：首轮 settle 后 rewindToAccepted 模拟 crash-before-settled，重启后断言 `after.state === "session_committed"`、`after.userEntryId === committedUserEntryId`（raw 身份跨重启稳定）、`events2.includes("turn_start") === false`（无第二次提示）。
- 代码层保证：recoverUncommitted（ingress.ts L396-411）只 SELECT `acceptance_state = 'accepted'` 行，session_committed 行永不重入；markSessionCommitted（L344-364）同时 removeFromQueue + markIdle，pump 无法再次提示。测试 #10/#11 实际通过（968ms）。

### 2. 恢复：crash-before-settled（accepted 记录 + 已存在 Pi pair）重启即提升 —— PASS

- rewindToAccepted（ingress.ts L454-463）为测试缝，仅用于模拟该窗口。重启后 IrisHost.open 内同步执行 recoverUncommitted → reconcileUncommitted，projection 配对 → markSessionCommitted。测试 #10/#11 断言提升发生且 userEntryId 与首轮完全一致（同一真实 raw entry）。通过。

### 3. Duplicate pair（同 inputId 两次）fail-closed 进 ambiguous，绝不静默覆盖 —— PASS

- 测试 #8：两次 appendVerifiedPair 同一 inputId，重启断言 `IrisHost.open` 拒绝 `/ambiguous ingress recovery for inputs: dup-0001/`。
- 代码路径核实：reconcileUncommitted L1129-1131 `verifiedPairs.has(key)`（复合 key = epoch+inputId+pairKey）→ duplicateIdentities.push；L1193 `ambiguous` 初始化为 duplicateIdentities，即使第 4 步 verified-pair 分支对该记录执行了 markSessionCommitted，inputId 仍在 ambiguous 集合中，L898-903 抛错 → 启动 fail-closed（not-ready）。绝不静默覆盖其中一个。通过。

### 4. 错序（companion 在 user 之前）fail-closed → 启动 not-ready —— PASS

- 测试 #12：companion 先 append。投影后配对循环只扫 (user, companion) 顺序相邻对，companion 在前不成对；user 的 wire 匹配 pending 信封 → orphan → ambiguous → 启动抛错。通过。

### 5. 非 message entry（label）夹在 user 与 companion 之间，同时破坏 raw adjacency 与 parent chain → fail-closed，绝不静默接受 —— PASS

- 测试 #5：label 落盘后 leaf = label（leafIdAfterEntry），companion 再 append 时 parentId = label ≠ user → rawIndex 不相邻（差 2）且 parentId 断链 → 不配对 → orphan wire 匹配 → ambiguous 启动抛错。
- 单元投影测试（L581-612）：projectSessionMessages 输出 rawIndex=1/3（label 被过滤但位置保留），findInputPairsByProjection 返回 0 对。通过。

### 6. 不一致 parent chain（companion 挂在另一条 message 上）→ 不通过验证 → fail-closed —— PASS

- 测试 #6：B 的 companion 与 B 的 user 之间插入 assistant message，companion.parentId = assistant entry ≠ user B entry → 不配对 → B 的 orphan wire 匹配 → 启动抛错；同时 A 的合法配对仍被提升为 session_committed。通过。

### 7. 相同 body、两个不同 inputId：保持各自 raw 身份，两者都提升，pi_user_entry_id 各自正确 —— PASS

- 测试 #7：pairA.userEntryId ≠ pairB.userEntryId（真实不同 raw entry），两条记录均 session_committed 且 userEntryId 与 appendVerifiedPair 返回的原始 id 精确相等。通过。

### 8. pi_user_entry_id 精确等于真实 raw UserMessage entry id，绝不为 model_change/companion entry id —— PASS

- 测试 #9：前置 model_change + active_tools_change 使 raw 数组与压缩消息数组发散（旧 bug 场景）；reopen 后断言 rawUser.type === "message" 且 message.role === "user"；record.userEntryId === userEntryId，且 !== modelChangeId、!== companionEntryId。通过。

### 9. companion 以真实 Pi custom_message entry 持久化（appendCustomMessageEntry）仍正确配对 —— PASS

- 测试 #4：appendCustomMessageEntry 持久化 companion，reopen 断言 entry.type === "custom_message"，经 IrisHost.open 成功 session_committed 且 userEntryId 正确。projectSessionMessages L62-81 将 custom_message 提升为 { role:"custom", customType, content, display, details?, timestamp: new Date(entry.timestamp).getTime() }，与 isInputMetaCompanion（role/customType/content/display 四字段）完全匹配。通过。

### 10. 测试质量：真产品路径（真实 SqliteSessionRepo + IrisHost.open + 真实 companion 生成器）—— PASS

- 13 个用例中 11 个走完整启动路径：真实 openOrCreateSession / SqliteSessionRepo、真实 InputAcceptanceLedger.accept、真实 createInputMetaCompanion + computeContentLayoutHash（非伪造 companion）、真实 IrisHost.open（内部 recoverUncommitted → reconcileUncommitted → markSessionCommitted 全链路）。#4/#9 还用真实 repo.open(metadata) + getEntries 复核原始 entry。仅最后 2 个用例是纯函数单测（projection + 配对规则），属适当的单元级覆盖。关键路径无任何 mock。通过。

### 11. 崩溃窗口与 custom_message timestamp（string→number）—— PASS（无缺口）

- 已覆盖窗口：完整 pair 后-settle 前（#10/#11、A1）；仅 UserMessage 无 companion（host.test.ts review-pass2 #1 → fail-closed）；session_committed 后重启（ingress crash window 5 测试）；crash:check 7 边界（无合成修复、可重开）。projection 对 custom_message 的 timestamp 转换 `new Date(entry.timestamp).getTime()` 与 CustomMessage.timestamp（number）一致；配对逻辑完全不使用 timestamp，`isInputMetaCompanion` 不涉及时戳，因此 string/number 差异无功能影响。通过。

---

## Verdict

VERDICT: PASS

SPEC COMPLIANCE:

- 与 Pi leaf 语义完全一致：appendMessage/appendCustomMessageEntry/appendLabel 均 parentId = getLeafId()，leafIdAfterEntry 使非 leaf entry 落盘后 leaf = entry.id，因此"中间夹 label → companion.parentId 指向 label"的断链是 Pi 原生语义的直接结果，配对规则（raw_adjacent / parent_chain）据此正确判定，未自建平行配对语义。
- 修复彻底消除 reconcile 路径"压缩数组下标 → raw 数组下标"的错位（issue #6 核心），pi_user_entry_id 现在恒为 projection 携带的真实 raw UserMessage entry id（host.ts L1121、L1217-1222）。
- 唯一契约缺口：pi_user_entry_id 的第二个写入方（settle 路径 resolveCommittedPair，pi-runtime-adapter.ts L91-119）仍保留旧压缩索引模式，当前 Iris 流程不可触发（详见 FINDINGS F1）。

CODE CORRECTNESS:

- projectSessionMessages：类型守卫 + 直接遍历原始数组，rawIndex 指向原始下标，位置不被擦除；custom_message 提升形状与 Pi CustomMessage 逐字段匹配。
- findInputPairsByProjection：两条接受规则（raw_adjacent、parent_chain）均基于 raw 身份而非过滤数组位置；内容级校验（inputId/pairKey/layoutHash/envelope 全量比对）仍在 reconcile 下游把关，排除的配对绝不会误收。
- reconcileUncommitted 的 duplicate 判定（复合 key）与 ambiguous 集合逻辑在 duplicate 场景下即使 verified 分支提交了记录仍因 ambiguous 非空而抛错 fail-closed，逻辑闭环正确。
- typecheck / lint / build 全部通过。

RECOVERY/CONCURRENCY:

- 重启恢复路径：recoverUncommitted 只取 accepted → projection 配对 → 提升，幂等且唯一（#10/#11、A1 双重证明，无 turn_start）。
- 全部损坏/歧义场景（partial pair、duplicate、错序、间隔、断链、envelope 不匹配）fail-closed 进入 not-ready，绝不静默覆盖、绝不误提升、绝不 re-prompt。
- 无新增共享可变状态；projection 为纯函数，恢复流程仍在启动锁内串行执行，无并发风险引入。

TEST COVERAGE:

- 13 个新用例全部通过（实际执行），覆盖检查清单全部 12 项，且为真产品路径。
- 全量 102 测试 100 pass 0 fail（2 skipped 为 live provider），crash:check 7 边界全过，migration:smoke idempotent。
- 缺口（非阻塞）：(a) 无 settle 路径（resolveCommittedPair）含前置非 message entry 的用例（当前流程不可达，见 F1）；(b) 无"同 inputId 不同 body 的重复 pair"用例（见 F2）；(c) parent_chain 仅在纯函数单测中覆盖，无经 leaf 复位触发的端到端用例（见 F3）。

EVIDENCE ACCURACY:

- commit message"13 new product-path tests"属实；"reconcileUncommitted() 写入真实 raw UserMessage entry id"对 reconcile 路径属实；"never re-prompts an input whose durable pair exists"对 reconcile 路径属实。
- 注意：commit message 未提及 settle 路径 resolveCommittedPair 仍保留旧模式（对 pi_user_entry_id 全生命周期的表述略超范围）。
- `npm run check` 在本工作区因未跟踪的 evidence/notion-round4/*.md 文件触发 prettier 失败（非提交所致，基线/HEAD 均无这些文件），不影响本提交的正确性；提交涉及的 5 个文件 prettier 检查全部通过。

FINDINGS:

- F1（NON_BLOCKING，建议跟进）：src/runtime/pi-runtime-adapter.ts L91-119 resolveCommittedPair() 仍使用 `entries.map(message).filter(...)` 压缩 + `messages.indexOf(pair.userMessage)` → `entries[userIndex]` 的旧模式，且为 pi_user_entry_id 的第二个写入方（host.ts L468 settle 路径）。已核实当前不可触发：agent-harness.js 的 constructor 直接赋值 model/tools 不追加 entry；model_change/active_tools_change/thinking_level_change 仅在 setter 中追加，Iris 全仓库无 setModel/setTools 调用（grep 0 命中）；prompt 期间仅 message 类 entry 追加，companion 紧跟 user 落盘，故压缩下标 == raw 下标。但任何未来在活动 session 追加非 message entry 的代码都会使该路径重蹈 issue #6 覆辙。建议迁移至同一 projection 并补 settle 路径用例，使"pi_user_entry_id 恒为真实 raw UserMessage entry id"成为两条写入路径的共同不变量。
- F2（观察，无需阻塞）：同 inputId 但不同 body（不同 pairKey）的重复 pair 不会 fail-closed——复合 key 含 pairKey，两条 pair 各占一个 key 不触发 duplicate；信封只匹配其中一条，另一条被 consumed 后静默忽略（不误提升、不 re-prompt、不污染其它 inputId，因 inputId 嵌入 pair 且信封按 inputId 绑定）。无测试覆盖该形态（测试 #8 仅覆盖同 body 即同 pairKey）。如希望对此类本地损坏也显式 fail-closed，可将 duplicate 判定扩展为按 (epoch, inputId) 而非 (epoch, inputId, pairKey)。
- F3（观察）：parent_chain 单测构造的 entry 序列（session_info 夹中间但 companion.parentId = user）无法由线性 append 产生，仅可能经 Pi leaf 复位/分支操作出现。规则本身正确且下游有全量内容校验兜底，但建议在可行时补一个 leaf 复位触发 parent_chain 的 reconcile 端到端用例，避免该分支只被纯函数单测覆盖。

## Fix Recommendations

1. （建议）将 resolveCommittedPair 迁移至 projectSessionMessages + findInputPairsByProjection，与 reconcileUncommitted 共用同一投影不变量；并补一个"session 前置 model_change/compaction 后 settle 路径写入 pi_user_entry_id 仍正确"的用例。
2. （可选）评估是否将 duplicate 判定扩展到 (epoch, inputId) 维度，使同 inputId 不同 body 的重复 pair 也进入 ambiguous 而非静默忽略。
3. （可选）为 parent_chain 分支补充经真实 leaf 复位触发的端到端 reconcile 用例。
4. （环境清理，与提交无关）`npm run check` 的 format:check 失败源于本地未跟踪的 evidence/notion-round4/*.md；建议在 CI 中只对跟踪文件做 prettier 检查，或在合并前将这些文件纳入格式化/移出仓库。


---

# RE-REVIEW — F1 修复复审（commit d36a411）

## 复审范围

针对首轮评审 FINDINGS F1（src/runtime/pi-runtime-adapter.ts resolveCommittedPair 仍使用压缩数组索引模式，为 pi_user_entry_id 第二写入方）的修复复审。

- 复审 HEAD：d36a41122ef9db0f8b7c2a2cbd6b38a469ec01a6（fix(host): settle path resolveCommittedPair honors raw-entry identity (review F1)）
- 完整修复范围：441c329 + d36a411 两个提交
- 复审 diff：`git diff 441c329...HEAD`（src/runtime/pi-runtime-adapter.ts +37/-20，test/reconcile-raw-identity.test.ts +61，及 evidence 提交）

## F1 修复核验（逐项）

### 1. resolveCommittedPair 与 reconcileUncommitted 共用同一 raw-entry projection —— PASS
- pi-runtime-adapter.ts L95-97：`const projected = projectSessionMessages(entries); const pairs = findInputPairsByProjection(projected);`
- L109-111：返回 `pair.user.entryId` / `pair.companion.entryId`（投影携带的真实 raw entry id，来自 ProjectedSessionMessage.entryId）。
- 已彻底移除 `entries.map(...).filter(...)` 压缩与 `messages.indexOf(...)` → `entries[index]` 映射；未使用的 `SessionTreeEntry`/`AgentMessage`/`findInputPairs` 导入一并清理。
- 全 src/ grep `messages.indexOf|entries\[.*index|findInputPairs(messages)` 仅剩 harness-factory.ts L158 `const entry = entries[index]`——这是 tool_result 钩子对 raw 数组按 index 从尾部倒扫定位含目标 toolCallId 的 assistant 消息，逐项校验 `entry.type === "message"` 与 role，属合法直接遍历，非"压缩下标→raw 下标"映射。`findInputPairs` 仅在 context-adapter.ts L213（live transformContextMessages 路径）保留，该路径不写入 pi_user_entry_id，与 issue #6 无关。
- 结论：pi_user_entry_id 两个写入方（reconcile 路径 host.ts L1217-1222 与 settle 路径 host.ts L468→resolveCommittedPair）现已共享"恒为真实 raw UserMessage entry id"这一共同不变量。

### 2. settle 路径测试为真实 native settle 流程 + model_change 前置 —— PASS
- 测试 #14（test/reconcile-raw-identity.test.ts 末尾新增）：openSessionFor 预建 active Epoch + Session → appendModelChange（raw 数组为 [model_change, user, companion]）→ 同一 data root 上 IrisHost.open → host.run() + acceptInput → waitFor settled（真实 native settle 事件）→ host.ts L468 resolveCommittedPair 写入 pi_user_entry_id → 重新打开 SqliteSessionRepo 读取原始 entries，断言 `record.userEntryId === userEntry.id` 且 `!== modelChangeId`。
- 该用例在旧代码下必然失败（messages.indexOf(user)=0 → entries[0]=model_change id），是真正的回归测试。实际执行通过（147.9ms）。
- 唯一小瑕疵：settle 流程由 Host 注入的 companion 是 Pi `message` 类型（role custom，before_agent_start 钩子），因此 settle 路径测试未覆盖"companion 以 custom_message entry 持久化"的形态——但该形态已由 reconcile 路径测试 #4 覆盖，且 resolveCommittedPair 与 reconcileUncommitted 共用同一投影/配对函数，行为一致，不构成缺口。

### 3. 恢复/幂等测试（#10/#11 restart 提升 + 无 re-prompt）不受影响 —— PASS
- 聚合 `npm test` 中 #79（issue-6 #10/#11 restart 提升且无 turn_start）与 #31（host.test.ts A1）均通过；#77（duplicate fail-closed）、#80（错序 fail-closed）、#74（label 间隔 fail-closed）等恢复/幂等/重复投递用例全部通过。
- 代码改动仅限 settle 路径的 entry id 绑定方式，reconcileUncommitted 未改动，重启恢复行为不变。

### 4. 聚合门禁全绿 —— PASS
- `npm run check` 完整通过：format:check（evidence/notion-round4/*.md 与 reviews 已在 d36a411 提交并格式化，prettier 全绿）→ lint → typecheck → npm test（**103 tests，101 pass，0 fail，2 skipped**，skip 为需 OPENCODE_GO_API_KEY 的 live provider 用例）→ migration:smoke（idempotent）→ crash:check（7 边界全过）→ build → test:subprocess（3/3）→ test:cli（6/6）→ dist:smoke（ok）。
- 单独运行 `npx tsx --test test/reconcile-raw-identity.test.ts` → **14/14 pass**（4.7s）。

---

## 复审 Verdict

VERDICT: PASS

SPEC COMPLIANCE:
- F1 已闭环：pi_user_entry_id 的两个写入方（reconcileUncommitted 与 resolveCommittedPair）现在共同遵循"恒为真实 raw UserMessage entry id"的投影不变量，issue #6 的契约对 pi_user_entry_id 全生命周期成立。
- 首轮 F2/F3（同 inputId 不同 body 的重复 pair 静默忽略；parent_chain 仅纯函数单测覆盖）为可选观察项，不阻塞本次修复，d36a411 未改变相关行为。

CODE CORRECTNESS:
- resolveCommittedPair 复用 projectSessionMessages + findInputPairsByProjection，配对与 entry id 来源与 reconcile 路径完全一致；删除未使用的类型导入与旧函数引用。
- 唯一残留的 `entries[index]`（harness-factory.ts tool_result 钩子）为 raw 数组直接倒扫定位 assistant entry，逐项校验 entry.type/role，非压缩索引映射，无 issue #6 风险。

RECOVERY/CONCURRENCY:
- settle 路径修复后，原生 settle → markSessionCommitted 写入的 pi_user_entry_id 在存在前置非 message entry 的 session 中也指向真实 raw UserMessage entry；重启恢复路径行为不变（#10/#11、A1 仍通过）。
- 无新增共享可变状态；resolveCommittedPair 仍为只读 Session 查询，无并发风险。

TEST COVERAGE:
- 新增 settle 路径回归用例 #14（真实 native settle + model_change 前置 + 原始 entry 复核），旧代码下必失败，是有效的 F1 回归测试。
- 全量 103 单元测试 101 pass 0 fail（2 live skip），crash:check 7 边界、subprocess 3、CLI 6、migration:smoke、build、dist:smoke 全绿。

EVIDENCE ACCURACY:
- commit d36a411 message 声称"Full npm run check passes: 103 unit tests (101 pass, 2 live skip)"——本复审实际执行确认属实。
- 首轮"F1 为潜在缺陷、当前不可触发"的判断与修复方向一致；修复实现了两条写入路径的共同不变量。

FINDINGS:
- F1：已修复（关闭）。resolveCommittedPair 迁移至同一投影，回归测试 #14 覆盖。
- F2（观察，保持开放，可选）：同 inputId 不同 body 的重复 pair 静默忽略，无测试覆盖；不影响本次评审结论。
- F3（观察，保持开放，可选）：parent_chain 仅纯函数单测覆盖，无 leaf 复位端到端用例；不影响本次评审结论。
- 新增观察（无需处理）：settle 路径测试 #14 的 companion 为 Pi `message` 形态（before_agent_start 注入），custom_message 形态的 settle 路径未单独覆盖——因两条路径共用同一投影/配对函数，行为等价，且 reconcile 路径测试 #4 已覆盖 custom_message 形态。

## 复审 Fix Recommendations

1. （已完成）resolveCommittedPair 迁移至 projectSessionMessages + findInputPairsByProjection —— 已在本提交落地并验证。
2. （可选，保持）F2：duplicate 判定扩展到 (epoch, inputId) 维度，或为该形态补一个 fail-closed 测试。
3. （可选，保持）F3：补 parent_chain 经真实 leaf 复位触发的 reconcile 端到端用例。
4. （可选，极低优先级）settle 路径补一个 companion 经 appendCustomMessageEntry 持久化的用例，锁定"两条写入路径 + 两种 companion 持久化形态"的四象限组合。
