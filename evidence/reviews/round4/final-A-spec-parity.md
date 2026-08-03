# R2 Round 4 最终评审 A — Spec / Parity（final-A-spec-parity.md）

## Reviewer 角色

Reviewer A：规格 / parity 专项评审员（FINAL 多路径评审之一，独立于实现者与其它 reviewer，非橡皮图章）。
评审门禁：本评审通过（PASS / NON_BLOCKING）是 git push 的四个必要条件之一。

## 评审范围

- 分支：`agent/r2-magic-context-parity` vs `main`（27 commits，71 files，+13079/-45）
- Reviewed HEAD：e2f7c25（docs(evidence): Feature 9 + Feature 10 review records (all PASS)）
- 权威源（locked）：`C:\Users\15027\AppData\Local\Temp\opencode\mc-authority\magic-context` @ `48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`（release v0.33.0）
- 工作树状态：clean（评审全程未修改任何源代码；仅新增本证据文件）

## 评审文件

- Gold：`src/context/{projection,pass-taxonomy,protected-tail,replay,lkg,carriers,pipeline}.ts`、`src/contracts/context.ts`、`src/context/context-store.ts`、`src/db/migrations/context/0001_bootstrap.sql`
- 交叉面：`src/runtime/{session-projection,context-adapter,pi-runtime-adapter,harness-factory}.ts`、`src/host/host.ts`、`src/runtime/vertical-slice.ts`、`src/contracts/ports.ts`、`src/config/schema.ts`
- 测试：`test/context-{golden,pass-taxonomy,protected-tail,replay,lkg,pipeline,carriers,projection,parity-gate,store}.test.ts`、`test/reconcile-raw-identity.test.ts`
- 证据：`evidence/notion-round4/01-context-assembly.md`（Physical Layout L62-97、Pass Taxonomy L134-157、LKG L221-234）、`07-roadmap.md`（R2 Exit Gate L127-132）、`02-magic-context.md`（L22 raw passthrough 禁令、L69 LKG 语义）、`04-pi-compat.md`（L78 mural 禁令）
- 权威源码：`inject-compartments.ts`（mustMaterialize L1310-1422、M0_EMPTY_BODY/M1_EMPTY_PLACEHOLDER L732-734）、`m0m1-taxonomy.test.ts`（全文）、`protected-tail-boundary.ts`（全文）、`derive-budgets.ts`、`drop-stale-reduce-calls.ts`、`lkg-replay.ts`/`lkg-slot.ts`、`sentinel.ts`
- 既有审查：`evidence/reviews/round4/*.md`（17 份 feature 审查 + final-B/final-D 在制品记录）

## 权威锁定核验

- `git -C mc-authority rev-parse HEAD` = `48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`（"release: v0.33.0"），与 `scripts/context-golden/authority.json`、`evidence/context-golden/provenance.md`、`test/context-golden.test.ts` 内联常量一致。
- 12 个 fixture 实测 sha256 与 `provenance.md` 哈希表逐项一致（含 constants.json `4f7cbaf3…`、taxonomy-softplus `2f4801a2…`、protected-tail-suffix-walk `8bd07854…` 等）。
- fixture expected 值映射权威自测断言（`m0m1-taxonomy.test.ts`：SOFT+ byte-identical / SOFT m1 re-render / HARD model_change/system_hash / ttl_idle fold-once+idempotent；`protected-tail-boundary.test.ts`：findSuffixStartForTokens [2,1,1,4]、ceilingN [2080,3120]、minForceEligibleTokens [1,1000]）；generate.ts 以 13 条 assertion anchor + HEAD 锁反自证，确定性修复（40d75cf）后两次生成 12/12 hash 与提交版一致（feature-02 复审实测）。

## 执行验证命令与真实输出

### 1) `npm run check`（完整 gate，全部步骤真实执行，exit 0）

