# Round 4 — Feature 2 (Golden Fixture Generator) 独立审查

- Reviewer role: Golden-fixture reviewer（独立审查者，非实现者）
- Reviewed baseline: 441c329 / d36a411 / 3158cd1
- Reviewed HEAD: baca85a86db8ebd7c061974df0ccddb1baf09115 `feat(context): OpenCode v0.33.0 golden fixture generator (R2 Feature 1)`
- Review date: 2026-08-03
- Verdict: **NON_BLOCKING**（详见结论块；存在必须修复的确定性缺陷，但不影响已提交 fixture 的正确性，也不违反 R2 核心授权来源/非自证要求）

## 审查对象（全部实读）

| 类别 | 文件 |
| --- | --- |
| 锁清单 | `scripts/context-golden/authority.json` |
| 生成器 | `scripts/context-golden/generate.ts`（600 行） |
| 测试 | `test/context-golden.test.ts`（151 行，4 个用例） |
| 12 个 fixture | `test/fixtures/context/opencode-v0.33.0/`（constants.json + 11） |
| provenance | `evidence/context-golden/provenance.{json,md}` |
| 格式豁免 | `.prettierignore` |
| 权威源（锁定 @48ab531d, v0.33.0） | `inject-compartments.ts`（3062 行）、`compartment-trigger.ts`、`derive-budgets.ts`、`protected-tail-boundary.ts`、`sentinel.ts`、`m0m1-taxonomy.test.ts`、`protected-tail-boundary.test.ts` |

## 检查清单逐项结论

### 1. AUTHORITY LOCK — PASS
- `authority.json` 锁定 `48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`（v0.33.0），与 `test/context-golden.test.ts` 内联常量一致。
- 本地克隆 `C:\Users\15027\AppData\Local\Temp\opencode\mc-authority\magic-context`：`git log --oneline -1` = `48ab531d release: v0.33.0`；`git describe --tags` = `v0.33.0`。
- `git show -s --format="%H %D %s" v0.33.0`：标注 tag object `10cb731d…`（tagger ualtinok, “Release v0.33.0”），指向 commit `48ab531d` = HEAD。是真实 released tag。
- 生成器 `assertAuthorityHead()` 在生成前硬校验 HEAD，不匹配即抛错（实测：把 `MC_AUTHORITY_PATH` 指向 iris 仓库 → `authority HEAD mismatch: expected 48ab531d…, got baca85a…`，EXIT=1，未写任何文件）。

