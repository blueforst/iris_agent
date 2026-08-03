Runtime Coordinator 位于当前 Pi Runtime Capsule 外，只负责一次 invocation 的单写者门闩、输入交接、精确取消和原生事件转发。它不拥有 Pi Session 生命周期；Runtime Session 的创建、恢复、rollover 与 active Epoch CAS 由同层但独立的 RuntimeSessionEpochManager 管理。

## Core Shape

RuntimeSessionEpochManager
→ chooses one active Pi Session / AgentHarness Capsule

Runtime Coordinator
→ runs one invocation through that active Capsule
Pi 与 Iris 的完整所有权见 05 Pi Runtime Capsule Boundary｜Pi Harness 与 Iris 实现边界 和 02 Runtime Sessions & History Archive｜运行会话与历史归档。

## Invocation Invariant

one invocation
→ one active runtimeSessionId
→ one ContextSourceSnapshot preparation
→ one AgentHarness prompt/tool loop
→ one Context transform per provider call
→ one native settled boundary
Invocation 开始后绑定的 runtimeSessionId 不得在中途变化。日期变化或容量阈值只设置 rolloverPending；当前 provider/tool loop 完成并发出 settled 后才允许切换 Epoch。

## Ownership

Runtime Coordinator 拥有：

- 当前进程 runtimeId；
  -进程内 correlation invocationId；
- active invocation 门闩与 AbortController；
  -冻结 runtimeSessionId、triggerOrigin 和 block origins；
  -调用 Context preparation；
  -调用当前 Capsule 的原生 AgentHarness.prompt()；
  -转发 Pi runtime events；
  -在 settled 后释放 invocation。
  Runtime Coordinator 不拥有：
- Pi Session create/open/list/close；
- active Epoch CAS 或 rollover policy；
  -普通消息、assistant result、ToolResult、pending writes 或 settled truth；
- Persona、Historian、Evidence、Graphiti 或 Context repository；
  -用户可见 Session/Conversation/Branch registry；
- ToolRegistry 实现或具体 capability Adapter。

## Ports

interface OrchestratorPort {
reply(input: AgentInput): AsyncIterable<AgentReplyEvent>;
abort(invocationId: string, reason?: string): Promise<void>;
getActiveInvocation(): ActiveInvocationInfo | null;
}

interface ActiveRuntimePort {
getActiveRuntime(): ActiveRuntimeHandle;
}

interface ActiveRuntimeHandle {
epochId: string;
runtimeSessionId: string;
runtime: AgentRuntimePort;
}
Runtime Coordinator 只通过 ActiveRuntimePort 获得已经 ready 的当前 Capsule，不取得 SqliteSessionRepo 或 Epoch database。

## Invocation Lifecycle

Host / Adapter / Body input
→ route command vs AgentInput
→ acquire active invocation latch
→ read active RuntimeHandle
→ freeze runtimeSessionId + invocationId + origin
→ ContextRuntimePort.prepareInvocationSources(runtimeSessionId, input)
→ bind prepared Context into active Capsule
→ core AgentHarness.prompt()
→ systemPrompt resolver replays P0 across tool turns
→ before_agent_start injects iris_input_meta companion
→ context hook renders Session-scoped m0/m1/live tail
→ Pi native prompt/tool loop
→ forward native events
→ observe native settled
→ release Context invocation binding
→ clear active invocation
→ notify Epoch Manager that settled boundary is available
若 rolloverPending=true，Epoch Manager 可以在 invocation latch 释放后关闭旧 Session、创建新 Session和新 Harness，然后再处理 Host 队列中的下一输入。

## Invocation Context

interface InvocationContext {
invocationId: string;
runtimeId: string;
epochId: string;
runtimeSessionId: string;
triggerOrigin: OriginEnvelope;
originHash: string;
startedAt: string;
abortSignal: AbortSignal;
interaction?: InteractionContext;
}
runtimeSessionId 是内部运行历史 identity，不是 caller 选择的 conversation、权限或 memory scope。

## Context Preparation

interface ContextRuntimePort {
prepareInvocationSources(input: PrepareInvocationInput): Promise<PreparedContextSources>;
transformMessages(input: TransformMessagesInput): Promise<ContextTransformResult>;
releaseInvocation(invocationId: string): Promise<void>;
}
PrepareInvocationInput 必须包含 active runtimeSessionId、epochId、当前 AgentInput、model/provider/context window 和 Session-scoped History head。它还可以引用 latest ContinuitySnapshot 和 previous-session overlap，但不把 closed Session entries拼接成当前 Pi messages。
ContextSourceSnapshot、m0/m1、LKG、protected-tail state 和 P5 boundary全部绑定 active runtimeSessionId。rollover 后新 Session必须建立 fresh Context lineage。

## Session Advanced Signal

