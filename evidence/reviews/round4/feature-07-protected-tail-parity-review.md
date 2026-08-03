# Feature 6 (R2) — Protected Tail & Tool-Arc Fences 独立评审（OpenCode parity reviewer）

## 评审人角色
OpenCode parity reviewer（独立评审，非实现者）

## Reviewed HEAD
a3ea251c feat(context): protected tail & tool-arc fences (R2 Feature 6)

## 变更范围
- src/context/protected-tail.ts（新增 374 行）
- test/context-protected-tail.test.ts（新增 394 行，11 个测试）
- evidence/reviews/round4/feature-06-pass-taxonomy-review.md（48 行历史评审记录，随本提交附带）

## 审阅文件
- git show HEAD --stat 与 git show HEAD 全文
- src/context/protected-tail.ts（全文 374 行）
- test/context-protected-tail.test.ts（全文 394 行，11 个测试）
- src/context/projection.ts（HistoryProjectionUnit 与 projectLogicalUnits，485 行）
- evidence/notion-round4/01-context-assembly.md（LKG/splice 语义第 234 行）
- evidence/notion-round4/02-magic-context.md（Protected Tail 章节第 109-124 行、trigger budget 公式第 144-152 行）
- evidence/notion-round4/04-pi-compat.md（v0.33.0 pressure-gated tool reclaim 第 75 行）
- evidence/notion-round4/07-roadmap.md（R2 里程碑第 110-132 行）
- 权威源 protected-tail-boundary.ts（全文 1033 行）与 protected-tail-boundary.test.ts（全文 767 行）
- 权威源 derive-budgets.ts（全文 114 行）
- 权威源 read-session-true-raw-tokens.ts（findSuffixStartForTokens 第 612-630 行、fenceBoundaryForToolArcs 第 491-525 行）
- test/fixtures/context/opencode-v0.33.0/ 下 3 个 protected-tail fixture + constants.json
- evidence/context-golden/provenance.md（fixture 哈希表）

权威 checkout 验证：`git -C mc-authority rev-parse HEAD` = 48ab531d8fa98af2f463db2e4d9f8ffdd63d765e（"release: v0.33.0"），与 fixture 内 authorityCommit、provenance.md 记录完全一致。

## 实际执行的测试与输出

### 1) npx tsx --test test/context-protected-tail.test.ts
结果：# tests 11, # pass 11, # fail 0, # skipped 0, duration_ms 329.1
11 个用例全部通过：authority golden 矩阵（n-clamp / suffix walk / force-head minimum）、token target 数学、trigger budget + per-run caps、anchor floor、sealed-arc fence、open-arc fence、reasoning seam、no-anchor fail-conservative、hysteresis、fingerprint determinism、empty projection。

### 2) npm run check（完整 gate，真实执行）
逐段通过：
- format:check（prettier）、lint（eslint）、typecheck（tsc --noEmit）
- npm test：150 unit → 148 pass + 2 SKIP（R1-P1 live vertical slice，OPENCODE_GO_API_KEY 未设置，声明为 live skip）
- test:context-golden：4/4
- test:context-migrations：12/12（含 SIGKILL 崩溃窗口）
- migration:smoke：idempotent（firstApplied: [0001_bootstrap], secondApplied: []）
- crash:check：7/7 boundaries ok
- build + copy-migrations：ok
- test:subprocess：3/3
- test:cli：6/6
- dist:smoke：ok

## Checklist 逐项核对

1. 常量 byte-locked — PASS。protected-tail.ts 第 28-46 行的 15 个常量逐一与权威 protected-tail-boundary.ts 第 145-161 行 + derive-budgets.ts 第 26-28 行比对：ALPHA=0.3、FLOOR_RATIO=0.08、FLOOR_MIN=2000、FLOOR_MAX=12000、ABS_CAP=96000、MAX_USABLE_RATIO=0.4、RESERVED_HEADROOM_MIN=1000、RESERVED_HEADROOM_RATIO=0.02、NON_EMERGENCY_MAX_CAP=250000、FORCE80_MAX_CAP=500000、FORCE95_MAX_CAP=750000、NORMAL_HYSTERESIS_TOKENS=256、RECOVERY_NO_HEAD_LIMIT=2、MIN_FORCE_ELIGIBLE_TOKENS_CAP=1000、TRIGGER_BUDGET_PERCENTAGE=0.05/MIN=5000/MAX=50000。全部一致；constants.json fixture 亦锁定 TRIGGER_BUDGET 与 RECOVERY_NO_HEAD_LIMIT / MIN_FORCE_ELIGIBLE_TOKENS_CAP。

