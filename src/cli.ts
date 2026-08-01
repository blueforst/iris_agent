import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentInput } from "./contracts/origin.js";
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

function loadInput(inputFile: string | undefined): AgentInput {
  if (inputFile === undefined) {
    throw new Error("iris run requires --input-file <path.json>");
  }
  const raw = readFileSync(inputFile, "utf8");
  return JSON.parse(raw) as AgentInput;
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
