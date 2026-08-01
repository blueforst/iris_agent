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
import { computeToolExecutionKey } from "../contracts/tool.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "./companion.js";
import { transformContextMessages } from "./context-adapter.js";

export interface IrisHarnessCallbacks {
  onSystemPrompt?(systemPrompt: string): void;
  onContext?(messages: AgentMessage[]): void;
  onToolCall?(event: ToolCallEvent): void;
  onToolResult?(event: ToolResultEvent): void;
  onSettled?(event: SettledEvent): void;
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

export interface CreateIrisHarnessOptions {
  session: Session;
  instanceEpoch: number;
  models: Models;
  model: Model<string>;
  tools: AgentHarnessTool<undefined>[];
  prepared: PreparedContextSources;
  input: AgentInput;
  invocationId: string;
  now: string;
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
    observers.systemPromptValues.push(options.prepared.canonicalSystemPrompt);
    options.callbacks?.onSystemPrompt?.(options.prepared.canonicalSystemPrompt);
    return options.prepared.canonicalSystemPrompt;
  };

  const layoutHash = computeContentLayoutHash(
    options.input,
    encodeInputFrames(options.input.blocks),
  );
  const companion = createInputMetaCompanion(options.input, layoutHash, options.now);

  const harness = new AgentHarness({
    session: options.session,
    models: options.models,
    model: options.model,
    tools: options.tools,
    systemPrompt: systemPromptResolver,
    thinkingLevel: "off",
  });

  harness.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    options.callbacks?.onSystemPrompt?.(event.systemPrompt);
    return { messages: [companion] };
  });

  harness.on("context", async (event: ContextEvent) => {
    observers.contextPasses += 1;
    options.callbacks?.onContext?.(event.messages);
    const result = transformContextMessages({
      invocationId: options.invocationId,
      runtimeSessionId: options.prepared.runtimeSessionId,
      messages: event.messages,
      model: { provider: options.model.provider, modelId: options.model.id },
      providerProfileId: "mock-iris-provider-v1",
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
      runtimeSessionId: options.prepared.runtimeSessionId,
      assistantEntryId,
      toolCallOrdinal,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      toolVersion: "0.1.0",
      canonicalArgsHash: createHash("sha256").update(JSON.stringify(event.input)).digest("hex"),
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

  harness.subscribe(async (event) => {
    if (event.type === "settled") {
      observers.settled = true;
      observers.settledNextTurnCount = event.nextTurnCount;
      options.callbacks?.onSettled?.(event);
    }
  });

  return { harness, observers };
}