2. deriveProtectedTailTokenTarget — PASS。protected-tail.ts 第 98-123 行与权威第 176-202 行逐行等价（safeContextLimit/safeThreshold/usable/clampPercentage/triggerBudget/reserve/rawN/floorN/headroom/ceilingN/effectiveFloor/N，顺序与公式一致）。手工验证 golden：8000/65/30 → usable=5200、rawN=1092、floorN=2000、headroom=2600、ceilingN=2080、N=2000；12000/65/95 → usable=7800、ceilingN=3120、N=2000。与 protected-tail-n-clamp.json（ceilingN [2080,3120]、N [2000,2000]）完全一致。

3. findSuffixStartForTokens — PASS。权威（read-session-true-raw-tokens.ts 第 612-630 行）为 prefix-sum 二分：tokens<=0 → rawMessageCount+1；total<target → 1；否则返回使后缀 >= target 的最小 ordinal。Iris（第 170-180 行）为等价后向线性扫描，对 golden [100,100,100]/[150,301,300,0] 输出 [2,1,1,4] 全部一致（0 → 4 即 length+1，边界 `targetTokens <= 0` 与权威 `!isFinite || <=0` 在整数输入下等价）。与 protected-tail-suffix-walk.json 一致。

4. deriveMinForceEligibleTokens — PASS。protected-tail.ts 第 126-128 行与权威第 163-165 行逐字等价；golden 8→1、16000→1000、cap=1000，与 protected-tail-force-head-minimum.json 一致。

5. per-run caps + selectPerRunCap — PASS。nonEmergency/force80/force95 公式与权威第 204-217 行逐字等价；selectPerRunCap（usage>=95→force95、>=80→force80、else nonEmergency）与权威第 219-232 行一致，usable 计算一致（max(1, round(contextLimit*threshold/100))）。测试 3 显式覆盖三个分支。

6. resolveProtectedTail 语义：
   (a) last safe real-user anchor = 最新 VERIFIED input unit — PASS。Iris 第 263-271 行遍历取 `kind==="input" && verified===true` 的最后一项；unverified/orphan input 永不成为 anchor（测试 8 fail-conservative 验证）。与 projection.ts 的 lastSafeUserAnchor（第 301-303 行）同规则同源。
   (b) routine live-user floor：anchor 及之后全部内容在 tail — 部分 PASS（见 F1）。Iris 第 284-286 行无条件 clamp `tailStartUnitIndex = min(tailStartUnitIndex, anchorUnitIndex+1)`；权威仅在 `!ctx.emergencyTailScale && usagePercentage < 80` 时应用 live-prompt floor（第 561-573 行），force 压力路径（usage>=80、emergencyTailScale）有意允许跨界，保证 #132 型稀疏会话仍可压缩（权威测试第 276-291 行显式断言 emergency 路径跨界且 `emergency.protectedTailStart >= snapshot.protectedTailStart`）。Iris 缺少该压力豁免，"routine"限定未落实。
   (c) boundary 落在 unit start、永不切断 input pair / tool arc / reasoning / boundary — PASS 但 sealed-arc 折叠方向与权威相反（见 F2）。Iris fence（第 292-307 行）当 prev.end >= cur.start 时把 boundary 拉回 prev 起点，使跨界的 sealed arc 整体进入 tail（保护）；权威 trigger 路径对 closed arc 取 `boundary = resOrdinal + 1`（第 499-502 行），把跨界 arc 整体推进 head（折叠）。两者都满足"绝不切断 arc"，但折叠策略相反。
   (d) open tool-arc fence 经 openToolCallIds（callId set difference）— PASS。projection 只发 sealed tool_arc unit，未解析的 callId 保留在 assistant unit.toolCallIds；Iris 第 206-225 行用 resolved set 差集识别 open arc，第 312-320 行把 boundary 拉到 open assistant 之前（openIndex+1）。与权威 recentOpenArcCutoff 语义等价：boundary 之前的 open arc（stale/interrupted）不进 tail、可折叠；boundary 处或之后的 open arc 被保护（测试 6 验证）。Iris 缺少权威对 `invOrdinal >= boundary` 时把 boundary 前移到 open arc 的等价分支，但后果一致（open arc 均受保护）。
   (e) hysteresis — 偏差（见 F3）。权威（第 575-580 行）：eligible head 的 token 总量 `rangeTokens(offset, protectedTailStart) <= NORMAL_HYSTERESIS_TOKENS` 时把 boundary 收回 offset；Iris（第 329-335 行）：当前 boundary 与 previousPlan.protectedTailStartEntrySeq 的 entrySeq 差 < 256 时保持上轮 boundary。度量（tokens vs entries）、锚点（offset vs 上轮 boundary）、作用方向（收回到折叠起点 vs 保持上轮位置）均不同；checklist 表述为 "<256-token moves"，实现是 "<256-entry moves"。
   (f) oversizeAtomicUnit — 存在但定义不同（见 F4）。权威（第 349 行）：`end === offset+1 && tokenForOrdinal(offset) > capTokens`（首个 eligible head message 超 per-run cap）；Iris（第 341-348 行）：boundary 处首个 tail unit 的 token 数 > tokenTarget N。判断侧（head vs tail）与阈值（per-run cap vs N）均不同。