- format:check：`All matched files use Prettier code style!`
- lint：clean；typecheck（tsc --noEmit）：clean
- npm test：`1..198 / # tests 198 / # pass 196 / # fail 0 / # skipped 2`（2 skip = OPENCODE_GO_API_KEY 未设置的 live provider 用例）
  - 含 parity-gate 5/5（#40-44）、pass-taxonomy 12、pipeline 7（含 bdcc8bd 端到端回归）、protected-tail 12、replay 7、lkg 17、context-store 12、projection、reconcile-raw-identity 14（含 settle 路径 #178）
- test:context-golden：4/4 pass；test:context-migrations：12/12 pass（corrupt fail-closed、newer-schema fence、SIGKILL）
- migration:smoke：`"status":"idempotent"`（firstApplied [0001_bootstrap]，secondApplied []）
- crash:check：7/7 boundaries ok
- bench:context：`{"turns":200,"rawEntries":600,"units":400,"classification":"HARD","decisionMsPerPass":5.674,"materializeMs":1.301,"m0BodyBytes":5731,"status":"ok"}`（结构数字与既有 4 次运行一致）
- build ✓；test:subprocess 3/3；test:cli 6/6；dist:smoke `{"status":"ok","epochDb":true,"ingressDb":true}`

### 2) 权威源码逐行对照（本评审独立完成）

- `decidePass`（pass-taxonomy.ts L78-164）vs `mustMaterialize`（inject-compartments.ts L1310-1422）：first_render/cached_m1_missing 前置一致；model_change/system_hash 的 `!== "" && !== undefined` 空信号守卫与权威 L1341/L1344 一致；ttl_idle 门 `cacheExpired && lastResponseTime>0 && lastResponseTime>m0MaterializedAt` 与权威 L1354-1360 逐字等价（ed25923 已移除 lineage.lastResponseTime 回退），fold 后 materializedAt 前进 → 幂等。
- `deriveProtectedTailTokenTarget`/`findSuffixStartForTokens`/per-run caps（protected-tail.ts）与权威 protected-tail-boundary.ts L176-232 逐行等价；pipeline `deriveTokenTarget` 复用权威版（bdcc8bd 已删平行公式，含 ABS_CAP=96000 钳制）。
- M0_EMPTY_BODY=`<session-history></session-history>`、M1_EMPTY_PLACEHOLDER=`<session-history-since>(no new content since last materialization)</session-history-since>` 与权威常量字节一致。
- `runReplay` REPLAY/DETECT split 与权威 drop-stale-reduce-calls.ts 同构；DETECT 仅 `detect && endSeq < protectedStart`，defer pass 恒空。

## 六项 VERIFY 逐项结论

### 1. R2 Exit Gate（07-roadmap L127-132）— PASS（管线层全部满足，产品接线缺口见 BOUNDARY HONESTY / FINDINGS F1）

- 127 parity gate on locked fixtures：context-parity-gate 5/5 驱动 `runContextPass` 从 fixture 读取期望值并断言决策（SOFT+/SOFT/HARD/empty-signal/ttl-idle），pass-taxonomy 矩阵测试显式断言与 fixture 分类相等；fixture 哈希与 provenance 一致、expected 值来自权威自测。
- 128 SOFT+ byte-identical replay：parity-gate #40（representedThrough 覆盖全投影 → SOFT+ reuse）+ pipeline 测试「identical second pass SOFT+ reuses m0」+ bdcc8bd 端到端回归（pass1 HARD → pass2/pass2b SOFT+ reuse → pass3 模型变更 HARD）；决策路径纯函数（零 Date.now）。
- 129 raw-message passthrough 不存在：pipeline 测试 5 断言 renderProviderVisible 只发射 m0/m1 carriers + 合成 live 单元（leaked=false）；renderProviderVisible 代码确认无原始消息发射。注：该性质在管线层成立，产品 hook 层尚未接线（FINDINGS F1）。
- 130 rollover fresh lineage：context-store 测试 11（session B 不继承 A 的 m0/represented/LKG）+ context_lineages 按 runtime_session_id 主键 + LKG (session, slot_key) 主键；Host 集成断言缺失属既有 NON_BLOCKING 覆盖项。
- 131-132 capacity benchmark 首轮证据：bench:context 已接入 `npm run check` 并实测运行（200 turns/600 raw/400 units/HARD/5.674ms/1.301ms/5731B），结构数字跨 5 次运行一致。

