import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { stableHash } from "../contracts/historian.js";
import type {
  HistoryGap,
  RuntimeSessionHistoryReadPort,
  SequencedSessionEntry,
  SessionHistoryPage,
} from "../contracts/historian.js";

/**
 * Historian read port implementation (issue #8 Phase B Feature B1).
 *
 * A narrow, cursor-based view over the CURRENT Runtime Session's raw Pi
 * entries. entrySeq = the raw 1-based ordinal (the SAME basis the Context
 * projection uses — `entrySeqById.set(entry.id, index + 1)`), so the
 * Historian's range/cursor invariants align with the Context projection's
 * unit boundaries. ALL raw entry types are surfaced (message, custom_message,
 * model_change, active_tools_change, compaction, branch_summary, label, ...)
 * — never a filtered/compressed index inference (iris_agent#6).
 *
 * The port NEVER reads the Context repository (m0/m1/LKG). It consumes the
 * Session entries through a caller-supplied narrow read closure — the Host
 * wires it to the Pi Session's getEntries(); the Historian itself never
 * holds a Pi Session object.
 */

export interface HistoryReadPortOptions {
  /** Read the CURRENT raw entries of the active Runtime Session. */
  readRawEntries: () => Promise<SessionTreeEntry[]>;
}

/** Decode a raw entry into a hashable byte form (best-effort, stable). */
function entryContent(entry: SessionTreeEntry): unknown {
  // Keep the raw entry payload as-is; the content hash is over the whole
  // entry so ANY change (message content, custom details, timestamp,
  // parentId) invalidates the hash.
  return entry;
}

export class SessionHistoryReadPort implements RuntimeSessionHistoryReadPort {
  private readonly readRawEntries: () => Promise<SessionTreeEntry[]>;

  constructor(options: HistoryReadPortOptions) {
    this.readRawEntries = options.readRawEntries;
  }

  async readEntries(input: {
    runtimeSessionId: string;
    afterEntrySeqExclusive?: number;
    limit: number;
  }): Promise<SessionHistoryPage> {
    const raw = await this.readRawEntries();
    const after = input.afterEntrySeqExclusive ?? 0;
    const limit = Math.max(1, Math.floor(input.limit));

    const all: SequencedSessionEntry[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry = raw[index];
      if (entry === undefined) {
        continue;
      }
      const entrySeq = index + 1; // raw 1-based ordinal (shared basis)
      if (entrySeq <= after) {
        continue;
      }
      all.push({
        runtimeSessionId: input.runtimeSessionId,
        entrySeq,
        entryId: entry.id,
        entry: entryContent(entry),
        contentHash: stableHash(entryContent(entry)),
      });
    }

    const page = all.slice(0, limit);
    const endOfSession = page.length === all.length;
    return {
      entries: page,
      nextCursor: endOfSession ? 0 : (page[page.length - 1]?.entrySeq ?? 0),
      endOfSession,
      gap: null,
    };
  }

  /**
   * Read all remaining entries in bounded pages (B3 finite-batch runner).
   * Each page re-reads from the Session — the caller freezes the boundary
   * FIRST and never widens the range (runner uses the frozen
   * eligibleThroughEntrySeq as its ceiling).
   */
  async readRangeUpTo(input: {
    runtimeSessionId: string;
    afterEntrySeqExclusive: number;
    throughEntrySeqInclusive: number;
    pageSize?: number;
  }): Promise<SequencedSessionEntry[]> {
    const raw = await this.readRawEntries();
    const out: SequencedSessionEntry[] = [];
    for (let index = input.afterEntrySeqExclusive; index < raw.length; index += 1) {
      const entry = raw[index];
      if (entry === undefined) {
        continue;
      }
      const entrySeq = index + 1;
      if (entrySeq > input.throughEntrySeqInclusive) {
        break; // frozen ceiling — the runner NEVER widens the range
      }
      out.push({
        runtimeSessionId: input.runtimeSessionId,
        entrySeq,
        entryId: entry.id,
        entry: entryContent(entry),
        contentHash: stableHash(entryContent(entry)),
      });
    }
    return out;
  }

  /** Detect a durable gap (decode/schema/sequence) — surfaces, never guesses. */
  static detectGap(entries: Array<{ entrySeq: number }>): HistoryGap | null {
    for (let index = 0; index < entries.length - 1; index += 1) {
      const current = entries[index];
      const next = entries[index + 1];
      if (current === undefined || next === undefined) {
        continue;
      }
      if (next.entrySeq !== current.entrySeq + 1) {
        return {
          fromEntrySeq: current.entrySeq + 1,
          toEntrySeq: next.entrySeq - 1,
          kind: "sequence_gap",
          detail: `raw entrySeq jumped from ${current.entrySeq} to ${next.entrySeq}`,
        };
      }
    }
    return null;
  }
}
