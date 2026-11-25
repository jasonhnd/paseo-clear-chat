import { useCallback, useSyncExternalStore } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { classifyUserMessage, messagePreview } from "./user-message-kind";
import { formatClock, localDayStartBefore } from "./local-day";
import {
  myMessagesSnapshot,
  publishMyMessages,
  subscribeMyMessages,
  type MyMessageRow,
  type MyMessagesFields,
  type MyMessagesSnapshot,
} from "./my-messages-store";

/**
 * The "what I said" panel's data: how many rows automation sent and how many the person
 * sent today, and the person's own messages, newest first.
 *
 * The panel covers the reader's local day and can be asked for one earlier day at a time.
 * Reading walks the same projected timeline pages the answer card reads, newest first, and
 * stops once the oldest day in view is fully covered — a page boundary never has to line up
 * with midnight, so it reads one page past the boundary and keeps what it found.
 *
 * A message that automation wrote is recognized by `classifyUserMessage`; nothing else is
 * counted as the person's. A message inserted mid-turn is unwrapped and counted as theirs.
 */

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];
type Unsubscribe = ReturnType<AgentHandle["timeline"]["subscribe"]>;

const READ_RETRY_DELAYS_MS = [10, 20, 40];
const RESUBSCRIBE_DELAYS_MS = [10, 20, 40];
/** A day with thousands of rows would otherwise read for a long time on one panel open. */
const MAX_PAGES_PER_READ = 40;

export interface MyMessagesFeed {
  /** Settles after the first read, whether it succeeded or published an error. */
  ready: Promise<void>;
  stop(): void;
  /** Extends the list by one earlier local day. A no-op when nothing older is left. */
  loadEarlier(): Promise<void>;
}

function warnPanel(message: string, error: unknown): void {
  console.warn(`Clear Chat my-messages panel ${message}`, error);
}

function entryAt(entry: TimelineEntry): number {
  return Date.parse(entry.timestamp);
}

