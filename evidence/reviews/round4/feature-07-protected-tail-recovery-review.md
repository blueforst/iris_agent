# R2 Feature 6 — Protected tail & tool-arc fences：Recovery/Tool-arc 独立评审（Reviewer: Tool-arc/recovery）

## 评审对象

- 提交：`a3ea251c6d0ae45024a45470f4951da87e415a92` "feat(context): protected tail & tool-arc fences (R2 Feature 6)"
- 变更范围（git show HEAD --stat）：
  - `src/context/protected-tail.ts`（+374 行，新模块）
  - `test/context-protected-tail.test.ts`（+394 行，11 个测试）
  - `evidence/reviews/round4/feature-06-pass-taxonomy-review.md`（追加 RE-REVIEW 记录）
- 评审人独立于实现者；本次未修改任何源代码。

## 验证方法与真实输出

### 1) 测试：npx tsx --test test/context-protected-tail.test.ts
```
# tests 11   # pass 11   # fail 0   # skipped 0   duration_ms 357.4
```

### 2) 完整门禁：npm run check（全部通过）
- unit：`# tests 150  # pass 148  # fail 0  # skipped 2`（2 个 live skip = R1-P1 vertical slice，OPENCODE_GO_API_KEY 未设置，与 commit message 一致）
- test:context-golden：4/4
- test:context-migrations：12/12（含 `context-store: SIGKILL crash leaves a reopenable, consistent DB`）
- migration:smoke：idempotent（`firstApplied: [0001_bootstrap]`，`secondApplied: []`）
- test:subprocess：3/3；test:cli：6/6；dist:smoke：`{"status":"ok",...}`
- 专项 lint/typecheck：`npx eslint src/context/protected-tail.ts test/context-protected-tail.test.ts` exit 0；`npx tsc --noEmit` exit 0（此前 feature-06 re-review 记录的 lint 失败来自未跟踪在制品，本次 HEAD 已提交版本干净）
- git status：工作树干净

### 3) Golden fixture 真实性（evidence accuracy）
- provenance.md 记录的 sha256 与磁盘文件逐一吻合：
  - `protected-tail-suffix-walk.json` = `8bd07854…`（记录一致）
  - `protected-tail-n-clamp.json` = `9df70085…`（记录一致）
  - `protected-tail-force-head-minimum.json` = `833bc360…`（记录一致）
- 手工复算 n-clamp 两用例（contextLimit 8000/12000、threshold 65、usage 30/95）：usable=5200/7800，triggerBudget=5000（被 MIN 钳），reserve=1000，headroom=2600/3900，rawN=1092/117，floorN=2000，ceilingN=2080/3120，N=2000/2000，与 fixture expected 完全一致。
- suffix-walk fixture（[100,100,100] × target [150,301,300,0] → [2,1,1,4]）与实现一致。

### 4) 三个实证脚本（临时脚本，位于系统临时目录，未进入仓库）

脚本 1 —— 无锚点 + 超目标会话（10 组孤儿 input+assistant，各 5000 token，N=5000）：
```
A no-anchor oversize: anchor= null  tailStart= 20  headEnd= 19
```
结论：无已验证锚点时，超过 N 的头部**被折叠**（headEnd=19），并非"fold nothing"。

脚本 2 —— 滞后边界用 entry-seq 而非 token 比较（边界移动 1 个 entry = 5000 tokens，`|6-5|=1 < 256`）：
```
B freshBoundary= 6 prev= 5 heldBoundary= 5 hysteresisHeld= true (moved 1 entry = 5000 tokens, but 1 < 256 so HELD)
```
结论：滞后窗口实际为「256 条 raw entry」≈ 默认估计下 256×512 ≈ 131K tokens，远超权威的 256 tokens。

脚本 3 —— 非相邻 tool_arc（assistant(3) 调 c1 → 中间夹 assistant(4) 文本 → c1 结果在(5)），target=500 落在末单元：
```
units: input(1-2), assistant(3), tool_arc[3-5], assistant(4), tool_result(5)
target=500 -> tailStart= 5 headEnd= 4 fenced= false
```
结论：tool_arc[3,5] 整体在 head，但其覆盖的 raw entry 5（tool_result 单元）在 tail —— 弧被切跨且 `fenced=false`。正常相邻弧场景不触发（工具结果紧邻 assistant 追加，fence 逐一回退可覆盖）。

## 清单逐项核对

