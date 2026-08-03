import { createHash } from "node:crypto";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import type { ContextStore, ContextLineage } from "./context-store.js";
import { projectLogicalUnits, type ProjectedLogicalUnits } from "./projection.js";
import { buildCarriers, type BuiltCarrier } from "./carriers.js";
import { decidePass, type PassClassification } from "./pass-taxonomy.js";
import {
  resolveProtectedTail,
  deriveProtectedTailTokenTarget,
  type ProtectedTailPlan,
} from "./protected-tail.js";
import { runReplay, type ReplayResult, type ReplayWatermarks } from "./replay.js";
import { renderUnitProviderVisible } from "./provider-visible.js";
import { M0_EMPTY_BODY, M1_EMPTY_PLACEHOLDER } from "../contracts/context.js";
import type { P3CommittedInput, P4MemoryInput } from "./projection.js";
import {
  projectSessionMessages,
  type ProjectedSessionMessage,
} from "../runtime/session-projection.js";

/**
 * Iris Host product-path Context pipeline (R2 Feature 9).
 *
 * Composes the reviewed Context capability layers into ONE transform pass the
 * Host's `context` event can call:
 *
 *   projection (P0-P5 logical units)
 *     → pass taxonomy (SOFT+/SOFT/HARD decision against the persisted lineage)
 *     → protected-tail plan (boundary + fences)
 *     → replay state machine (frozen reasoning/tool-reclaim suppression)
 *     → materialization decision (reuse / materialize m1 / rebuild m0+m1)
 *     → m0/m1 carriers (byte-stable provider-visible prefix)
 *
 * The decision is PURE: given (projection, lineage, signals) the same inputs
 * always produce the same output. Persistence (materializeM0/M1, watermarks,
 * emergency state) is applied by the caller via the returned `actions` so the
 * pipeline stays testable without a live store.
 *
 * R2 boundary: this wires the decision + carrier layers into the product
 * path. Historian folding of the m0 head, Compartment LLM production and
 * publication are R3.
 */

export interface ContextPassInput {
  runtimeSessionId: string;
  entries: SessionTreeEntry[];
  lineage: ContextLineage | undefined;
  /** System/persona/declaration identity of the CURRENT pass. */
  source: {
    contextSourceSnapshotId: string;
    personaSnapshotId: string;
    declarationVersion: string;
    providerProfileId: string;
    canonicalSystemPrompt: string;
    systemProjectionHash: string;
  };
  model: { provider: string; modelId: string };
  /** Context usage 0-100 (authority usagePercentage); 0 = unknown. */
  usagePercentage?: number;
  /** Context window limit tokens (authority contextLimit). */
  contextLimit?: number;
  /** Execute threshold percentage (authority executeThresholdPercentage). */
  executeThresholdPercentage?: number;
  /** Per-unit token estimates for the protected-tail suffix walk. */
  unitTokenCounts?: number[];
  /**
   * R2 P3 read-port input (committed Compartments + accepted ContinuitySeed).
   * In R2 these arrive through stable read ports / fixtures; production
   * Historian production is R3. m1's real delta renders these compartments.
   */
  p3Committed?: P3CommittedInput;
  /** R2 P4 read-port input (stable memory pool). m0/m1 baseline data. */
  p4Memory?: P4MemoryInput;
}

export interface ContextPassDecision {
  classification: PassClassification;
  /** Fresh projection of the current session. */
  projection: ProjectedLogicalUnits;
  protectedTail: ProtectedTailPlan;
  replay: ReplayResult;
  /** The materialization action the caller must persist. */
  action:
    | { kind: "reuse" }
    | { kind: "materialize_m1"; m1Body: string; representedThroughEntrySeq: number }
    | {
        kind: "materialize_m0";
        m0Body: string;
        m1Body: string;
        protectedTailStartEntrySeq: number;
        lastSafeUserAnchorEntrySeq: number | null;
        representedThroughEntrySeq: number;
        /** Highest committed compartment sequence folded into this m0 (A2). */
        m0CompartmentWatermark: number;
        /** Current-pass identity recorded into cachedM0* on materialization
         * (the pass that materialized under these is the cache authority;
         * a later pass compares against them — reviewer F1). */
        cachedM0SystemHash: string;
        cachedM0ModelKey: string;
        cachedM0ProviderProfileId: string;
      };
  /**
   * Provider-visible carriers (m0 + m1). Present on EVERY pass: HARD builds
   * fresh carriers, SOFT re-renders m1 over the persisted m0, SOFT+ replays
   * the persisted m0/m1 byte-identically (issue #8: SOFT+/SOFT must never
   * omit the stable prefix because carriers was empty).
   */
  carriers: BuiltCarrier;
  /** Updated replay watermarks (only when detect results were committed). */
  nextWatermarks: ReplayWatermarks | undefined;
  /** Fail-closed escalation, when the pass must not proceed. */
  failClosed: "none" | "defer_blocked" | "transform_unavailable" | "emergency_fail_closed";
  /**
   * LKG capture payload (issue #8 A4): populated on a successful HARD pass.
   * The caller persists it via captureLkgSlot. input = the identity-
   * preserving projection of the raw entries; output = the provider-visible
   * carriers (m0/m1/live tail) wrapped as ProjectedSessionMessage so the
   * captured prefix IS the safe provider-visible wire. modelKey/providerKey
   * follow the authority's `provider/model` slash-form identity.
   */
  lkgCapture?: {
    input: ProjectedSessionMessage[];
    output: ProjectedSessionMessage[];
    modelKey: string;
    providerKey: string;
  };
}