### 2. NO SELF-CERTIFICATION — PASS（附 1 处措辞超卖）
- 22 个常量全部由正则从权威源机械提取，并逐项与权威源比对：`M0_EMPTY_BODY`/`M1_EMPTY_PLACEHOLDER`/`DEFAULT_MEMORY_BUDGET_TOKENS=8000`/`DEFAULT_USER_PROFILE_BUDGET_TOKENS=4000`（inject-compartments.ts）；`PROACTIVE_TRIGGER_OFFSET_PERCENTAGE=2`/`POST_DROP_TARGET_RATIO=0.75`/`MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE=6000`/`MIN_PROACTIVE_TAIL_MESSAGE_COUNT=12`/`TAIL_SIZE_TRIGGER_MULTIPLIER=3`/`FORCE_COMPARTMENT_PERCENTAGE=80`/`BLOCK_UNTIL_DONE_PERCENTAGE=95`/`FORCE_MATERIALIZE_PERCENTAGE=85`（compartment-trigger.ts）；`TRIGGER_BUDGET_PERCENTAGE=0.05`/`MIN=5000`/`MAX=50000`/`HISTORIAN_CHUNK_PERCENTAGE=0.25`/`MIN=8000`/`MAX=50000`/`DEFAULT_HISTORIAN_CONTEXT_FALLBACK=128000`（derive-budgets.ts）；`RECOVERY_NO_HEAD_LIMIT=2`/`MIN_FORCE_ELIGIBLE_TOKENS_CAP=1000`（protected-tail-boundary.ts）；`WHOLE_MESSAGE_PLACEHOLDER_TEXT="[dropped]"`（sentinel.ts）。全部一致。
- 11 个 fixture 的 expected 与权威测试断言逐一映射成立：
  - SOFT+（defer 双 pass m0/m1 byte-identical、m1 不含 “Bravo delta”）↔ `expect(d1.m1).not.toContain("Bravo delta")` 等；
  - SOFT（m0 不变、m1 重渲染并含 B、m0 不含 B）↔ `expect(soft.m1).toContain("Bravo delta")`/`expect(soft.m0).not.toContain(...)`；
  - HARD model_change（reason="model_change"、rematerialized、m0 含 B、m1 复位为 M1_PLACEHOLDER）↔ `expect(hard.reason).toBe("model_change")` 等；
  - HARD system_hash ↔ `expect(hard.reason).toBe("system_hash")`；
  - empty-signal no-fold ↔ `expect(unknown.rematerialized).toBe(false)`；
  - ttl_idle fold-once + idempotent ↔ `expect(fold.reason).toBe("ttl_idle")`/`expect(again.rematerialized).toBe(false)`；
  - pressure backstop m1 cap ↔ `expect(folded.m0RematerializedThisPass).toBe(true)`/`expect(folded.m1Text).toBe(M1_PLACEHOLDER)`（但 reason 标签见下）；
  - restart markers persist ↔ `expect(restartState.cachedM0ModelKey).toBe("anthropic/opus")`/`expect(noFold.rematerialized).toBe(false)`；
  - suffix walk [2,1,1,4] ↔ `findSuffixStartForTokens(150)).toBe(2)` 等 4 条；
  - n-clamp ceilingN [2080,3120] / N [2000,2000] ↔ `ceilingN).toBe(2_080)` 等 4 条；
  - force-head-minimum [1,1000]/cap 1000 ↔ `MIN_FORCE_ELIGIBLE_TOKENS_CAP).toBe(1_000)`/`deriveMinForceEligibleTokens(8)).toBe(1)`/`(16_000)).toBe(1_000)`。
- **发现**：`taxonomy-pressure-backstop-m1-cap.json` 的 `expected.reason = "m1_absolute_cap"` 在权威源中**零命中**（全仓 grep 无此字符串；`mustMaterialize` 的 reason 仅有 first_render/model_change/system_hash/ttl_idle/project_change/project_memory_epoch/max_mutation_id/upgrade_state/compartment_render_epoch/cached_m1_missing）。权威实现的 m1 绝对上限折叠（`injectM0M1` 内 `M1_ABSOLUTE_CAP_RATIO=0.2`，行 2987）及其测试只断言行为（rematerialized + m1 复位），不产出该 reason 字符串。因此该标签是 Iris 自创的序列化标签；语义忠实（来自权威实现与测试注释），但 commit message 与 `authority.json` notes 中“verifies every fixed expected value is literally present in the authority’s tests”的表述超卖。同理 `reset_to_placeholder`/`byte_identical`/`re_rendered` 为 Iris 侧 schema 标签，语义各有权威断言锚定。

### 3. ASSERTION ANCHORS — PASS（部分覆盖，属纵深防御）
- 13 个 anchor 全部实测存在于权威测试源码（行号逐一核对：`isCacheBustingPass: false`→m0m1-taxonomy.test.ts:128；`toBe(M1_PLACEHOLDER)`→:173/:286；`"model_change"`→:169；`"system_hash"`→:187；`"ttl_idle"`→:233；`first_render`→:121/:266；`cached_m0_materialized_at`→:224；suffix-walk/ceilingN/MIN_FORCE_ELIGIBLE_TOKENS_CAP/deriveMinForceEligibleTokens(16_000) 等→protected-tail-boundary.test.ts:15/16/35/37/44/46）。
- 若权威源改动/删除这些字符串，生成会硬失败——机制对命中项有效。
- 但覆盖是部分的：pressure-backstop 的 `reason` 标签、`m0RematerializedThisPass` 语义、SOFT/HARD 分类、`m0MustContain` 等未锚定。真正的漂移防线是 HEAD 锁（生成被限定在精确 commit 上），anchor 是防御纵深。若规格要求“任何断言漂移都导致生成失败”，当前 13 条 needle 不足以实现该承诺。

