# Feature 3 (P0-P5 logical projection units) — Projection/provenance 独立评审

## Reviewer 角色

Projection/provenance reviewer（R2 Feature 3：P0–P5 logical projection units）。本评审由独立 reviewer 执行，非实现者本人，目标为验证 P5 逻辑单元投影的来源保真（raw identity / range / hash / ordering）、配对单一基础、tool arc 密封与 R2 边界合规性。

## Reviewed Baseline

`a62b0f7` docs(evidence): record Feature 2 dual-review PASS + busy_timeout hardening

## Reviewed HEAD

`8691a215af89c55d48380a016343eeb9a22f26d0` feat(context): P0-P5 logical projection units (R2 Feature 3)
（HEAD 处工作树干净，无未提交改动）

## 审查文件清单

- `src/context/projection.ts`（全文 494 行）— 新增，P0–P5 类型与 `projectLogicalUnits()`
- `test/context-projection.test.ts`（全文 330 行，10 个测试）— 新增
- `package.json` — 仅把 projection 测试加入 `npm test` 文件列表（+1 行）
- `src/runtime/session-projection.ts` — 被复用的 identity-preserving projection
- `src/runtime/context-adapter.ts` — `findInputPairsByProjection`（raw-adjacency/parent-chain 规则）
- `src/runtime/companion.ts` — `IrisInputMetaDetails`、`derivePairKey`、`verifyCompanionLayoutHash`
- `src/runtime/harness-factory.ts` — toolResult `details.iris.toolExecutionKey` 契约来源
- `src/runtime/pi-runtime-adapter.ts`、`src/host/host.ts` — ingress 配对消费方（`findInputPairsByProjection` 调用点）
- `src/context/context-store.ts` — `representedThroughEntrySeq` / `lastSafeUserAnchorEntrySeq` / `protectedTailStartEntrySeq` watermark
- `src/contracts/context.ts` — `IRIS_INPUT_META_CONTENT`/`IRIS_INPUT_META_CUSTOM_TYPE`
- 规格：`evidence/notion-round4/01-context-assembly.md`（Context Layers、Pi Input and Provenance Projection、Physical Layout）、`evidence/notion-round4/00-module-boundaries.md`（Context 所有权；"P5 boundary 由 m0+m1 已表示的最后一个 committed Compartment endEntrySeq 决定"；"Context 与 Historian 必须共用…不得各自重新推导 UserMessage/companion"）
- OpenCode authority（语义参考，非拷贝）：`tag-messages.ts`（composite tool owner key：`<ownerMsgId>\x00<callId>` 的 FIFO 配对）、`read-session-raw.ts`（ordinal-anchored raw unit 概念）

## 实际执行测试与输出

### 1) `npx tsx --test test/context-projection.test.ts`

10/10 PASS，0 fail，0 skip：

- projection: P0/P1/P2 types are structurally sound
- projection: P3/P4 are read-port inputs (never fake production Historian)
- projection: verified input pair becomes one input unit with real entry ids
- projection: assistant + toolResult produce tool_arc with adjacency from durable key
- projection: reasoning unit detected from thinking parts
- projection: compaction and branch boundaries become units with real ids
- projection: provenance — projection hash is deterministic and order-stable
- projection: unverified/orphan user (no companion) is fail-conservative
- projection: empty session projects cleanly with zero units
- projection: P5 boundary uses m0/m1 represented watermark contract

### 2) `npm run check`（全门禁）

全部通过：

- format:check（prettier）PASS；lint（eslint）PASS；typecheck（tsc --noEmit）PASS
- `npm test`：125 tests，pass 123，fail 0，skip 2（2 个 live provider 测试因无 OPENCODE_GO_API_KEY 跳过）
- test:context-golden：4/4 PASS
- test:context-migrations：12/12 PASS
- migration:smoke：idempotent PASS
- crash:check：7 个 boundary 全部 ok
- build（tsc + copy-migrations）PASS
- test:subprocess：3/3 PASS
- test:cli：6/6 PASS
- dist:smoke PASS

## Checklist 核验结果

