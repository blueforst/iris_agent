import { createHash } from "node:crypto";

import type { CustomMessage } from "@earendil-works/pi-agent-core";

import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../contracts/context.js";
import type { AgentInput, ProvenancedContentBlock } from "../contracts/origin.js";
import type { IrisBlockLayoutV1 } from "../contracts/tool.js";

export const INPUT_FRAME_HEADER = "IRIS_INPUT_V1";

export interface InputFrame {
  kind: "inline_text" | "external_ref";
  utf8ByteLength: number;
  payload: string;
}

export function encodeInputFrames(blocks: ProvenancedContentBlock[]): string {
  const frames: InputFrame[] = [];
  for (const block of blocks) {
    if (block.content.mode === "inline_text") {
      frames.push({
        kind: "inline_text",
        utf8ByteLength: Buffer.byteLength(block.content.text, "utf8"),
        payload: block.content.text,
      });
    } else if (block.content.mode === "external_ref") {
      const preview = block.content.ref.uri;
      frames.push({
        kind: "external_ref",
        utf8ByteLength: Buffer.byteLength(preview, "utf8"),
        payload: preview,
      });
    }
  }
  return [
    INPUT_FRAME_HEADER,
    ...frames.map((frame) => `${frame.kind}:${frame.utf8ByteLength}\n${frame.payload}`),
  ].join("\n");
}

export function decodeInputFrames(wire: string): InputFrame[] {
  const lines = wire.split("\n");
  if (lines[0] !== INPUT_FRAME_HEADER) {
    throw new Error("invalid input frame header");
  }
  const frames: InputFrame[] = [];
  let offset = 1;
  while (offset < lines.length) {
    const header = lines[offset];
    if (header === undefined || header === "") {
      break;
    }
    const match = /^(inline_text|external_ref):(\d+)$/.exec(header);
    if (match === null) {
      throw new Error(`invalid frame header: ${header}`);
    }
    const byteLength = Number(match[2]);
    const payload = lines.slice(offset + 1).join("\n");
    if (Buffer.byteLength(payload, "utf8") !== byteLength) {
      throw new Error("frame byte length mismatch");
    }
    frames.push({ kind: match[1] as InputFrame["kind"], utf8ByteLength: byteLength, payload });
    offset += 2;
  }
  return frames;
}

export function computeContentLayoutHash(input: AgentInput, wire: string): string {
  const layout: Array<{
    blockId: string;
    blockIndex: number;
    contentKind: string;
    sourceOriginHash: string;
    sourceContentHash: string;
    wireContentHash: string;
  }> = [];
  for (const [index, block] of input.blocks.entries()) {
    layout.push({
      blockId: block.blockId,
      blockIndex: index,
      contentKind: block.content.mode,
      sourceOriginHash: createHash("sha256")
        .update(JSON.stringify(block.sourceOrigin))
        .digest("hex"),
      sourceContentHash: block.contentHash,
      wireContentHash: createHash("sha256").update(wire).digest("hex"),
    });
  }
  return createHash("sha256")
    .update(JSON.stringify({ layoutVersion: "iris_content_layout_v1", layout }))
    .digest("hex");
}

export function inputPairKey(input: AgentInput): string {
  return createHash("sha256")
    .update(`${input.inputId}:${computeUserContentHash(input)}`)
    .digest("hex");
}

export function computeUserContentHash(input: AgentInput): string {
  const wire = encodeInputFrames(input.blocks);
  return createHash("sha256").update(wire).digest("hex");
}

export function createInputMetaCompanion(
  input: AgentInput,
  layoutHash: string,
  timestamp: string,
): CustomMessage<unknown> {
  const wire = encodeInputFrames(input.blocks);
  const blocks: IrisBlockLayoutV1[] = input.blocks.map((block, index) => ({
    blockId: block.blockId,
    blockIndex: index,
    contentKind: block.content.mode,
    location:
      block.content.mode === "inline_text"
        ? { mode: "text_frame", frameIndex: index, utf8ByteLength: Buffer.byteLength(wire, "utf8") }
        : { mode: "content_part", partIndex: index },
    sourceOrigin: block.sourceOrigin,
    sourceContentHash: block.contentHash,
    wireContentHash: createHash("sha256").update(wire).digest("hex"),
    ...(block.content.mode === "external_ref"
      ? {
          originalPayloadRef: {
            schemaVersion: block.content.ref.schemaVersion,
            kind: block.content.ref.kind,
            hash: block.content.ref.hash,
            byteLength: block.content.ref.byteLength,
            uri: block.content.ref.uri,
          },
        }
      : {}),
  }));

  return {
    role: "custom",
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: IRIS_INPUT_META_CONTENT,
    display: false,
    details: {
      iris: {
        schemaVersion: 1,
        inputId: input.inputId,
        pairKey: inputPairKey(input),
        triggerOrigin: input.triggerOrigin,
        entryOrigin: input.triggerOrigin,
        layoutVersion: "iris_content_layout_v1",
        blocks,
        contentLayoutHash: layoutHash,
      },
    },
    timestamp: new Date(timestamp).getTime(),
  };
}
