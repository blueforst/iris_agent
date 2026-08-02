import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { AgentInput, ExternalizedPayloadRef, OriginEnvelope } from "./contracts/origin.js";
import { defaultAgentConfig, loadAgentConfig } from "./config/load.js";
import { openHost } from "./host/composition.js";
import { IrisHost } from "./host/host.js";
import { startHttpTransport } from "./host/http-transport.js";
import type { SliceProviderMode } from "./runtime/vertical-slice.js";

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
export function validateAgentInput(raw: unknown): AgentInput {
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
      // For ref blocks the content-addressed source hash IS ref.hash (the
      // externalized payload's content hash), not a hash of the URI — the
      // sourceContentHash contract (review blocker #4, third pass).
      const expectedHash = ref.hash;
      if (
        typeof b.contentHash === "string" &&
        b.contentHash !== "" &&
        b.contentHash !== expectedHash
      ) {
        throw new Error(`input block ${index} contentHash does not match ref.hash`);
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
    await new Promise<void>((resolve) => {
      // Remove the default SIGINT/SIGTERM handlers so the process does NOT
      // terminate before the graceful shutdown path releases iris.lock.
      const onSignal = (): void => {
        resolve();
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
    // Signal received: mark not-ready, stop the pump, close resources and
    // release the lock BEFORE awaiting the pump (run() only exits once
    // shuttingDown is set).
    await host.shutdown();
    await pumpPromise;
    await transport.close();
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
