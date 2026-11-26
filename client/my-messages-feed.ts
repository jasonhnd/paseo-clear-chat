import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoApi } from "@getpaseo/client";
import { classifyUserMessage, isEmptyMessageText, messagePreview } from "./user-message-kind";
import { formatClock, localDateKey, startOfLocalDay, startOfNextLocalDay } from "./local-day";
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

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type Subscription = ReturnType<AgentHandle["timeline"]["subscribe"]>;

const READ_RETRY_DELAYS_MS = [10, 20, 40];
const BASE_PAGES = 40;
const MAX_PAGES = 320;
const SUBSCRIBE_BASE_MS = 10;
const SUBSCRIBE_MAX_MS = 30_000;

export interface MyMessagesFeed {
  /** Settles after the initial read queue drains and the first subscription attempt settles. */
  ready: Promise<void>;
  stop(): void;
  retry(): void;
}

export interface StartMyMessagesFeedInput {
  agentId: string;
  client?: PaseoApi;
  now?: () => number;
  timers?: FeedTimers;
  /** Injected page budget, so tests do not have to build large histories. */
  budgets?: { basePages?: number; maxPages?: number };
  foreground?: { subscribe(listener: () => void): () => void };
}

function warnPanel(message: string, error: unknown): void {
  console.warn(`Clear Chat my-messages panel ${message}`, error);
}

function rowFor(seq: number, at: number, text: string): MyMessageRow {
  return {
    key: `${at}:${seq}`,
    at,
    seq,
    time: formatClock(at),
    text,
    ...messagePreview(text),
    empty: isEmptyMessageText(text),
  };
}

function newestFirst(left: MyMessageRow, right: MyMessageRow): number {
  return right.at - left.at || right.seq - left.seq;
}

const appForeground = {
  subscribe(listener: () => void): () => void {
    const registered = AppState?.addEventListener?.("change", state => {
      if (state === "active") listener();
    });
    return () => registered?.remove?.();
  },
};

