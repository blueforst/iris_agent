import { createHash } from "node:crypto";

import type { AgentInput, ExternalizedPayloadRef, OriginEnvelope } from "../contracts/origin.js";

/**
 * Host-owned AgentInput normalization/validation (independent审查 #2).
 *
 * The Host is the ONLY normalization/validation authority before an input is
 * durably accepted: every transport (/v1/input, CLI, future clients) must run
 * `validateAgentInput` so a poisoned envelope can never become a durable
 * `accepted` record. Failures raise a typed error with a machine-readable
 * code; the HTTP transport maps them to typed 4xx responses.
 */

export class AgentInputValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentInputValidationError";
  }
}

export function isOriginEnvelope(value: unknown): value is OriginEnvelope {
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
 * Validate an AgentInput envelope: structural shape, per-block contentHash
 * consistency, origin provenance, and mode/content validity. Returns a
 * normalized input (recomputed hashes) or throws an
 * `AgentInputValidationError` with a typed code — the Host must never
 * durably accept an unverified input.
 */
export function validateAgentInput(raw: unknown): AgentInput {
  if (typeof raw !== "object" || raw === null) {
    throw new AgentInputValidationError("input_invalid", "iris input must be a JSON object");
  }
  const candidate = raw as Partial<AgentInput>;
  if (typeof candidate.inputId !== "string" || candidate.inputId === "") {
    throw new AgentInputValidationError("input_invalid", "iris input requires a non-empty inputId");
  }
  if (!Array.isArray(candidate.blocks) || candidate.blocks.length === 0) {
    throw new AgentInputValidationError(
      "input_invalid",
      "iris input requires a non-empty blocks array",
    );
  }
  const inputId: string = candidate.inputId;
  const blocks = candidate.blocks.map((block, index) => {
    if (typeof block !== "object" || block === null) {
      throw new AgentInputValidationError("input_invalid", `input block ${index} is not an object`);
    }
    const b = block as {
      blockId?: unknown;
      sourceOrigin?: unknown;
      content?: unknown;
      contentHash?: unknown;
    };
    if (typeof b.blockId !== "string" || b.blockId === "") {
      throw new AgentInputValidationError(
        "input_invalid",
        `input block ${index} requires a non-empty blockId`,
      );
    }
    if (!isOriginEnvelope(b.sourceOrigin)) {
      throw new AgentInputValidationError(
        "input_invalid",
        `input block ${index} requires a valid sourceOrigin provenance envelope`,
      );
    }
    if (typeof b.content !== "object" || b.content === null) {
      throw new AgentInputValidationError("input_invalid", `input block ${index} requires content`);
    }
    const content = b.content as {
      mode?: unknown;
      text?: unknown;
      ref?: unknown;
    };
    if (typeof content.mode !== "string") {
      throw new AgentInputValidationError(
        "input_invalid",
        `input block ${index} content requires a mode`,
      );
    }
    if (content.mode === "inline_text") {
      if (typeof content.text !== "string") {
        throw new AgentInputValidationError(
          "input_invalid",
          `input block ${index} inline_text content requires a text string`,
        );
      }
      const text: string = content.text;
      const expectedHash = createHash("sha256").update(text).digest("hex");
      if (
        typeof b.contentHash === "string" &&
        b.contentHash !== "" &&
        b.contentHash !== expectedHash
      ) {
        throw new AgentInputValidationError(
          "content_hash_mismatch",
          `input block ${index} contentHash does not match its content`,
        );
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
        throw new AgentInputValidationError(
          "input_invalid",
          `input block ${index} ${content.mode} content requires a valid payload ref`,
        );
      }
      const ref = content.ref;
      // For ref blocks the content-addressed source hash IS ref.hash (the
      // externalized payload's content hash), not a hash of the URI.
      const expectedHash = ref.hash;
      if (
        typeof b.contentHash === "string" &&
        b.contentHash !== "" &&
        b.contentHash !== expectedHash
      ) {
        throw new AgentInputValidationError(
          "content_hash_mismatch",
          `input block ${index} contentHash does not match ref.hash`,
        );
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
    throw new AgentInputValidationError(
      "input_invalid",
      `input block ${index} content mode must be inline_text, external_ref or image_ref`,
    );
  });
  // Fail closed on provenance: a missing or invalid triggerOrigin is an
  // error, never a silent fallback to a block origin.
  if (!isOriginEnvelope(candidate.triggerOrigin)) {
    throw new AgentInputValidationError(
      "input_invalid",
      "iris input requires a valid triggerOrigin provenance envelope",
    );
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
