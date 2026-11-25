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
 * There is no cross-refresh cache. Every refresh — the first read, a new message, a restored
 * subscription, midnight, the foreground, a retry — reads the newest page and walks older
 * pages until it holds a timestamp strictly older than the first instant of the visible
 * window, or reaches the beginning of the conversation. What it read becomes the snapshot and
 * replaces what was there, so a page boundary, a replaced subscription or a rebuilt timeline
 * cannot leave a stale or half-merged state behind. A read that runs out of its page budget
 * says so and never claims a finished day.
 *
 * "Today" is the reader's calendar day on this device. One read takes one clock value; if the
 * local day has moved on by the time the read lands, the result is thrown away and read
 * again. A read begun just before midnight therefore cannot publish yesterday's counts.
 */

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];
type Unsubscribe = ReturnType<AgentHandle["timeline"]["subscribe"]>;

const READ_RETRY_DELAYS_MS = [10, 20, 40];
/** Pages a background refresh may spend before it calls itself partial. */
const BACKGROUND_PAGE_BUDGET = 40;
/** Pages one press of Earlier may spend: the reader asked for that day, so it may cost more. */
const EARLIER_PAGE_BUDGET = 500;
/** Backoff for a timeline subscription that keeps failing: capped, never abandoned. */
const SUBSCRIBE_BASE_MS = 10;
const SUBSCRIBE_MAX_MS = 30_000;

export interface MyMessagesBudgets {
  background: number;
  earlier: number;
}

export interface MyMessagesFeed {
  /** Settles after the first read, whether it succeeded or published an error. */
  ready: Promise<void>;
  stop(): void;
  /** Reads one more local day, or continues the day an earlier press left unread. */
  loadEarlier(): Promise<void>;
  /** Retries what is not working: a pending Earlier read first, otherwise the window. */
  retry(): void;
}

/** What one read of the timeline produced. Nothing here is kept between reads. */
interface WindowRead {
  /** The clock value the read and its rows share. */
  at: number;
  rows: MyMessageRow[];
  machineToday: number;
  humanToday: number;
  /** The oldest instant seen, any kind of row: coverage is about pages, not about rows. */
  oldestAt: number;
  reachedStart: boolean;
  /** A message from the person older than the visible window was seen: Earlier has content. */
  sawOlderHuman: boolean;
}

export interface StartMyMessagesFeedInput {
  agentId: string;
  client?: PaseoApi;
  /** Injected clock. The panel takes its clock from `my-messages-clock`. */
  now?: () => number;
  /** Injected timers. The panel takes its timers from `my-messages-clock`. */
  timers?: FeedTimers;
  /** Injected page budgets, so a test does not have to build thousands of pages. */
  budgets?: Partial<MyMessagesBudgets>;
  /** Injected foreground signal; defaults to the app's own state changes. */
  foreground?: { subscribe(listener: () => void): () => void };
}

function warnPanel(message: string, error: unknown): void {
  console.warn(`Clear Chat my-messages panel ${message}`, error);
}

function entryAt(entry: TimelineEntry): number {
  return Date.parse(entry.timestamp);
}

function rowFor(entry: TimelineEntry, text: string): MyMessageRow {
  const at = entryAt(entry);
  const { preview, truncated } = messagePreview(text);
  return {
    key: `${at}:${entry.seqStart}`,
    at,
    seq: entry.seqStart,
    time: formatClock(at),
    text,
    preview,
    truncated,
    empty: isEmptyMessageText(text),
  };
}

