import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { AgentInput, ExternalizedPayloadRef, OriginEnvelope } from "./contracts/origin.js";
import { defaultAgentConfig, loadAgentConfig } from "./config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "./host/data-root.js";
import { acquireDataRootLock } from "./host/lock.js";
import type { SliceProviderMode } from "./runtime/vertical-slice.js";
import { runMinimalSlice } from "./runtime/vertical-slice.js";

export interface RunCommandOptions {
  dataRoot: string;
  inputFile?: string | undefined;
  provider: SliceProviderMode;
}

function isOriginEnvelope(value: unknown): value is OriginEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const o = value as Record<string, unknown>;
  const kind = o["principalKind"];
  const authority = o["authority"];
  const trust = o["trust"];
  return (
    o["schemaVersion"] === 1 &&
    typeof o["channel"] === "string" &&
    o["channel"] !== "" &&
    (kind === "user" ||
      kind === "external_actor" ||
      kind === "environment" ||
      kind === "tool" ||
      kind === "model" ||
      kind === "system") &&
    (authority === "user_request" ||
      authority === "notice_only" ||
      authority === "data_only" ||
      authority === "internal_control") &&
    (trust === "trusted" || trust === "limited" || trust === "untrusted")
  );
}

/** Validate an externalized payload ref (external_ref / image_ref). */
function isPayloadRef(value: unknown): value is ExternalizedPayloadRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    o["schemaVersion"] === 1 &&
    typeof o["kind"] === "string" &&
    typeof o["hash"] === "string" &&
    typeof o["byteLength"] === "number" &&
    typeof o["uri"] === "string"
  );
}

/**
 * Validate an AgentInput loaded from disk: structural shape, per-block
 * contentHash consistency, and origin provenance. Returns a normalized input
 * (recomputed hashes) or throws a descriptive error — the CLI must never
 * silently run an unverified input (review blocker #4).
 */
function validateAgentInput(raw: unknown): AgentInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("iris run input must be a JSON object");
  }
  const candidate = raw as Partial<AgentInput>;
  if (typeof candidate.inputId !== "string" || candidate.inputId === "") {
    throw new Error("iris run input requires a non-empty inputId");
  }
  if (!Array.isArray(candidate.blocks) || candidate.blocks.length === 0) {
    throw new Error("iris run input requires a non-empty blocks array");
  }
  const inputId: string = candidate.inputId;
  const blocks = candidate.blocks.map((block, index) => {
    if (typeof block !== "object" || block === null) {
      throw new Error(`input block ${index} is not an object`);
    }
    const b = block as {
      blockId?: unknown;
      sourceOrigin?: unknown;
      content?: unknown;
      contentHash?: unknown;
    };
    if (typeof b.blockId !== "string" || b.blockId === "") {
      throw new Error(`input block ${index} requires a non-empty blockId`);
    }
    if (!isOriginEnvelope(b.sourceOrigin)) {
      throw new Error(`input block ${index} requires a valid sourceOrigin provenance envelope`);
    }
    if (typeof b.content !== "object" || b.content === null) {
      throw new Error(`input block ${index} requires content`);
    }
    const content = b.content as {
      mode?: unknown;
      text?: unknown;
      ref?: unknown;
    };
    if (typeof content.mode !== "string") {
      throw new Error(`input block ${index} content requires a mode`);
    }
    if (content.mode === "inline_text") {
      if (typeof content.text !== "string") {
        throw new Error(`input block ${index} inline_text content requires a text string`);
      }
      const text: string = content.text;
      const expectedHash = createHash("sha256").update(text).digest("hex");
      if (
        typeof b.contentHash === "string" &&
        b.contentHash !== "" &&
        b.contentHash !== expectedHash
      ) {
        throw new Error(`input block ${index} contentHash does not match its content`);
      }
      return {
        blockId: b.blockId,
        sourceOrigin: b.sourceOrigin,
        content: { mode: "inline_text" as const, text },
        contentHash: expectedHash,
      };
    }
    if (content.mode === "external_ref" || content.mode === "image_ref") {
      if (!isPayloadRef(content.ref)) {
        throw new Error(
          `input block ${index} ${content.mode} content requires a valid payload ref`,
        );
      }
      const ref = content.ref;
      const expectedHash = createHash("sha256").update(ref.uri).digest("hex");
      if (
        typeof b.contentHash === "string" &&
        b.contentHash !== "" &&
        b.contentHash !== expectedHash
      ) {
        throw new Error(`input block ${index} contentHash does not match its content`);
      }
      return {
        blockId: b.blockId,
        sourceOrigin: b.sourceOrigin,
        content:
          content.mode === "external_ref"
            ? { mode: "external_ref" as const, ref }
            : { mode: "image_ref" as const, ref },
        contentHash: expectedHash,
      };
    }
    throw new Error(
      `input block ${index} content mode must be inline_text, external_ref or image_ref`,
    );
  });
  // Fail closed on provenance (review blocker #4): a missing or invalid
  // triggerOrigin is an error, never a silent fallback to a block origin.
  if (!isOriginEnvelope(candidate.triggerOrigin)) {
    throw new Error("iris run input requires a valid triggerOrigin provenance envelope");
  }
  const triggerOrigin = candidate.triggerOrigin;
  return {
    inputId,
    triggerOrigin,
    blocks,
    ...(typeof candidate.interaction === "object" && candidate.interaction !== null
      ? { interaction: candidate.interaction }
      : {}),
  };
}