function earliestEntry(entries: readonly TimelineEntry[]): number | null {
  let earliest: number | null = null;
  for (const entry of entries) {
    const at = entryAt(entry);
    if (!Number.isFinite(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/** One read of the timeline, oldest page first, plus whether pages were left unread. */
export interface MyMessagesWindow {
  entries: readonly TimelineEntry[];
  unreadOlder: boolean;
}

/** Reads newest-first pages until the local day starting at `targetStart` is covered. */
export async function readMyMessagesWindow(handle: AgentHandle, targetStart: number): Promise<MyMessagesWindow> {
  let page = await handle.timeline.refetch({ direction: "tail", projection: "projected" });
  const collected: TimelineEntry[] = [];
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
    collected.unshift(...page.entries);
    pages += 1;
    const earliest = earliestEntry(collected);
    const covered = earliest !== null && earliest <= targetStart;
    if (covered || !page.hasOlder || !page.startCursor || pages >= MAX_PAGES_PER_READ) break;
    const key = `${page.startCursor.epoch}:${page.startCursor.seq}`;
    if (seen.has(key)) break;
    seen.add(key);
    page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected" });
  }
  return { entries: collected, unreadOlder: page.hasOlder === true };
}

/** Everything the panel draws, from one read. Exported so a test can pin the day boundary. */
export function buildMyMessagesFields(
  window: MyMessagesWindow,
  loadedDays: number,
  now: number,
): MyMessagesFields {
  const todayStart = localDayStartBefore(now, 0);
  const tomorrowStart = localDayStartBefore(now, -1);
  const windowStart = localDayStartBefore(now, loadedDays - 1);
  let machineToday = 0;
  let humanToday = 0;
  let coveredFrom: number | null = null;
  const rows: MyMessageRow[] = [];
  for (const entry of window.entries) {
    const item = entry.item;
    if (item.type !== "user_message") continue;
    const at = entryAt(entry);
    if (!Number.isFinite(at)) continue;
    if (coveredFrom === null || at < coveredFrom) coveredFrom = at;
    const classified = classifyUserMessage(item.text);
    if (at >= todayStart && at < tomorrowStart) {
      if (classified.kind === "machine") machineToday += 1;
      else humanToday += 1;
    }
    if (classified.kind === "human" && at >= windowStart && at < tomorrowStart) {
      const { preview, truncated } = messagePreview(classified.text);
      rows.push({
        key: `${at}:${entry.seqStart}`,
        at,
        time: formatClock(at),
        text: classified.text,
        preview,
        truncated,
        empty: classified.text.length === 0,
      });
    }
  }
  rows.sort((left, right) => right.at - left.at);
  return {
    status: "ready",
    loadedDays,
    machineToday,
    humanToday,
    rows,
    // More to read when a page was left over, or when the oldest row in hand sits before
    // the oldest day this list covers.
    hasEarlier: window.unreadOlder || (coveredFrom !== null && coveredFrom < windowStart),
    error: null,
  };
}

export interface StartMyMessagesFeedInput {
  agentId: string;
  client?: PaseoApi;
  /** Injected clock: the panel reads it again on every row build. */
  now?: () => number;
}

export function startMyMessagesFeed(input: StartMyMessagesFeedInput): MyMessagesFeed {
  const now = input.now ?? (() => Date.now());
  const api = input.client ?? getPaseoClient("");
  const handle = api.agents.ref(input.agentId);
  let stopped = false;
  let accepting = false;
  let loadedDays = 1;
  let chain: Promise<void> = Promise.resolve();
  let current: Unsubscribe | null = null;
  let resubscribeAttempt = 0;
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  const queued: PaseoAgentTimelineEvent[] = [];

  const sync = async (): Promise<void> => {
    const targetStart = localDayStartBefore(now(), loadedDays - 1);
    const window = await readMyMessagesWindow(handle, targetStart);
    if (stopped) return;
    // A failed read leaves the last snapshot in place with an error on it, so a panel that
    // worked a moment ago does not empty itself because one read was refused.
    publishMyMessages(input.agentId, buildMyMessagesFields(window, loadedDays, now()));
  };

  const syncWithRetry = async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return;
      try {
        await sync();
        return;
      } catch (error) {
        warnPanel("could not read the timeline", error);
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || stopped) {
          if (!stopped) {
            const currentSnapshot = myMessagesSnapshot(input.agentId);
            publishMyMessages(input.agentId, {
              status: "error",
              loadedDays,
              machineToday: currentSnapshot.machineToday,
              humanToday: currentSnapshot.humanToday,
              rows: currentSnapshot.rows,
              hasEarlier: currentSnapshot.hasEarlier,
              error: error instanceof Error ? error.message : "Timeline unavailable",
            });
          }
          return;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };

  const enqueue = (): Promise<void> => {
    chain = chain.then(() => (stopped ? undefined : syncWithRetry())).catch(error => {
      warnPanel("could not read the timeline", error);
    });
    return chain;
  };

  const scheduleResubscribe = (): void => {
    if (stopped || resubscribeAttempt >= RESUBSCRIBE_DELAYS_MS.length) {
      if (!stopped) warnPanel("stopped retrying the timeline subscription", "retry limit");
      return;
    }
    const delay = RESUBSCRIBE_DELAYS_MS[resubscribeAttempt] ?? 40;
    resubscribeAttempt += 1;
    if (resubscribeTimer) clearTimeout(resubscribeTimer);
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null;
      if (stopped) return;
      const next = handle.timeline.subscribe(onMessage);
      current = next;
      void next.ready.then(() => {
        resubscribeAttempt = 0;
        if (!stopped) enqueue();
      }).catch(error => {
        warnPanel("could not resubscribe to the timeline", error);
        scheduleResubscribe();
      });
    }, delay);
  };

  const onMessage = (message: PaseoAgentTimelineEvent): void => {
    if (stopped || message.agentId !== input.agentId) return;
    if (!accepting) {
      queued.push(message);
      return;
    }
    const event = message.event;
    if (event.type === "timeline") {
      // Only a user-side row can change a count or a row. The model's own words cannot.
      if (event.item.type === "user_message") enqueue();
      return;
    }
    if (event.type === "replacement" || event.type === "subscription_restored") {
      enqueue();
      return;
    }
    if (event.type === "error") {
      warnPanel("lost the timeline subscription", event.error);
      scheduleResubscribe();
    }
  };

  const subscription = handle.timeline.subscribe(onMessage);
  current = subscription;
  const ready = (async () => {
    try {
      await subscription.ready;
    } catch (error) {
      warnPanel("could not subscribe to the timeline", error);
      if (!stopped) scheduleResubscribe();
    }
    if (stopped) return;
    await enqueue();
    if (stopped) return;
    accepting = true;
    for (const message of queued.splice(0)) onMessage(message);
    await chain;
  })();

  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (resubscribeTimer) clearTimeout(resubscribeTimer);
      resubscribeTimer = null;
      current?.();
      current = null;
    },
    async loadEarlier(): Promise<void> {
      if (stopped) return;
      const known = myMessagesSnapshot(input.agentId);
      if (known.status === "ready" && !known.hasEarlier) return;
      loadedDays += 1;
      await enqueue();
    },
  };
}

/** The panel's snapshot for one conversation; identity is stable between changes. */
export function useMyMessages(agentId: string): MyMessagesSnapshot {
  const read = useCallback(() => myMessagesSnapshot(agentId), [agentId]);
  return useSyncExternalStore(subscribeMyMessages, read, read);
}
