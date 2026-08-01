import { existsSync } from "node:fs";
import { join } from "node:path";

import { defaultAgentConfig, loadAgentConfig } from "./config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "./host/data-root.js";
import { acquireDataRootLock } from "./host/lock.js";

export async function main(argv: string[]): Promise<number> {
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
