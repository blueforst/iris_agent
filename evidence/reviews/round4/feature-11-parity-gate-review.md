# R2 Feature 10 Parity-Gate Review（独立评审）

## Reviewer

- 角色：R2 Parity-gate 独立评审员（非实现者）
- 评审日期：2026-08-04
- 评审对象 commit：`9a991c6`（feat(context): R2 Feature 10 gate — parity, capacity benchmark (R2 final feature)）
- Reviewed baseline：`a8b5158`（R2 Feature 9 — Host product-path Context pipeline）
- Reviewed HEAD：`9a991c6`（HEAD of D:\code\iris）

## Files Reviewed

- `test/context-parity-gate.test.ts`（5 个 parity 测试，本 commit 新增，+277 行）
- `scripts/context-bench-smoke.ts`（容量 benchmark，本 commit 新增，+171 行）
- `package.json`（npm test 接入 parity gate、check 链入 bench:context，+5/-2）
- `src/context/pipeline.ts`（Feature 9 组合管线：projection → pass taxonomy → protected tail → replay → materialization → carriers）
- `src/context/pass-taxonomy.ts`（decidePass 分类层，ttl_idle 语义所在层）
- `src/context/projection.ts`（P5 logical units，entrySeq 推导）
- `src/context/context-store.ts`（context_lineages / materializeM0/M1 / rollover 隔离）
- `test/context-pass-taxonomy.test.ts`（fixture 矩阵测试）
- `test/context-pipeline.test.ts`（renderProviderVisible / SOFT+ reuse / watermark 测试）
- `test/context-golden.test.ts`（golden 锁定与 hash、mural 负向断言）
- `test/context-store.test.ts`（rollover 隔离、crash、migration）
- `test/fixtures/context/opencode-v0.33.0/`：taxonomy-softplus-defer-identical、taxonomy-soft-exec-surfaces-m1、taxonomy-hard-model-change、taxonomy-empty-hard-signal-no-fold、taxonomy-hard-ttl-idle-fold-once（5 个 taxonomy fixtures）
- `evidence/notion-round4/07-roadmap.md`（R2 Exit Gate，第 127–132 行）
- `evidence/notion-round4/01-context-assembly.md`（Pass Taxonomy 第 134–157 行）
- 权威源：`mc-authority/magic-context/packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts` @ `48ab531d`

## Tests Reviewed（真实执行输出）

### 1) `npx tsx --test test/context-parity-gate.test.ts`

```
# tests 5  # pass 5  # fail 0  # duration_ms 322.03
ok 1 - parity-gate: SOFT+ fixture — pipeline reproduces byte-identical defer classification
ok 2 - parity-gate: SOFT fixture — pipeline re-renders m1 when live delta exists
ok 3 - parity-gate: HARD fixture — pipeline rebuilds m0 on model change
ok 4 - parity-gate: empty HARD signal fixture — no fold unless live delta
ok 5 - parity-gate: ttl-idle fixture folds ONLY on a genuine current-flight signal
```

### 2) `npx tsx scripts/context-bench-smoke.ts`

两次独立运行（均 status ok，unit 计数完全一致）：

```
运行 A: turns 200, rawEntries 600, units 400, classification HARD,
        decisionMsPerPass 5.923, materializeMs 1.399, m0BodyBytes 5731, status ok
运行 B: turns 200, rawEntries 600, units 400, classification HARD,
        decisionMsPerPass 4.729, materializeMs 1.548, m0BodyBytes 5731, status ok
```

确定性：单位计数（600 raw → 400 units）、classification、m0BodyBytes 均跨运行一致；仅墙钟耗时波动（决策路径纯函数）。

### 3) `npm run check`（全量 gate）

- `npm test`：197 tests，195 pass + 2 skip（skip 为 OPENCODE_GO_API_KEY 未设置的 live provider 测试，注明 SKIP）
- `test:context-golden`：4/4 pass
- `test:context-migrations`：12/12 pass（含 rollover 隔离、SIGKILL crash、newer-schema fail-closed）
- `migration:smoke`：0001_bootstrap idempotent，status idempotent
- `crash:check`：7/7 boundaries ok
- `bench:context`：status ok（见上）
- `build`：tsc + copy-migrations 成功
- `test:subprocess`：3/3 pass
- `test:cli`：6/6 pass
- `dist:smoke`：status ok

## Checklist 逐项验证