### 1) Tool-arc 原子性（sealed arc 永不被 fold 边界切成两半）
实现成立（相邻弧场景）。projection 对 sealed arc 同时产出三个互相重叠的单元：assistant(seq)、tool_arc[start..end]、tool_result(end)；`resolveProtectedTail` 的 fence 从候选边界向前（更早）逐项回退，条件 `unitEndEntrySeq(prev) >= unitEntrySeq(cur)`，最终把边界拉到整个重叠簇（assistant+arc+result）的起点，使弧整体进入尾部；边界落在簇之后时弧整体留在头部。两种情形都不会切跨。并行多 call 簇（同一 assistant 多个 arc 共享起点）同样被拉回。实证 + 代码走查确认。
- 局限（见 F3）：fence 只检查「紧邻前一个单元」，对非相邻 assistant/result 配对不设防。

### 2) 不完整 tool-arc fence（open arc）
- 检测正确：`openToolCallIds` 用 callId 集合差（tool_arc ∪ tool_result 的 callId 对 assistant.toolCallIds 做差）。projection 只在 `result !== undefined` 时才产出 tool_arc 且恒 `sealed:true`，未解析的 call 不会成为 unsealed tool_arc 单元（代码走查确认，第 341-357 行）。
- 强制边界部分成立但受限：只有 open 单元位于边界「上或之后」（`openIndex + 1 >= boundaryUnitIndex`）时才把边界拉回 open 单元起点；位于边界之前的 open arc 不会被救回，直接随头部折叠。commit message 声称"force the boundary before them"是无条件的，实现是有条件的（代码注释 "at/after the boundary" 更准确）。实际影响有限：最新已验证锚点之后的一切都被锚点地板保护，open arc 位于最新锚点之前意味着损坏会话。见 F4。
- 细节：`openToolCallIds` 不检查 `tool_arc.sealed`，一旦未来 projection 开始产出 unsealed arc 会把其 callId 误判为已解析（当前不可达）。

### 3) Reasoning seam 原子性
成立。reasoning 是单 entry 原子单元；reasoning 与其 assistant 共享 entrySeq，fence 会把两者聚簇（assistant.end >= reasoning.start 触发回退），边界不可能插在二者之间。测试通过但计数数组与单元数错位（3 个 counts 对 4 个单元，reasoning 单元 token 按 undefined 跳过记 0）——测试实际未把 reasoning 单元纳入 suffix walk 的权重。见 F5。

### 4) Fail-conservative（无已验证锚点 → fold nothing）
**不成立（一般情形）**。锚点地板只在 `anchorUnitIndex !== null` 时生效；无锚点时边界退化为纯 suffix walk，会话超过 N 即折叠头部。实证脚本 1：100K token 孤儿会话、N=5000 → headEnd=19。提交的测试只覆盖「会话总量 ≤ N」的情形——此时 suffix walk 本身就返回位置 1，测试**无法区分**"fail-conservative 导致 fold nothing"与"budget 本来就不足"。因此测试断言通过但未验证其声称的属性。孤儿/未验证 input 永不成为锚点：成立（`verified: companion !== undefined`）。见 F1。

### 5) 幂等 / 确定性
成立。`resolveProtectedTail` 是纯函数（projection + tokenTarget + 可选 previousPlan + 可选 counts），无模块级可变状态；`protectedTailFingerprint`（sha256 锚点/尾起点/头终点/N/fenced）确定且对边界敏感，测试覆盖同一输入两次指纹相等、边界偏移指纹不同。

### 6) 滞后（hysteresis，NORMAL_HYSTERESIS_TOKENS=256）
部分成立，存在两处偏差：
- **单位偏差（F2）**：权威按 256 tokens 比较；实现按 256 条 raw entry 比较（代码注释明确 "Compared in entrySeq space"）。默认估计 512 token/unit 时窗口放大约两个数量级，边界被过度持有。
- **顺序偏差（F4）**：滞后在 unit-fence 与 open-arc-fence 之后执行，且 `previousPlan` 只重读 `protectedTailStartEntrySeq` 而不重验单位对齐——滞后结果可覆盖当次的 fence 决定（测试用人为 prev=2 切跨 input 对即证明代码接受非单位起点边界）。生产上前次边界本身曾为单位起点、单元只追加不重排，风险有界；但投影结构若在两次 pass 之间变化（如 companion 补验使 input 从单 entry 变双 entry），持有旧边界可造成切跨。测试未覆盖 ≥256 的大移动不持有、也未覆盖 fence 与滞后的交互。

