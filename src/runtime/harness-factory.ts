import { createHash } from "node:crypto";

import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentMessage,
  type BeforeAgentStartEvent,
  type ContextEvent,
  type Session,
  type SessionTreeEntry,
  type SettledEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-agent-core";
import type { Model, Models, ToolCall } from "@earendil-works/pi-ai";

import type { PreparedContextSources } from "../contracts/context.js";
import type { AgentInput } from "../contracts/origin.js";
import { computeToolExecutionKey, canonicalJson } from "../contracts/tool.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "./companion.js";
import { transformContextMessages } from "./context-adapter.js";
import { projectSessionMessages } from "./session-projection.js";

export interface IrisHarnessCallbacks {
  onSystemPrompt?(systemPrompt: string): void;
  onContext?(messages: AgentMessage[]): void;
  onToolCall?(event: ToolCallEvent): void;
  onToolResult?(event: ToolResultEvent): void;
  onSettled?(event: SettledEvent): void;
  /**
   * Fired when Pi is about to make a provider call AFTER at least one tool
   * result has been processed — i.e. the Session writes are flushed and the
   * follow-up provider call has not started yet. This is the exact
   * ToolResult-commit-to-next-provider-call crash window (R1 Exit Gate).
   * Return a never-resolving promise to park the slice at this boundary.
   */
  onAfterToolResultProviderCall?(attempt: number): Promise<void> | void;
}

export interface HarnessObservers {
  systemPromptValues: string[];
  contextPasses: number;
  toolCallOrder: Array<{ toolCallId: string; toolName: string }>;
  toolResultOrder: Array<{ toolCallId: string; toolName: string }>;
  providerContextSnapshots: string[];
  settled: boolean;
  settledNextTurnCount: number | undefined;
}

/**
 * Per-invocation binding. The harness is stateful (it owns the Pi Session and
 * the transcript), so it is created once per runtime Session; each prompt()
 * invocation updates this binding so companion pairing and the context hook
 * reflect the CURRENT input, not the first one.
 */
export interface InvocationBinding {
  input: AgentInput;
  prepared: PreparedContextSources;
  invocationId: string;
}

export interface CreateIrisHarnessOptions {
  session: Session;
  instanceEpoch: number;
  models: Models;
  model: Model<string>;
  tools: AgentHarnessTool<undefined>[];
  /** Read on every turn; caller updates it per invocation. */
  currentInvocation: InvocationBinding;
  now: string;
  providerProfileId: string;
  callbacks?: IrisHarnessCallbacks | undefined;
}