### 4. OFFLINE — PASS
- `test/context-golden.test.ts` 只读 `process.cwd()` 下已提交文件（`test/fixtures/context/opencode-v0.33.0/`、`evidence/context-golden/provenance.json`、`scripts/context-golden/authority.json`），无网络、无需 authority checkout。代码审读 + 4 个用例实测通过确认。`.prettierignore` 已豁免 fixture 与 provenance（`format:check` 通过）。

### 5. MURAL — PASS
- 生成器 `assertNoMural()`（`/mural/i`）应用于 constants fixture 与全部 11 个 fixture body，命中即抛错。
- 测试套件对全部 12 个已提交 fixture 断言 `doesNotMatch(/mural/i)`（实测通过）。
- 我对 fixture 目录独立 grep `mural|experimental`：零命中。
- provenance 清单散文有意包含 “Memory Mural” 一词作为禁令陈述（代码注释明确说明守卫只作用于 fixture 数据，不作用于 manifest 散文）——可接受，已记录。

### 6. DETERMINISM — FAIL（核心缺陷）
- `generate.ts` 行 371：ttl fixture 的 `lastResponseTime` 在**生成时刻**计算 `Date.now() - 60*60*1000 + 1000`；`generatedAtUtc: new Date().toISOString()` 写入 provenance。
- 实测（同一锁定 authority，`MC_AUTHORITY_PATH` 指向克隆）：
  - 提交版 `taxonomy-hard-ttl-idle-fold-once` hash = `d54526c8…`（generatedAtUtc 2026-08-02T20:55:24.552Z）
  - 第 1 次生成 = `79b33c33…`；第 2 次生成（间隔 1.2s）= `e8bab782…`，且 `generatedAtUtc` 随之改变。
  - 其余 11 个产物两次生成均字节一致，与提交版完全相同。
- 结论：同一权威源、同一生成器，三次运行产出三个不同 hash——生成器自述保证“Deterministic output: the same authority produces byte-identical fixtures and hashes”（generate.ts:16-17）与 commit message 声称的 “Deterministic output” 均被证伪。后果：已提交 provenance 永远无法复现；任何重新生成都会在没有权威变更的情况下改变 golden 基线，削弱 hash 锚定的漂移检测价值。
- 复核后已将工作区恢复为提交状态（`git checkout --` 回滚 3 个被重写文件，工作区 clean）。

### 7. HASH INTEGRITY — PASS
- 对提交状态运行 `npx tsx --test test/context-golden.test.ts`：4/4 通过（authority lock；fixture 完整性 + 离线 + mural；expected 值与权威断言一致；provenance 自洽含 constantsJson hash）。TAP 摘要 `# pass 4 # fail 0`。

### 8. COMMIT vs MASTER — PASS
- authority 克隆 HEAD = `48ab531d`（v0.33.0）；`git log --oneline -3 master` = `7d223061 / 5b3e0e07 / 3c0dbe42`——master 在完全不同的 commit。锁定 commit 是 released tag，不是 master。

### 9. FULL GATE — PASS
- `npm run check` 全链路通过：`format:check` ✓、`lint` ✓、`typecheck` ✓、`npm test`（103 用例：101 pass / 2 skip [live provider] / 0 fail）、`test:context-golden`（4/4）、`migration:smoke`（idempotent）、`crash:check`（7 个边界全过）、`build` ✓、`test:subprocess`（3/3）、`test:cli`（6/6）、`dist:smoke` ✓。与 commit message 声称 “103 unit + 4 golden + 3 subprocess + 6 CLI” 完全吻合。