export function startMyMessagesFeed(input: StartMyMessagesFeedInput): MyMessagesFeed {
  const now = input.now ?? nowMs;
  const timers = input.timers ?? { set: scheduleTimer, clear: cancelTimer };
  const maxPages = input.budgets?.maxPages ?? MAX_PAGES;
  let pageBudget = Math.min(maxPages, input.budgets?.basePages ?? BASE_PAGES);
  const api = input.client ?? getPaseoClient("");
  const { timeline } = api.agents.ref(input.agentId);

  let stopped = false;
  let live = false;
  let offline = false;
  let generation = 0;
  let subscription: Subscription | null = null;
  let releasing = false;
  let subscribeTimer: unknown = null;
  let subscribeAttempt = 0;
  let midnightTimer: unknown = null;
  let cancelReadDelay: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let pending = false;

  const snapshot = () => myMessagesSnapshot(input.agentId);

  function publish(change: Partial<MyMessagesFields> = {}, currentDay = localDateKey(now())): void {
    if (stopped) return;
    const next = { ...snapshot(), ...change, live, offline };
    publishMyMessages(input.agentId, { ...next, stale: next.day !== "" && next.day !== currentDay });
  }

  async function readToday(from: number, until: number, budget: number) {
    const rows: MyMessageRow[] = [];
    let machineToday = 0;
    let humanToday = 0;
    let page = await timeline.refetch({ direction: "tail", projection: "projected" });

    for (let pages = 1; !stopped; pages += 1) {
      if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
      let crossedMidnight = false;
      for (const { timestamp, item, seqStart } of page.entries) {
        const at = Date.parse(timestamp);
        if (!Number.isFinite(at)) continue;
        if (at < from) crossedMidnight = true;
        if (at < from || at >= until || item.type !== "user_message") continue;
        const classified = classifyUserMessage(item.text);
        if (classified.kind === "machine") {
          machineToday += 1;
        } else {
          humanToday += 1;
          rows.push(rowFor(seqStart, at, classified.text));
        }
      }
      const partial = page.hasOlder && !crossedMidnight;
      if (!partial || pages >= budget) {
        rows.sort(newestFirst);
        return { rows, machineToday, humanToday, partial };
      }
      const cursor = page.startCursor;
      if (!cursor) throw new Error("Timeline page is missing its cursor");
      page = await timeline.refetch({ direction: "before", cursor, projection: "projected" });
    }
    return null;
  }

  function waitToRetry(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        cancelReadDelay = null;
        resolve();
      };
      const timer = timers.set(finish, ms);
      cancelReadDelay = () => {
        timers.clear(timer);
        finish();
      };
    });
  }

  async function runRead(): Promise<void> {
    const budget = pageBudget;
    for (let attempt = 0; !stopped; attempt += 1) {
      const startedAt = now();
      const day = localDateKey(startedAt);
      const from = startOfLocalDay(startedAt);
      const until = startOfNextLocalDay(startedAt);
      publish({}, day);
      const result = await readToday(from, until, budget).then(
        read => ({ read } as const),
        (error: unknown) => ({ error } as const),
      );
      if (stopped) return;

      const finishedAt = now();
      const currentDay = localDateKey(finishedAt);
      armMidnight(finishedAt);
      // Never publish a read for a day that ended while it was running. If another trigger
      // is already waiting, that same follow-up reads the new day.
      if (day !== currentDay || from !== startOfLocalDay(finishedAt)) {
        pending = true;
        return;
      }
      if ("error" in result) {
        warnPanel("could not read the timeline", result.error);
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          await waitToRetry(delay);
          continue;
        }
        publish({
          status: "error",
          error: result.error instanceof Error ? result.error.message : "Timeline unavailable",
        }, currentDay);
        return;
      }

      if (result.read) {
        const { read } = result;
        const known = snapshot();
        let { rows, humanToday } = read;
        if (read.partial && known.day === day) {
          const byKey = new Map(known.rows.map(row => [row.key, row]));
          for (const row of rows) byKey.set(row.key, row);
          rows = [...byKey.values()].sort(newestFirst);
          humanToday = Math.max(humanToday, rows.length);
        }
        publish({ ...read, day, rows, humanToday, status: "ready", error: null }, currentDay);
      }
      return;
    }
  }

  /** One queue for every trigger. Requests during a read set one bit, even on failure. */
  function requestRead(): Promise<void> {
    if (stopped) return Promise.resolve();
    pending = true;
    running ??= Promise.resolve().then(async () => {
      try {
        while (pending && !stopped) {
          pending = false;
          await runRead();
        }
      } finally {
        running = null;
      }
    });
    // Notify the panel even if a midnight or foreground request must wait behind a read.
    publish();
    return running;
  }

  function armMidnight(at: number): void {
    if (midnightTimer !== null) timers.clear(midnightTimer);
    midnightTimer = timers.set(() => {
      midnightTimer = null;
      if (stopped) return;
      armMidnight(now());
      void requestRead();
    }, Math.max(1, startOfNextLocalDay(at) - at));
  }

  function cancelReconnect(): void {
    if (subscribeTimer !== null) timers.clear(subscribeTimer);
    subscribeTimer = null;
  }

  function markLiveDown(error: unknown): void {
    if (!offline || subscribeTimer === null) warnPanel("live updates are unavailable", error);
    live = false;
    offline = true;
    if (subscribeTimer === null) {
      const delay = Math.min(SUBSCRIBE_MAX_MS, SUBSCRIBE_BASE_MS * 2 ** Math.min(subscribeAttempt++, 12));
      subscribeTimer = timers.set(() => {
        subscribeTimer = null;
        void connect();
      }, delay);
    }
    publish();
  }

  function markLiveUp(restored: boolean): void {
    const catchUp = offline || restored;
    live = true;
    offline = false;
    subscribeAttempt = 0;
    cancelReconnect();
    publish();
    if (catchUp) void requestRead();
  }

  async function release(held: Subscription): Promise<void> {
    try {
      await held.release();
    } catch (error) {
      warnPanel("could not release the timeline subscription", error);
    }
  }

  async function connect(): Promise<void> {
    if (stopped || releasing) return;
    const mine = ++generation;
    const current = () => !stopped && generation === mine;
    const previous = subscription;
    subscription = null;
    if (previous) {
      releasing = true;
      await release(previous);
      releasing = false;
      if (!current()) return;
    }

    let failed = false;
    try {
      const next = timeline.subscribe(message => {
        if (!current() || message.agentId !== input.agentId) return;
        const { event } = message;
        if (event.type === "error") {
          failed = true;
          markLiveDown(event.error);
        } else if (event.type === "subscription_restored") {
          failed = false;
          markLiveUp(true);
        } else if (event.type === "replacement" || event.type === "timeline") {
          void requestRead();
        }
      });
      if (!current()) {
        void release(next);
        return;
      }
      subscription = next;
      await next.ready;
      if (current() && !failed) markLiveUp(false);
    } catch (error) {
      if (current()) markLiveDown(error);
    }
  }

  const stopForeground = (input.foreground ?? appForeground).subscribe(() => {
    if (stopped) return;
    armMidnight(now());
    void requestRead();
  });
  armMidnight(now());
  const firstRead = requestRead();
  const firstSubscription = connect();

  return {
    ready: Promise.all([firstRead, firstSubscription]).then(() => {}),
    stop(): void {
      if (stopped) return;
      stopped = true;
      generation += 1;
      if (midnightTimer !== null) timers.clear(midnightTimer);
      cancelReconnect();
      cancelReadDelay?.();
      stopForeground();
      const held = subscription;
      subscription = null;
      if (held) void release(held);
    },
    retry(): void {
      if (stopped) return;
      pageBudget = Math.min(maxPages, pageBudget * 2);
      if (!live) {
        cancelReconnect();
        subscribeAttempt = 0;
        void connect();
      }
      void requestRead();
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
    retry: () => { if (!released) held.feed.retry(); },
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