### 7) 崩溃 / 重启可重建性
结构上成立：计划完全由「projection（纯派生自 raw entries）+ tokenTarget + 可选 previousPlan」决定，无任何仅内存的可变状态，SIGKILL 后可从持久化 lineage 重建；`context-store` 已持久化 `protected_tail_start_entry_seq` / `last_safe_user_anchor_entry_seq`（`MaterializeM0Input`），12/12 migration（含 SIGKILL crash window）通过，migration:smoke idempotent。
**关键接线缺口（F6）**：全仓库检索 `resolveProtectedTail`/`deriveProtectedTailTokenTarget`/`protectedTailFingerprint` 只有 protected-tail.ts 自身、测试文件与 golden 生成脚本（注释）引用——**生产 transform/hook 无任何调用点**（与 feature-06 评审 F4 同类）。因此「持久化 → 计划 → m0 fold」的恢复闭环尚未接线：上述崩溃/重启论证目前是"模块级 + store 级"成立的静态证据，不是端到端验证。

### 8) 测试质量
11 个测试全部真实执行并通过，但存在系统性弱点（详见 F1/F2/F5）：
- 真正独立验证：golden 矩阵（fixture 哈希已校验、数学已手工复算）——质量高。
- 自指断言：token-target 数学与 per-run caps 两个测试用与实现**相同公式/常量**内联重算期望值，只能发现自我不一致，无法发现与权威的偏差。
- 声称与行为不符：sealed-arc 测试注释称弧应"wholly in the head"，实现把弧整体放入尾部（断言 `tailStart <= arc.start` 与实现一致、注释误导）。
- 边界场景覆盖单一：sealed-arc 只测了边界落在弧起点；未测边界落在弧内部（tool_result 处）、弧整体在头、非相邻 assistant/result 配对（评审清单明确点名的缺口，实证脚本 3 显示会切跨）。
- 未覆盖：多 entry input 对恰好压在边界上（fence 的 input-pair 分支无直接用例）；open arc 位于更新已验证锚点之前；滞后 ≥256 大移动不持有；指纹对锚点/tokenTarget 变化敏感；滞后与 fence 交互。

## 发现

- **F1（NON_BLOCKING，接线前必修）** 无锚点 fail-conservative 名不副实：会话超过 N 且无已验证锚点时头部照常折叠（实证 headEnd=19），提交的测试因会话不足 N 而无法暴露。建议：实现上强制 `anchorUnitIndex === null` 时 `tailStartUnitIndex = 1`（全会话保护），或收缩测试/提交声明为「无锚点时按 token 预算折叠且孤儿 input 不成为锚点」，二者必须对齐后再接线。
- **F2（NON_BLOCKING，接线前必修）** 滞后阈值单位偏差：entry-seq 比较而非 token 比较，窗口默认估计下放大 ≈ 512 倍，与权威 NORMAL_HYSTERESIS_TOKENS=256 tokens 语义偏离。建议改为按边界两侧单元 token 累计差比较，并补 ≥256 大移动用例。
- **F3（NON_BLOCKING）** 非相邻 tool_arc 可被切跨：projection 仅按 callId 封口、不验证 raw 相邻性；fence 只查紧邻前单元，边界落在弧的末单元时弧被切跨且 `fenced=false`（实证）。Pi 生命周期下工具结果紧邻追加、当前不可达；建议 projection 对 non-adjacent seal 发出警告或 fence 改为区间包含检查（任意在保单元 start < 边界 ≤ 其 end 即回退）。
- **F4（NON_BLOCKING）** open-arc fence 与滞后的交互：open-arc 只在边界上/之后生效；滞后在 fence 之后执行且不重验单位对齐，可覆盖当次 open-arc/fence 决定。
- **F5（NON_BLOCKING）** 测试可验证性：reasoning 测试 counts 与单元错位（reasoning 记 0 token）、sealed-arc 注释与断言方向相反、两个数学测试为自指断言、open-arc 测试使用生产不可达的 target=0。
- **F6（信息性，接线时必办）** 生产无调用点：`resolveProtectedTail` 未被任何 transform/hook 引用（与 feature-06 F4 同类）。建议随接线 commit 一并补齐端到端用例（transform 级），届时本评审的崩溃/重启结论从"模块级静态成立"升级为"端到端验证"。
- **F7（文档）** `findSuffixStartForTokens` 文档注释错误：会话总量不足 target 时返回 1（fold nothing），返回 `length+1` 的是 `targetTokens <= 0` 分支（生产不可达，N ≥ 2000 地板）。

