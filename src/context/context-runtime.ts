import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import type {
  ContextTransformResult,
  PreparedContextSources,
  TransformMessagesInput,
} from "../contracts/context.js";
import { applyContextPass, runContextPass, renderProviderVisible } from "./pipeline.js";
import type { ContextStore } from "./context-store.js";
import { captureLkgSlot, replayLkg } from "./lkg.js";
import { LKG_SLOT_KEY } from "./lkg.js";
import {
  projectSessionMessages,
  type ProjectedSessionMessage,
} from "../runtime/session-projection.js";

/**
 * Iris Context runtime (issue #8 A3) — the ContextRuntimePort implementation
 * the Host wires into the Pi harness `context` hook.
 *
 * The REAL product path:
 *
 *   Session.buildContext()
 *   → identity-preserving projection (projectLogicalUnits)
 *   → runContextPass (SOFT+/SOFT/HARD against the persisted lineage)
 *   → applyContextPass (persistence transaction on context.db)
 *   → renderProviderVisible (m0 + m1 + live tail)
 *   → provider request
 *
 * Constraints honored here (01 Context Assembly / 05 Pi Runtime Capsule):
 *  - the transform NEVER calls the Provider (pure + persistence only);
 *  - the transform NEVER writes Pi messages or drives the tool loop;
 *  - the transform returns only the provider-visible view; Pi owns the
 *    message append / tool loop / settled lifecycle;
 *  - the legacy mock transformer (transformContextMessages /
 *    mock-m0m1-v1) is NOT used on this path;
 *  - every provider call runs a full pass — the delta of the current
 *    invocation is re-projected on every hook invocation.
 *
 * The runtime is per-Host (one ContextStore) but Session-scoped: every
 * transform call binds to the ACTIVE runtimeSessionId of the current
 * invocation (frozen by the Coordinator), so a rollover never mixes
 * lineages.
 */

export interface ContextRuntimeOptions {
  store: ContextStore;
  /**
   * Narrow read port: the CURRENT runtime Session's raw entries. Supplied by
   * the Capsule (Host) — Context never holds a Pi Session object.
   */
  readEntries: () => Promise<SessionTreeEntry[]>;
  /** Identity of the prepared sources (persona/declaration/system). */
  identity: {
    personaSnapshotId: string;
    declarationVersion: string;
    providerProfileId: string;
    canonicalSystemPrompt: string;
    systemProjectionHash: string;
  };
  /** Clock for persistence timestamps (tests inject a fixed now). */
  nowMs: () => number;
  /**
   * Context window limit (tokens) of the active model profile. Required for
   * the unresolved-hard-overflow escalation (oversizeAtomicUnit compares the
   * head seam unit against the derived per-run cap). Optional: when absent,
   * the overflow escalation is conservatively disabled (no false positives).
   */
  contextLimit?: number;
  /** Execute threshold percentage (authority executeThresholdPercentage). */
  executeThresholdPercentage?: number;
}

export class ContextRuntime {
  private readonly store: ContextStore;
  private readonly readEntries: () => Promise<SessionTreeEntry[]>;
  private readonly identity: ContextRuntimeOptions["identity"];
  private readonly nowMs: () => number;
  private readonly contextLimit: number | undefined;
  private readonly executeThresholdPercentage: number | undefined;

  constructor(options: ContextRuntimeOptions) {
    this.store = options.store;
    this.readEntries = options.readEntries;
    this.identity = options.identity;
    this.nowMs = options.nowMs;
    this.contextLimit = options.contextLimit;
    this.executeThresholdPercentage = options.executeThresholdPercentage;
  }

