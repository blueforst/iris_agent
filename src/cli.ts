import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentInput } from "./contracts/origin.js";
import { defaultAgentConfig, loadAgentConfig } from "./config/load.js";
import { openHost } from "./host/composition.js";
import { IrisHost } from "./host/host.js";
import { startHttpTransport } from "./host/http-transport.js";
import { validateAgentInput } from "./host/input-validation.js";
import type { SliceProviderMode } from "./runtime/vertical-slice.js";

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
  return validateAgentInput(JSON.parse(raw));
}

/**
 * One-shot `iris run` — TEST/DEV SURFACE (03 Host Runtime: Frontend Client
 * Boundary). It opens the data root and composes an Iris itself; the product
 * path is `iris serve` (long-lived Host) with CLI commands as Host clients.
 */
export async function runCommand(options: RunCommandOptions): Promise<number> {
  const { dataRoot } = options;
  const configPath = join(dataRoot, "agent.json");
  const config = existsSync(configPath) ? await loadAgentConfig(configPath) : defaultAgentConfig();
  const input = loadInput(options.inputFile);

  const host = await openHost({ dataRoot, config, provider: options.provider });
  try {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    for await (const event of host.coordinator.prompt(input)) {
      events.push(event as { type: string } & Record<string, unknown>);
    }
    const settled = events.some((event) => event.type === "settled");
    const failed = events.some((event) => event.type === "failed");
    const toolCalls = events
      .filter((event) => event.type === "tool_call")
      .map((event) => ({
        toolCallId: event["toolCallId"] as string,
        toolName: event["toolName"] as string,
      }));
    const assistantText = events
      .filter((event) => event.type === "message_delta")
      .map((event) => event["text"] as string)
      .join("");

    const output = {
      service: "iris-agent",
      dataRoot,
      phase: "r1-p2-host-composition",
      surface: "test/dev — product path is `iris serve`",
      provider: options.provider,
      status: failed ? "error" : "ok",
      settled,
      epochId: host.epoch.epochId,
      runtimeSessionId: host.epoch.runtimeSessionId,
      toolCalls,
      assistantText,
      eventCount: events.length,
    };
    console.log(JSON.stringify(output, null, 2));
    return failed ? 1 : 0;
  } finally {
    await host.close();
  }
}

async function loadHostConfig(dataRoot: string) {
  const configPath = join(dataRoot, "agent.json");
  return existsSync(configPath) ? await loadAgentConfig(configPath) : defaultAgentConfig();
}

/**
 * Long-lived `iris serve` (03 Host Runtime). Holds iris.lock for the full
 * lifetime, runs startup recovery, opens the active Epoch/Session, starts the
 * loopback ingress/admin transport, reports ready, then remains alive until a
 * shutdown signal. A second process against the same data root fails fast.
 */