### 2. Provider-visible layout 符合 01-context-assembly（L62-97）— PASS（管线层）

- system = P0+P1+P2：`ContextSourceSnapshot`（contracts/context.ts L9-22）携带 canonicalSystemPrompt（P0）、personaSnapshotId（P1）、declarationVersion（P2）；由 native systemPrompt resolver 提供，管线不重建。
- m0 = folded P3 + seed + baseline P4：R2 中 P3/P4 仅经 read-port/fixture 边界（projection.ts P3CommittedInput/P4MemoryInput 显式可选、空时不伪造）；renderM0Head 以 head 单元确定性快照作 m0 body，Historian 真折叠声明为 R3（pipeline.ts L261-266 注释）。
- m1 = committed P3/P4 delta：R2 为静态占位 delta（applyContextPass materialize_m1 `(delta)` 字面量），真实 delta 渲染声明为 R3（feature-10-host-spec R3 finding）。
- live tail = current P5 + invocation delta：renderProviderVisible 从同一 projection 发射合成 live 单元（`[live <kind> <seq>]`），携带 unitId。
- 固定顺序 m0 → m1 → live tail（renderProviderVisible L444-447 先 push m0 再 m1 再 live）；M0_EMPTY_BODY / M1_EMPTY_PLACEHOLDER 固定且与权威字节一致，m1 placeholder 永不省略（carriers 测试 2/3）。
- m0/m1 为 cache-sensitive prefix：carriers 字节确定性（canonicalCarrierJson 排序键 + providerProfileId/materializationId 参与哈希 → HARD 失效），SOFT+ 前缀 byte-stable。

### 3. 锁定 authority / fixture 无漂移 / 无 Mural — PASS

- authority = v0.33.0 @ 48ab531d（released tag，非 master）；fixture 12/12 哈希与 provenance 一致；anti-self-certification（expected 值机械提取自权威自测 + assertion anchor + HEAD 锁）成立；确定性修复后再次生成字节一致。
- `experimental.mural` / Memory Mural：src/ 与 fixture 数据零命中；仅 evidence 禁令散文、context-golden.test.ts L46 负向断言、generate.ts L507 守卫含该词（均为禁止语义）。04-pi-compat.md L78 明确 experimental.mural 不进入 M1 payload。

### 4. Pass taxonomy 语义 — PASS

- SOFT+（identity 不变 + byte-identical replay + 仅 live delta + 无新 drop/reasoning decision）仅在 wouldAdvanceLive=false 且无 HARD 信号时返回（advancesMaterialization=false）。
- SOFT（system/m0 不变、m1 重渲染、additive/mutation 提交）在 wouldAdvanceLive=true 且无 HARD 信号时返回。
- HARD reasons 12 个成员全部有代码路径，覆盖 spec 合法清单；空当前 HARD 信号（""/undefined）永不变更；ttl_idle 仅当前飞行信号折叠一次后幂等；普通 ToolResult 仅 SOFT 不重建 P0/P1/P2（测试 10）。
- golden 矩阵测试（context-pass-taxonomy.test.ts L197-258）对 SOFT+/SOFT/HARD/empty-signal 断言与 fixture 分类相等（F3 修复后 empty-signal 以 wouldAdvanceLive=true 驱动 SOFT 并与 fixture 相等）。

### 5. R2/R3/R4 边界诚实性 — PASS（附 F1：产品接线需在 PR 描述中精确声明）

