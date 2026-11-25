import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { classifyUserMessage, isEmptyMessageText, messagePreview } from "./user-message-kind";
import { formatClock, localDayStartBefore } from "./local-day";
import { cancelTimer, nowMs, scheduleTimer, type FeedTimers } from "./my-messages-clock";
import {
  forgetMyMessages,
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
 * keeps the cursor of the page it stopped on: a day with more pages than one read may spend
 * still becomes reachable, one press at a time, instead of restarting at the tail forever.
 * A read that stops before the oldest day in view is covered is reported as `partial`, never
 * as a finished day, so the counts do not claim to be complete when they are not.
 *
 * "Today" is the reader's calendar day on this device. The panel re-reads at the next local
 * midnight and when the app comes back to the foreground, because a panel left open
 * overnight would otherwise keep yesterday's counts. One read takes one clock value, and
 * the rows it publishes are built from that same value.
 */

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];
type TimelineCursor = NonNullable<TimelinePage["startCursor"]>;
type Unsubscribe = ReturnType<AgentHandle["timeline"]["subscribe"]>;

const READ_RETRY_DELAYS_MS = [10, 20, 40];
/** Pages one read may spend. A press of Earlier spends the same budget again. */
const MAX_PAGES_PER_READ = 40;
/** Backoff for a timeline subscription that keeps failing: capped, never abandoned. */
const SUBSCRIBE_BASE_MS = 10;
const SUBSCRIBE_MAX_MS = 30_000;

export interface MyMessagesFeed {
  /** Settles after the first read, whether it succeeded or published an error. */
  ready: Promise<void>;
  stop(): void;
  /** Finishes a day that was read partially, or extends the list by one earlier local day. */
  loadEarlier(): Promise<void>;
  /** Drops a dead subscription and tries it again now, then re-reads. */
  retry(): void;
}

/** What one conversation's read holds, and where it continues. */
export interface MyMessagesReadState {
  entries: Map<string, TimelineEntry>;
  /** The page to continue from, or null when nothing older exists. */
  cursor: TimelineCursor | null;
  /** The oldest instant held. */
  oldest: number;
  /** True once the beginning of the conversation was read. */
  reachedStart: boolean;
}

function warnPanel(message: string, error: unknown): void {
  console.warn(`Clear Chat my-messages panel ${message}`, error);
}

function entryAt(entry: TimelineEntry): number {
  return Date.parse(entry.timestamp);
}

function entryKey(entry: TimelineEntry): string {
  return `${entryAt(entry)}:${entry.seqStart}`;
}

function emptyReadState(): MyMessagesReadState {
  return { entries: new Map(), cursor: null, oldest: Number.POSITIVE_INFINITY, reachedStart: false };
}

function absorbPage(state: MyMessagesReadState, page: TimelinePage): void {
  if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
  for (const entry of page.entries) {
    state.entries.set(entryKey(entry), entry);
    const at = entryAt(entry);
    if (Number.isFinite(at) && at < state.oldest) state.oldest = at;
  }
}

/** True when every entry at or after `targetStart` is in hand. */
function covers(state: MyMessagesReadState, targetStart: number): boolean {
  return state.reachedStart || state.oldest <= targetStart;
}

/** Walks older pages from `state.cursor` until `targetStart` is covered or the budget runs out. */
async function readOlderPages(
  handle: AgentHandle,
  state: MyMessagesReadState,
  targetStart: number,
  stopped: () => boolean,
  budgetPages: number,
): Promise<void> {
  let pages = 0;
  while (!covers(state, targetStart) && state.cursor && pages < budgetPages) {
    if (stopped()) return;
    const page = await handle.timeline.refetch({ direction: "before", cursor: state.cursor, projection: "projected" });
    // A closed panel must not keep walking the timeline.
    if (stopped()) return;
    pages += 1;
    absorbPage(state, page);
    if (!page.hasOlder || !page.startCursor) {
      state.cursor = null;
      state.reachedStart = true;
      return;
    }
    state.cursor = page.startCursor;
  }
}

/** Reads the newest page, then older pages until `targetStart` is covered or the budget runs out. */
export async function openMyMessagesWindow(
  handle: AgentHandle,
  targetStart: number,
  stopped: () => boolean,
  budgetPages: number = MAX_PAGES_PER_READ,
): Promise<MyMessagesReadState> {
  const state = emptyReadState();
  if (stopped()) return state;
  const first = await handle.timeline.refetch({ direction: "tail", projection: "projected" });
  if (stopped()) return state;
  absorbPage(state, first);
  if (!first.hasOlder || !first.startCursor) {
    state.reachedStart = true;
    return state;
  }
  state.cursor = first.startCursor;
  await readOlderPages(handle, state, targetStart, stopped, Math.max(0, budgetPages - 1));
  return state;
}