/**
 * Run one Context pass. Pure: no store writes, no Date.now() in the decision
 * path (materialization timestamps are supplied by the caller via `nowMs`).
 */
export function runContextPass(input: ContextPassInput): ContextPassDecision {
  const projection = projectLogicalUnits(input.runtimeSessionId, input.entries);
  const lineage = input.lineage;

  // Replay state machine runs BEFORE taxonomy: whether the wire is allowed
  // to change (wouldAdvanceLive) feeds the pass classification.
  const watermarks: ReplayWatermarks = lineage
    ? {
        clearedReasoningThroughTag: lineage.clearedReasoningThroughTag,
        toolReclaimWatermark: lineage.toolReclaimWatermark,
        mutationReplayWatermark: lineage.mutationReplayWatermark,
      }
    : {
        clearedReasoningThroughTag: 0,
        toolReclaimWatermark: 0,
        mutationReplayWatermark: 0,
      };
  const tokenTarget = deriveTokenTarget(input);
  const protectedTail = resolveProtectedTail(projection, tokenTarget, {
    ...(input.unitTokenCounts === undefined ? {} : { unitTokenCounts: input.unitTokenCounts }),
    ...(input.usagePercentage === undefined ? {} : { usagePercentage: input.usagePercentage }),
    ...(input.contextLimit === undefined ? {} : { contextLimit: input.contextLimit }),
    ...(input.executeThresholdPercentage === undefined
      ? {}
      : { executeThresholdPercentage: input.executeThresholdPercentage }),
  });

  // Pass taxonomy against the persisted lineage. wouldAdvanceLive = the HEAD
  // region (<= headEndEntrySeq — what m0/m1 actually represent) has units
  // beyond the last materialization's represented watermark, OR new committed
  // P3 compartments arrived above the folded watermark. Live-tail growth
  // (protected tail + current invocation delta) is append-only and NEVER
  // counts as a prefix divergence (OpenCode: append-only growth is not a
  // stable-prefix divergence) — it is re-rendered on every pass.
  const representedThrough = lineage?.representedThroughEntrySeq ?? 0;
  const headEnd = protectedTail.headEndEntrySeq;
  const foldWatermark = lineage?.m0CompartmentWatermark ?? 0;
  const headLiveDelta = projection.units.some(
    (unit) => unitEndSeq(unit) <= headEnd && unitEndSeq(unit) > representedThrough,
  );
  const newCompartments = maxCompartments(input.p3Committed) > foldWatermark;
  const liveDelta = headLiveDelta || newCompartments;
  const pass = decidePass(
    lineage,
    {
      // Authority slash-form identity (issue #8 P1.5): `provider/model`, the
      // same bytes used for LKG modelKey and cachedM0ModelKey — a single
      // deterministic byte mapping for model identity across the pipeline.
      modelKey: `${input.model.provider}/${input.model.modelId}`,
      providerProfileId: input.source.providerProfileId,
      systemHash: input.source.systemProjectionHash,
      personaSnapshotId: input.source.personaSnapshotId,
      declarationVersion: input.source.declarationVersion,
    },
    { wouldAdvanceLive: liveDelta },
  );

  // DETECT only on a cache-busting pass (HARD or SOFT — the wire is allowed
  // to change).
  const detect = pass.classification === "HARD" || pass.classification === "SOFT";
  const replay = runReplay(projection, watermarks, {
    detect,
    protectedTailStartEntrySeq: protectedTail.protectedTailStartEntrySeq,
  });

  // Fail-closed: a defer pass (SOFT+) never runs DETECT (detect=false), so
  // nothing can be pending-committed on it — the replay layer already enforces
  // this. LKG invalidation escalation is the R3 wiring concern (Feature 9/10).
  if (pass.classification === "SOFT+") {
    assertReplayClean(replay);
  }

  // Materialization decision.
  const action = classifyAction(
    pass.classification,
    protectedTail,
    projection,
    representedThrough,
    input.p3Committed,
    foldWatermark,
  );

  // Issue #8 A4 — unresolved hard overflow: the first eligible head unit is
  // atomic and alone exceeds the fold budget, so NO legal fold can satisfy
  // the token target. This is the emergency escalation: fail closed before
  // any provider request (never raw fallback, never a blocked placeholder).
  if (protectedTail.oversizeAtomicUnit && action.kind !== "reuse") {
    const emergency: ContextPassDecision = {
      classification: pass.classification,
      projection,
      protectedTail,
      replay,
      action: { kind: "reuse" },
      carriers: replayCarriersFromLineage(lineage),
      nextWatermarks: undefined,
      failClosed: "emergency_fail_closed",
    };
    return emergency;
  }

  if (action.kind === "reuse") {
    // SOFT+: byte-identical replay of the persisted m0/m1 carriers + the
    // append-only live tail. The carriers MUST come from the persisted
    // lineage — never undefined, never empty (issue #8 A2: SOFT+/SOFT must
    // not omit the stable prefix because carriers was empty).
    const replayed = replayCarriersFromLineage(lineage);
    return {
      classification: pass.classification,
      projection,
      protectedTail,
      replay,
      action,
      carriers: replayed,
      nextWatermarks: undefined,
      failClosed: "none",
    };
  }

  // A cache-busting pass commits newly-detected reclaims into the watermark.
  const nextWatermarks =
    replay.newlyReclaimedToolArcUnitIds.length > 0
      ? {
          clearedReasoningThroughTag: watermarks.clearedReasoningThroughTag,
          toolReclaimWatermark: Math.max(
            watermarks.toolReclaimWatermark,
            replay.newlyReclaimedMaxEndSeq,
          ),
          mutationReplayWatermark: watermarks.mutationReplayWatermark,
        }
      : undefined;

  if (action.kind === "materialize_m1") {
    // SOFT: m0 stays byte-identical (replayed from the persisted lineage);
    // m1 re-renders the REAL delta — the head-region units that entered the
    // m0/m1 representation since the last materialization (issue #8 A2: m1
    // must never be a fixed "(delta)" placeholder).
    const m0Body = lineage?.m0Body ?? null;
    const carriers = buildCarriers({
      runtimeSessionId: input.runtimeSessionId,
      materializationId:
        lineage?.materializationId ??
        `mat-${input.source.contextSourceSnapshotId}-${projection.projectionHash}`,
      providerProfileId: lineage?.cachedM0ProviderProfileId ?? input.source.providerProfileId,
      m0Body: m0Body ?? "",
      m1Body: action.m1Body,
      atMs: 0, // deterministic; caller stamps on persistence
    });
    return {
      classification: pass.classification,
      projection,
      protectedTail,
      replay,
      action,
      carriers,
      nextWatermarks,
      failClosed: "none",
    };
  }

  // HARD: rebuild m0 + reset m1. Carriers built from the projected prefix.
  const m0Body = wrapM0(renderM0Head(projection, protectedTail));
  const m1Body = wrapM1(""); // reset; SOFT/HARD deltas accumulate later.
  const carriers = buildCarriers({
    runtimeSessionId: input.runtimeSessionId,
    materializationId: `mat-${input.source.contextSourceSnapshotId}-${projection.projectionHash}`,
    providerProfileId: input.source.providerProfileId,
    m0Body,
    m1Body,
    atMs: 0, // deterministic; caller stamps on persistence
  });
  const foldWatermarkForM0 = maxCompartments(input.p3Committed);
  const providerKey = input.model.provider;
  const modelKey = `${providerKey}/${input.model.modelId}`;
  const projected = projectSessionMessages(input.entries);
  const liveVisible: AgentMessage[] = [];
  for (const unit of projection.units) {
    if (unitEntrySeq(unit) < protectedTail.protectedTailStartEntrySeq) continue;
    const text = renderUnitProviderVisible(unit);
    if (text.length === 0) continue;
    liveVisible.push({
      role: "custom",
      customType: "iris_context_carrier",
      content: text,
      display: false,
      details: { irisContext: { surface: "live", unitId: unit.unitId } },
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  const lkgCapture = {
    input: projected,
    output: [carriers.m0, carriers.m1, ...liveVisible].map((message): ProjectedSessionMessage => ({
      rawIndex: -1,
      entryId: "",
      parentId: null,
      entryType: "message",
      message,
    })),
    modelKey,
    providerKey,
  };
  return {
    classification: pass.classification,
    projection,
    protectedTail,
    replay,
    action: {
      kind: "materialize_m0",
      m0Body,
      m1Body,
      protectedTailStartEntrySeq: protectedTail.protectedTailStartEntrySeq,
      lastSafeUserAnchorEntrySeq: protectedTail.lastSafeUserAnchorEntrySeq,
      // representedThrough = the HEAD end (what m0/m1 actually represent).
      // An identical second pass has no head-region live delta → SOFT+
      // (authority isCacheBustingPass:false semantics — reviewer F2).
      representedThroughEntrySeq: headEnd,
      m0CompartmentWatermark: foldWatermarkForM0,
      cachedM0SystemHash: input.source.systemProjectionHash,
      cachedM0ModelKey: modelKey,
      cachedM0ProviderProfileId: input.source.providerProfileId,
    },
    carriers,
    nextWatermarks,
    failClosed: "none",
    lkgCapture,
  };
}

/** Highest committed compartment sequence in the R2 P3 read-port input. */
function maxCompartments(p3: P3CommittedInput | undefined): number {
  let max = 0;
  for (const compartment of p3?.compartments ?? []) {
    if (compartment.sequence > max) {
      max = compartment.sequence;
    }
  }
  return max;
}

/**
 * Authority m0 wire shape: non-empty bodies are wrapped in the
 * `<session-history>` block (inject-compartments.ts v2); empty → the stable
 * empty body. The wrapped bytes are what the provider sees AND what is
 * persisted — so a SOFT+ replay is byte-identical to the HARD first render.
 */
function wrapM0(body: string): string {
  if (body.length === 0) {
    return M0_EMPTY_BODY;
  }
  return `<session-history>\n${body}\n</session-history>`;
}

/** Authority m1 wire shape: `<session-history-since>` block or the stable
 * empty placeholder. */
function wrapM1(body: string): string {
  if (body.length === 0) {
    return M1_EMPTY_PLACEHOLDER;
  }
  return `<session-history-since>\n${body}\n</session-history-since>`;
}

/**
 * SOFT+ replay: rebuild the exact persisted m0/m1 carriers from the lineage.
 * Byte-identical when the persisted bytes are unchanged (the carrier hash is
 * over the message object, which includes the persisted body bytes). When no
 * lineage exists (defensive) falls back to the stable empty carriers so the
 * provider prefix is never missing. atMs is pinned to 0 exactly like the HARD
 * first render so the full carrier envelope is byte-identical on replay.
 */
function replayCarriersFromLineage(lineage: ContextLineage | undefined): BuiltCarrier {
  if (lineage?.m0Body !== undefined && lineage.m0Body !== null) {
    return buildCarriers({
      runtimeSessionId: lineage.runtimeSessionId,
      materializationId: lineage.materializationId,
      providerProfileId: lineage.cachedM0ProviderProfileId ?? lineage.providerProfileId,
      m0Body: lineage.m0Body,
      m1Body: lineage.m1Body ?? "",
      atMs: 0,
    });
  }
  // Defensive: no persisted m0 yet — the caller should have classified HARD;
  // emit the stable empty prefix rather than omitting carriers entirely.
  return buildCarriers({
    runtimeSessionId: lineage?.runtimeSessionId ?? "",
    materializationId: lineage?.materializationId ?? "mat-none",
    providerProfileId: lineage?.providerProfileId ?? "",
    m0Body: "",
    m1Body: "",
    atMs: 0,
  });
}

function classifyAction(
  classification: PassClassification,
  protectedTail: ProtectedTailPlan,
  projection: ProjectedLogicalUnits,
  representedThrough: number,
  p3Committed: P3CommittedInput | undefined,
  foldWatermark: number,
): ContextPassDecision["action"] {
  switch (classification) {
    case "SOFT+":
      return { kind: "reuse" };
    case "SOFT": {
      // Real m1 delta (issue #8 A2 — never a fixed "(delta)" placeholder):
      // 1. the head-region units that entered the represented range since the
      //    last materialization, rendered as their canonical provider-visible
      //    semantics;
      // 2. new committed P3 compartments above the folded watermark.
      const parts: string[] = [];
      const deltaUnits = projection.units.filter(
        (unit) =>
          unitEndSeq(unit) <= protectedTail.headEndEntrySeq &&
          unitEndSeq(unit) > representedThrough,
      );
      for (const unit of deltaUnits) {
        const text = renderUnitProviderVisible(unit);
        if (text.length > 0) {
          parts.push(text);
        }
      }
      for (const compartment of p3Committed?.compartments ?? []) {
        if (compartment.sequence <= foldWatermark) {
          continue;
        }
        parts.push(`COMPARTMENT ${compartment.sequence}: ${compartment.title}\n${compartment.p1}`);
      }
      const m1Body = parts.join("\n");
      return {
        kind: "materialize_m1",
        m1Body: wrapM1(m1Body),
        representedThroughEntrySeq: protectedTail.headEndEntrySeq,
      };
    }
    case "HARD":
      // The HARD full action (with m0Body + cached identity) is constructed by
      // runContextPass after renderM0Head; this placeholder only satisfies the
      // union type before the branch is replaced. representedThrough uses the
      // head end so an identical pass resolves SOFT+.
      return {
        kind: "materialize_m0",
        m0Body: "",
        m1Body: "",
        protectedTailStartEntrySeq: protectedTail.protectedTailStartEntrySeq,
        lastSafeUserAnchorEntrySeq: protectedTail.lastSafeUserAnchorEntrySeq,
        representedThroughEntrySeq: 0,
        m0CompartmentWatermark: 0,
        cachedM0SystemHash: "",
        cachedM0ModelKey: "",
        cachedM0ProviderProfileId: "",
      };
  }
}

/**
 * Deterministic m0 head rendering (issue #8 A1): the stable prefix is the
 * protected tail's FOLDED head — rendered from the projection units' REAL
 * provider-visible semantics (never structural placeholders like
 * `[input 1-2]`). Historian folding is R3; until then the head renders the
 * projected semantic text of every unit up to headEndEntrySeq.
 */
function renderM0Head(projection: ProjectedLogicalUnits, protectedTail: ProtectedTailPlan): string {
  const headUnits = projection.units.filter(
    (unit) => unitEntrySeq(unit) <= protectedTail.headEndEntrySeq,
  );
  if (headUnits.length === 0) return "";
  const rendered = headUnits
    .map((unit) => renderUnitProviderVisible(unit))
    .filter((text) => text.length > 0)
    .join("\n");
  return rendered;
}

function unitEntrySeq(unit: ProjectedLogicalUnits["units"][number]): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.startEntrySeq;
    default:
      return unit.entrySeq;
  }
}

function unitEndSeq(unit: ProjectedLogicalUnits["units"][number]): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.endEntrySeq;
    default:
      return unit.entrySeq;
  }
}