- 无生产 Historian：grep src/ 无 Historian 实现（仅 contracts/ports.ts `HistorianPublicationOutboxPort` 接口、config/schema.ts 配置类型、data-root.ts 路径派生、注释中的 R3 声明）；无任何 `implements HistorianPublicationOutboxPort`。
- 无 Compartment LLM producer、无 ContinuitySnapshot 生产代码、无 publication outbox 实现、无 Graphiti、无稳定 memoryRef 生产使用（memoryRef 仅 P4MemoryInput 类型字段与 ports.ts 接口参数）。
- R2 实现为 capability 层 + 决策管线 + parity gate，全部字节锁定 authority 常量，无 mock 伪装成实现（唯一 mock 标记 `materializationIdentity: "mock-m0m1-v1"` 为显式标签，符合 AGENTS.md mock 标记规则）。
- **接线缺口（必须如实声明）**：`runContextPass`/`applyContextPass`/`renderProviderVisible` 在 src/ 无生产调用点；产品 context hook（harness-factory.ts L129-142）仍调用 `transformContextMessages`（context-adapter.ts，返回 `materializationIdentity: "mock-m0m1-v1"`，assistant/toolResult 原样透传，无 m0/m1 carriers）。a8b5158 commit 标题 "Host product-path Context pipeline" 措辞超卖（应为「产品路径就绪的决策管线 + parity gate，hook 接线留待接线提交」）。该状态已被 feature-10-host-spec-review L93、final-B F1、final-D F1 三方明确记录，分支证据未隐瞒。PR 描述必须逐字声明：R2 Context 侧 parity（管线 + fixture gate）已实现并验证；harness context hook 尚未接入 runContextPass；R3 Historian / R4 Memory 未实现。

### 6. 跨 feature 一致性 — PASS

- projection 配对谓词 == ingress reconciliation 谓词（issue #6）：`findInputPairsByProjection`（raw_adjacent=rawIndex+1 / parent_chain=parentId===user.entryId + content/display/pairKey 四条件）被 `projectLogicalUnits`（projection.ts L237）与 `reconcileUncommitted`（host.ts L1075）与 `resolveCommittedPair`（pi-runtime-adapter.ts L97）共用，单一配对基础；e855367 修复后投影与 ingress 对 corrupt companion 行为一致（回归测试 3 个）。pi_user_entry_id 两个写入方共享「恒为真实 raw UserMessage entry id」不变量。
- protected-tail fences == LKG seam 规则：两侧均强制 tool-arc 原子性（protected-tail：sealed arc 边界落入 span 内推进到 arcEnd+1、open arc 拉回调用起点；LKG validateLkgSeamBoundary：prefix 末条 assistant 的每个 open call 必须在 tail 中某处有匹配 result，tail 首条不得为悬空 toolResult），方向一致（不切断 arc / 不悬空 tool_use）。
- pipeline 组合已审图层，无弱化重实现：runContextPass 依序组合 projectLogicalUnits → deriveProtectedTailTokenTarget（权威）→ resolveProtectedTail → decidePass → runReplay → classifyAction → buildCarriers；bdcc8bd 已删除 deriveTokenTarget 平行公式（缺 ABS_CAP 钳制），N 单一权威来源。

## 既有 17 份 feature 审查 PASS 声明核验

- 数字核验：npm test 198（196+2 skip）、golden 4、migrations 12、subprocess 3、CLI 6、bench 结构数字 —— 全部与本评审实测一致。
- BLOCKING 关闭核验（代码在 HEAD 中确认）：bdcc8bd（cachedM0* 当前 pass 身份 + representedThrough=toEntrySeq + deriveTokenTarget 复用权威）、353c702/e3591c8（lkg/replay/protected-tail 测试接入 npm test）、ed25923（taxonomy F1/F2/F3）、e855367（projection F1/F2/F4）、6876dff（protected-tail 压力 floor + sealed-arc fence）、5563620（LKG F2/F3 + corrupt payload fail-closed）、40d75cf（golden 确定性）、d36a411（settle 路径 raw identity）。
- fixture 哈希：12/12 与 provenance.md 一致（本评审独立计算）。
- 遗留 NON_BLOCKING 均如实记录于各审查文件（ttl fixture 内嵌时间戳已随 40d75cf 冻结；m1_absolute_cap 标签为 Iris 自创序列化标签；modelKey 斜杠/冒号映射未逐字节验证；hysteresis/oversize/LKG growing-window/replayHash 均 R3 修复计划；bench 冷写单测；setDeferredSignalCursor 不校验 changes；deferred 入队+cursor 非原子）——无隐藏项。