export function startMyMessagesFeed(input: StartMyMessagesFeedInput): MyMessagesFeed {
  const now = input.now ?? nowMs;
  const timers: FeedTimers = input.timers ?? {
    set: (callback, ms) => scheduleTimer(callback, ms),
    clear: handle => cancelTimer(handle),
  };
  // Read on every use: a test may hand in a budget it changes between presses.
  const budgetFor = (kind: keyof MyMessagesBudgets): number =>
    input.budgets?.[kind] ?? (kind === "background" ? BACKGROUND_PAGE_BUDGET : EARLIER_PAGE_BUDGET);
  const api = input.client ?? getPaseoClient("");
  const handle = api.agents.ref(input.agentId);

  let stopped = false;
  /** Days the visible window covers, today included. Only moves when that day is covered. */
  let days = 1;
  /** The day an Earlier press is still reading, or null. */
  let pendingDays: number | null = null;
  let live = false;
  /** The first subscription needs no catch-up read: the first read is already on its way. */
  let everConnected = false;
  let accepting = false;
  let subscription: Unsubscribe | null = null;
  let firstSubscription: Promise<void> | null = null;
  /** Guards every callback and completion: a replaced subscription owns nothing. */
  let generation = 0;
  let midnightTimer: unknown = null;
  let subscribeTimer: unknown = null;
  let subscribeAttempt = 0;
  let running: Promise<void> | null = null;
  let rerun = false;
  let earlierRunning = false;
  const queuedEvents: { generation: number; message: PaseoAgentTimelineEvent }[] = [];
  /** The last published fields, so a flag change republishes without taking a new clock value. */
  let lastPublished: MyMessagesFields | null = null;

  /**
   * One read. Only the person's rows inside the visible window are kept; the model's rows and
   * older days are dropped as they pass, so an open panel does not grow with the conversation.
   */
  async function readWindow(at: number, targetDays: number, budgetPages: number): Promise<WindowRead | null> {
    const todayStart = localDayStartBefore(at, 0);
    const tomorrowStart = localDayStartBefore(at, -1);
    const windowStart = localDayStartBefore(at, targetDays - 1);
    const rows: MyMessageRow[] = [];
    let machineToday = 0;
    let humanToday = 0;
    let oldestAt = Number.POSITIVE_INFINITY;
    let reachedStart = false;
    let sawOlderHuman = false;

    let page = await handle.timeline.refetch({ direction: "tail", projection: "projected" });
    let pages = 0;
    for (;;) {
      // A closed panel must not keep walking the timeline.
      if (stopped) return null;
      if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
      pages += 1;
      for (const entry of page.entries) {
        const rowAt = entryAt(entry);
        if (!Number.isFinite(rowAt)) continue;
        if (rowAt < oldestAt) oldestAt = rowAt;
        const item = entry.item;
        if (item.type !== "user_message") continue;
        const classified = classifyUserMessage(item.text);
        if (rowAt >= todayStart && rowAt < tomorrowStart) {
          if (classified.kind === "machine") machineToday += 1;
          else humanToday += 1;
        }
        if (classified.kind !== "human") continue;
        if (rowAt < windowStart) {
          sawOlderHuman = true;
          continue;
        }
        if (rowAt >= tomorrowStart) continue;
        rows.push(rowFor(entry, classified.text));
      }
      // Strictly before the window start: a page that ends exactly at midnight leaves the
      // day's own midnight rows unproven, so it keeps reading.
      if (oldestAt < windowStart) break;
      if (!page.hasOlder || !page.startCursor) {
        reachedStart = true;
        break;
      }
      if (pages >= budgetPages) break;
      page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected" });
    }
    if (stopped) return null;
    rows.sort((left, right) => right.at - left.at || right.seq - left.seq);
    return { at, rows, machineToday, humanToday, oldestAt, reachedStart, sawOlderHuman };
  }

  function coveredFor(read: WindowRead, targetDays: number): boolean {
    return read.reachedStart || read.oldestAt < localDayStartBefore(read.at, targetDays - 1);
  }

  function publish(read: WindowRead, publishedDays: number, pendingDayAt: number | null, busy: boolean): void {
    const committedStart = localDayStartBefore(read.at, publishedDays - 1);
    const rows = pendingDayAt === null ? read.rows : read.rows.filter(row => row.at >= committedStart);
    const partial = !coveredFor(read, publishedDays);
    lastPublished = {
      status: "ready",
      loadedDays: publishedDays,
      machineToday: read.machineToday,
      humanToday: read.humanToday,
      rows,
      hasEarlier: partial || pendingDayAt !== null || read.sawOlderHuman,
      partial,
      pendingDayAt,
      earlierBusy: busy,
      live,
      error: null,
    };
    publishMyMessages(input.agentId, lastPublished);
  }

  /** Republishing to change a flag replays the last result; it never takes a new clock value. */
  function publishLatest(change: Partial<MyMessagesFields> = {}): void {
    if (!lastPublished || stopped) return;
    // The live flag belongs to the subscription, not to the read that published last.
    lastPublished = { ...lastPublished, live, ...change };
    publishMyMessages(input.agentId, lastPublished);
  }

  function publishError(error: unknown): void {
    if (stopped) return;
    const known = lastPublished ?? myMessagesSnapshot(input.agentId);
    lastPublished = {
      status: "error",
      loadedDays: known.loadedDays,
      machineToday: known.machineToday,
      humanToday: known.humanToday,
      rows: known.rows,
      hasEarlier: known.hasEarlier,
      partial: known.partial,
      pendingDayAt: known.pendingDayAt ?? null,
      earlierBusy: false,
      live,
      error: error instanceof Error ? error.message : "Timeline unavailable",
    };
    publishMyMessages(input.agentId, lastPublished);
  }

  const sleep = (ms: number) => new Promise<void>(resolve => { timers.set(() => resolve(), ms); });

  /** Runs one read with the small read retry; null when it never landed (the error is published). */
  const withReadRetry = async (read: () => Promise<WindowRead | null>): Promise<WindowRead | null> => {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return null;
      try {
        const result = await read();
        if (result === null || stopped) return null;
        return result;
      } catch (error) {
        warnPanel("could not read the timeline", error);
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || stopped) {
          if (!stopped) publishError(error);
          return null;
        }
        await sleep(delay);
      }
    }
  };

  /**
   * True when the local day of `at` is still the current day. A read that lands after
   * midnight describes yesterday; publishing it would show yesterday's counts under
   * today's heading, so the caller reads again instead.
   */
  const stillCurrentDay = (at: number): boolean =>
    localDayStartBefore(now(), 0) === localDayStartBefore(at, 0);

  /** Reads the visible window again and replaces the snapshot. */
  const refreshOnce = async (): Promise<void> => {
    // One clock value for the read and the rows it produces.
    const at = now();
    const read = await withReadRetry(() => readWindow(at, days, budgetFor("background")));
    if (!read) return;
    if (!stillCurrentDay(at)) {
      rerun = true;
      return;
    }
    publish(read, days, pendingDays, false);
    armMidnight(now());
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
          await refreshOnce();
        } while (rerun && !stopped);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  /**
   * Reads one earlier day. The visible window only grows once that day is covered; a read
   * that stops short leaves the day pending, named in the panel, and Retry continues it.
   */
  const runEarlier = async (targetDays: number): Promise<void> => {
    if (stopped) return;
    // A second press while the first is still reading is dropped, not queued: the button is
    // disabled while a read is in flight, and two reads of the same day would race.
    if (earlierRunning) return;
    earlierRunning = true;
    pendingDays = targetDays;
    publishLatest({ pendingDayAt: localDayStartBefore(now(), targetDays - 1), earlierBusy: true });
    let finished = false;
    try {
      const at = now();
      const read = await withReadRetry(() => readWindow(at, targetDays, budgetFor("earlier")));
      if (!read || stopped) return;
      if (!stillCurrentDay(at)) return;
      finished = true;
      if (coveredFor(read, targetDays)) {
        days = targetDays;
        pendingDays = null;
        publish(read, days, null, false);
      } else {
        // Keep the visible window where it was and name the day that is still short.
        publish(read, days, localDayStartBefore(at, targetDays - 1), false);
      }
      armMidnight(now());
    } finally {
      earlierRunning = false;
      if (!stopped && !finished) publishLatest({ earlierBusy: false });
    }
  };

  /**
   * A subscription that keeps failing is retried with a growing, capped delay for as long as
   * the panel lives: silence would leave a list that looks live and never updates.
   */
  const scheduleSubscribe = (): void => {
    if (stopped || subscribeTimer !== null) return;
    const delay = Math.min(SUBSCRIBE_MAX_MS, SUBSCRIBE_BASE_MS * 2 ** Math.min(subscribeAttempt, 12));
    subscribeAttempt += 1;
    subscribeTimer = timers.set(() => {
      subscribeTimer = null;
      connect();
    }, delay);
  };

  /** Only the subscription that is still current may report a failure. */
  const markLiveDown = (mine: number, error: unknown): void => {
    if (stopped || mine !== generation) return;
    warnPanel("live updates are unavailable", error);
    const wasLive = live;
    live = false;
    if (wasLive) publishLatest();
    scheduleSubscribe();
  };

  const handleEvent = (event: PaseoAgentTimelineEvent["event"]): void => {
    if (event.type === "timeline") {
      // Only a user-side row can change a count or a row. The model's own words cannot.
      if (event.item.type === "user_message") void requestRefresh();
      return;
    }
    if (event.type === "replacement" || event.type === "subscription_restored") {
      void requestRefresh();
      return;
    }
    if (event.type === "error") markLiveDown(generation, event.error);
  };

  const onMessage = (mine: number, message: PaseoAgentTimelineEvent): void => {
    if (stopped || mine !== generation || message.agentId !== input.agentId) return;
    if (!accepting) {
      queuedEvents.push({ generation: mine, message });
      return;
    }
    handleEvent(message.event);
  };

  const flushQueued = (): void => {
    for (const queued of queuedEvents.splice(0)) {
      if (queued.generation !== generation) continue;
      onMessage(queued.generation, queued.message);
    }
  };

  /**
   * Opens a subscription. The previous one is released first, and the new one is the only
   * generation whose callbacks, queued events and completion may act.
   */
  function connect(): void {
    if (stopped) return;
    generation += 1;
    const mine = generation;
    const previous = subscription;
    subscription = null;
    try { previous?.(); } catch { /* A dead subscription may already be released. */ }
    let next: Unsubscribe;
    try {
      next = handle.timeline.subscribe(message => onMessage(mine, message));
    } catch (error) {
      markLiveDown(mine, error);
      return;
    }
    subscription = next;
    const settled = next.ready.then(() => {
      if (stopped || mine !== generation) return;
      subscribeAttempt = 0;
      const reconnect = everConnected && !live;
      const wasLive = live;
      everConnected = true;
      live = true;
      if (!wasLive && lastPublished !== null) publishLatest();
      flushQueued();
      // A subscription that comes back may have missed events: re-read. The first connection
      // needs no extra read, because the first read is already on its way.
      if (reconnect) void requestRefresh();
    }).catch(error => {
      if (stopped || mine !== generation) return;
      markLiveDown(mine, error);
    });
    if (firstSubscription === null) firstSubscription = settled;
  }

  /**
   * Wakes at the next local midnight, and re-arms immediately when it does. A panel left open
   * overnight would otherwise keep yesterday's counts; a failed read must not be able to
   * leave the panel without a next wake.
   */
  function armMidnight(at: number): void {
    if (stopped) return;
    if (midnightTimer !== null) timers.clear(midnightTimer);
    const nextMidnight = localDayStartBefore(at, -1);
    const delay = Math.max(50, nextMidnight - at + 50);
    midnightTimer = timers.set(() => {
      midnightTimer = null;
      if (stopped) return;
      // Re-arm before reading, so a failed read cannot leave the panel without a next wake.
      armMidnight(now());
      void requestRefresh();
    }, delay);
  }

  const defaultForeground = {
    subscribe(listener: () => void): () => void {
      const host = AppState as unknown as {
        addEventListener?: (type: "change", handler: (state: string) => void) => { remove?: () => void };
      } | undefined;
      const registered = host?.addEventListener?.("change", state => {
        if (state === "active") listener();
      });
      return () => registered?.remove?.();
    },
  };
  const foreground = input.foreground ?? defaultForeground;
  const stopForeground = foreground.subscribe(() => {
    // Returning to the foreground can cross midnight; re-read rather than trust the rows.
    if (!stopped) void requestRefresh();
  });

  armMidnight(now());
  connect();
  const firstRead = requestRefresh();
  const ready = (async () => {
    // The panel may draw as soon as the first read and the first subscription settled, in
    // either order: a dead subscription must not hold the rows back, and a slow read must not
    // hide that live delivery is up.
    await Promise.allSettled([firstRead, firstSubscription]);
    if (stopped) return;
    accepting = true;
    flushQueued();
  })();

  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      accepting = false;
      generation += 1;
      if (midnightTimer !== null) timers.clear(midnightTimer);
      midnightTimer = null;
      if (subscribeTimer !== null) timers.clear(subscribeTimer);
      subscribeTimer = null;
      stopForeground();
      const held = subscription;
      subscription = null;
      try { held?.(); } catch { /* A host that already dropped it must not block teardown. */ }
    },
    async loadEarlier(): Promise<void> {
      if (stopped) return;
      await runEarlier(pendingDays ?? days + 1);
    },
    retry(): void {
      if (stopped) return;
      if (subscribeTimer !== null) timers.clear(subscribeTimer);
      subscribeTimer = null;
      subscribeAttempt = 0;
      if (!live) connect();
      if (pendingDays !== null) void runEarlier(pendingDays);
      else void requestRefresh();
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
 * closed conversation does not keep the rows it listed in memory. Releasing the same handle
 * twice decrements once: a surface that stops twice cannot close the other reader's feed.
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
  let released = false;
  return {
    ready: held.feed.ready,
    loadEarlier: () => held.feed.loadEarlier(),
    retry: () => held.feed.retry(),
    stop(): void {
      if (released) return;
      released = true;
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
