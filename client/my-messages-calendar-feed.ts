import type { PaseoApi } from "@getpaseo/client";
import type { HistoryDayResult, HistoryDaysResult } from "../shared/history-rpc";
import type { HistorySource } from "./history-source";
import { startOfNextLocalDay, localDateKey } from "./local-day";
import { DayKey, parseDayKey } from "./my-messages-calendar";
import { currentTimers, nowMs } from "./my-messages-clock";
import {
  listAllConversations,
  readConversation,
  readWithRetries,
  type Conversation,
  type MyMessagesScreenRow,
} from "./my-messages-screen-feed";

/**
 * Data for the calendar page.
 *
 * The two history RPCs are the fast path: `days` paints the whole grid and `day` fills the
 * selected list. A host that cannot answer them, or conversations the fast read deliberately
 * skipped, fall back to the same timeline reader the today-only page uses. The fallback is
 * merged by the message's own identity, and only the rows that were not already counted are
 * added to that day's cell.
 *
 * A host that cannot answer `days` at all reports `mode: "fallback"`: the page then keeps its
 * previous today-only shape instead of drawing a calendar with no data.
 */

export type CalendarDaysStatus = "reading" | "ready" | "error" | "unsupported";
export type CalendarDetailStatus = "reading" | "ready" | "error";

export interface CalendarDetailSnapshot {
  day: DayKey;
  status: CalendarDetailStatus;
  rows: readonly MyMessagesScreenRow[];
  conversations: number;
  progress: { done: number; total: number } | null;
  partial: readonly string[];
  failed: readonly string[];
  unavailable: readonly string[];
  /** True when at least one row came from the timeline fallback. */
  fromTimeline: boolean;
  /** The selected day's history RPC answered; its rows are already in `days`. */
  fromRpc: boolean;
  /** How many of `rows` the RPC supplied, before the fallback merged in. */
  rpcRows: number;
  /** The conversation directory could not be read, so titles and slow rows are missing. */
  directoryFailed: boolean;
}

export interface CalendarNotices {
  directoryPartial: boolean;
  cacheError: boolean;
  skippedDatabases: readonly string[];
  /** UTC months whose archive file stopped keeping text. */
  cacheFull: readonly string[];
}

export interface MyMessagesCalendarSnapshot {
  mode: "calendar" | "fallback";
  daysStatus: CalendarDaysStatus;
  /** Local day key -> messages the fast path counted. */
  days: Readonly<Record<DayKey, number>>;
  /** Extra rows the timeline fallback found, per day; overwritten, never accumulated. */
  extraDays: Readonly<Record<DayKey, number>>;
  firstDay: DayKey | null;
  lastDay: DayKey | null;
  selectedDay: DayKey;
  detail: CalendarDetailSnapshot;
  notices: CalendarNotices;
  slowConversationIds: readonly string[];
  timeZone: string;
}

const TIMELINE_BUDGET = 40;
const DETAIL_CACHE_LIMIT = 120;
const READ_RETRY_DELAY_MS = 250;

type Agents = PaseoApi["agents"];

interface CalendarMount {
  hostId: string;
  agents: Agents;
  history: HistorySource;
  initialDay?: DayKey;
  publish(state: MyMessagesCalendarSnapshot): void;
}

interface CalendarSession extends CalendarMount {
  snapshot: MyMessagesCalendarSnapshot;
  daysToken: number;
  detailToken: number;
  directory: Promise<{ conversations: Conversation[]; directoryPartial: boolean }> | null;
  stopped: boolean;
  /** The day RPC answered at least once; a later total failure keeps the calendar. */
  dayRpcSucceeded: boolean;
  /** The first both-methods failure already spent its one automatic retry. */
  errorAutoRetried: boolean;
}

function emptyDetail(day: DayKey): CalendarDetailSnapshot {
  return {
    day, status: "reading", rows: [], conversations: 0, progress: null,
    partial: [], failed: [], unavailable: [], fromTimeline: false, fromRpc: false, rpcRows: 0,
    directoryFailed: false,
  };
}

export function emptyCalendarSnapshot(day: DayKey, timeZone = "UTC"): MyMessagesCalendarSnapshot {
  return {
    mode: "calendar", daysStatus: "reading", days: {}, extraDays: {}, firstDay: null, lastDay: null,
    selectedDay: day, detail: emptyDetail(day), notices: { directoryPartial: false, cacheError: false, skippedDatabases: [], cacheFull: [] },
    slowConversationIds: [], timeZone,
  };
}