function deriveTokenTarget(input: ContextPassInput): number {
  // Reuse the authority-locked protected-tail token target (single source of
  // truth for N; includes ABS_CAP/FLOOR/headroom clamps — reviewer F1). The
  // usage percentage defaults to 0 when unknown (authority clampPercentage).
  return deriveProtectedTailTokenTarget({
    contextLimit: input.contextLimit ?? 0,
    executeThresholdPercentage: input.executeThresholdPercentage ?? 0,
    usagePercentage: input.usagePercentage ?? 0,
  }).N;
}

/**
 * Persist a materialization decision to the ContextStore. Throws on missing
 * lineage (fail closed). `nowMs` is supplied by the caller so the pipeline
 * stays deterministic.
 */
export function applyContextPass(
  store: ContextStore,
  runtimeSessionId: string,
  decision: ContextPassDecision,
  nowMs: number,
): void {
  if (decision.failClosed !== "none") {
    store.setEmergencyState(
      runtimeSessionId,
      decision.failClosed === "emergency_fail_closed"
        ? "emergency_fail_closed"
        : "transform_unavailable",
      `context pass blocked: ${decision.failClosed}`,
    );
    return;
  }
  switch (decision.action.kind) {
    case "reuse":
      break;
    case "materialize_m1": {
      const lineage = store.getLineage(runtimeSessionId);
      if (lineage?.m0Body === undefined || lineage.m0Body === null) {
        throw new Error(
          `applyContextPass materialize_m1: no materialized m0 for ${runtimeSessionId}`,
        );
      }
      // Real m1 delta (issue #8 A2): the decision already carries the
      // authority-wrapped delta (never a fixed "(delta)" marker).
      const m1Body = decision.action.m1Body;
      store.materializeM1({
        runtimeSessionId,
        m1Body,
        m1ContentHash: sha256(m1Body),
        // representedThrough = the head end the m0/m1 prefix now covers
        // (issue #8 A2: watermark must match what m0/m1 really represent).
        representedThroughEntrySeq: decision.action.representedThroughEntrySeq,
        atMs: nowMs,
      });
      break;
    }
    case "materialize_m0": {
      const lineage = store.getLineage(runtimeSessionId);
      if (lineage === undefined) {
        throw new Error(`applyContextPass materialize_m0: no lineage for ${runtimeSessionId}`);
      }
      // The decision already carries the authority-wrapped m0/m1 bytes; the
      // persisted bytes MUST equal the provider-visible carrier bytes so a
      // SOFT+ replay is byte-identical (issue #8 A2).
      const m0Body = decision.action.m0Body;
      const m1Body = decision.action.m1Body;
      store.materializeM0({
        runtimeSessionId,
        m0Body,
        m1Body,
        m0ContentHash: sha256(m0Body),
        m1ContentHash: sha256(m1Body),
        atMs: nowMs,
        // F1: record the CURRENT pass identity as the cache authority —
        // the m0 cache was built under these; a later pass compares against
        // them (model/system/provider change → HARD).
        cachedM0SystemHash: decision.action.cachedM0SystemHash,
        cachedM0ModelKey: decision.action.cachedM0ModelKey,
        cachedM0ProviderProfileId: decision.action.cachedM0ProviderProfileId,
        representedThroughEntrySeq: decision.action.representedThroughEntrySeq,
        protectedTailStartEntrySeq: decision.action.protectedTailStartEntrySeq,
        lastSafeUserAnchorEntrySeq: decision.action.lastSafeUserAnchorEntrySeq ?? 0,
        m0CompartmentWatermark: decision.action.m0CompartmentWatermark,
      });
      break;
    }
  }
  if (decision.nextWatermarks !== undefined) {
    // Persist advanced replay watermarks (single-row update; monotonic).
    const lineage = store.getLineage(runtimeSessionId);
    if (lineage !== undefined) {
      const next = decision.nextWatermarks;
      if (
        next.toolReclaimWatermark > lineage.toolReclaimWatermark ||
        next.clearedReasoningThroughTag > lineage.clearedReasoningThroughTag
      ) {
        store.persistWatermarks(runtimeSessionId, next);
      }
    }
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Defensive invariant: a defer pass must never produce pending detect
 * results (detect is off, so this can only trip on a bug). */
function assertReplayClean(replay: ReplayResult): void {
  if (replay.newlyReclaimedToolArcUnitIds.length > 0) {
    throw new Error(
      `context pipeline invariant violated: SOFT+ pass produced pending detect results (${replay.newlyReclaimedToolArcUnitIds.length})`,
    );
  }
}

/** Provider-visible output: carriers + the live tail (issue #8 A1: the live
 * tail is the projected semantic view — real user/assistant/tool content,
 * never `[live <kind> <seq>]` structural markers and never raw transcript
 * copies). */
export function renderProviderVisible(
  decision: ContextPassDecision,
  liveTailFrom: ProjectedLogicalUnits,
): { messages: AgentMessage[] } {
  const messages: AgentMessage[] = [];
  if (decision.carriers !== undefined) {
    messages.push(decision.carriers.m0 as unknown as AgentMessage);
    messages.push(decision.carriers.m1 as unknown as AgentMessage);
  }
  // Live tail: every unit strictly after the protected tail start is emitted
  // as a provider-visible carrier message carrying the unit's REAL rendered
  // semantics (origin-labelled user text, assistant text, tool result,
  // reasoning). Empty text (tool arcs — semantics live in their parts) is
  // skipped so no hollow marker reaches the model.
  for (const unit of liveTailFrom.units) {
    if (unitEntrySeq(unit) < decision.protectedTail.protectedTailStartEntrySeq) continue;
    const text = renderUnitProviderVisible(unit);
    if (text.length === 0) continue;
    messages.push({
      role: "custom",
      customType: "iris_context_carrier",
      content: text,
      display: false,
      details: { irisContext: { surface: "live", unitId: unit.unitId } },
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  return { messages };
}
