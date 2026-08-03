# Feature 4 (R2) — Ephemeral m0/m1 Carriers 独立评审

## 评审人角色
Carrier-byte-stability reviewer（独立评审，非实现者）

## Reviewed baseline
8691a21 feat(context): P0-P5 logical projection units (R2 Feature 3)

## Reviewed HEAD
b7024db feat(context): ephemeral m0/m1 carriers (R2 Feature 4)

## 变更范围
- package.json（+1 行）：将 test/context-carriers.test.ts 纳入 npm test 清单
- src/context/carriers.ts（新增 170 行）：ephemeral m0/m1 carrier 纯函数模块
- src/contracts/context.ts（+4 行）：IrisContextCarrierDetails 新增 carrierSchemaVersion / providerProfileId
- test/context-carriers.test.ts（新增 214 行，10 个测试）

## 审阅文件
- git show HEAD --stat 与 git show HEAD 全文 diff（b7024db）
- src/context/carriers.ts（全文，170 行）
- src/contracts/context.ts（全文，62 行）
- src/context/context-store.ts（createLineage / materializeM0 写路径，核对原子性）
- test/context-carriers.test.ts（全文，214 行）
- evidence/notion-round4/01-context-assembly.md（Physical Layout 小节）
- OpenCode 权威源码 inject-compartments.ts（M0_EMPTY_BODY / M1_EMPTY_PLACEHOLDER 常量，第 732-734 行）
- 权威测试 m0m1-taxonomy.test.ts（placeholder / SOFT+ / SOFT / HARD 语义）

## 实际执行的测试与输出

### 1) npx tsx --test test/context-carriers.test.ts
结果：# tests 10, # pass 10, # fail 0, # skipped 0, duration_ms 298
10 个用例全部通过：role/customType/details 契约、固定空常量、placeholder 永不省略且不合并、字节一致重放、provider 失效、materialization 失效、无伪造 baseline、重启重建、companion 排除、固定 m0→m1 顺序。

### 2) npm run check（完整 gate）
逐段通过：
- format:check（prettier）、lint（eslint）、typecheck（tsc --noEmit）
- npm test：135 unit → 133 pass + 2 SKIP（R1-P1 live vertical slice，OPENCODE_GO_API_KEY 未设置，声明为 live skip）
- test:context-golden：4/4
- test:context-migrations：12/12（含 SIGKILL 崩溃窗口）
- migration:smoke：idempotent（firstApplied: [0001_bootstrap], secondApplied: []）
- crash:check：7/7 boundaries ok（before_any_write 至 after_creating_epoch）
- build + copy-migrations：ok
- test:subprocess：3/3
- test:cli：6/6
- dist:smoke：ok

## Checklist 逐项核对

1. EXACT CONSTANTS — PASS。程序化比对确认 Iris 与权威源码都包含：
   - "<session-history></session-history>"（35 字节）
   - "<session-history-since>(no new content since last materialization)</session-history-since>"（90 字节）
   与 spec Physical Layout 常量及权威 m0m1-taxonomy.test.ts 第 31-32 行的 M1_PLACEHOLDER 完全一致。

2. Role/customType/details/timestamp 契约 — PASS。details.irisContext 含 spec 要求的全部 5 个字段（schemaVersion: 1 number、runtimeSessionId、surface 'm0'|'m1'、materializationId、contentHash），新增 carrierSchemaVersion（"1"）与 providerProfileId 为 additive 超集，不破坏固定契约；消息层 role/customType/content/display/details/timestamp 与 pi-agent-core CustomMessage 接口逐字段吻合（typecheck 通过佐证）。注意：测试 1 标题含 "timestamp" 但未断言 timestamp===atMs（见 F3）。

3. 固定顺序 m0, m1, live tail — PASS。buildCarriers 固定先构造 m0 再 m1 并原样返回；仓库内无任何消费者，不存在可重排或合并的代码路径；测试 10 断言 surfaces 恰为 ["m0","m1"]。live tail 不属于本模块职责（由后续 transform 接线）。

4. m1 placeholder 永不省略、m0/m1 永不合并 — PASS。空 m1Body 一律替换为 M1_EMPTY_PLACEHOLDER（从不省略、从不省略整条消息），始终返回两条独立 CustomMessage；测试 2/3 覆盖。

5. 字节稳定性 — PASS。canonicalCarrierJson 递归按键排序，输出确定；相同 (runtimeSessionId, materializationId, providerProfileId, m0Body, m1Body, atMs) 输入 → 相同 canonical JSON + 相同 m0ContentHash/m1ContentHash/carrierFingerprint。测试 4 同时断言 contentHash、fingerprint 与 canonical JSON 全等。

6. Provider profile / materialization 变化 → 不同字节（HARD 失效）— PASS。两字段均参与哈希 canonical 且写入 details；测试 5（providerProfileId 变更）与测试 6（materializationId 变更）断言 fingerprint 不同。

7. Reload/restart 重建 — PASS。buildCarriersFromLineage 在 lineage.m0Body 为 null/undefined 时返回 undefined（绝不伪造 fake baseline）；有 m0 时从持久化字段重建，m1Body 为 null 时以空串走 placeholder。测试 7/8 覆盖。materializeM0 单行 UPDATE 原子写 m0_body + m0_materialized_at + cached_m0_provider_profile_id（context-store.ts 第 382-418 行），保证重启重建字节来源确定。