function noticesFromDays(result: HistoryDaysResult): CalendarNotices {
  return {
    directoryPartial: result.directoryPartial,
    cacheError: result.cacheError === true,
    skippedDatabases: result.skippedDatabases,
    cacheFull: result.cacheFull ?? [],
  };
}

function mergeNotices(left: CalendarNotices, right: Partial<CalendarNotices>): CalendarNotices {
  return {
    directoryPartial: left.directoryPartial || right.directoryPartial === true,
    cacheError: left.cacheError || right.cacheError === true,
    skippedDatabases: [...new Set([...left.skippedDatabases, ...(right.skippedDatabases ?? [])])],
    cacheFull: [...new Set([...left.cacheFull, ...(right.cacheFull ?? [])])],
  };
}

function rowKey(row: MyMessagesScreenRow): string {
  return `${row.agentId}\u0000${row.at}\u0000${row.text}`;
}

function compareRows(left: MyMessagesScreenRow, right: MyMessagesScreenRow): number {
  if (left.at !== right.at) return right.at - left.at;
  if (left.agentId !== right.agentId) return left.agentId < right.agentId ? -1 : 1;
  return left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
}

/** Merge RPC and timeline rows, dropping a message both paths saw. */
export function mergeCalendarRows(
  rpcRows: readonly MyMessagesScreenRow[],
  timelineRows: readonly MyMessagesScreenRow[],
): MyMessagesScreenRow[] {
  const seen = new Set<string>();
  const merged: MyMessagesScreenRow[] = [];
  for (const row of [...rpcRows, ...timelineRows]) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged.sort(compareRows);
}

function countConversations(rows: readonly MyMessagesScreenRow[]): number {
  return new Set(rows.map(row => row.agentId)).size;
}

/** The number a cell and a summary show: raw fast count plus this day's fallback delta. */
export function displayedDayCount(
  days: Readonly<Record<DayKey, number>>,
  extraDays: Readonly<Record<DayKey, number>>,
  day: DayKey,
): number {
  return (days[day] ?? 0) + (extraDays[day] ?? 0);
}