export function createIrisHarness(options: CreateIrisHarnessOptions): {
  harness: AgentHarness;
  observers: HarnessObservers;
} {
  for (const tool of options.tools) {
    if (tool.executionMode !== "sequential") {
      throw new Error(`tool ${tool.name} must declare executionMode='sequential'`);
    }
  }

  const observers: HarnessObservers = {
    systemPromptValues: [],
    contextPasses: 0,
    toolCallOrder: [],
    toolResultOrder: [],
    providerContextSnapshots: [],
    settled: false,
    settledNextTurnCount: undefined,
  };

  const systemPromptResolver = (): string => {
    const { prepared } = options.currentInvocation;
    observers.systemPromptValues.push(prepared.canonicalSystemPrompt);
    options.callbacks?.onSystemPrompt?.(prepared.canonicalSystemPrompt);
    return prepared.canonicalSystemPrompt;
  };

  const harness = new AgentHarness({
    session: options.session,
    models: options.models,
    model: options.model,
    tools: options.tools,
    thinkingLevel: "off",
    // PI-015 (R1-P1e): Iris 正常 Provider path 不从 Session.buildContext()
    // 构造 Context（R1 Exit Gate 1）。R1 最小实现：从 session entries 做
    // identity-preserving 投影（projectSessionMessages，非 buildContext），
    // 携带 canonical system prompt；companion 折叠仍由 context hook 完成。
    contextController: async ({ session }) => {
      const entries = await session.getEntries();
      const projected = projectSessionMessages(entries);
      return {
        systemPrompt: systemPromptResolver(),
        messages: projected.map((item) => item.message),
      };
    },
  });

  harness.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    options.callbacks?.onSystemPrompt?.(event.systemPrompt);
    const { input, prepared, invocationId } = options.currentInvocation;
    void prepared;
    void invocationId;
    const layoutHash = computeContentLayoutHash(input, encodeInputFrames(input.blocks));
    const companion = createInputMetaCompanion(
      input,
      layoutHash,
      options.now,
      options.instanceEpoch,
    );
    return { messages: [companion] };
  });

  harness.on("context", async (event: ContextEvent) => {
    observers.contextPasses += 1;
    options.callbacks?.onContext?.(event.messages);
    const { input, prepared, invocationId } = options.currentInvocation;
    void input;
    const result = transformContextMessages({
      invocationId,
      runtimeSessionId: prepared.runtimeSessionId,
      messages: event.messages,
      model: { provider: options.model.provider, modelId: options.model.id },
      providerProfileId: options.providerProfileId,
    });
    return { messages: result.messages };
  });

  harness.on("tool_call", async (event: ToolCallEvent) => {
    observers.toolCallOrder.push({ toolCallId: event.toolCallId, toolName: event.toolName });
    options.callbacks?.onToolCall?.(event);
    return undefined;
  });

  harness.on("tool_result", async (event: ToolResultEvent) => {
    observers.toolResultOrder.push({ toolCallId: event.toolCallId, toolName: event.toolName });
    options.callbacks?.onToolResult?.(event);

    const entries = await options.session.getEntries();
    let assistantEntryId = "";
    let toolCallOrdinal = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "message") {
        continue;
      }
      const message = (entry as SessionTreeEntry & { message: AgentMessage }).message;
      if (message.role !== "assistant") {
        continue;
      }
      const toolCalls = message.content.filter(
        (part): part is ToolCall => part.type === "toolCall",
      );
      const ordinal = toolCalls.findIndex((call) => call.id === event.toolCallId);
      if (ordinal >= 0) {
        assistantEntryId = entry.id;
        toolCallOrdinal = ordinal + 1;
        break;
      }
    }
    if (assistantEntryId === "" || toolCallOrdinal === 0) {
      throw new Error("tool result has no committed assistant entry");
    }

    const toolExecutionKey = computeToolExecutionKey({
      instanceEpoch: options.instanceEpoch,
      runtimeSessionId: options.currentInvocation.prepared.runtimeSessionId,
      assistantEntryId,
      toolCallOrdinal,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      toolVersion: "0.1.0",
      canonicalArgsHash: createHash("sha256").update(canonicalJson(event.input)).digest("hex"),
    });
    const iris = {
      schemaVersion: 1,
      toolExecutionKey,
      assistantEntryId,
      entryOrigin: {
        schemaVersion: 1,
        channel: "tool",
        principalKind: "tool" as const,
        authority: "data_only" as const,
        trust: "limited" as const,
      },
      layoutVersion: "iris_content_layout_v1" as const,
      blocks: [],
      contentLayoutHash: createHash("sha256").update(JSON.stringify(event.content)).digest("hex"),
    };
    return {
      details: event.details === undefined ? { iris } : { iris, adapter: event.details },
    };
  });

  let toolResultSeen = false;
  let providerCallAfterToolResult = 0;
  harness.on("tool_result", async () => {
    toolResultSeen = true;
    return undefined;
  });
  harness.on("before_provider_request", async () => {
    // before_provider_request fires right before a provider call, AFTER the
    // preceding tool-result Session writes were flushed (agent-harness
    // prepareNextTurn -> flushPendingSessionWrites -> provider call). So the
    // first such event following a tool result is the exact
    // ToolResult-commit-to-next-provider-call crash window.
    if (toolResultSeen) {
      providerCallAfterToolResult += 1;
      await options.callbacks?.onAfterToolResultProviderCall?.(providerCallAfterToolResult);
    }
    return undefined;
  });
  harness.subscribe(async (event) => {
    if (event.type === "settled") {
      observers.settled = true;
      observers.settledNextTurnCount = event.nextTurnCount;
      options.callbacks?.onSettled?.(event);
    }
  });

  return { harness, observers };
}