  /**
   * prepareInvocationSources: bind the immutable system prompt + ensure the
   * Session lineage exists (HARD first_render on the first pass). The same
   * prepared bytes are replayed by the native systemPrompt resolver for every
   * tool turn of the invocation (05 Pi Runtime Capsule: immutable binding).
   */
  prepareInvocationSources(input: {
    inputId: string;
    runtimeSessionId: string;
    epochId: string;
  }): PreparedContextSources {
    const { runtimeSessionId, epochId } = input;
    const lineage = this.store.getLineage(runtimeSessionId);
    if (lineage === undefined) {
      this.store.createLineage({
        runtimeSessionId,
        contextSourceSnapshotId: `snapshot-${this.identity.systemProjectionHash.slice(0, 12)}`,
        epochId,
        personaSnapshotId: this.identity.personaSnapshotId,
        declarationVersion: this.identity.declarationVersion,
        providerProfileId: this.identity.providerProfileId,
        canonicalSystemPrompt: this.identity.canonicalSystemPrompt,
        systemProjectionHash: this.identity.systemProjectionHash,
        preparedAt: new Date(this.nowMs()).toISOString(),
        materializationId: `mat-${runtimeSessionId}-pending`,
        contextSerializerVersion: "iris-context-golden-v1",
        carrierSchemaVersion: "1",
      });
    }
    const current = this.store.getLineage(runtimeSessionId);
    if (current === undefined) {
      throw new Error(`context prepare failed: no lineage after create for ${runtimeSessionId}`);
    }
    return {
      contextSourceSnapshotId: current.contextSourceSnapshotId,
      runtimeSessionId,
      canonicalSystemPrompt: current.canonicalSystemPrompt,
      systemProjectionHash: current.systemProjectionHash,
      materializationIdentity: current.materializationId,
      preparedAt: current.preparedAt,
    };
  }