/** Merges the newest pages into a window already in hand, stopping where it meets what it holds. */
async function refreshNewest(
  handle: AgentHandle,
  state: MyMessagesReadState,
  stopped: () => boolean,
  budgetPages: number,
): Promise<void> {
  let page = await handle.timeline.refetch({ direction: "tail", projection: "projected" });
  let pages = 0;
  for (;;) {
    if (stopped()) return;
    pages += 1;
    if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
    const known = page.entries.filter(entry => state.entries.has(entryKey(entry))).length;
    absorbPage(state, page);
    // Nothing new on this page: the rest of the window is already in hand.
    if (known === page.entries.length) return;
    if (!page.hasOlder || !page.startCursor || pages >= budgetPages) return;
    page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected" });
  }
}

/** Everything the panel draws, from one read and one clock value. */
export function buildMyMessagesFields(input: {
  state: MyMessagesReadState;
  loadedDays: number;
  at: number;
  live: boolean;
}): MyMessagesFields {
  const { state, loadedDays, at } = input;
  const todayStart = localDayStartBefore(at, 0);
  const tomorrowStart = localDayStartBefore(at, -1);
  const windowStart = localDayStartBefore(at, loadedDays - 1);
  let machineToday = 0;
  let humanToday = 0;
  /** The oldest of the person's rows in hand, whether or not it is inside the visible window. */
  let oldestHuman = Number.POSITIVE_INFINITY;
  const rows: MyMessageRow[] = [];
  for (const entry of state.entries.values()) {
    const item = entry.item;
    if (item.type !== "user_message") continue;
    const rowAt = entryAt(entry);
    if (!Number.isFinite(rowAt)) continue;
    const classified = classifyUserMessage(item.text);
    if (rowAt >= todayStart && rowAt < tomorrowStart) {
      if (classified.kind === "machine") machineToday += 1;
      else humanToday += 1;
    }
    if (classified.kind === "human" && rowAt < oldestHuman) oldestHuman = rowAt;
    if (classified.kind === "human" && rowAt >= windowStart && rowAt < tomorrowStart) {
      const { preview, truncated } = messagePreview(classified.text);
      rows.push({
        key: entryKey(entry),
        at: rowAt,
        seq: entry.seqStart,
        time: formatClock(rowAt),
        text: classified.text,
        preview,
        truncated,
        empty: isEmptyMessageText(classified.text),
      });
    }
  }
  // Newest first; the timeline sequence breaks a tie, so two rows in the same millisecond
  // keep an order that matches the conversation.
  rows.sort((left, right) => right.at - left.at || right.seq - left.seq);
  const partial = !covers(state, windowStart);
  // Another day is reachable when the read is unfinished, when older pages are left, or when
  // rows older than the visible window are already in hand.
  const hasEarlier = partial || state.cursor !== null || oldestHuman < windowStart;
  return {
    status: "ready",
    loadedDays,
    machineToday,
    humanToday,
    rows,
    hasEarlier,
    partial,
    live: input.live,
    error: null,
  };
}

export interface StartMyMessagesFeedInput {
  agentId: string;
  client?: PaseoApi;
  /** Injected clock. The panel takes its clock from `my-messages-clock`. */
  now?: () => number;
  /** Injected timers. The panel takes its timers from `my-messages-clock`. */
  timers?: FeedTimers;
}

