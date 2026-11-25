import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { classifyUserMessage, isEmptyMessageText, messagePreview } from "./user-message-kind";
import { formatClock, localDateKey, localDaySpan, localDayStartFor, nextLocalDateKey, previousLocalDateKey } from "./local-day";
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
 * There is one operation: read from the newest page back until a message is strictly older
 * than the first instant of the target window, or until the conversation begins; then replace
 * the snapshot with what was read. Every trigger — the first read, a new message, a restored
 * subscription, midnight, the foreground, an Earlier press, a retry — is that operation, run
 * one at a time in a single queue. Overlapping triggers collapse into one waiting request that
 * keeps the widest target, so a later read can never overwrite an earlier one's result and an
 * Earlier press cannot be undone by a refresh that raced it.
 *
 * The panel remembers days as calendar dates, not as counts: a count turns into the wrong day
 * the moment midnight passes, while a date keeps pointing at the day the reader asked for.
 * A page budget is per day of target window, so a refresh of a window the reader widened still
 * reads all of it; an explicit retry doubles the budget (up to a cap), so retrying always gets
 * further than the attempt before it.
 */

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];
type Unsubscribe = ReturnType<AgentHandle["timeline"]["subscribe"]>;

const READ_RETRY_DELAYS_MS = [10, 20, 40];
/** Pages one read may spend per day of its target window. */
const PAGES_PER_DAY = 40;
/** The most pages any one read may spend, however many days or retries it covers. */
const MAX_PAGES = 2000;
/** Each explicit retry reads twice as far, up to this multiple of the base budget. */
const MAX_RETRY_FACTOR = 8;
/** Backoff for a timeline subscription that keeps failing: capped, never abandoned. */
const SUBSCRIBE_BASE_MS = 10;
const SUBSCRIBE_MAX_MS = 30_000;

export interface MyMessagesBudgets {
  /** Base pages per day of target window. */
  pagesPerDay: number;
  /** Hard cap on one read. */
  maxPages: number;
}

export interface MyMessagesFeed {
  /** Settles after the first read, whether it succeeded or published an error. */
  ready: Promise<void>;
  stop(): void;
  /** Widens the window by one day, or finishes the day an earlier press left unread. */
  loadEarlier(): Promise<void>;
  /** Retries what is not working: a pending Earlier read first, otherwise the window. */
  retry(): void;
}

/** What one read of the timeline produced. Nothing here is kept between reads. */
interface WindowRead {
  /** The clock value the read and its rows share. */
  at: number;
  day: string;
  rows: MyMessageRow[];
  machineToday: number;
  humanToday: number;
  /** The oldest instant seen, any kind of row: coverage is about pages, not about rows. */
  oldestAt: number;
  reachedStart: boolean;
  /** The read stopped with older pages still unread. */
  hasOlder: boolean;
  /** A message from the person older than the window was read: a press of Earlier has content. */
  sawOlderHuman: boolean;
}

export interface StartMyMessagesFeedInput {
  agentId: string;
  client?: PaseoApi;
  /** Injected clock. The panel takes its clock from `my-messages-clock`. */
  now?: () => number;
  /** Injected timers. The panel takes its timers from `my-messages-clock`. */
  timers?: FeedTimers;
  /** Injected page budget, so a test does not have to build thousands of pages. */
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
  const pagesPerDay = input.budgets?.pagesPerDay ?? PAGES_PER_DAY;
  const maxPages = input.budgets?.maxPages ?? MAX_PAGES;
  const api = input.client ?? getPaseoClient("");
  const handle = api.agents.ref(input.agentId);

  let stopped = false;
  /** The first local day the visible window covers, as a calendar date. */
  let coveredFrom = localDateKey(now());
  /** A day an Earlier press is trying to reach, as a calendar date, until it is covered. */
  let pendingDay: string | null = null;
  /** Doubles on each explicit retry so a retry always reads further than the last attempt. */
  let retryFactor = 1;
  let earlierBusy = false;
  let live = false;
  /** True once a subscription was lost: the next success must catch up on what it missed. */
  let wentOffline = false;
  let accepting = false;
  let subscription: Unsubscribe | null = null;
  let firstSubscription: Promise<void> | null = null;
  /** Guards every callback and completion: a replaced subscription owns nothing. */
  let generation = 0;
  let midnightTimer: unknown = null;
  let subscribeTimer: unknown = null;
  let subscribeAttempt = 0;
  /** The single read queue: one running read and at most one waiting target. */
  let running: Promise<void> | null = null;
  let waitingTarget: string | null = null;
  const queuedEvents: { generation: number; message: PaseoAgentTimelineEvent }[] = [];
  /** The last published fields, so a flag change republishes without taking a new clock value. */
  let lastPublished: MyMessagesFields | null = null;