1. **P0/P1/P2 系统前缀 + P3/P4 仅 read-port/fixture** — 通过。P0/P1/P2 为纯类型（frozen system prefix 由 prepared ContextSourceSnapshot 提供）；P3/P4 注释明确 "R2 read-port/fixture input only"，`P3CommittedInput.compartments` 可选、无生产 Historian/Memory 声明，无任何构造 P3/P4 的生产代码。
2. **P5 保留真实 raw entry id / range / contentHash / raw ordering** — 通过。`entrySeqById` 以真实 `entry.id` 为键（raw 数组 index+1）；input/assistant/tool_result 单元携带真实 entryId；`entryRange` 起止均为 raw seq；单元排序由 raw seq 决定（stable sort 处理同 seq 平局）。
3. **input 折叠 + 同一配对基础 + 孤儿不成为 anchor** — **部分通过（有偏差，见 Finding 1）**。raw-adjacency/parent-chain 的 *linkage 规则* 与 `findInputPairsByProjection` 一致；孤儿场景（测试 8）正确 fail-conservative、不成为 `lastSafeUserAnchor`。但投影内联重写了配对循环，companion 谓词弱于 ingress（缺 content/display/pairKey 三条件），且 `verified` 仅表示"存在相邻 companion"，未做 pairKey/布局 hash 校验。
4. **tool arc 密封** — **部分通过（见 Finding 2、3）**。密封本身正确：pre-index 先行索引 toolResult，assistant 单元遇到 toolCall 时即可拿到真实 `toolResultEntryId` 成弧，arc 带双真实 entry id、`sealed:true`、raw 顺序正确。但注释声称的"durable key 证明邻接"与实现不符（实现按 message 级 `toolCallId` 索引，未使用 `details.iris.toolExecutionKey`/`assistantEntryId`）；tool_result 单元的 `toolName` 字段被填入 toolExecutionKey 哈希而非真实工具名。
5. **reasoning / compaction / branch 单元** — 通过。`thinking` part 检测正确；compaction/branch 边界携带真实 `entry.id`、`summary`、`firstKeptEntryId`、`fromId`。
6. **确定性** — 通过。同输入 → 同 `projectionHash`（测试 7）；空 session 哈希 = sha256("") 硬断言；单元按 raw 位置排序稳定。
7. **fromEntrySeq/toEntrySeq + live-tail watermark 契约** — 通过。投影暴露 from/to raw seq；测试 10 演示超出 `representedThrough` 的 live-tail 计算；`context-store.ts` lineage 已存在 `representedThroughEntrySeq`、`lastSafeUserAnchorEntrySeq`、`protectedTailStartEntrySeq`，接线点齐备。
8. **R2 边界：无 synthetic assistant/toolResult 修复；孤立 companion 丢弃** — 通过。不生成任何合成单元；`role:"custom"` 的孤立条目直接跳过。
9. **无回归：投影路径无压缩数组索引推导** — 通过。identity 全部来自真实 entry.id；仅有的数组位置回退（`?? index + 1`）为不可达死代码。

## Findings

### Finding 1（主要，NON_BLOCKING 前提下的必改项）— "one pairing basis" 声明不成立，`verified` 语义弱于 ingress

`projection.ts:231-254` 内联重写了配对循环，而**没有复用** `findInputPairsByProjection`（`context-adapter.ts:75-112`）。两者 linkage 规则相同（`rawIndex===user.rawIndex+1` 或 `companion.parentId===user.entryId`），但 companion 身份谓词不同：

- ingress `isInputMetaCompanion` 要求 `role==="custom" && customType===IRIS_INPUT_META_CUSTOM_TYPE && content===IRIS_INPUT_META_CONTENT && display===false`，并且 pairKey 必须为 string（`context-adapter.ts:85-92`）；
- 投影仅要求 `role==="custom" && customType===IRIS_INPUT_META_CUSTOM_TYPE`。

实测复现（tsx 脚本，仅读不改）：
- Case A：companion customType 正确、content 为 `"EVIL-OTHER"`、`display:true`、无 pairKey → 投影 `verified=true` 且成为 `lastSafeUserAnchor`；ingress `findInputPairsByProjection` 返回 0 对。
- Case B：companion content/display 正确但无 pairKey → 投影 `verified=true` 且成为 anchor；ingress 返回 0 对。

后果：`verified` 在投影中仅表示"存在相邻/挂链 companion"，未执行 ingress 级别的 pairKey 重算与 `verifyCompanionLayoutHash`（host.ts:1085-1117 的完整验证链）；corrupt companion 可错误成为 LKG 的 "last safe real-user anchor"（规格 LKG 一节、`01-context-assembly.md` "Pi Input and Provenance Projection" 要求验证 pair key/layout/hash，hash 不一致必须 fail-conservative）。`00-module-boundaries.md` 明令 "Context 与 Historian 必须共用…不得各自重新推导 UserMessage/companion"。提交信息中 "one pairing basis for the whole path" 与实际代码不符。影响当前为潜伏态（`projectLogicalUnits` 尚未被任何 src/ 生产路径消费，仅测试引用），但必须在接线 LKG/Historian（Feature 6+）前修复。

修复建议：直接调用 `findInputPairsByProjection(projected)` 复用同一发现谓词，或补上 content/display/pairKey 三条件；若 `verified` 需要表示完整校验，则应沿用 host.ts/transformContextMessages 的 pairKey+layoutHash 验证链。

### Finding 2（代码正确性）— tool_result 单元 `toolName` 字段被填入 toolExecutionKey 哈希

`projection.ts:377-399`：`toolName: details?.iris?.toolExecutionKey ?? ""`，同时把同一值写入可选 `toolExecutionKey` 字段。而 Pi `ToolResultMessage` 自带 `toolName`（`pi-ai/dist/types.d.ts:293-296`；harness-factory 写入的是真实工具名，见 `agent-loop.js` 的 `toolName: finalized.toolCall.name`）。实测：真实 toolResult 输入（toolName="read_file"，toolExecutionKey=64 字符哈希）投影出 `tool_result { toolName: '<64个X>', toolExecutionKey: '<64个X>' }`，而同一调用生成的 `tool_arc.toolName === "read_file"`。同一工具弧的两个单元对工具名的表达不一致；provenance 载体应记录真实工具名。