## Findings（本评审新增 / 强调）

- F1（NON_BLOCKING，范围表述必须精确）：Exit Gate 128/129 的「SOFT+ byte-identical replay 通过」与「raw-message passthrough 不存在」仅在管线层成立；产品 harness context hook 仍运行 `transformContextMessages`（`mock-m0m1-v1`）并透传 raw assistant/toolResult。分支证据（feature-10-host-spec L93、final-B F1、final-D F1）已如实记录，非欺骗；但 PR 描述必须把「R2 管线 + parity gate 已实现」与「hook 接线未入产品路径」分开声明，不得让「Host product-path Context pipeline」措辞暗示已接线。
- F2（NON_BLOCKING，证据精度）：parity modelKey 格式（权威 "anthropic/opus" 斜杠 vs 管线 "anthropic:opus" 冒号）跨系统不一致，分类 parity 成立但字节级 cache-key 格式 parity 未被证明；建议在 fixture/provenance 中显式记录映射（feature-11 F1 遗留）。
- F3（NON_BLOCKING，fixture 语义）：`taxonomy-pressure-backstop-m1-cap` 的 expected.reason="m1_absolute_cap" 在权威源零命中（Iris 自创序列化标签），且无任何测试断言管线复现该 HARD 分类（R2 m1 为静态占位，绝对上限折叠在 R3 前不可达）；行为语义与权威（m0RematerializedThisPass=true + m1 reset）锚定成立，fixture 哈希完整。
- F4（NON_BLOCKING，覆盖）：`taxonomy-hard-markers-persist-restart` 的 SOFT/rematerialized=false 无直接 fixture 断言（由 context-store 持久化语义 + taxonomy 身份持久测试间接覆盖）；`taxonomy-hard-system-hash` 的 reason 由 pass-taxonomy 单测复现但未读 fixture 断言。属覆盖增强建议，非 parity 缺口。
- F5（NON_BLOCKING，已文档化偏差，R3 修复计划内）：protected-tail hysteresis（entrySeq vs token）与 oversizeAtomicUnit（tail unit vs N）偏差已在代码注释标注 acknowledged deviation；LKG growing-window 回放（F1）defer 到 R3 布线；replayHash 未含 mutationReplayWatermark（无当前决策影响）。均 fail-safe 方向，无数据丢失风险。