## 结论

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 锚点地板、sealed/open arc fence、reasoning seam、指纹确定性符合 01-context-assembly 规格与 commit 声明；偏差在于无锚点时的 fail-conservative 语义（F1）与滞后单位（F2）两处未与声明/权威对齐，规格正文对无锚点场景未作明确约定。
CODE CORRECTNESS: 核心 fence 算法对相邻弧、并行弧簇、reasoning 簇正确（逐一代码走查 + 3 个实证脚本）；非相邻弧切跨（F3）在 Pi 生命周期下不可达；open-arc 检测集合差正确；纯函数、无全局状态；eslint/tsc 干净。
RECOVERY/CONCURRENCY: 计划纯派生自投影 + 持久化 lineage，SIGKILL 后可重建；migration（12/12 含 crash window）与 migration:smoke idempotent 通过；滞后跨 pass 状态仅依赖持久化 previousPlan；但生产接线缺失（F6）使恢复闭环尚未端到端成立。
TEST COVERAGE: 11/11 通过，golden 矩阵真实（哈希 + 手工复算验证）；但 no-anchor 测试未覆盖超目标会话（F1）、reasoning 计数错位（F5）、滞后无大移动用例（F2）、非相邻弧与多 entry 对边界无用例（F3）；两个数学测试为自指断言。
EVIDENCE ACCURACY: commit message 数字与实际输出吻合（150 unit: 148+2 skip、4 golden、12 migrations、3 subprocess、6 CLI、11 protected-tail tests）；fixture 哈希与 provenance.md 一致；本评审全部命令真实执行并记录输出，实证脚本存放于系统临时目录、未写入仓库。
FINDINGS: F1 无锚点 fail-conservative 超目标会话实际折叠头部（测试无法区分，接线前必修）；F2 滞后以 entry-seq 而非 token 比较、窗口放大 ~512 倍（接线前必修）；F3 非相邻 tool_arc 可被切跨且 fenced=false（Pi 生命周期不可达）；F4 open-arc fence 与滞后执行顺序可相互削弱；F5 测试可验证性（自指断言、计数错位、注释与断言方向相反）；F6 生产无 resolveProtectedTail 调用点（与 feature-06 F4 同类）；F7 findSuffixStartForTokens 文档注释错误。
<!-- OMO_INTERNAL_INITIATOR -->

---

## RE-REVIEW (6876dff)

### 评审对象

- 提交：`6876dffe87109133ad11fda1434d9fb7ec5c8c2d` "fix(context): protected-tail review F1/F2 (force-pressure anchor floor, sealed-arc fence to authority semantics)"
- 变更范围（git show 6876dff --stat）：
  - `src/context/protected-tail.ts`（+113/-56，resolveProtectedTail 重写 fence + 新增 usagePercentage/emergencyTailScale）
  - `test/context-protected-tail.test.ts`（+68，新增 force-pressure 测试、重写 sealed-arc 测试）
- 评审人独立于实现者；本次仅追加本 RE-REVIEW 记录，未修改任何源代码。

### 验证方法与真实输出（全部真实执行）