## 测试实况汇总

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test test/context-golden.test.ts`（提交状态） | 4/4 pass，fail 0 |
| 生成器 run 1（`MC_AUTHORITY_PATH` 指向锁定克隆） | status ok；ttl hash `79b33c33…` ≠ 提交版 `d54526c8…` |
| 生成器 run 2（间隔 1.2s） | status ok；ttl hash `e8bab782…` ≠ run1 ≠ 提交版 |
| 生成器（`MC_AUTHORITY_PATH`=iris 仓库，HEAD 不匹配） | 硬失败 `authority HEAD mismatch`，EXIT=1，未写文件 |
| `npm run check` | 全通过（含 103+4+3+6 测试） |

VERDICT: NON_BLOCKING
SPEC COMPLIANCE: PASS（fixture 来自锁定 released v0.33.0 @ 48ab531d，非 master；expected 值全部映射权威测试断言，无 Iris 运行时自证；mural 禁令有效）
CODE CORRECTNESS: PASS with one must-fix（HEAD 锁、常量机械提取、anchor 机制、mural 守卫、离线可用均正确；唯一缺陷是 ttl fixture 内嵌 `Date.now()` 与 provenance 内嵌 `generatedAtUtc`，破坏字节级确定性）
RECOVERY/CONCURRENCY: PASS（生成器无共享状态与并发面；HEAD 不匹配/文件缺失均硬失败，无静默回退；工作区复核后已恢复 clean）
TEST COVERAGE: PASS（4 个 golden 用例覆盖锁、离线+mural、expected 值、provenance 自洽；hash 校验覆盖全部 12 个文件；npm run check 全量通过）
EVIDENCE ACCURACY: PASS with overstatement（provenance.json/md 与提交版一致且哈希全部校验通过；但 commit message 与 authority.json notes 声称“deterministic output / every fixed expected value literally present in authority tests”与事实不符——确定性已被 3 次不同 hash 证伪，`m1_absolute_cap` 标签在权威源零命中）
FINDINGS:
- F1 [MUST FIX] 确定性被破坏：generate.ts:371 的 `Date.now()`（ttl fixture `lastResponseTime`）与 provenance 的 `generatedAtUtc` 使同一权威源每次生成产生不同字节/hash（实测 3 次 3 个 hash：d54526c8/79b33c33/e8bab782）。建议改为固定合成时间戳（如固定 epoch 或与 `materializedAt` 的相对偏移量），并/或从 hash 域排除 `generatedAtUtc`；修复后重新生成并提交以兑现“deterministic output”承诺。
- F2 [MINOR] `expected.reason = "m1_absolute_cap"` 为 Iris 自创标签，权威源（实现与测试）均无此字符串；pressure-backstop 行为虽被 `toBe(M1_PLACEHOLDER)` 锚定，但 reason 标签不受 anchor 保护。建议：将该标签标注为 serializer 侧解释标签（记录于 provenance/schema 文档），或将该行为锚定到权威测试对 `m0RematerializedThisPass` 的断言，并修正“every fixed expected value literally present”的超卖表述。
- F3 [MINOR] assertion anchor 仅 13 条 needle、部分覆盖（SOFT/HARD 分类、`m0MustContain`、pressure-backstop reason 等未锚定）；若“断言漂移即失败”是硬要求，需扩 anchor 集；当前实际漂移防线为 HEAD 锁（工作正常）。
- F4 [OBSERVATION] ttl fixture 的 input 未携带 `cached_m0_materialized_at`，而 ttl 折叠语义依赖 `materializedAt < lastResponseTime`；作为场景描述可接受，但建议在 provenance 中注明该隐式前提，便于消费者正确回放。

<!-- OMO_INTERNAL_INITIATOR -->
---

## RE-REVIEW (F1 FIX) — 2026-08-03

Reviewed commit: 40d75cf7bd8fe4907f3e489baa4a93e2aa7ff022 `fix(context-golden): deterministic regeneration (reviewer F1/F4)`

### 验证 1 — 修复 diff
- `generate.ts` 行 365-377：ttl fixture 改用冻结常量 `cachedM0MaterializedAt = 1_785_696_925_547` 与 `lastResponseTime = 1_785_696_926_547`（非 Date.now() 派生）；差值 = 3,600,000ms（1h）+ 1,000ms（1s），与权威测试相对语义完全一致（`tPast = Date.now()-1h` 作为 materializedAt，`lastResponseTime = tPast + 1000`）。
- fixture input 新增 `cachedM0MaterializedAt` 字段 —— F4 顺带修复（回放前提已携带）。
- `provenance.json` 删除 `generatedAtUtc`，`provenance.md` 删除 "Generated at (UTC)" 行（第二处非确定性源）。
- 全 `scripts/context-golden/` grep `Date.now|new Date|generatedAtUtc|toISOString`：零命中。

### 验证 2 — DETERMINISM（关键）
- 同一锁定 authority（HEAD = 48ab531d）连续两次生成（间隔 3s）：
  - Run 1 与 Run 2 的 12 个输出 hash **全部一致**；
  - 且与提交版 `provenance.json` 的 `outputHashes` 完全一致；
  - 两次生成后 `git status --short` 输出为空 —— 工作区零 fixture/provenance diff，字节级等于提交状态（无需 restore）。
- ttl fixture hash = `a608b801ade7862b053da38e7c12046223337160637513f4c0c159658530d436`，与 commit message 声称、提交版 provenance 三方一致。
- 对照修复前：3 次运行 3 个不同 hash（d54526c8 / 79b33c33 / e8bab782）→ 现为 3 次一致。F1 已实证修复。

### 验证 3 — HASH INTEGRITY
- `npx tsx --test test/context-golden.test.ts`：4/4 pass，fail 0。

### 验证 4 — FULL GATE
- `npm run check` 全链路通过：format:check ✓ / lint ✓ / typecheck ✓ / npm test（103 用例：101 pass + 2 skip [live provider] + 0 fail）/ test:context-golden（4/4）/ migration:smoke（idempotent）/ crash:check（7 边界全过）/ build ✓ / test:subprocess（3/3）/ test:cli（6/6）/ dist:smoke ✓。与 commit message "103 unit + 4 golden + 3 subprocess + 6 CLI" 一致。

### 验证 5 — F4 关闭确认
- ttl fixture input 现携带 `cachedM0MaterializedAt = 1785696925547`（基线在 1h 前）与 `lastResponseTime = 1785696926547`（基线后 1s）；折叠语义（`materializedAt < lastResponseTime` 触发一次 HARD fold，fold 后 materializedAt 前进故幂等）完整、可回放、可复现。

RE-REVIEW VERDICT: PASS
SPEC COMPLIANCE: PASS（核心授权来源/非自证要求未受影响；"deterministic output" 承诺现已兑现）
CODE CORRECTNESS: PASS（F1 修复正确：冻结 epoch 常量 + 移除 generatedAtUtc；两次生成字节级一致且等于提交版；F4 一并修复）
RECOVERY/CONCURRENCY: PASS（无变化：无共享状态、无并发面；HEAD 锁硬失败机制保持）
TEST COVERAGE: PASS（4/4 golden 通过；npm run check 全量通过）
EVIDENCE ACCURACY: PASS（commit message 声称的 a608b801 hash 与提交版 provenance 及实测三方一致；EVIDENCE 无残留超卖）
FINDINGS:
- F1 [CLOSED] 确定性已实证修复：两次生成 12/12 hash 一致且等于提交版（ttl `a608b801…`），工作区零 diff，生成器无时间源残留。
- F4 [CLOSED] ttl fixture input 已携带 `cachedM0MaterializedAt`，回放前提完整。
- 遗留（非本 commit 范围，维持原 F2/F3 为 MINOR，不影响验收）：`m1_absolute_cap` 为 Iris 自创标签（权威源零命中）、assertion anchor 集部分覆盖——可在后续提交处理。
<!-- OMO_INTERNAL_INITIATOR -->