1. **Parity 语义** — PASS。5 个测试全部通过 `runContextPass` 驱动管线，仅从 fixture 读取期望值后构造具体 (lineage + source + model) 输入并断言决策；无任何测试只重读 fixture。SOFT+（representedThrough 7 ≥ 投影最大 endSeq 6）、SOFT（representedThrough 3 < 最新单元起点 4）、HARD（cachedM0ModelKey anthropic:opus ≠ 当前 anthropic:sonnet）均有具体输入映射。
2. **SOFT+ fixture** — PASS。fixture 期望 SOFT+/rematerialized=false；测试以 representedThroughEntrySeq=7（完整覆盖两轮 6 条 entry 全部单元）驱动管线，`liveDelta=false → decidePass 返回 SOFT+`，断言 classification=SOFT+ 且 action.kind=reuse（完整解析，非弱断言）。配套 `context-pipeline.test.ts` "identical second pass with same lineage is SOFT+ and reuses m0" 经 store 往返验证同一语义。
3. **SOFT fixture** — PASS。representedThrough 3 < 最新 input 单元起点（entrySeq 4）→ live delta → SOFT → action.kind=materialize_m1；断言成立。
4. **HARD fixture / modelKey 格式** — PASS（附发现 F1）。管线约定为 `provider:modelId`（pipeline.ts:121 拼接冒号分隔），测试内 lineage cachedM0ModelKey 与 model 输入均使用冒号格式、内部自洽，model 变化正确触发 HARD materialize_m0。但 fixture 记录的是权威字符串 `anthropic/sonnet`（斜杠分隔），与管线冒号格式不一致；测试未把 fixture 字面 modelKey 传入管线（见 FINDINGS F1）。
5. **Empty-signal fixture** — PASS（附说明）。fixture 记录 SOFT（权威场景为 exec pass）；测试显式允许 SOFT 或 SOFT+，驱动"全表示 + 空信号"输入并断言 SOFT+ reuse、didSuppress=false（无折叠）。fixture 记录的精确 SOFT 分类由 `context-pass-taxonomy.test.ts` 矩阵测试（wouldAdvanceLive=true → SOFT，且断言等于 fixture）复现；两层共同覆盖该 fixture 语义。
6. **ttl-idle fixture 诚实性** — PASS。测试读取 fixture 的 HARD/ttl_idle 期望并断言 fixture.expected.rematerialized=true，同时明确注明管线 R2 未接线 lastResponseTime（ContextPassInput 无该字段），仅断言管线"无显式 cacheExpired/lastResponseTime 信号时不产生 HARD"（assert.notEqual）。ttl_idle 的真实实现与测试位于 pass-taxonomy 层（decidePass ttl 分支 + context-pass-taxonomy.test.ts "ttl_idle folds once, then idempotent"）。未虚假宣称管线级 ttl parity。
7. **Benchmark 诚实性** — PASS。测量的是组合管线决策成本（5 次取均值）+ ContextStore 真实物化往返（临时 SQLite），单位计数确定、输出 status ok。脚本头注释与 commit message 均明示"first-round provisional capacity evidence"，未声称 Historian benchmark；数据与 commit 声明（~5ms/decision、~1.3ms/materialize）吻合。
8. **R2 Exit Gate 覆盖** — PASS。
   - Parity gate on locked fixtures：parity 5 测试 + golden 4 测试（authority lock/hash 校验）+ pass-taxonomy 矩阵；
   - SOFT+ byte-identical replay：parity test 1（reuse）+ pipeline "identical second pass SOFT+ reuses m0" + carriers 字节确定性与 golden m0Replay/m1Replay=byte_identical 断言；
   - raw-message passthrough 不存在：`context-pipeline.test.ts` "renderProviderVisible emits carriers + live tail, never raw messages"（leaked=false 断言）；管线只发射 m0/m1 carriers + 合成 live 单元消息；
   - rollover 后建立 fresh Context lineage：`context-store.test.ts` "separate runtime sessions keep fully isolated lineages (rollover)"（session B 不继承 A 的 m0/watermarks/LKG）；
   - capacity benchmark 证据：bench:context 已接入 npm run check 并实际运行通过。
