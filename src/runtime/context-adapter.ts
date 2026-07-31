import type { AgentMessage, CustomMessage } from "@earendil-works/pi-agent-core";

import {
  IRIS_INPUT_META_CONTENT,
  IRIS_INPUT_META_CUSTOM_TYPE,
  type ContextTransformResult,
  type TransformMessagesInput,
} from "../contracts/context.js";
import { decodeInputFrames } from "./companion.js";

export interface DetectedInputPair {
  userMessage: AgentMessage & { role: "user" };
  companion: CustomMessage<unknown>;
  pairKey: string;
}

interface IrisMetaDetails {
  iris?: { pairKey?: string };
}

export function findInputPairs(messages: AgentMessage[]): DetectedInputPair[] {
  const pairs: DetectedInputPair[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const companion = messages[index + 1];
    const details = (companion?.role === "custom" ? companion.details : undefined) as
      IrisMetaDetails | undefined;
    if (
      user?.role === "user" &&
      companion?.role === "custom" &&
      companion.customType === IRIS_INPUT_META_CUSTOM_TYPE &&
      companion.content === IRIS_INPUT_META_CONTENT &&
      companion.display === false &&
      typeof details?.iris?.pairKey === "string"
    ) {
      pairs.push({
        userMessage: user as AgentMessage & { role: "user" },
        companion,
        pairKey: details.iris.pairKey,
      });
    }
  }
  return pairs;
}

function projectedUserText(userMessage: AgentMessage & { role: "user" }): string {
  const raw = Array.isArray(userMessage.content)
    ? userMessage.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : userMessage.content;
  let text = raw;
  try {
    const frames = decodeInputFrames(raw);
    text = frames.map((frame) => frame.payload).join("\n");
  } catch {
    // Keep the raw content when it is not an Iris input frame.
  }
  return `[USER REQUEST | LIMITED]\n${text}`;
}

export function transformContextMessages(input: TransformMessagesInput): ContextTransformResult {
  const pairs = findInputPairs(input.messages);
  const companionIds = new Set(pairs.map((pair) => pair.companion.timestamp));
  const projected: AgentMessage[] = [];

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    if (message === undefined) {
      continue;
    }
    const pairIndex = pairs.findIndex((pair) => pair.userMessage === message);
    if (pairIndex >= 0) {
      const pair = pairs[pairIndex];
      if (pair === undefined) {
        continue;
      }
      projected.push({
        ...pair.userMessage,
        content: [{ type: "text", text: projectedUserText(pair.userMessage) }],
      });
      continue;
    }
    if (companionIds.has(message.timestamp)) {
      continue;
    }
    projected.push(message);
  }

  return {
    messages: projected,
    representedBoundaryState: {
      runtimeSessionId: input.runtimeSessionId,
      materializationIdentity: "mock-m0m1-v1",
      providerProfileId: input.providerProfileId,
    },
  };
}