## 结论块（固定格式）

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 满足。R2 Exit Gate 五项在管线层全部达成（parity gate on locked fixtures 5/5 + golden 4/4 + 矩阵测试显式断言；SOFT+ byte-identical replay 端到端可达并经 bdcc8bd 回归锁定；renderProviderVisible 无 raw passthrough；rollover fresh lineage 由 context_lineages 主键 + 隔离测试保证；capacity benchmark 首轮证据接入 check）。Provider-visible layout 与 01-context-assembly Physical Layout 一致（system=P0+P1+P2 经 ContextSourceSnapshot；m0=P3 折叠+baseline P4 快照；m1=P3/P4 delta 占位；live tail=P5+invocation delta；固定 m0→m1→live tail 顺序；M0_EMPTY_BODY/M1_EMPTY_PLACEHOLDER 字节锁定）。Pass taxonomy 与权威 mustMaterialize 逐字等价（空信号不变更、ttl_idle 单次折叠幂等）。唯一 spec 侧关注是产品 hook 未接线（F1），属范围表述而非语义偏差。
PARITY: 通过。authority 锁定 v0.33.0 @ 48ab531d（released tag 核实）；fixture 12/12 哈希与 provenance 一致、expected 值来自权威自测断言、无自证（assertion anchor + HEAD 锁 + 确定性修复验证）；experimental.mural/Memory Mural 零 payload 出现（仅禁令散文与守卫）。decidePass/protected-tail 数学/placeholders 与权威逐行等价；pipeline 复现 SOFT+/SOFT/HARD/empty-signal/ttl 五个 fixture 分类。已知未字节验证项：modelKey 格式映射（F2）与 m1_absolute_cap 标签（F3）——均如实记录，非静默漂移。
BOUNDARY HONESTY: 诚实（需在 PR 描述中固化）。R3（Historian、Compartment LLM、ContinuitySnapshot、publication outbox）与 R4（Graphiti、稳定 memoryRef）在 src/ 零生产实现（仅端口接口/配置类型/类型字段/R3 注释）；无任何实现声称 R3/R4 工作。R2 为 capability 层 + 决策管线 + parity gate，mock 标记显式（mock-m0m1-v1）。重要：产品 harness context hook 仍未接线 runContextPass（transformContextMessages 继续透传 raw assistant/toolResult），该状态已被 feature-10-host-spec/final-B/final-D 三方记录；PR 描述必须精确声明「管线与 parity 已实现、hook 接线未入产品路径」，不得复用「Host product-path」暗示已接线（F1）。
CROSS-FEATURE CONSISTENCY: 通过。projection 配对谓词 == ingress reconciliation 谓词 == settle 路径谓词（findInputPairsByProjection 单一基础，issue #6 闭环，pi_user_entry_id 双写入方共享 raw identity 不变量）；protected-tail fences 与 LKG seam 规则一致执行 tool-arc 原子性；pipeline 组合已审图层无弱化重实现（deriveTokenTarget 已并入权威 N 公式）。
EVIDENCE ACCURACY: 通过。本评审独立复核：npm run check 全绿（198/196+2skip、golden 4/4、migrations 12/12、smoke idempotent、crash 7/7、bench 结构数字一致、subprocess 3/3、CLI 6/6、dist ok）；fixture 12/12 哈希与 provenance.md 逐项一致；authority HEAD=48ab531d；全部历史 BLOCKING 的修复代码在 HEAD 中确认存在；遗留 NON_BLOCKING 均在各审查文件中如实记录。两处表述超卖已定位并记录：a8b5158 标题「Host product-path」（F1）与 fixture 标签「m1_absolute_cap」（F3）。
FINDINGS:
- F1（NON_BLOCKING，PR 描述必须声明）产品 hook 未接线 runContextPass，产品路径仍走 transformContextMessages（mock-m0m1-v1、raw assistant/toolResult 透传）；Exit Gate 128/129 的「SOFT+ 通过」「无 raw passthrough」目前为管线层性质。分支证据诚实，但 PR 必须把「管线+parity 已实现」与「hook 接线未入产品路径」分开声明，并修正「Host product-path Context pipeline」措辞。
- F2（NON_BLOCKING）modelKey 格式权威斜杠 vs 管线冒号映射未逐字节验证，建议在 fixture/provenance 显式记录映射。
- F3（NON_BLOCKING）taxonomy-pressure-backstop-m1-cap 的 reason 标签为 Iris 自创（权威零命中），且 R2 无测试复现该 HARD 分类（m1 绝对上限折叠 R3 可达）；行为语义锚定成立。
- F4（NON_BLOCKING）markers-persist / system-hash fixture 的 expected 未直接读 fixture 断言（间接覆盖），建议后续补充。
- F5（NON_BLOCKING，R3 修复计划内）hysteresis entrySeq/token、oversize tail/head、LKG growing-window、replayHash 缺 mutationReplayWatermark —— 均已文档化，fail-safe 方向。
- 无 BLOCKING 项。四个 reviewer 维度中本维度结论：NON_BLOCKING（相当于通过，附 F1 的 PR 描述要求）。
<!-- OMO_INTERNAL_INITIATOR -->