8. 永不写入 Pi Session — PASS。carriers.ts 为纯函数模块：仅 node:crypto 与类型导入，无 Session、无 DB、无任何写调用；src 全库 grep 确认无消费者（buildCarriers / emptyM1Placeholder 仅被自身与测试引用）。customType = "iris_context_carrier" ≠ "iris_input_meta"，不会命中 projection.ts 第 246 行的 input companion 过滤；测试 9 断言 customType 差异。

9. contentHash 自洽 — PASS。makeCarrier 将同一 m0ContentHash/m1ContentHash 注入 details.irisContext.contentHash，结构上必然自洽；测试 8 显式断言 details.contentHash === rebuilt.m0ContentHash。

10. 跨重启确定性哈希 — PASS。哈希路径（sha256 + canonicalCarrierJson）不含 Date.now / Math.random；atMs 由调用方传入（buildCarriers）或取自持久化 m0MaterializedAt（buildCarriersFromLineage），且 atMs 不参与任何 hash 计算。buildCarriersFromLineage 的 Date.now() 仅兜底消息 timestamp 字段（不进入哈希），且因 materializeM0 原子写而实际不可达（见 F2）。

## 结论
VERDICT: PASS（发现项均为非阻塞 / 信息性）

## 发现项
- F1（非阻塞，注释精确性）：carriers.ts 接口注释称 contentHash 是 "sha256 of the m0 carrier message object"，但实际哈希对象是手工构造的字段子集，不含消息级 timestamp 与 details.irisContext.schemaVersion。排除易变 timestamp 是保证内容哈希稳定的正确设计，但注释应改为 "canonical carrier content payload" 以免误导实现者。
- F2（非阻塞，防御性）：buildCarriersFromLineage 在 m0Body 非空但 m0MaterializedAt 为 null 时用 Date.now() 兜底生成消息 timestamp。该状态当前不可达（materializeM0 原子写两字段，且测试验证原子性），且该值不参与任何哈希；若希望彻底消除消息字节层面唯一理论不确定性，可改用确定性兜底（如 lineage.createdAt）。
- F3（非阻塞，测试缺口）：测试 1 标题声明 "timestamp contract" 但未断言 m0.timestamp / m1.timestamp === atMs；测试 4 的字节一致性依赖两次调用传入相同 atMs，无法捕获 timestamp 回归。建议补充显式 timestamp 断言。
- F4（非阻塞，可读性）：测试 3 的断言写法绕（`assert.notEqual(m0.customType===m1.customType ? m0.content===m1.content : false, true)`），建议改为 `assert.notEqual(m0.content, m1.content)` 加 `assert.notEqual(m0, m1)`，语义更直接。
- F5（信息性，尚未接线）：仓库内没有任何消费者导入 carriers.ts（grep 仅命中测试文件）。"只由 context hook 返回、不追加 Pi Session" 当前因无消费者而平凡成立。后续接线 transform/hook 时必须保持：固定 m0→m1 顺序、不持久化 carriers、distinct customType 穿透 input companion 过滤；并补充一条集成测试（含 iris_context_carrier 的消息流经 projection 过滤不被丢弃、且不进入 Session 存储）。
- F6（信息性）：spec 未禁止额外字段；新增 carrierSchemaVersion / providerProfileId 不破坏 spec 固定契约，符合评审前提。

## 结论块

VERDICT: PASS
SPEC COMPLIANCE: 常量与 spec/权威字节一致（m0=35B，m1=90B，逐字节比对）；IrisContextCarrierDetails 的 5 个固定字段类型与名称完全符合 spec，新增 2 字段为 additive 超集，不破坏固定契约；顺序 m0→m1 固定；m1 空 delta 使用固定 placeholder 且永不省略。
CODE CORRECTNESS: 纯函数模块，无 Session/DB 写路径，无消费者接线；canonical JSON 排序键确定性哈希；providerProfileId/materializationId 参与哈希与 details 实现 HARD 失效；buildCarriersFromLineage 对未物化 m0 返回 undefined，绝不伪造 baseline。
RECOVERY/CONCURRENCY: 重启重建字节来源为持久化 lineage（materializeM0 单行原子 UPDATE），m0MaterializedAt 兜底分支实际不可达；无并发共享状态，模块无副作用，无需额外并发保护。
TEST COVERAGE: 10/10 专用测试通过，覆盖全部 10 项 checklist 的关键断言；npm run check 全绿（135 unit: 133 pass + 2 live skip；4 golden；12 migrations；3 subprocess；6 CLI；crash-check 7/7）。缺口：timestamp 字段无显式断言（F3）、无消费者级集成测试（F5）。
EVIDENCE ACCURACY: 提交说明与实际输出一致（133 pass + 2 live skip、10/10 carriers、全 gate 通过）；本评审所有命令为真实执行并记录。
FINDINGS: F1 哈希注释不精确（非阻塞）；F2 buildCarriersFromLineage 的 Date.now() 兜底理论上可引入消息 timestamp 非确定性，当前不可达（非阻塞）；F3 测试 1 缺 timestamp 断言（非阻塞）；F4 测试 3 断言可读性（非阻塞）；F5 模块尚未接线任何 transform/hook 消费者（信息性）；F6 新增字段不破坏 spec 契约（信息性）。
<!-- OMO_INTERNAL_INITIATOR -->