1. `git -C D:\code\iris show 6876dff`：diff 确认三项改动——(a) 新增 `usagePercentage`/`emergencyTailScale` 选项与 `anchorFloorActive = !isEmergency && usagePercentage < 80` 条件；(b) fence 重写为区间包含检查（sealed arc 边界落 span 内推进 head、open arc 拉回调用起点）；(c) hysteresis/oversize 偏差写入代码注释。
2. 专项测试 `npx tsx --test test/context-protected-tail.test.ts`：`# tests 12  # pass 12  # fail 0`（含新增 "anchor floor is lifted at force pressure (authority #132)"）。
3. 完整门禁 `npm run check`（真实执行）：format:check / lint / typecheck 通过；unit `150 → 148 pass + 2 skip`（R1-P1 live skip）；test:context-golden 4/4；test:context-migrations 12/12（含 SIGKILL crash window）；migration:smoke idempotent（`firstApplied: [0001_bootstrap]`、`secondApplied: []`）；crash:check 7/7；build ok；test:subprocess 3/3；test:cli 6/6；dist:smoke `{"status":"ok"}`。与 commit message 声称数字逐项吻合。
4. 独立实证脚本（临时目录，未入仓库）：
   - F1 稀疏会话（唯一 verified input 在最前 + 巨型 assistant/tool 尾部，tokenTarget=500）：
     - routine `usagePercentage:30` → `anchor=1 tailStart=1 headEnd=0`（anchor floor 生效，全会话保护）
     - force `usagePercentage:95` → `anchor=1 tailStart=5 headEnd=4`（floor 解除，head 可折叠）
     - emergency `emergencyTailScale:0.5` → `tailStart=5`（floor 解除）
     - 默认无压力选项 → `tailStart=1`（无回归）
   - F3 sealed-arc（arc span=[3,4]，sealed=true）：target=700 时后缀步进边界落入弧内 → `tailStart=5(=arcEnd+1) fenced=true`；target 800/900/1000/1500/2000 → `tailStart=3(=arcStart)`，target=3000 → `tailStart=1`。所有 target 边界均不落在 `(arcStart, arcEnd]` 内。
   - 无锚点超目标会话（recovery F1 场景，未改）：`anchor=null tailStart=20 headEnd=19` —— 超 N 头部仍被折叠，与提交测试"fold nothing"声称不对齐，保持原状。
   - reasoning 测试：units=4（input@1, assistant@3, reasoning@3, assistant@4）vs `unitTokenCounts:[1000,1000,1000]`（3 项）—— 计数仍错位，第 4 单元按 undefined 记 0；`tailStart=1`，测试因 anchor floor 覆盖全会话而平凡通过。
   - hysteresis × fence 交互（recovery F4，未改）：stale previousPlan `protectedTailStartEntrySeq=4`（位于弧 span [3,4] 内部）时，新边界 5 被滞后拉回 4，`insideArcSpan=true`（弧被切跨）。新代码自身产出的 plan 恒为 fenced 边界（5 / 3=arcStart / 1），仅旧代码迁移期持久化的 in-arc previousPlan 可触发；生产无 previousPlan 调用方，属理论边角。

### 逐项核对（对照原始发现）

- **F1（anchor floor 无条件化 → #132 稀疏会话压力下无 eligible head）—— 已解决（VERIFIED）**。`anchorFloorActive = !isEmergency && usagePercentage < 80`（protected-tail.ts L251-256）落实权威 protected-tail-boundary.ts "Live-prompt floor" 豁免：force（usage>=80）与 emergency 路径解除 floor，实证 `tailStart=5 > 1`（head 可折叠）；routine 路径 floor 仍生效（`tailStart=1`），无回归。
- **F3（sealed tool_arc 可切跨）—— 已解决（VERIFIED）**。fence 重写为权威 fenceBoundaryForToolArcs 语义（L298-331）：边界落入 `[arcStart, arcEnd]` 时整体推进 head（`boundary=arcEnd+1`）；open arc 在/之后边界拉回调用起点。区间包含检查取代旧的"仅查紧邻前单元"回退，旧 F3 的非相邻弧切跨场景被覆盖。实证边界从不落在 `(arcStart, arcEnd]`。sealed-arc 测试同步重写（注释改为 authority 语义、断言 `outsideArc && fenced===true` 与实现方向一致），原 F5 中"注释与断言方向相反"随之修复。
- **F2（hysteresis 以 entry-seq 而非 token 比较）—— 未改，已文档化**。L333-338 代码注释明确标注 "reviewer F3 — acknowledged deviation, kept simple; token-accurate hysteresis is deferred to the fold-path integration in R3"。作为 R3 fold-path 集成时一并修复的已知偏差，接受为 NON_BLOCKING。
- **F4（oversizeAtomicUnit：tail unit vs N）—— 未改，已文档化**。L349-354 代码注释明确标注 "reviewer F4, acknowledged difference"（权威比较首个 eligible head message vs per-run cap）。接受为 NON_BLOCKING。
  - 注：代码注释沿用 parity 评审编号（F3=hysteresis、F4=oversize），与 recovery 评审编号（F2=hysteresis、F4=open-arc×hysteresis）不一致，属跨评审编号混用，无害但建议后续统一引用来源。