7. Spec 映射：
   - "newest todo/tool state floor 被保护" — 由 (b) verified-anchor floor 实现；但该 floor 无条件生效，在 force 压力下过度保护（F1）。
   - "不能在 tool arc 中间截断" — fence 保证 arc 原子性 ✓（放置方向见 F2）。
   - "不能在 signed reasoning seam 中间 splice" — reasoning unit 与其 assistant 绑定（prev.end>=cur.start 判定拉回），never spliced ✓。注：测试 7 实际因 anchor floor 覆盖全会话（tail start=1）而平凡通过，未独立锻炼 reasoning fence 分支。
   - "unrelated fold 不会错误回收 tool state" — open arc 永不折叠（保护）；stale open arc 留在可折叠 head 中与权威一致 ✓。
   - "v0.33.0 pressure-gated tool reclaim" — per-run caps + selectPerRunCap 已 byte-lock ✓；但压力路径不能跨 anchor floor（F1），#132 稀疏会话在 force 压力下无法形成 eligible head 的权威行为缺失。

8. Golden fixtures — PASS。三个 fixture 的 expected 值与权威 protected-tail-boundary.test.ts 的硬编码断言一致（n-clamp ceilingN [2080,3120]、N [2000,2000]；suffix walk [2,1,1,4]；force-head minimum [1,1000]、cap 1000）；实测 sha256（8bd07854…、9df7008586…、833bc360…）与 provenance.md 第 31-33 行逐一吻合；权威 checkout 确证位于 48ab531d。

## 发现项
- F1（非阻塞，权威行为缺口）：anchor floor 无条件应用。权威 live-prompt floor 只作用于 routine pass（usage<80 且非 emergency），force80/force95 与 emergency-scaled 路径可跨界以保持 #132 型稀疏会话（单一 user turn + 巨量 assistant/tool tail）在压力下仍有可压缩 head（权威测试第 276-291 行）；Iris resolveProtectedTail 无 usage/emergency 参数，任何 pass 都从最新 verified anchor 起保护全部内容。后果：稀疏长会话在 95% 压力下无法形成 eligible head，context 可能溢出；属 fail-conservative（不丢用户内容）但与 v0.33.0 压力语义不符。建议 R3 接线时引入 usage 维度并复刻 force 路径豁免。
- F2（非阻塞，sealed-arc fence 方向偏差）：对 closed（sealed）tool arc，权威 trigger 路径把跨界 arc 整体推进 head（boundary=resOrdinal+1，整条折叠，第 499-502 行）；Iris 把跨界 arc 拉回 tail（保护，测试 5 断言 boundary <= arc start）。两者都保证原子性，但 Iris 的 eligible head 在 tool 密集会话中明显小于权威、折叠更保守。R3 Historian 消费该 plan 后，折叠产出将与权威 golden 不同。
- F3（非阻塞，hysteresis 算法偏差）：权威以 eligible head 的 token 总量为度量（<=256 收回到 offset），Iris 以当前/上轮 boundary 的 entrySeq 差为度量（<256 保持上轮）。每 unit 数百~数千 token 时，256-entry 死区可对应数十万 token，显著延迟折叠；当前 previousPlan 无任何生产调用方（仅测试传入），属潜伏偏差。
- F4（信息性，oversizeAtomicUnit 定义偏差）：Iris 判定"boundary 处首个 tail unit > N"，权威判定"首个 eligible head message > per-run cap"。侧（tail/head）与阈值（N/capTokens）均不同，当前无消费者。
- F5（信息性，尚未接线）：src/ 全库 grep 确认 resolveProtectedTail / protected-tail.ts 无任何生产调用点（仅模块自身与测试引用）；context-store.ts 的 protected_tail_start_entry_seq 列与字段虽已存在，但本提交未接入。R3 Historian 接线时需保证 plan→fold 映射并补端到端集成测试。