9. **npm 集成** — PASS。`test/context-parity-gate.test.ts` 已加入 npm test 列表；`bench:context` 已加入 check 链（format:check → lint → typecheck → test → golden → migrations → migration:smoke → crash:check → bench:context → build → subprocess → cli → dist:smoke），实际全量运行通过。
10. **无 Mural** — PASS。test/ 目录全文检索 "mural|Memory Mural|experimental.mural" 仅命中 `context-golden.test.ts:46` 的负向断言（fixture 不得包含 Mural token）；parity fixtures 与测试中无任何 Mural token。

## Verdict & Findings

VERDICT: PASS
SPEC COMPLIANCE: 满足 07-roadmap R2 Exit Gate 全部五项（parity gate on locked fixtures、SOFT+ byte-identical replay、raw-message passthrough 不存在、rollover fresh Context lineage、capacity benchmark 首轮证据），且与 01-context-assembly Pass Taxonomy（SOFT+/SOFT/HARD、空信号不视为变化、ttl_idle 仅当前 in-flight 信号折叠）一致。01 规格未规定 modelKey 字面格式（provider:modelId 为管线自洽约定），无规格冲突。
CODE CORRECTNESS: pipeline.ts 决策路径为纯函数（无 Date.now()），liveDelta=投影单元 endSeq>representedThrough 的语义正确，SOFT+ 断言 replay clean（defer 永不提交 watermark），materializeM0/M1 单行事务 fail-closed；context-parity-gate 与 context-pipeline 测试在真实 store 往返下验证了 reuse/m1/m0 三种 action 的持久化一致性。未发现缺陷。
RECOVERY/CONCURRENCY: 本 commit 未改动持久化/并发路径（仅新增测试与脚本）；既有 crash:check 7 边界、SIGKILL 可重开一致性 DB、newer-schema fail-closed 均在 check 全绿中复证。benchmark 使用临时目录并在结束后清理，无泄漏。
TEST COVERAGE: 5 个 parity 测试覆盖 SOFT+/SOFT/HARD/empty-signal/ttl-idle 五个 fixture 场景，全部驱动管线而非重读 fixture；npm test 197（195 pass + 2 注明 SKIP 的 live provider 测试）与 check 全链（golden 4、migrations 12、subprocess 3、CLI 6、bench:context）全部绿。ttl 分支诚实标注为 pass-taxonomy 层覆盖。
EVIDENCE ACCURACY: commit message 中 5ms/1.3ms 数字与实测（4.7–5.9ms / 1.4–1.5ms）相符；"197（195 pass + 2 live skip）"与真实输出一致；"rollover 创建 fresh lineage"证据落在 context-store 层（per-session context_lineages 隔离测试），未虚报 Host 集成级实现。bench 单位计数跨运行确定。
FINDINGS:
- F1（NON_BLOCKING，证据精度）modelKey 格式跨系统不一致：fixtures 记录权威字符串 "anthropic/opus"、"anthropic/sonnet"（斜杠分隔），管线/测试使用 "anthropic:opus"（冒号分隔，provider:modelId 约定）。分类 parity 成立（冒号自洽），但 fixture 字面 modelKey 从未被管线消费，字节级 cache-key 格式 parity 未被证明；context-pass-taxonomy.test.ts:234 亦直接使用斜杠形式。建议后续在 fixture 或测试注释中显式声明该映射（权威斜杠 ↔ 管线冒号），避免将来 authority 变更 modelKey 格式时静默漂移。
- F2（NON_BLOCKING，覆盖说明）empty-signal fixture 的精确 SOFT 分类由 pass-taxonomy 矩阵测试复现，parity 测试本身断言的是同 fixture 语义的 SOFT+（无 live delta）输入；两层合起来覆盖完整语义，但若单独阅读 parity 测试容易误读为与 fixture 记录分类不一致。建议在测试注释中更醒目地交叉引用矩阵测试。
- F3（NON_BLOCKING，测试面）rollover fresh-lineage 的 Exit Gate 证据为 ContextStore 层隔离测试（sessionA/sessionB），Host 滚轮集成测试（host.test.ts / rollover.test.ts）未显式断言"rollover 后新 Session 建立 context lineage"。对 R2 验收充分，建议在后续 feature 补一条 Host rollover → 新 lineage 的集成断言。
- F4（NON_BLOCKING，bench 覆盖面）bench 驱动 lineage:undefined 首轮 HARD（first_render）路径，未单独计时 SOFT+/SOFT 决策路径；决策测量已覆盖完整组合栈，属首轮容量证据，可接受。
<!-- OMO_INTERNAL_INITIATOR -->