- **recovery-F1（无锚点超目标会话仍折叠头部，测试无法区分声称与行为）—— 未改**。实证 `headEnd=19` 依旧；标注"接线前必修"但 F6 接线尚未发生，条件未触发。仍 NON_BLOCKING。
- **recovery-F4（open-arc fence 与滞后交互：滞后在 fence 之后执行且不重验单位对齐）—— 未改**。新代码中交互仍存在（实证 stale prev=4 可把边界拉回弧内切跨）；因新代码产出的 plan 恒为 fenced 边界、生产无 previousPlan 调用方，仅旧→新迁移期理论边角。R3 实现 token-accurate 滞后时需同时约束"滞后不得推翻当次 fence 决定"。仍 NON_BLOCKING。
- **F5（测试可验证性）—— 部分改善**。sealed-arc 测试已重写（注释/断言一致、覆盖边界落弧内）。未改：reasoning 计数错位（3 counts vs 4 units，测试平凡通过）、open-arc 测试仍用 target=0（生产不可达）、两个数学测试仍为自指断言。
- **F6（生产无调用点）—— 未改，仍成立**。`grep resolveProtectedTail` 仅命中 protected-tail.ts 自身与测试文件。
- **F7（findSuffixStartForTokens 文档注释）—— 未改**。注释仍把"会话总量不足 target"的返回值写成 `entries.length+1`（实际为 1），与实现相反。

## 固定结论块（RE-REVIEW 6876dff）

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 锚点 floor 的 force/emergency 压力豁免（authority #132 sparse-session compaction）与 sealed-arc fence 的 fenceBoundaryForToolArcs 语义（边界落 span 内推进 head）两项已与权威 protected-tail-boundary.ts 对齐并通过实证与测试双验证；hysteresis（entry-seq vs token）与 oversizeAtomicUnit（tail vs N）两处偏差已以代码注释形式明示为 acknowledged deviation 并推迟至 R3 fold-path 集成，规格正文无冲突约定；原 recovery-F1 无锚点超目标折叠行为及测试声称不对齐保持原状（接线前必修，条件未触发）。
CODE CORRECTNESS: resolveProtectedTail 重写正确——anchorFloorActive 条件（`!isEmergency && usage<80`）在 routine 路径保留 floor、force/emergency 路径解除；sealed-arc 区间推进单调向前（多弧重叠/连续时多次推进收敛），open-arc 拉回在推进之后执行；实证所有 target 下边界不落在 `(arcStart, arcEnd]`，无回归（routine 与默认路径 tailStart=1）。残余理论边角：stale previousPlan 的 in-arc 边界可被滞后拉回切跨（仅旧→新代码迁移期可产生，生产无 previousPlan 调用方）。
RECOVERY/CONCURRENCY: 计划仍为纯函数派生（projection + tokenTarget + 可选 previousPlan），无新持久状态或并发共享；context-migrations 12/12（含 SIGKILL crash window）、crash:check 7/7、migration:smoke idempotent 均通过；previousPlan 为显式参数，崩溃后重放由调用方重新提供。生产接线缺失（F6）不变，恢复闭环仍为模块级+store 级静态成立。
TEST COVERAGE: 12/12 通过；新增 force-pressure 测试真实锻炼 routine vs force vs emergency 三分支并断言 `tailStart>1`，sealed-arc 测试按权威语义断言边界落在弧外且 `fenced===true`。未改缺口：reasoning 计数错位致测试平凡通过、open-arc target=0、无锚点超目标用例（声称 vs 行为未对齐）、滞后无 ≥256 大移动用例、数学测试自指断言。
EVIDENCE ACCURACY: commit message 数字与真实输出逐项吻合（12/12 专项、150 unit: 148+2 skip、4 golden、12 migrations、3 subprocess、6 CLI、crash:check 7/7、dist:smoke ok）；本 RE-REVIEW 全部命令真实执行并记录输出，实证脚本存放于系统临时目录、未写入仓库。
FINDINGS: R-F1 已解决（usage>=80 或 emergencyTailScale 时 anchor floor 解除，稀疏会话 head 可折叠，实证 tailStart=5>1）；R-F3 已解决（sealed-arc 边界恒落在 [arcStart,arcEnd] 之外，fenced=true，非相邻弧场景被区间检查覆盖）；F2 hysteresis entry-seq 偏差与 F4 oversize tail-vs-N 偏差已文档化为 acknowledged deviation 并推迟 R3（可接受 NON_BLOCKING）；recovery-F1 无锚点超目标折叠仍与测试声称不对齐（接线前必修，未触发）；recovery-F4 滞后可覆盖 fence 决定的交互仍存在，仅迁移期理论边角，R3 需约束顺序；F5 reasoning 计数错位/自指断言保留，sealed-arc 部分已修复；F6 生产无调用点与 F7 文档注释错误未改。
<!-- OMO_INTERNAL_INITIATOR -->