每次 settled 后可以发布轻量信号：
interface RuntimeSessionAdvanced {
invocationId: string;
runtimeSessionId: string;
previousHeadSeq: number;
newHeadSeq: number;
settledAt: string;
reason: 'invocation_settled';
}
该信号只唤醒 Historian cheap check 与 observability，不是第二份消息、outcome 或 delivery ledger。entrySeq 只在该 runtimeSessionId 内解释。

## Rollover Coordination

Runtime Coordinator 不亲自执行 rollover，只遵守以下协议：

1. active invocation 时拒绝 Session switch；
   2.日期/容量变化只记录 pending request；
1. native settled 后释放 invocation latch；
1. Epoch Manager 在没有 active invocation 时执行 rollover；
   5.新输入只能路由到 old ready Capsule 或 new ready Capsule，不能路由到 creating/closing Session；
1. rollover 失败时保持一个明确 active Capsule或进入 not-ready，不同时暴露两个 writer。

## Single-writer Concurrency

- 任一时刻只有一个 active AgentHarness invocation；
- 任一时刻只有一个 active Runtime Session writer；
- Host 输入队列有界、可取消、有超时；
- Body/外部事件不抢占 tool loop；
- Historian、Memory delivery 和 Graphiti reindex只读取已提交 Session archive/Evidence，不修改 Pi head。

## Queued-input Provenance

Pi 的 before_agent_start 不覆盖裸 steer/followUp/nextTurn。active invocation 期间的新外部输入由 Host 有界排队；settled 后：
-若不 rollover，作为当前 Session 的新普通 prompt()；
-若 rollover，作为新 Session 的首个普通 prompt()。
不得在队列中丢失 input companion 所需 metadata。

## Abort

abort(activeInvocationId)
→ signal current Pi run
→ wait for native abort/agent_end/settled
→ preserve already committed entries in bound runtimeSessionId
→ release invocation
→ rollover may proceed only after settled
无 invocationId 的全局 abort 不进入公共 Port。

## Tool Loop

Pi native tool request
→ ToolExecutionPort
→ validate descriptor/schema/runtime/idempotency
→ execute capability with timeout/abort
→ normalize ToolResult + provenance
→ Pi persists ToolResult
→ Pi continues native loop
Coordinator 不驱动第二轮模型，也不在 Session rollover 时迁移半完成 tool arc。

## Error Model

type OrchestratorErrorCode =
| 'runtime_busy'
| 'input_invalid'
| 'active_session_not_ready'
| 'context_prepare_failed'
| 'model_failed'
| 'tool_failed'
| 'aborted'
| 'settle_failed'
| 'runtime_not_ready';
第三方 exception 在 Capsule/Adapter 边界翻译。失败仍由 Pi 原生 failure message/agent_end/settled 落入当前 Session；Coordinator 不写第二份 InvocationOutcome。

## Non-goals

Runtime Coordinator 不成为：

- Session Manager；
  -持久任务调度器；
  -Conversation/Branch router；
  -第二套 agent loop；
  -权限或主体系统；
  -跨 Session continuity summarizer。
  跨 Session continuity 由 Historian ContinuitySnapshot、Context overlap 和 Graphiti recall提供。

## Durable Ingress Handoff

Runtime Coordinator consumes only AgentInputs that have passed Host durable acceptance. The ingress ledger remains outside the Coordinator.
Host validates + hashes AgentInput
→ persist accepted(inputId, instanceEpoch, payloadHash)
→ enqueue one delivery token
→ Coordinator acquires invocation latch
→ normal AgentHarness.prompt()
→ matching Pi UserMessage + companion committed
→ Host marks session_committed(runtimeSessionId, userEntryId)
Coordinator does not query or update ingress.db directly; Host supplies an opaque acceptance binding through the input envelope and receives the committed Pi input identity from the Capsule bridge. Retrying an accepted but uncommitted record must re-enter the same bounded ingress queue, never bypass the single-writer latch.

## Incomplete Epoch Boundary

Coordinator never attempts to continue a provider-unsafe unmatched tool arc. Startup recovery resolves that condition before readiness by either preserving a provider-safe active RuntimeHandle or replacing it with a fresh RuntimeHandle whose Context contains a bounded RuntimeRecoveryNotice. No active invocation is migrated between the old and new Epoch.

## Invocation Memory Recall Projection Handoff — 2026-07-26

Runtime Coordinator 不解释召回事实，也不把 recall projection 交给 Historian worker。它只保证 invocation identity 与 Context 生命周期正确：
prepareInvocationSources(invocationId, runtimeSessionId)
→ Context transform persists/merges InvocationMemoryRecallProjection
→ Pi native prompt/tool loop
→ settled
→ releaseInvocation removes in-memory binding only
持久化 projection 的 retention/GC 由 Context store 根据 Historian processed watermarks 与配置执行；releaseInvocation() 不得删除尚未被 Historian 分析的 projection。多次 tool-turn provider call 共用同一 invocationId，Context 以 provider-call ordinal 合并 exposure；Coordinator 不维护第二份 projection、Assessment 或 invocation outcome。