function loadInput(inputFile: string | undefined): AgentInput {
  if (inputFile === undefined) {
    throw new Error("iris run requires --input-file <path.json>");
  }
  const raw = readFileSync(inputFile, "utf8");
  return validateAgentInput(JSON.parse(raw));
}

export async function runCommand(options: RunCommandOptions): Promise<number> {
  const { dataRoot } = options;
  const configPath = join(dataRoot, "agent.json");
  const config = existsSync(configPath) ? await loadAgentConfig(configPath) : defaultAgentConfig();
  const input = loadInput(options.inputFile);

  const result = await runMinimalSlice({
    dataRoot,
    config,
    input,
    provider: options.provider,
  });

  const output = {
    service: "iris-agent",
    dataRoot,
    phase: "r1-p1-vertical-slice",
    provider: options.provider,
    status: "ok",
    epochId: result.epochId,
    runtimeSessionId: result.runtimeSessionId,
    settled: result.observers.settled,
    contextPasses: result.observers.contextPasses,
    toolCalls: result.observers.toolCallOrder,
    toolResults: result.observers.toolResultOrder,
    entryCount: result.entries.length,
    assistantText: result.assistantMessage.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(""),
  };
  console.log(JSON.stringify(output, null, 2));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "run") {
    const dataRootIndex = argv.indexOf("--data-root");
    const inputIndex = argv.indexOf("--input-file");
    const providerIndex = argv.indexOf("--provider");
    const dataRoot = dataRootIndex >= 0 ? argv[dataRootIndex + 1] : undefined;
    const inputFile = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
    const providerRaw = providerIndex >= 0 ? argv[providerIndex + 1] : "mock";
    if (dataRoot === undefined) {
      console.error("iris run requires --data-root <path>");
      return 1;
    }
    if (providerRaw !== "mock" && providerRaw !== "live") {
      console.error("iris run --provider must be 'mock' or 'live'");
      return 1;
    }
    try {
      return await runCommand({
        dataRoot,
        inputFile,
        provider: providerRaw as SliceProviderMode,
      });
    } catch (error) {
      console.error(`iris run failed: ${(error as Error).message}`);
      return 1;
    }
  }

  // Legacy bootstrap behavior: `iris serve --data-root <path>`
  const dataRootIndex = argv.indexOf("--data-root");
  const dataRoot = dataRootIndex >= 0 ? argv[dataRootIndex + 1] : undefined;
  if (dataRoot === undefined) {
    console.error("iris serve requires --data-root <path>");
    return 1;
  }

  const configPath = join(dataRoot, "agent.json");
  const config = existsSync(configPath) ? await loadAgentConfig(configPath) : defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  const lock = await acquireDataRootLock(dataRoot, paths.lockFile);
  try {
    initializeDataRoot(dataRoot, config);
    const output = {
      service: "iris-agent",
      dataRoot,
      phase: "r0-baseline",
      status: "bootstrap",
      lockAcquired: true,
      epochRegistryDb: paths.epochRegistryDb,
    };
    console.log(JSON.stringify(output, null, 2));
    return 0;
  } finally {
    await lock.release();
  }
}