### Finding 3（证据/注释准确性）— tool arc "由 durable key 证明邻接" 的注释与实际实现不符

`projection.ts:256-261` 注释声称 ToolResult `details.iris` 携带权威 `assistantEntryId + toolCallOrdinal`，"所以邻接由 durable key 证明，而非数组位置"。实际 `toolResultByCallId` 以 message 级 `toolCallId` 为键（`projection.ts:262-272`），未读取 `details.iris.toolExecutionKey`/`assistantEntryId`。按 Pi 数据模型 `message.toolCallId` 与 assistant toolCall part `id` 的对应是持久化、权威的邻接，实现本身可用；但若同一 callId 被两个 assistant 消息复用，仅按 callId 索引会令弧错误绑定到最后一个 toolResult——`tag-messages.ts` 用 composite key（`<ownerMsgId>\x00<callId>`）正是为消除该歧义。注释应改写为与实现一致，或实现改用 `details.iris.toolExecutionKey`（内含 assistantEntryId+ordinal，可消歧）。

### Finding 4（minor）— 死代码与 hash 覆盖缺口

- `projection.ts:233` 的 `userByEntryId` Map 只写不读，死代码。
- tool_result 单元的 `contentHash` 字面量写死 `toolName: ""`（`projection.ts:387-393`），不覆盖自身 `toolName`/`toolExecutionKey` 字段（`projectionHash` 会哈希完整单元对象，故整体确定性不受影响，但单元级 hash 未覆盖完整 identity payload）。

## 结论

- 投影主体正确：raw identity 保真、范围/hash/顺序确定、孤儿 fail-conservative、R2 边界干净、无回归，10/10 单元测试与完整 `npm run check` 门禁全部通过。
- 主要偏差集中在"配对单一基础"与"verified 语义"（Finding 1），以及 tool_result 单元字段误标（Finding 2）与注释/实现不符（Finding 3）。三者当前均未被任何生产路径消费（投影为独立模块），属潜伏问题。

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 部分符合 — P0–P5 结构、P3/P4 read-port-only、P5 边界 from/toEntrySeq、无 synthetic 修复均符合规格；但 "Pi Input and Provenance Projection" 要求验证 pair key/content layout/hash 后折叠，投影的 `verified` 仅基于发现（companion 存在），且 `00-module-boundaries` 要求 Context/Historian 共用同一 UserMessage/companion 推导（当前存在两套不同谓词），需在接线前对齐（Finding 1）。
CODE CORRECTNESS: 基本正确；tool_result 单元 `toolName` 被填入 toolExecutionKey 哈希而非真实工具名（Finding 2），tool arc 邻接证明机制与注释不符、callId 复用场景存在歧义（Finding 3），`userByEntryId` 死代码（Finding 4）。
RECOVERY/CONCURRENCY: 无风险 — `projectLogicalUnits` 为纯函数、无状态、无并发、无持久化；确定性哈希对重放友好；不影响任何崩溃窗口。
TEST COVERAGE: 10/10 覆盖结构性 P0-P4、真实 id 配对、arc 密封、reasoning、boundary、确定性、孤儿、空 session、watermark 契约；但缺少：corrupt companion（content/display/pairKey 异常）的投影行为测试（该场景正是 Finding 1 的暴露面），以及 tool_result 单元 `toolName` 断言的测试（现测试未校验该字段）。
EVIDENCE ACCURACY: 提交信息与代码注释存在高估 — "one pairing basis for the whole path" 不成立（两套配对谓词，已实测复现）；"adjacency proven by the durable toolExecutionKey" 与实现（message 级 toolCallId 索引）不符；"10 tests" 与门禁数字与实测一致，无虚报。
FINDINGS:
- F1 [必改，接线前] 投影内联配对谓词弱于 `findInputPairsByProjection`（缺 content/display/pairKey），corrupt companion 可被标记 verified=true 并成为 lastSafeUserAnchor；"one pairing basis" 声明不成立。修复：复用 `findInputPairsByProjection` 或补全三条件；如需语义级 verified 则复用 host.ts 的 pairKey+layoutHash 验证链。
- F2 [必改] tool_result 单元 `toolName` 填入 toolExecutionKey 哈希；应取 `message.toolName`。
- F3 [建议] tool arc 注释与实现不符；建议改用 `details.iris.toolExecutionKey`（含 assistantEntryId+ordinal）消解同 callId 复用歧义，或修正注释。
- F4 [minor] `userByEntryId` 死代码；tool_result 单元级 contentHash 未覆盖自身 toolName/toolExecutionKey。
<!-- OMO_INTERNAL_INITIATOR -->
