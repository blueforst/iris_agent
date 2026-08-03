import { createHash } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { HistoryProjectionUnit } from "../context/projection.js";

/**
 * R3 Historian contracts (Notion 02 Historian + 02 Runtime Sessions &
 * History Archive — issue #8 Phase B).
 *
 * The Historian is the ONLY persistent semantic processor of the Pi Session
 * transcript. It reads Session entries exclusively through the narrow
 * RuntimeSessionHistoryReadPort (never the Context repository, never
 * m0/m1/LKG), consumes the SAME HistoryProjectionUnit the Context pipeline
 * uses (one projection basis for the whole path — the Historian never
 * re-derives a different input/tool-arc boundary), and persists its own
 * immutable compartments/segments/evidence + publications in historian.db.
 */

/** Cursor-based read result of the Session history port. */
export interface SessionHistoryPage {
  /** Entries in ascending raw entrySeq order, strictly after the cursor. */
  entries: SequencedSessionEntry[];
  /**
   * Exclusive next cursor = the entrySeq AFTER the last returned entry.
   * `null` when the caller requested `limit` entries but the Session has
   * more (page again with this cursor); `0` when the page is at the end
   * (or the Session is empty). The cursor is forward-only and exclusive.
   */
  nextCursor: number | null;
  /** True when the returned page reaches the current end of the Session. */
  endOfSession: boolean;
  /**
   * A durable gap in the raw sequence (decode error / schema error /
   * missing sequence) — the port surfaces it instead of guessing content.
   */
  gap: HistoryGap | null;
}

/** Why a raw sequence cannot be read contiguously. */
export interface HistoryGap {
  /** entrySeq where the gap begins (inclusive). */
  fromEntrySeq: number;
  /** entrySeq where the gap ends (inclusive) — the last unreadable entry. */
  toEntrySeq: number;
  kind: "decode_error" | "schema_error" | "sequence_gap";
  detail: string;
}

/**
 * Narrow read port (Notion 02 Runtime Sessions): a single-page, cursor-based
 * view over the CURRENT Runtime Session's raw Pi entries. The port is
 * identity-preserving: every returned entry carries its raw entryId, its
 * session-local entrySeq and a content hash, so downstream consumers can
 * prove they processed exactly the bytes the Session actually wrote.
 */
export interface RuntimeSessionHistoryReadPort {
  /**
   * Read one finite page of raw entries strictly after `afterEntrySeqExclusive`
   * (default 0 = from the beginning), at most `limit` entries.
   * The port MUST NOT read the Context repository, m0/m1, or LKG.
   */
  readEntries(input: {
    runtimeSessionId: string;
    afterEntrySeqExclusive?: number;
    limit: number;
  }): Promise<SessionHistoryPage>;
}

/** One raw Session entry with its durable identity (entrySeq + hash). */
export interface SequencedSessionEntry {
  runtimeSessionId: string;
  /** Session-local raw ordinal (1-based, matches the Context projection). */
  entrySeq: number;
  /** The raw Pi entry id (authoritative; never derived from position). */
  entryId: string;
  /** The raw entry payload (identity-preserving; may be a non-message type). */
  entry: unknown;
  /** Deterministic content hash of `entry`. */
  contentHash: string;
}

/** Compact reference to a raw Session entry (Historian processing unit). */
export interface HistorianEntryRef {
  runtimeSessionId: string;
  entryId: string;
  entrySeq: number;
  contentHash: string;
}

/** Inclusive entrySeq range with a source range hash (endpoint-invariant). */
export interface HistorianRangeRef {
  runtimeSessionId: string;
  startEntrySeq: number;
  endEntrySeq: number;
  /** sha256 over (runtimeSessionId, startEntrySeq, endEntrySeq, entries). */
  sourceRangeHash: string;
}

/** Session processing state (the Historian's durable cursor + status). */
export interface HistorianSessionState {
  runtimeSessionId: string;
  /** Highest entrySeq successfully committed by the Historian (exclusive
   * cursor: the next eligible range starts at +1). Never advances on a
   * failed transaction. */
  processedThroughEntrySeq: number;
  status: "active" | "closing" | "closed" | "closed_incomplete" | "corrupt";
  /** Set when a boundary freeze captured the session head (B3). */
  observedHeadEntrySeq?: number;
  updatedAt: string;
}

/**
 * Frozen boundary snapshot (Notion 02 Historian): captured by the cheap
 * trigger and consumed by the runner. The trigger and the runner MUST use
 * the SAME snapshot — the runner never widens the range.
 */
export interface HistorianBoundarySnapshot {
  boundarySnapshotId: string;
  runtimeSessionId: string;
  /** Session head observed at freeze time (inclusive entrySeq). */
  observedHeadEntrySeq: number;
  /**
   * Last entrySeq eligible for semantic processing at freeze time
   * (inclusive). The protected tail (dynamic) is EXCLUDED: entrySeq >
   * eligibleThroughEntrySeq belongs to the tail and is never cut by a
   * compartment boundary.
   */
  eligibleThroughEntrySeq: number;
  /**
   * First entrySeq of the protected tail at freeze time (inclusive).
   * Compartments never cross this seam; the tail is always preserved raw.
   */
  protectedTailStartEntrySeq: number;
  /** True raw eligible tokens at freeze time (semantic estimate). */
  trueRawEligibleTokens: number;
  /** Eligible tokens the Narrator may actually narrate (budgeted). */
  narratableEligibleTokens: number;
  /** sha256 over the entire eligible range (endpoints + content). */
  sourceRangeHash: string;
  /** Model/provider profile that produced the projection at freeze time. */
  modelProviderProfile: string;
  /** Frozen at (ISO). */
  frozenAt: string;
}

/**
 * The shared semantic projection unit both Context and Historian consume
 * (issue #8: Context and Historian MUST NOT derive different projection
 * units — one basis for input/tool-arc boundaries).
 */
export type { HistoryProjectionUnit };

/** Projection-unit token/length estimate for budget accounting. */
export interface ProjectionUnitEstimate {
  unit: HistoryProjectionUnit;
  /** Deterministic token estimate (chars/4 unless a real counter is wired). */
  estimatedTokens: number;
}

/** Convenience: the shared projection unit's provider-visible text (B4). */
export function projectionUnitProviderText(unit: HistoryProjectionUnit): string {
  return unit.providerVisible;
}

/** Serialize a projection unit for hashing/evidence (stable byte form). */
export function serializeProjectionUnit(unit: HistoryProjectionUnit): string {
  return JSON.stringify(unit);
}

/** Content hash of a raw entry (sha256 over the stable serialization). */
export function entryContentHash(entry: unknown): string {
  return stableHash(entry);
}

/** Stable, order-insensitive-safe JSON hashing (deterministic byte form). */
export function stableHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Marker: a projection unit whose semantics have been narrated/compacted. */
export interface NarratedProjectionUnit {
  unit: HistoryProjectionUnit;
  narrationText: string;
  narrationHash: string;
}

export type { AgentMessage };