export function startMyMessagesFeed(input: StartMyMessagesFeedInput): MyMessagesFeed {
  const now = input.now ?? nowMs;
  const timers: FeedTimers = input.timers ?? {
    set: (callback, ms) => scheduleTimer(callback, ms),
    clear: handle => cancelTimer(handle),
  };
  const api = input.client ?? getPaseoClient("");
  const handle = api.agents.ref(input.agentId);
  let stopped = false;
  let days = 1;
  let readState: MyMessagesReadState | null = null;
  let live = false;
  let accepting = false;
  let subscription: Unsubscribe | null = null;
  let midnightTimer: unknown = null;
  let retryTimer: unknown = null;
  let retryAttempt = 0;
  let running: Promise<void> | null = null;
  let rerun = false;
  const queuedEvents: PaseoAgentTimelineEvent[] = [];

  /** The clock value of the read whose rows are on screen, so a flag change keeps its day. */
  let lastReadAt: number | null = null;

  const publish = (at: number): void => {
    if (stopped || !readState) return;
    lastReadAt = at;
    publishMyMessages(input.agentId, buildMyMessagesFields({ state: readState, loadedDays: days, at, live }));
    scheduleMidnight(at);
  };

  /** Republishing to change a flag only replays the last read; it never takes a new clock value. */
  const publishLatest = (): void => {
    if (lastReadAt === null) return;
    publish(lastReadAt);
  };

  const publishError = (error: unknown): void => {
    if (stopped) return;
    const known = myMessagesSnapshot(input.agentId);
    publishMyMessages(input.agentId, {
      status: "error",
      loadedDays: days,
      machineToday: known.machineToday,
      humanToday: known.humanToday,
      rows: known.rows,
      hasEarlier: known.hasEarlier,
      partial: known.partial,
      live,
      error: error instanceof Error ? error.message : "Timeline unavailable",
    });
  };

  const syncOnce = async (): Promise<void> => {
    // One clock value per read: the day window and the rows built from it agree.
    const at = now();
    const targetStart = localDayStartBefore(at, days - 1);
    if (!readState) {
      readState = await openMyMessagesWindow(handle, targetStart, () => stopped);
    } else {
      await refreshNewest(handle, readState, () => stopped, MAX_PAGES_PER_READ);
    }
    if (stopped) return;
    publish(at);
  };

  const sleep = (ms: number) => new Promise<void>(resolve => { timers.set(() => resolve(), ms); });

  /** One read with retries. False when it did not land; the error is already published. */
  const readWithRetry = async (): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return false;
      try {
        await syncOnce();
        return true;
      } catch (error) {
        warnPanel("could not read the timeline", error);
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || stopped) {
          if (!stopped) publishError(error);
          return false;
        }
        await sleep(delay);
      }
    }
  };

  /** Reads older pages toward `targetStart` with the same retry rule. */
  const extendWithRetry = async (targetStart: number): Promise<boolean> => {
    if (!readState) return false;
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return false;
      try {
        await readOlderPages(handle, readState, targetStart, () => stopped, MAX_PAGES_PER_READ);
        return true;
      } catch (error) {
        warnPanel("could not read older messages", error);
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || stopped) {
          if (!stopped) publishError(error);
          return false;
        }
        await sleep(delay);
      }
    }
  };

  /**
   * One refresh at a time. Overlapping triggers — a new message, a restored subscription,
   * midnight, the foreground — share the run in progress and ask for one more when it ends.
   */
  const requestRefresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          if (stopped) return;
          await readWithRetry();
        } while (rerun && !stopped);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  /**
   * A subscription that keeps failing is retried with a growing, capped delay for as long as
   * the panel lives: silence would leave a list that looks live and never updates.
   */
  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== null) return;
    const delay = Math.min(SUBSCRIBE_MAX_MS, SUBSCRIBE_BASE_MS * 2 ** Math.min(retryAttempt, 12));
    retryAttempt += 1;
    retryTimer = timers.set(() => {
      retryTimer = null;
      if (stopped) return;
      connect();
    }, delay);
  };

  const markLiveDown = (error: unknown): void => {
    warnPanel("live updates are unavailable", error);
    const wasLive = live;
    live = false;
    // The panel is told even when the rows cannot be re-read: a list that stops updating
    // without saying so is worse than one that says it is stale.
    if (wasLive) publishLatest();
    scheduleRetry();
  };

  const handleEvent = (event: PaseoAgentTimelineEvent["event"]): void => {
    if (event.type === "timeline") {
      // Only a user-side row can change a count or a row. The model's own words cannot.
      if (event.item.type === "user_message") void requestRefresh();
      return;
    }
    if (event.type === "replacement") {
      readState = null;
      void requestRefresh();
      return;
    }
    if (event.type === "subscription_restored") {
      void requestRefresh();
      return;
    }
    if (event.type === "error") markLiveDown(event.error);
  };

  const onMessage = (message: PaseoAgentTimelineEvent): void => {
    if (stopped || message.agentId !== input.agentId) return;
    if (!accepting) {
      queuedEvents.push(message);
      return;
    }
    handleEvent(message.event);
  };

  function connect(): void {
    if (stopped) return;
    let next: Unsubscribe;
    try {
      next = handle.timeline.subscribe(onMessage);
    } catch (error) {
      markLiveDown(error);
      return;
    }
    subscription = next;
    void next.ready.then(() => {
      if (stopped) return;
      retryAttempt = 0;
      const cameBack = !live;
      live = true;
      if (cameBack) publishLatest();
      for (const message of queuedEvents.splice(0)) onMessage(message);
      // A subscription that comes back may have missed events: re-read. The first connection
      // needs no extra read, because the first read is already on its way.
      if (cameBack && lastReadAt !== null) void requestRefresh();
    }).catch(error => {
      if (stopped) return;
      markLiveDown(error);
    });
  }

  /**
   * Wakes at the next local midnight. A panel left open overnight would otherwise keep
   * yesterday's counts and yesterday's rows until something else re-read the timeline.
   */
  function scheduleMidnight(at: number): void {
    if (stopped) return;
    if (midnightTimer !== null) timers.clear(midnightTimer);
    const nextMidnight = localDayStartBefore(at, -1);
    const delay = Math.max(50, nextMidnight - at + 50);
    midnightTimer = timers.set(() => {
      midnightTimer = null;
      if (stopped) return;
      void requestRefresh();
    }, delay);
  }

  const appStateHost = AppState as unknown as {
    addEventListener?: (type: "change", handler: (state: string) => void) => { remove?: () => void };
  } | undefined;
  const appStateHandle = appStateHost?.addEventListener?.("change", state => {
    // Returning to the foreground can cross midnight; re-read rather than trust the rows.
    if (state === "active" && !stopped) void requestRefresh();
  });

  connect();
  const ready = (async () => {
    await requestRefresh();
    if (stopped) return;
    accepting = true;
    for (const message of queuedEvents.splice(0)) onMessage(message);
  })();

  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      accepting = false;
      if (midnightTimer !== null) timers.clear(midnightTimer);
      midnightTimer = null;
      if (retryTimer !== null) timers.clear(retryTimer);
      retryTimer = null;
      appStateHandle?.remove?.();
      const held = subscription;
      subscription = null;
      try { held?.(); } catch { /* A host that already dropped it must not block teardown. */ }
    },
    async loadEarlier(): Promise<void> {
      if (stopped) return;
      if (!readState) {
        await requestRefresh();
        return;
      }
      const at = now();
      const windowStart = localDayStartBefore(at, days - 1);
      // A day that was read only partially is finished before the list moves on to the next
      // one, so the visible window never skips a gap.
      if (!covers(readState, windowStart)) {
        if (await extendWithRetry(windowStart)) publish(at);
        return;
      }
      const nextDays = days + 1;
      const nextWindowStart = localDayStartBefore(at, nextDays - 1);
      // The day count only advances once the older day is in hand; a failed read leaves the
      // visible window where it was. Rows already read past the window need no new page.
      if (readState.cursor !== null && !(await extendWithRetry(nextWindowStart))) return;
      days = nextDays;
      publish(at);
    },
    retry(): void {
      if (stopped) return;
      retryAttempt = 0;
      if (retryTimer !== null) timers.clear(retryTimer);
      retryTimer = null;
      const held = subscription;
      subscription = null;
      try { held?.(); } catch { /* A dead subscription may already be released. */ }
      connect();
      void requestRefresh();
    },
  };
}

