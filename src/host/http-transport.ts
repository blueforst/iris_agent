import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { IrisHost } from "./host.js";
import { IngressConflictError, IngressQueueFullError } from "./ingress.js";

/**
 * Loopback HTTP/SSE transport for the long-lived Host (03 Host Runtime:
 * Client Service Transport).
 *
 * HTTP default binds to 127.0.0.1:18001 only. The transport NEVER becomes a
 * second runtime event truth: streaming/SSE only forwards events that the
 * RuntimeCoordinator already produced; regular requests enter the same Host
 * ingress + RuntimeCoordinator as every other client.
 *
 * Routes (M1):
 *   GET  /v1/health
 *   POST /v1/input
 *   POST /v1/abort/{invocationId}
 *   GET  /v1/stream                     (SSE; Coordinator events)
 *   GET  /v1/admin/session/status
 *   POST /v1/admin/session/rollover
 *   GET  /v1/admin/session/archives
 */
export interface HttpTransportOptions {
  host: IrisHost;
  bindHost?: string;
  port?: number;
}

export interface HttpTransportHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startHttpTransport(
  options: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const bindHost = options.bindHost ?? "127.0.0.1";
  const port = options.port ?? 18001;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await route(req, res, options.host);
      } catch (error) {
        sendJson(res, 500, { error: "internal_error", message: (error as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      resolve();
    });
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function route(req: IncomingMessage, res: ServerResponse, host: IrisHost): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/v1/health") {
    sendJson(res, 200, host.health());
    return;
  }

  if (method === "GET" && path === "/v1/stream") {
    await streamSse(req, res, host);
    return;
  }

  if (method === "POST" && path === "/v1/input") {
    await handleInput(req, res, host);
    return;
  }

  if (method === "POST" && path.startsWith("/v1/abort/")) {
    const invocationId = decodeURIComponent(path.slice("/v1/abort/".length));
    try {
      await host.abort(invocationId);
      sendJson(res, 200, { status: "aborting", invocationId });
    } catch (error) {
      sendJson(res, 409, { error: "not_active", invocationId, message: (error as Error).message });
    }
    return;
  }

  if (method === "GET" && path === "/v1/admin/session/status") {
    sendJson(res, 200, host.sessionStatus());
    return;
  }

  if (method === "POST" && path === "/v1/admin/session/rollover") {
    const body = await readJsonBody(req);
    const reason =
      typeof body?.["reason"] === "string" && body["reason"] !== ""
        ? body["reason"]
        : "admin_request";
    host.requestRollover(reason);
    sendJson(res, 202, { status: "rollover_pending", reason });
    return;
  }

  if (method === "GET" && path === "/v1/admin/session/archives") {
    const limit = parseLimit(url.searchParams.get("limit"), 50);
    sendJson(res, 200, { archives: host.archives(limit) });
    return;
  }

  sendJson(res, 404, { error: "not_found", path });
}

async function handleInput(
  req: IncomingMessage,
  res: ServerResponse,
  host: IrisHost,
): Promise<void> {
  const body = await readJsonBody(req);
  const inputId = body?.["inputId"];
  if (typeof inputId !== "string" || inputId === "") {
    sendJson(res, 400, { error: "input_invalid", message: "inputId is required" });
    return;
  }
  const instanceEpoch =
    typeof body?.["instanceEpoch"] === "number" ? body["instanceEpoch"] : undefined;
  try {
    const outcome = host.acceptInput(body, inputId, instanceEpoch);
    if (outcome.outcome === "accepted") {
      sendJson(res, 202, {
        status: "accepted",
        inputId: outcome.record.inputId,
        instanceEpoch: outcome.record.instanceEpoch,
        payloadHash: outcome.record.payloadHash,
        state: outcome.record.state,
      });
      return;
    }
    if (outcome.outcome === "duplicate") {
      sendJson(res, 200, {
        status: "duplicate",
        inputId: outcome.record.inputId,
        instanceEpoch: outcome.record.instanceEpoch,
        payloadHash: outcome.record.payloadHash,
        state: outcome.record.state,
      });
      return;
    }
    sendJson(res, 409, {
      error: "idempotency_conflict",
      inputId: outcome.record.inputId,
      instanceEpoch: outcome.record.instanceEpoch,
      expectedPayloadHash: outcome.record.payloadHash,
      receivedPayloadHash: outcome.receivedPayloadHash,
    });
  } catch (error) {
    if (error instanceof IngressQueueFullError) {
      sendJson(res, 429, { error: "queue_full", capacity: error.capacity });
      return;
    }
    if (error instanceof IngressConflictError) {
      sendJson(res, 409, {
        error: "idempotency_conflict",
        inputId: error.inputId,
        instanceEpoch: error.instanceEpoch,
        expectedPayloadHash: error.expectedPayloadHash,
        receivedPayloadHash: error.receivedPayloadHash,
      });
      return;
    }
    throw error;
  }
}

async function streamSse(req: IncomingMessage, res: ServerResponse, host: IrisHost): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: ready\ndata: {}\n\n");

  const unsubscribe = host.onEvent((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  req.on("close", () => {
    unsubscribe();
    res.end();
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).byteLength > 1_000_000) {
      throw new Error("request body too large");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") {
    return undefined;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function parseLimit(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, 500);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}