export async function serveCommand(argv: string[]): Promise<number> {
  const dataRootIndex = argv.indexOf("--data-root");
  const portIndex = argv.indexOf("--port");
  const providerIndex = argv.indexOf("--provider");
  const dataRoot = dataRootIndex >= 0 ? argv[dataRootIndex + 1] : undefined;
  const portValue = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const port = portValue !== undefined ? Number.parseInt(portValue, 10) : 18001;
  const providerRaw = providerIndex >= 0 ? argv[providerIndex + 1] : "mock";
  if (dataRoot === undefined) {
    console.error("iris serve requires --data-root <path>");
    return 1;
  }
  if (providerRaw !== "mock" && providerRaw !== "live") {
    console.error("iris serve --provider must be 'mock' or 'live'");
    return 1;
  }
  const provider = providerRaw as SliceProviderMode;

  let host: IrisHost | undefined;
  try {
    const config = await loadHostConfig(dataRoot);
    host = await IrisHost.open({ dataRoot, config, provider });
    const transport = await startHttpTransport({ host, port });
    // A7 (审查 #7): the transport is owned by the Host lifecycle — shutdown()
    // closes it before releasing iris.lock (no reachable-server-with-free-lock
    // window), and closes SSE connections rather than waiting indefinitely.
    host.attachTransport(async () => {
      await transport.close();
    });
    host.markReady();
    const output = {
      service: "iris-agent",
      dataRoot,
      phase: "r1-p2-long-lived-host",
      status: "ready",
      lockAcquired: true,
      endpoint: `http://127.0.0.1:${transport.port}`,
      epochId: host.getCurrentEpoch().epochId,
      runtimeSessionId: host.getCurrentEpoch().runtimeSessionId,
      coordinatorPhase: host.getCoordinator().getPhase(),
    };
    console.log(JSON.stringify(output, null, 2));
    // Print a single ready line so parent processes can detect startup.
    const pumpPromise = host.run();
    // review-pass-4 #3: race the pump against the shutdown signal. If the
    // pump rejects (rollover fault, runtime error) the process must NOT keep
    // waiting for an external signal — it immediately tears down transport/
    // stores/Session, releases the lock and exits non-zero (fail-stop).
    const shutdownSignal = new Promise<"signal">((resolve) => {
      // Remove the default SIGINT/SIGTERM handlers so the process does NOT
      // terminate before the graceful shutdown path releases iris.lock.
      const onSignal = (): void => {
        resolve("signal");
      };
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      // Cross-process test/dev convenience: closing stdin (EOF) is also a
      // graceful shutdown signal, so a parent process can stop the Host
      // without platform-specific signal semantics (Windows SIGTERM = kill).
      if (!process.stdin.isTTY) {
        process.stdin.on("end", onSignal);
        process.stdin.resume();
      }
    });
    // A pump rejection surfaces as an immediate fail-stop path; a clean pump
    // completion (only after shuttingDown is set) resolves to "done".
    const pumpOutcome = pumpPromise.then(
      () => "done" as const,
      (error: unknown) => ({ pumpError: error as Error }),
    );
    const winner = await Promise.race([shutdownSignal, pumpOutcome]);
    if (winner !== "signal" && winner !== "done") {
      // Fail-stop: the pump died on its own (rollover fault etc.) — tear down
      // and exit non-zero immediately; do not keep serving on a dead pump.
      console.error(`iris serve pump failed: ${winner.pumpError.message}`);
      await host.shutdown().catch(() => undefined);
      await pumpPromise.catch(() => undefined);
      return 1;
    }
    // Signal received: mark not-ready, close the transport, stop the pump,
    // close resources and release the lock (run() only exits once
    // shuttingDown is set).
    await host.shutdown();
    await pumpPromise;
    return 0;
  } catch (error) {
    console.error(`iris serve failed: ${(error as Error).message}`);
    if (host !== undefined) {
      await host.shutdown().catch(() => undefined);
    }
    return 1;
  }
}

/** Host client helper: POST /v1/input through the running Host. */
async function hostSubmit(
  endpoint: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${endpoint}/v1/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** CLI as a Host client (03 Host Runtime): connect to a running `iris serve`. */
export async function clientCommand(argv: string[]): Promise<number> {
  const command = argv[0];
  const endpointIndex = argv.indexOf("--endpoint");
  const endpointValue = endpointIndex >= 0 ? argv[endpointIndex + 1] : undefined;
  const endpoint = endpointValue ?? "http://127.0.0.1:18001";

  if (command === "status") {
    const response = await fetch(`${endpoint}/v1/admin/session/status`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return response.ok ? 0 : 1;
  }
  if (command === "archives") {
    const response = await fetch(`${endpoint}/v1/admin/session/archives`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return response.ok ? 0 : 1;
  }
  if (command === "rollover") {
    const response = await fetch(`${endpoint}/v1/admin/session/rollover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "cli_admin_request" }),
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    return response.ok ? 0 : 1;
  }
  if (command === "chat") {
    const inputIndex = argv.indexOf("--input-file");
    const inputFileValue = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
    const input = loadInput(inputFileValue);
    const { status, json } = await hostSubmit(endpoint, input);
    console.log(JSON.stringify(json, null, 2));
    return status === 202 || status === 200 ? 0 : 1;
  }
  if (command === "health") {
    const response = await fetch(`${endpoint}/v1/health`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return response.ok ? 0 : 1;
  }
  console.error(`iris client: unknown command '${command}'`);
  return 1;
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

  if (command === "serve") {
    return serveCommand(argv.slice(1));
  }

  // Host client commands (status / archives / rollover / chat / health).
  if (
    command === "status" ||
    command === "archives" ||
    command === "rollover" ||
    command === "chat" ||
    command === "health"
  ) {
    return clientCommand(argv);
  }

  console.error(
    "usage: iris serve --data-root <path> [--port <port>] | " +
      "iris run --data-root <path> --input-file <file> | " +
      "iris status|archives|rollover|chat|health [--endpoint <url>]",
  );
  return 1;
}