interface SharedFeed {
  feed: MyMessagesFeed;
  refs: number;
}

const sharedFeeds = new Map<string, SharedFeed>();

/**
 * The panel's entry point: one feed per conversation, however many surfaces show it.
 *
 * Two mounts of the same panel (a reopened tab, a second pane) share one read and one
 * subscription. The snapshot survives until the last one closes and is then forgotten, so a
 * closed conversation does not keep every message it ever listed in memory.
 */
export function acquireMyMessagesFeed(input: StartMyMessagesFeedInput): MyMessagesFeed {
  const key = input.agentId;
  let entry = sharedFeeds.get(key);
  if (!entry) {
    entry = { feed: startMyMessagesFeed(input), refs: 0 };
    sharedFeeds.set(key, entry);
  }
  entry.refs += 1;
  const held = entry;
  return {
    ready: held.feed.ready,
    loadEarlier: () => held.feed.loadEarlier(),
    retry: () => held.feed.retry(),
    stop(): void {
      const current = sharedFeeds.get(key);
      if (!current || current !== held) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      sharedFeeds.delete(key);
      current.feed.stop();
      forgetMyMessages(key);
    },
  };
}

/** The panel's snapshot for one conversation; identity is stable between changes. */
export function useMyMessages(agentId: string): MyMessagesSnapshot {
  const read = useCallback(() => myMessagesSnapshot(agentId), [agentId]);
  return useSyncExternalStore(subscribeMyMessages, read, read);
}