  /**
   * transformMessages: the REAL context hook transform. Runs the full pass
   * over the current Session projection and persists the materialization
   * decision; returns the provider-visible m0 + m1 + live tail.
   *
   * Throws the typed fail-closed errors (IRIS_CONTEXT_TRANSFORM_UNAVAILABLE /
   * IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED) before any provider call — the Pi
   * harness normalizes the hook error and completes the native failure
   * lifecycle (05 Pi Runtime Capsule, Context Integrity Guards).
   */
  async transformMessages(input: TransformMessagesInput): Promise<ContextTransformResult> {
    // The read port is INSIDE the try so a session-read failure also walks
    // the LKG replay path / typed fail-closed contract (A4 review #2).
    let entries: SessionTreeEntry[] | undefined;
    let lineage: Awaited<ReturnType<ContextStore["getLineage"]>> | undefined;
    try {
      entries = await this.readEntries();
      lineage = this.store.getLineage(input.runtimeSessionId);
      if (lineage === undefined) {
        // No lineage means prepareInvocationSources was never called for this
        // Session (contract violation). Fail closed with the typed error —
        // never fabricate a wire or a baseline.
        throw new ContextFailClosedError("transform_unavailable", input.runtimeSessionId);
      }

      // Armed emergency (issue #8 A4): a prior pass escalated and the Session
      // has not been recovered — fail closed before any provider request.
      if (lineage.emergencyState === "emergency_fail_closed") {
        throw new ContextFailClosedError("emergency_fail_closed", input.runtimeSessionId);
      }

      const decision = runContextPass({
        runtimeSessionId: input.runtimeSessionId,
        entries,
        lineage,
        source: {
          contextSourceSnapshotId: lineage?.contextSourceSnapshotId ?? "snapshot-none",
          personaSnapshotId: lineage?.personaSnapshotId ?? this.identity.personaSnapshotId,
          declarationVersion: lineage?.declarationVersion ?? this.identity.declarationVersion,
          providerProfileId: input.providerProfileId,
          canonicalSystemPrompt:
            lineage?.canonicalSystemPrompt ?? this.identity.canonicalSystemPrompt,
          systemProjectionHash: lineage?.systemProjectionHash ?? this.identity.systemProjectionHash,
        },
        model: input.model,
        ...(this.contextLimit === undefined ? {} : { contextLimit: this.contextLimit }),
        ...(this.executeThresholdPercentage === undefined
          ? {}
          : { executeThresholdPercentage: this.executeThresholdPercentage }),
      });

      if (decision.failClosed !== "none") {
        applyContextPass(this.store, input.runtimeSessionId, decision, this.nowMs());
        const state =
          decision.failClosed === "emergency_fail_closed"
            ? "emergency_fail_closed"
            : "transform_unavailable";
        throw new ContextFailClosedError(state, input.runtimeSessionId);
      }

      applyContextPass(this.store, input.runtimeSessionId, decision, this.nowMs());

      // Issue #8 A4 + A5 #3 (growing-window replay): capture the LKG slot on
      // EVERY successful pass (HARD/SOFT/SOFT+), not just HARD — the slot
      // always reflects the newest safe provider-visible window so a later
      // ordinary failure replays the latest known-good prefix, not a stale
      // HARD snapshot. The output is the decision's provider-visible
      // carriers + the current live tail.
      const visible = renderProviderVisible(decision, decision.projection);
      const captureOutput: ProjectedSessionMessage[] = [
        decision.carriers.m0 as unknown as AgentMessage,
        decision.carriers.m1 as unknown as AgentMessage,
        ...visible.messages.filter(
          (message) => (message as { customType?: string }).customType === "iris_context_carrier",
        ),
      ].map((message): ProjectedSessionMessage => ({
        rawIndex: -1,
        entryId: "",
        parentId: null,
        entryType: "message",
        message,
      }));
      captureLkgSlot(this.store, {
        runtimeSessionId: input.runtimeSessionId,
        input: projectSessionMessages(entries ?? []),
        output: captureOutput,
        modelKey: `${input.model.provider}/${input.model.modelId}`,
        providerKey: input.model.provider,
        capturedAt: this.nowMs(),
      });

      return {
        messages: visible.messages,
        representedBoundaryState: {
          runtimeSessionId: input.runtimeSessionId,
          materializationIdentity:
            decision.action.kind === "reuse"
              ? (lineage?.materializationId ?? "mat-none")
              : `mat-${input.runtimeSessionId}-${decision.projection.projectionHash}`,
          providerProfileId: input.providerProfileId,
        },
      };
    } catch (error) {
      if (error instanceof ContextFailClosedError) {
        throw error;
      }
      // Ordinary transform/storage failure (issue #8 A4): validate the
      // compatible LKG and replay the safe prefix + current suffix; when no
      // compatible LKG exists, fail closed with the typed error BEFORE any
      // provider request. Raw message fallback is forbidden. A read-port
      // failure yields no entries to replay against — treat as unavailable.
      const projected = projectSessionMessages(entries ?? []);
      const providerKey = input.model.provider;
      const modelKey = `${providerKey}/${input.model.modelId}`;
      const replayed = replayLkg(this.store, {
        runtimeSessionId: input.runtimeSessionId,
        messages: projected,
        modelKey,
        providerKey,
      });
      if (replayed.ok) {
        return {
          messages: replayed.messages
            .map((item) => item.message)
            .filter((message) => message.role !== "custom" || !isIrisCompanion(message)),
          representedBoundaryState: {
            runtimeSessionId: input.runtimeSessionId,
            materializationIdentity: `lkg-${LKG_SLOT_KEY}`,
            providerProfileId: input.providerProfileId,
          },
        };
      }
      throw new ContextFailClosedError("transform_unavailable", input.runtimeSessionId);
    }
  }
  releaseInvocation(invocationId: string): Promise<void> {
    void invocationId;
    // No in-memory invocation state to release; the durable lineage is
    // Session-scoped and survives invocations (01 Context Assembly:
    // releaseInvocation() only frees memory bindings).
    return Promise.resolve();
  }
}

/**
 * True when a message is the iris_input_meta companion (never provider-
 * visible — filtered before convertToLlm, 01 Context Assembly).
 */
function isIrisCompanion(message: {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}): boolean {
  return (
    message.role === "custom" &&
    message.customType === "iris_input_meta" &&
    message.content === "<iris-input-meta/>" &&
    message.display === false
  );
}

/** Typed fail-closed error the harness normalizes before the provider call. */
export class ContextFailClosedError extends Error {
  readonly code: "IRIS_CONTEXT_TRANSFORM_UNAVAILABLE" | "IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED";
  readonly runtimeSessionId: string;

  constructor(state: "transform_unavailable" | "emergency_fail_closed", runtimeSessionId: string) {
    super(
      state === "emergency_fail_closed"
        ? "IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED"
        : "IRIS_CONTEXT_TRANSFORM_UNAVAILABLE",
    );
    this.name = "ContextFailClosedError";
    this.code =
      state === "emergency_fail_closed"
        ? "IRIS_CONTEXT_EMERGENCY_FAIL_CLOSED"
        : "IRIS_CONTEXT_TRANSFORM_UNAVAILABLE";
    this.runtimeSessionId = runtimeSessionId;
  }
}