  const windowStartFor = (day: string): number => localDayStartFor(day);
  const isCovered = (read: WindowRead, day: string): boolean =>
    read.reachedStart || read.oldestAt < windowStartFor(day);

  /**
   * One read. Only the person's rows inside the target window are kept; the model's rows and
   * older days are dropped as they pass, so an open panel does not grow with the conversation.
   */
  async function readWindow(at: number, targetDay: string, budgetPages: number): Promise<WindowRead | null> {
    const todayKey = localDateKey(at);
    const todayStart = windowStartFor(todayKey);
    const tomorrowStart = windowStartFor(nextLocalDateKey(todayKey));
    const windowStart = windowStartFor(targetDay);
    const rows: MyMessageRow[] = [];
    let machineToday = 0;
    let humanToday = 0;
    let oldestAt = Number.POSITIVE_INFINITY;
    let reachedStart = false;
    let hasOlder = false;
    /** A message from the person older than the window: a press of Earlier has something to show. */
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
      if (oldestAt < windowStart) {
        // Unread pages may still hold the person's older messages, so Earlier stays offered.
        hasOlder = page.hasOlder === true;
        break;
      }
      if (!page.hasOlder || !page.startCursor) {
        reachedStart = true;
        break;
      }
      if (pages >= budgetPages) {
        hasOlder = true;
        break;
      }
      page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected" });
    }
    if (stopped) return null;
    rows.sort((left, right) => right.at - left.at || right.seq - left.seq);
    return { at, day: localDateKey(at), rows, machineToday, humanToday, oldestAt, reachedStart, hasOlder, sawOlderHuman };
  }

  function publishLatest(change: Partial<MyMessagesFields> = {}): void {
    if (!lastPublished || stopped) return;
    // The live flag belongs to the subscription, not to the read that published last.
    lastPublished = { ...lastPublished, live, earlierBusy, ...change };
    publishMyMessages(input.agentId, lastPublished);
  }

  /**
   * Applies a read. A covered read replaces the window; a read that stopped short keeps what
   * the reader already had and says it is partial, rather than quietly showing fewer rows.
   */
  function applyRead(read: WindowRead, targetDay: string): void {
    if (isCovered(read, targetDay)) {
      // A window only ever widens: a refresh queued before an Earlier press must not pull it
      // back to the day it was reading.
      if (targetDay < coveredFrom) coveredFrom = targetDay;
      if (pendingDay !== null && pendingDay >= coveredFrom) pendingDay = null;
      retryFactor = 1;
      lastPublished = {
        status: "ready",
        day: read.day,
        coveredFrom,
        machineToday: read.machineToday,
        humanToday: read.humanToday,
        rows: read.rows,
        hasEarlier: read.hasOlder || read.sawOlderHuman,
        partial: false,
        pendingDay,
        earlierBusy,
        live,
        stale: false,
        error: null,
      };
    } else {
      const known = lastPublished ?? myMessagesSnapshot(input.agentId);
      if (targetDay < coveredFrom) pendingDay = targetDay;
      // Show what this read found when it found more than is on screen; never quietly show
      // fewer rows than the last complete read.
      const keep = known.rows.length > read.rows.length;
      lastPublished = {
        status: "ready",
        day: read.day,
        coveredFrom,
        machineToday: keep ? known.machineToday : read.machineToday,
        humanToday: keep ? known.humanToday : read.humanToday,
        rows: keep ? known.rows : read.rows,
        hasEarlier: true,
        partial: true,
        pendingDay,
        earlierBusy,
        live,
        // Retained values from an earlier day must not be shown as today's.
        stale: keep && known.day !== read.day,
        error: null,
      };
    }
    publishMyMessages(input.agentId, lastPublished);
    armMidnight(now());
  }

  function publishError(error: unknown): void {
    if (stopped) return;
    const known = lastPublished ?? myMessagesSnapshot(input.agentId);
    const today = localDateKey(now());
    lastPublished = {
      ...known,
      status: "error",
      earlierBusy,
      live,
      // Retained counts from an earlier day must not be shown as today's.
      stale: known.status === "ready" && known.day !== today,
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
        return await read();
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

  /** The page budget for a target window: its days, times the current retry factor. */
  function budgetFor(targetDay: string): number {
    const today = localDateKey(now());
    const days = targetDay < today ? localDaySpan(targetDay, today) : 1;
    return Math.min(maxPages, pagesPerDay * days * retryFactor);
  }

  /** One read of one target window, then the result is applied. */
  async function runRead(requested: string): Promise<"applied" | "stale" | "failed"> {
    // Every read covers at least the window already on screen, whatever target was asked for.
    const targetDay = requested < coveredFrom ? requested : coveredFrom;
    const at = now();
    const budget = budgetFor(targetDay);
    const read = await withReadRetry(() => readWindow(at, targetDay, budget));
    if (stopped) return "failed";
    if (!read) return "failed";
    // A read that lands after midnight describes yesterday: throw it away and read again.
    if (read.day !== localDateKey(now())) return "stale";
    applyRead(read, targetDay);
    return "applied";
  }

  /**
   * The one queue. A request that arrives while a read is running waits as a single target:
   * the widest (earliest) one, so the result the reader asked for is never narrower than a
   * refresh that raced it.
   */
  const requestRead = (targetDay: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      waitingTarget = waitingTarget === null || targetDay < waitingTarget ? targetDay : waitingTarget;
      return running;
    }
    running = (async () => {
      let next: string | null = targetDay;
      try {
        while (next !== null && !stopped) {
          const outcome = await runRead(next);
          if (stopped) return;
          if (outcome === "stale") continue;      // the day turned over mid-read: read again
          if (outcome === "failed") break;        // the error is already published
          next = waitingTarget;
          waitingTarget = null;
        }
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
  const scheduleSubscribe = (): void => {
    if (stopped || subscribeTimer !== null) return;
    const delay = Math.min(SUBSCRIBE_MAX_MS, SUBSCRIBE_BASE_MS * 2 ** Math.min(subscribeAttempt, 12));
    subscribeAttempt += 1;
    subscribeTimer = timers.set(() => {
      subscribeTimer = null;
      if (stopped) return;
      connect();
    }, delay);
  };

  /** Only the subscription that is still current may report a failure. */
  const markLiveDown = (mine: number, error: unknown): void => {
    if (stopped || mine !== generation) return;
    warnPanel("live updates are unavailable", error);
    const wasLive = live;
    live = false;
    wentOffline = true;
    if (wasLive) publishLatest();
    scheduleSubscribe();
  };

  const handleEvent = (event: PaseoAgentTimelineEvent["event"]): void => {
    if (event.type === "timeline") {
      // Only a user-side row can change a count or a row. The model's own words cannot.
      if (event.item.type === "user_message") void requestRead(pendingDay ?? coveredFrom);
      return;
    }
    if (event.type === "replacement" || event.type === "subscription_restored") {
      void requestRead(pendingDay ?? coveredFrom);
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
      const wasLive = live;
      live = true;
      if (!wasLive && lastPublished !== null) publishLatest();
      flushQueued();
      // Coming back from being offline — including a first subscription that failed — means
      // the timeline may have moved on. The normal first start has one read on its way.
      if (wentOffline) void requestRead(pendingDay ?? coveredFrom);
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
    const nextMidnight = localDayStartFor(nextLocalDateKey(localDateKey(at)));
    const delay = Math.max(50, nextMidnight - at + 50);
    midnightTimer = timers.set(() => {
      midnightTimer = null;
      if (stopped) return;
      // Re-arm before reading, so a failed read cannot leave the panel without a next wake.
      armMidnight(now());
      void requestRead(pendingDay ?? coveredFrom);
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
    if (stopped) return;
    // Returning to the foreground can cross midnight: re-anchor the wake to the current
    // clock whatever the read does, then read.
    armMidnight(now());
    void requestRead(pendingDay ?? coveredFrom);
  });

  armMidnight(now());
  connect();
  const firstRead = requestRead(coveredFrom);
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
      // The busy state stays until this press's own read has finished, even if it had to wait
      // behind another one.
      if (earlierBusy) return;
      const target = pendingDay ?? previousLocalDateKey(coveredFrom);
      earlierBusy = true;
      publishLatest({ earlierBusy, pendingDay: target });
      try {
        await requestRead(target);
      } finally {
        earlierBusy = false;
        if (!stopped) publishLatest({ earlierBusy });
      }
    },
    retry(): void {
      if (stopped) return;
      if (subscribeTimer !== null) timers.clear(subscribeTimer);
      subscribeTimer = null;
      subscribeAttempt = 0;
      // A retry must get further than the attempt before it, so its budget doubles.
      retryFactor = Math.min(MAX_RETRY_FACTOR, retryFactor * 2);
      if (!live) connect();
      void requestRead(pendingDay ?? coveredFrom);
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