## 结论
VERDICT: NON_BLOCKING（全部 byte-locked 纯函数与 golden fixture 逐字一致；偏差集中在 plan 级策略——anchor floor 无条件化、sealed-arc fence 方向、hysteresis 度量、oversize 定义——均为 fail-conservative 或潜伏未接线，无数据丢失与现网影响）

## 固定结论块

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: 与 04-pi-compat.md 第 75 行 v0.33.0 pressure-gated tool reclaim 契约对齐的骨架成立（per-run caps/selectPerRunCap byte-lock、open arc 永不折叠、unrelated fold 不回收 in-flight tool state）；"newest todo/tool-state floor 被保护"由 verified-anchor floor 实现，但该 floor 无条件生效，缺少权威在 force80/force95/emergency 路径允许跨界以保证 #132 稀疏会话可压缩的行为（F1）；tool arc 与 reasoning seam 原子性（不切断）满足 spec 01-context-assembly 第 234 行 splice 要求（放置方向见 F2）。
CODE CORRECTNESS: deriveProtectedTailTokenTarget / findSuffixStartForTokens / deriveMinForceEligibleTokens / nonEmergency·force80·force95PerRunCap / selectPerRunCap / deriveTriggerBudget 与权威逐行等价并通过 golden fixture 验证；resolveProtectedTail 为确定性纯函数，anchor 取最新 verified input、boundary 落在 unit start、open-arc callId 差集 fence、no-anchor fail-conservative 均正确。偏差：sealed-arc fence 方向与权威 trigger 路径相反（保护 vs 折叠，F2）、hysteresis 以 entrySeq 差替代 token 总量（F3）、oversizeAtomicUnit 侧与阈值不同（F4），均不破坏"不切断"不变量。
RECOVERY/CONCURRENCY: 本模块为无副作用纯函数，不引入新持久状态、后台任务或并发共享；context-migrations 12/12、crash:check 7/7、migration:smoke idempotent 验证既有持久化路径无回归；previousPlan 为显式函数参数，崩溃后重放由调用方重新提供，无隐式可变状态。
TEST COVERAGE: 专用测试 11/11 通过（golden 矩阵、token target、per-run caps、anchor floor、sealed/open arc fence、reasoning seam、no-anchor、hysteresis、fingerprint、empty projection）；npm run check 全绿（150 unit: 148 pass + 2 live skip；4 golden；12 context-migrations；3 subprocess；6 CLI；migration:smoke idempotent；crash:check 7/7）。缺口：reasoning seam 测试因 anchor floor 覆盖全会话而平凡通过，未独立验证 reasoning fence 分支；无 #132 压力跨界、closed-arc 折叠方向、oversizeAtomicUnit 的专门测试。
EVIDENCE ACCURACY: commit message 声称的测试数字与实际输出逐项吻合（11/11 专用、150 unit: 148 pass + 2 live skip、4 golden、12 migrations、3 subprocess、6 CLI）；三份 fixture 实测 sha256 与 provenance.md 记录一致；权威 checkout 确证位于 48ab531d（v0.33.0 release）。本评审全部命令真实执行并记录输出。
FINDINGS: F1 anchor floor 无条件化，缺少权威 force 路径跨界豁免（#132），稀疏会话压力下无 eligible head（非阻塞）；F2 sealed-arc fence 方向与权威 trigger 路径相反（Iris 保护、权威整条折叠），R3 接线时折叠产出将与 golden 不同（非阻塞）；F3 hysteresis 以 entrySeq 差代替权威的 token 总量度量，256-entry 死区可能显著延迟折叠，当前无生产调用方（非阻塞）；F4 oversizeAtomicUnit 判定侧与阈值（tail unit vs N）不同于权威（head message vs per-run cap）（信息性）；F5 本提交尚未接线任何生产调用点（信息性）。
<!-- OMO_INTERNAL_INITIATOR -->