export function createMyMessagesCalendarFeed(now: () => number = nowMs) {
  const detailCache = new Map<DayKey, CalendarDetailSnapshot>();
  let cacheHost: string | null = null;
  let active: CalendarSession | null = null;
  let cancelDelay: (() => void) | null = null;

  function isDaysCurrent(session: CalendarSession, token: number): boolean {
    return active === session && session.daysToken === token && !session.stopped;
  }

  function isDetailCurrent(session: CalendarSession, token: number): boolean {
    return active === session && session.detailToken === token && !session.stopped;
  }

  function publish(session: CalendarSession, patch: Partial<MyMessagesCalendarSnapshot>): void {
    session.snapshot = { ...session.snapshot, ...patch };
    session.publish(session.snapshot);
  }

  function waitToRetry(): Promise<void> {
    const timers = currentTimers();
    return new Promise(resolve => {
      const finish = () => {
        cancelDelay = null;
        resolve();
      };
      const timer = timers.set(finish, READ_RETRY_DELAY_MS);
      cancelDelay = () => {
        timers.clear(timer);
        finish();
      };
    });
  }

  function directory(session: CalendarSession, isOpen: () => boolean) {
    session.directory ??= listAllConversations(session.agents, isOpen).catch(error => {
      session.directory = null;
      throw error;
    });
    return session.directory;
  }

  /** The fallback's contribution to one day; overwritten on every read, never added to itself. */
  function extraForDetail(session: CalendarSession, detail: CalendarDetailSnapshot): Record<DayKey, number> {
    if (detail.status !== "ready") return { ...session.snapshot.extraDays };
    const base = session.snapshot.days[detail.day] ?? 0;
    const extra = detail.fromRpc
      ? Math.max(0, detail.rows.length - detail.rpcRows)
      : Math.max(0, detail.rows.length - base);
    // A failed RPC plus an empty fallback is no evidence that the fast count was wrong.
    const value = !detail.fromRpc && detail.rows.length === 0 && base > 0 ? 0 : extra;
    return { ...session.snapshot.extraDays, [detail.day]: value };
  }

  async function loadDetail(session: CalendarSession, day: DayKey, token: number): Promise<CalendarDetailSnapshot | null> {
    const isOpen = () => isDetailCurrent(session, token);
    if (session.snapshot.mode !== "calendar") return null;
    const cached = detailCache.get(day);
    if (cached) {
      publish(session, { selectedDay: day, detail: cached, extraDays: extraForDetail(session, cached) });
      return cached;
    }
    publish(session, { selectedDay: day, detail: emptyDetail(day) });

    const parts = parseDayKey(day);
    const fromMs = new Date(parts.year, parts.month - 1, parts.day).getTime();
    const until = startOfNextLocalDay(fromMs);

    let rpcRows: MyMessagesScreenRow[] = [];
    let fromRpc = false;
    let fromTimeline = false;
    let notices = session.snapshot.notices;
    let mode: "slow" | "all" = "all";
    let dayState;
    try {
      dayState = await session.history.day(day);
    } catch {
      dayState = { status: "error" as const };
    }
    if (!isOpen()) return null;
    if (dayState.status === "ready") {
      session.dayRpcSucceeded = true;
      const result: HistoryDayResult = dayState.snapshot;
      notices = mergeNotices(notices, {
        directoryPartial: result.directoryPartial,
        cacheError: result.cacheError === true,
        cacheFull: result.cacheFull ?? [],
      });
      fromRpc = true;
      rpcRows = result.rows
        .map(row => ({ agentId: row.agentId, at: row.at, seq: 0, text: row.text, title: null }))
        .sort(compareRows);
      publish(session, {
        notices,
        detail: { ...emptyDetail(day), rows: rpcRows, conversations: countConversations(rpcRows), fromRpc, rpcRows: rpcRows.length },
      });
      if (!rpcRows.length && !session.snapshot.slowConversationIds.length) {
        const ready: CalendarDetailSnapshot = {
          ...emptyDetail(day), status: "ready", fromRpc, rpcRows: 0,
        };
        cacheDetail(day, ready);
        publish(session, { detail: ready, extraDays: extraForDetail(session, ready) });
        return ready;
      }
      mode = "slow";
    }

    let listing;
    try {
      listing = await directory(session, isOpen);
    } catch {
      if (!isOpen()) return null;
      const failed: CalendarDetailSnapshot = {
        ...emptyDetail(day), status: rpcRows.length ? "ready" : "error", rows: rpcRows,
        conversations: countConversations(rpcRows), fromTimeline, fromRpc, rpcRows: rpcRows.length,
        directoryFailed: true,
      };
      publish(session, { detail: failed, notices });
      return failed;
    }
    if (!isOpen()) return null;
    notices = mergeNotices(notices, { directoryPartial: listing.directoryPartial });
    const titles = new Map(listing.conversations.map(conversation => [conversation.id, conversation.title]));
    rpcRows = rpcRows.map(row => ({ ...row, title: titles.get(row.agentId) ?? row.title }));

    const slowIds = new Set(session.snapshot.slowConversationIds);
    const candidates = listing.conversations.filter(conversation => conversation.lastAt >= fromMs
      && (mode === "all" || slowIds.has(conversation.id)));
    const detail: CalendarDetailSnapshot = {
      ...emptyDetail(day), rows: rpcRows, conversations: countConversations(rpcRows),
      progress: candidates.length ? { done: 0, total: candidates.length } : null,
      fromTimeline, fromRpc, rpcRows: rpcRows.length,
    };
    publish(session, { notices, detail });

    const timelineRows: MyMessagesScreenRow[] = [];
    const partial: string[] = [];
    const failed: string[] = [];
    const unavailable: string[] = [];
    for (const [index, conversation] of candidates.entries()) {
      if (!isOpen()) return null;
      const read = await readWithRetries(
        () => readConversation(session.agents, conversation, fromMs, until, TIMELINE_BUDGET, isOpen),
        isOpen,
        waitToRetry,
      );
      if (!isOpen()) return null;
      if (!read) failed.push(conversation.id);
      else {
        if (read.partial) partial.push(conversation.id);
        if (read.unavailable) unavailable.push(conversation.id);
        timelineRows.push(...read.rows.map(row => ({
          ...row, agentId: conversation.id, title: conversation.title,
        })));
      }
      fromTimeline = true;
      const merged = mergeCalendarRows(rpcRows, timelineRows);
      const next: CalendarDetailSnapshot = {
        ...detail,
        rows: merged,
        conversations: countConversations(merged),
        progress: { done: index + 1, total: candidates.length },
        partial, failed, unavailable, fromTimeline,
      };
      publish(session, { notices, detail: next });
    }

    const merged = mergeCalendarRows(rpcRows, timelineRows);
    const ready: CalendarDetailSnapshot = {
      ...detail,
      status: "ready",
      rows: merged,
      conversations: countConversations(merged),
      progress: null,
      partial, failed, unavailable, fromTimeline,
    };
    cacheDetail(day, ready);
    publish(session, { notices, detail: ready, extraDays: extraForDetail(session, ready) });
    return ready;
  }

  function cacheDetail(day: DayKey, detail: CalendarDetailSnapshot): void {
    // A partial read or a directory failure is retried when the day is opened again,
    // never replayed from cache.
    if (detail.partial.length > 0 || detail.failed.length > 0 || detail.unavailable.length > 0
      || detail.directoryFailed) return;
    detailCache.delete(day);
    detailCache.set(day, detail);
    if (detailCache.size > DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value!);
  }

  async function loadDays(session: CalendarSession): Promise<void> {
    const token = ++session.daysToken;
    const isOpen = () => isDaysCurrent(session, token);
    publish(session, { daysStatus: "reading" });
    let state;
    try {
      state = await session.history.days();
    } catch {
      state = { status: "error" as const };
    }
    if (!isOpen()) return;
    if (state.status === "unsupported") {
      // The host has no history RPC at all: keep the previous today-only page.
      publish(session, { mode: "fallback", daysStatus: "unsupported", detail: emptyDetail(session.snapshot.selectedDay) });
      return;
    }
    if (state.status === "error") {
      // A failed read is not an old host. Keep the calendar shape while the day still reads,
      // and give both methods one automatic second try before deciding the host is unusable.
      publish(session, {
        mode: "calendar", daysStatus: "error", days: {}, extraDays: {}, firstDay: null, lastDay: null,
        slowConversationIds: [],
        notices: { directoryPartial: false, cacheError: false, skippedDatabases: [], cacheFull: [] },
      });
      const detailToken = ++session.detailToken;
      const detail = await loadDetail(session, session.snapshot.selectedDay, detailToken);
      if (!isOpen() || session.stopped || session.detailToken !== detailToken) return;
      if (detail?.fromRpc || session.dayRpcSucceeded) return;
      if (!session.errorAutoRetried) {
        session.errorAutoRetried = true;
        session.directory = null;
        detailCache.delete(session.snapshot.selectedDay);
        await loadDays(session);
        return;
      }
      // Neither method ever answered: the previous today-only page still reads the timeline.
      publish(session, {
        mode: "fallback", daysStatus: "error", days: {}, extraDays: {}, firstDay: null, lastDay: null,
        slowConversationIds: [], detail: emptyDetail(session.snapshot.selectedDay),
        notices: { directoryPartial: false, cacheError: false, skippedDatabases: [], cacheFull: [] },
      });
      return;
    }
    const result = state.snapshot;
    const days: Record<DayKey, number> = {};
    for (const entry of result.days) if (entry.count > 0) days[entry.day] = entry.count;
    publish(session, {
      mode: "calendar", daysStatus: "ready", days, extraDays: {}, firstDay: result.firstDay, lastDay: result.lastDay,
      slowConversationIds: result.slowConversationIds, notices: noticesFromDays(result),
      timeZone: session.history.timeZone,
    });
    // A detail read that started before these ids were known may have missed the slow path.
    detailCache.delete(session.snapshot.selectedDay);
    await loadDetail(session, session.snapshot.selectedDay, ++session.detailToken);
  }

  return {
    mount(input: CalendarMount) {
      if (cacheHost !== input.hostId) {
        detailCache.clear();
        cacheHost = input.hostId;
      }
      const selected = input.initialDay ?? localDateKey(now());
      const session: CalendarSession = {
        ...input, daysToken: 0, detailToken: 0, directory: null, stopped: false,
        dayRpcSucceeded: false, errorAutoRetried: false,
        snapshot: emptyCalendarSnapshot(selected, input.history.timeZone),
      };
      active = session;
      const ready = loadDays(session);
      return {
        ready,
        select(day: DayKey) {
          if (active !== session) return;
          if (session.snapshot.mode !== "calendar") return;
          // Enter and the cell's onPress can both arrive for the same day; one read is enough.
          if (session.snapshot.selectedDay === day) return;
          const token = ++session.detailToken;
          void loadDetail(session, day, token);
        },
        refresh() {
          if (active !== session) return;
          detailCache.clear();
          session.directory = null;
          session.detailToken += 1;
          void loadDays(session);
        },
        retry() {
          if (active !== session) return;
          session.directory = null;
          void loadDetail(session, session.snapshot.selectedDay, ++session.detailToken);
        },
        stop() {
          session.stopped = true;
          cancelDelay?.();
          if (active === session) active = null;
        },
      };
    },
    stop() {
      active = null;
      cancelDelay?.();
      detailCache.clear();
    },
  };
}
