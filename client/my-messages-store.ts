/**
 * One snapshot of the "what I said" panel per conversation, read through
 * `useSyncExternalStore`.
 *
 * A snapshot object is only replaced when what the panel draws changes: React re-reads the
 * snapshot after every commit and compares by identity, so a fresh object per read would
 * re-render forever (React error #185).
 *
 * The snapshot holds only what the panel draws — the rows of the visible window and the two
 * counts. Timeline pages are not kept: every refresh reads them again.
 */

export interface MyMessageRow {
  /** Stable per timeline entry: the panel uses it as a list key. */
  key: string;
  at: number;
  /** The timeline sequence of the row, so equal timestamps still order newest first. */
  seq: number;
  /** `HH:MM` on this device's clock. */
  time: string;
  /** The message the way it was sent: this is what a row copies. */
  text: string;
  /** At most three lines, for the row body. */
  preview: string;
  truncated: boolean;
  /** True when the message carries no text of its own (an image-only turn). */
  empty: boolean;
}

export interface MyMessagesSnapshot {
  agentId: string;
  status: "loading" | "ready" | "error";
  /** The local day (`YYYY-MM-DD`) the two counts belong to. */
  day: string;
  /** The first local day the visible window covers, as `YYYY-MM-DD`. */
  coveredFrom: string;
  machineToday: number;
  humanToday: number;
  /** The visible window's messages from the person, newest first. */
  rows: readonly MyMessageRow[];
  /** Whether one more day of history can be read. */
  hasEarlier: boolean;
  /** True when the visible window itself was not fully read: the counts are a lower bound. */
  partial: boolean;
  /** The day an Earlier press is reading, as `YYYY-MM-DD`, while that day is not covered. */
  pendingDay: string | null;
  /** True while an Earlier read is in flight, so the button cannot queue a second one. */
  earlierBusy: boolean;
  /** False while the timeline subscription is down: rows would then stop updating. */
  live: boolean;
  /** True when what is drawn belongs to an earlier day than the one the reader is in. */
  stale: boolean;
  error: string | null;
}

export type MyMessagesFields = Omit<MyMessagesSnapshot, "agentId">;

const listeners = new Set<() => void>();
const snapshots = new Map<string, MyMessagesSnapshot>();

function emptySnapshot(agentId: string): MyMessagesSnapshot {
  return {
    agentId,
    status: "loading",
    day: "",
    coveredFrom: "",
    machineToday: 0,
    humanToday: 0,
    rows: [],
    hasEarlier: false,
    partial: false,
    pendingDay: null,
    earlierBusy: false,
    live: false,
    stale: false,
    error: null,
  };
}

export function subscribeMyMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current snapshot. Identity is stable while nothing the panel draws changed. */
export function myMessagesSnapshot(agentId: string): MyMessagesSnapshot {
  const cached = snapshots.get(agentId);
  if (cached) return cached;
  const created = emptySnapshot(agentId);
  snapshots.set(agentId, created);
  return created;
}

function sameRows(left: readonly MyMessageRow[], right: readonly MyMessageRow[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (a.key !== b.key || a.at !== b.at || a.seq !== b.seq || a.text !== b.text || a.time !== b.time) return false;
  }
  return true;
}

function same(current: MyMessagesSnapshot, next: MyMessagesFields): boolean {
  return current.status === next.status
    && current.day === next.day
    && current.coveredFrom === next.coveredFrom
    && current.machineToday === next.machineToday
    && current.humanToday === next.humanToday
    && current.hasEarlier === next.hasEarlier
    && current.partial === next.partial
    && current.pendingDay === next.pendingDay
    && current.earlierBusy === next.earlierBusy
    && current.live === next.live
    && current.stale === next.stale
    && current.error === next.error
    && sameRows(current.rows, next.rows);
}

/** Publishes a snapshot, notifying only when the panel would draw something else. */
export function publishMyMessages(agentId: string, next: MyMessagesFields): void {
  const current = snapshots.get(agentId);
  if (current && same(current, next)) return;
  snapshots.set(agentId, { agentId, ...next });
  for (const listener of [...listeners]) listener();
}

/**
 * Drops one conversation's snapshot when nothing reads it any more, so a closed panel does
 * not keep the rows it listed in memory.
 */
export function forgetMyMessages(agentId: string): void {
  if (!snapshots.delete(agentId)) return;
  for (const listener of [...listeners]) listener();
}
