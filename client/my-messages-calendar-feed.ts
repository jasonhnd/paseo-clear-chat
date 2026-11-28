import type { PaseoApi } from "@getpaseo/client";
import type { HistoryDayResult, HistoryDaysResult } from "../shared/history-rpc";
import type { HistorySource } from "./history-source";
import { startOfNextLocalDay, localDateKey } from "../shared/local-day";
import { DayKey, monthKeyOfDay, parseDayKey, type ConversationMonthCount, type MonthKey } from "./my-messages-calendar";
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
  /**
   * Messages the day's count already includes that this answer cannot list, because the
   * archive kept only their count. They are a multiset: a timeline row that matches one of
   * them by conversation and instant may be that message rather than a new one, and only as
   * many rows as there are records may be matched.
   */
  countedRows: readonly { agentId: string; at: number }[];
  conversations: number;
  progress: { done: number; total: number } | null;
  partial: readonly string[];
  failed: readonly string[];
  unavailable: readonly string[];
  /** True when at least one row came from the timeline fallback. */
  fromTimeline: boolean;
  /** The selected day's history RPC answered; its rows are already in `days`. */
  fromRpc: boolean;
  /**
   * The day counted messages this answer could not pair with the rows it read. The cell and
   * the summary keep the count; the list shows what the timeline returned; nothing claims the
   * two add up.
   */
  unreconciled: boolean;
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

/** Rows one open day's fallback read added, per conversation. */
export type CalendarConversationExtra = Readonly<Record<string, {
  count: number;
  lastAt: number;
  title: string | null;
}>>;

export interface MyMessagesCalendarSnapshot {
  mode: "calendar" | "fallback";
  daysStatus: CalendarDaysStatus;
  /** Local day key -> messages the fast path counted. */
  days: Readonly<Record<DayKey, number>>;
  /** Extra rows the timeline fallback found, per day; overwritten, never accumulated. */
  extraDays: Readonly<Record<DayKey, number>>;
  /**
   * The same extra rows split by conversation, per day; replaced on every read of that
   * day. The ranking adds them, so a cell, the summary and the ranking agree on what the
   * reader has actually seen.
   */
  extraConversations: Readonly<Record<DayKey, CalendarConversationExtra>>;
  /**
   * Per local month, the conversations that wrote anything that month and how much. Built
   * from the same merged records as `days`, so the ranking agrees with the grid; empty when
   * the host answered without the field.
   */
  conversationMonths: Readonly<Record<MonthKey, readonly ConversationMonthCount[]>>;
  /** The host's answer carried `conversationMonths` at all, even if the month is empty. */
  conversationMonthsKnown: boolean;
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
    day, status: "reading", rows: [], countedRows: [], conversations: 0, progress: null,
    partial: [], failed: [], unavailable: [], fromTimeline: false, fromRpc: false,
    unreconciled: false, rpcRows: 0,
    directoryFailed: false,
  };
}

export function emptyCalendarSnapshot(day: DayKey, timeZone = "UTC"): MyMessagesCalendarSnapshot {
  return {
    mode: "calendar", daysStatus: "reading", days: {}, extraDays: {}, extraConversations: {},
    conversationMonths: {}, conversationMonthsKnown: false,
    firstDay: null, lastDay: null,
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

/** One message's identity as the reader can rebuild it: conversation, instant and text. */
function rowKey(row: MyMessagesScreenRow): string {
  return `${row.agentId}\u0000${row.at}\u0000${row.text}`;
}

/** A count-only archive record's identity: it kept no text, only the conversation and instant. */
function countedKey(row: { agentId: string; at: number }): string {
  return `${row.agentId}\u0000${row.at}`;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Spends one occurrence of `key`, if any is left. */
function take(map: Map<string, number>, key: string): boolean {
  const left = map.get(key) ?? 0;
  if (left === 0) return false;
  if (left === 1) map.delete(key);
  else map.set(key, left - 1);
  return true;
}

function addExtra(
  extras: Record<string, { count: number; lastAt: number; title: string | null }>,
  row: MyMessagesScreenRow,
): void {
  const entry = extras[row.agentId];
  if (entry) {
    entry.count += 1;
    if (row.at > entry.lastAt) entry.lastAt = row.at;
  } else {
    extras[row.agentId] = { count: 1, lastAt: row.at, title: row.title };
  }
}

function compareRows(left: MyMessagesScreenRow, right: MyMessagesScreenRow): number {
  if (left.at !== right.at) return right.at - left.at;
  if (left.agentId !== right.agentId) return left.agentId < right.agentId ? -1 : 1;
  return left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
}

/**
 * Merge RPC and timeline rows by message identity, counting occurrences.
 *
 * The same message seen by both paths appears once; two identical messages in the same
 * millisecond are two rows, so this matches occurrences instead of keeping a set of keys.
 */
export function mergeCalendarRows(
  rpcRows: readonly MyMessagesScreenRow[],
  timelineRows: readonly MyMessagesScreenRow[],
): MyMessagesScreenRow[] {
  const remaining = new Map<string, number>();
  for (const row of rpcRows) bump(remaining, rowKey(row));
  const merged = [...rpcRows];
  for (const row of timelineRows) {
    if (take(remaining, rowKey(row))) continue;
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
  const detailCache = new Map<DayKey, { detail: CalendarDetailSnapshot; extras: CalendarConversationExtra }>();
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

  /** The fallback's contribution to one day, per conversation and in total.
   *
   * The rows are overwritten on every read of the day, never added to themselves. A failed
   * day RPC leaves the day's count unsplit, so `fallbackExtras` spreads the day's extra rows
   * over the conversations the timeline named, and the ranking gains exactly what the cell
   * gained. Records the archive kept as a count only are in `countedRows`: a timeline row
   * with the same conversation and instant is already counted and never becomes an extra.
   */
  function extraState(
    session: CalendarSession,
    detail: CalendarDetailSnapshot,
    extras: CalendarConversationExtra,
  ): Pick<MyMessagesCalendarSnapshot, "extraDays" | "extraConversations"> {
    if (detail.status !== "ready") {
      return { extraDays: { ...session.snapshot.extraDays }, extraConversations: { ...session.snapshot.extraConversations } };
    }
    const attributed = Object.values(extras).reduce((sum, entry) => sum + entry.count, 0);
    return {
      extraDays: { ...session.snapshot.extraDays, [detail.day]: attributed },
      extraConversations: { ...session.snapshot.extraConversations, [detail.day]: extras },
    };
  }

  /** Rows in a settled day that the fast path did not count, split by conversation. */
  function conversationExtras(
    detail: CalendarDetailSnapshot,
    rpcRows: readonly MyMessagesScreenRow[],
    timelineRows: readonly MyMessagesScreenRow[],
  ): CalendarConversationExtra {
    if (!detail.fromRpc) return {};
    // Both lists are multisets. The RPC's rows are the messages `history.days` counted, and
    // its count-only records are the messages it counted without keeping their text. A
    // timeline row is already counted when it matches one of the former on conversation,
    // instant and text, or when it can spend one of the latter on its conversation and
    // instant — a different message in the same millisecond is left over, so it is new.
    const counted = new Map<string, number>();
    for (const row of rpcRows) bump(counted, rowKey(row));
    const countOnly = new Map<string, number>();
    for (const row of detail.countedRows) bump(countOnly, countedKey(row));
    const extras: Record<string, { count: number; lastAt: number; title: string | null }> = {};
    for (const row of timelineRows) {
      if (take(counted, rowKey(row))) continue;
      if (take(countOnly, countedKey(row))) continue;
      addExtra(extras, row);
    }
    return extras;
  }

  /**
   * The same split when the day RPC failed.
   *
   * The day's count is known but not which messages it counted, so nothing can be paired row
   * by row. Only two things are still provable: a day that counted nothing has no message to
   * match, and a conversation the month ranking places at zero for this month cannot have
   * contributed to the day's count. Every other row stays outside the ranking and marks the
   * day `unreconciled`; the order of the rows is never used to guess.
   */
  function fallbackExtras(
    detail: CalendarDetailSnapshot,
    timelineRows: readonly MyMessagesScreenRow[],
    base: number,
    monthCounts: ReadonlyMap<string, number> | null,
  ): { extras: CalendarConversationExtra; unreconciled: boolean } {
    const extras: Record<string, { count: number; lastAt: number; title: string | null }> = {};
    if (timelineRows.length === 0) return { extras, unreconciled: false };
    if (base === 0) {
      for (const row of timelineRows) addExtra(extras, row);
      return { extras, unreconciled: false };
    }
    let unreconciled = false;
    for (const row of timelineRows) {
      // `monthCounts` is null unless the host ranked the whole month: only then does a
      // conversation missing from it provably have no message this month.
      if (monthCounts !== null && (monthCounts.get(row.agentId) ?? 0) === 0) addExtra(extras, row);
      else unreconciled = true;
    }
    return { extras, unreconciled };
  }

  async function loadDetail(session: CalendarSession, day: DayKey, token: number): Promise<CalendarDetailSnapshot | null> {
    const isOpen = () => isDetailCurrent(session, token);
    if (session.snapshot.mode !== "calendar") return null;
    const cached = detailCache.get(day);
    if (cached) {
      publish(session, { selectedDay: day, detail: cached.detail, ...extraState(session, cached.detail, cached.extras) });
      return cached.detail;
    }
    publish(session, { selectedDay: day, detail: emptyDetail(day) });

    const parts = parseDayKey(day);
    const fromMs = new Date(parts.year, parts.month - 1, parts.day).getTime();
    const until = startOfNextLocalDay(fromMs);

    let rpcRows: MyMessagesScreenRow[] = [];
    let countedRows: { agentId: string; at: number }[] = [];
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
      countedRows = [...(result.counted ?? [])];
      rpcRows = result.rows
        .map(row => ({ agentId: row.agentId, at: row.at, seq: 0, text: row.text, title: null }))
        .sort(compareRows);
      publish(session, {
        notices,
        detail: {
          ...emptyDetail(day), rows: rpcRows, countedRows: result.counted ?? [],
          conversations: countConversations(rpcRows), fromRpc, rpcRows: rpcRows.length,
        },
      });
      if (!rpcRows.length && !session.snapshot.slowConversationIds.length) {
        const ready: CalendarDetailSnapshot = {
          ...emptyDetail(day), status: "ready", fromRpc, rpcRows: 0,
          // A day with no rows can still hold count-only records; the filter and the
          // empty answer both need to know which conversation they belong to.
          countedRows,
        };
        cacheDetail(day, ready, {});
        publish(session, { detail: ready, ...extraState(session, ready, {}) });
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
      publish(session, { detail: failed, notices, ...extraState(session, failed, {}) });
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
      ...emptyDetail(day), rows: rpcRows, countedRows, conversations: countConversations(rpcRows),
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
    // Only a complete month ranking can prove that a conversation absent from it wrote
    // nothing this month; a partial one leaves every unlisted conversation unknown.
    const monthCounts = session.snapshot.conversationMonthsKnown
      && !notices.directoryPartial && !notices.cacheError && notices.skippedDatabases.length === 0
      ? new Map((session.snapshot.conversationMonths[monthKeyOfDay(day)] ?? []).map(entry => [entry.agentId, entry.count]))
      : null;
    const settled = detail.fromRpc
      ? { extras: conversationExtras(detail, rpcRows, timelineRows), unreconciled: false }
      : fallbackExtras(detail, timelineRows, session.snapshot.days[day] ?? 0, monthCounts);
    const ready: CalendarDetailSnapshot = {
      ...detail,
      status: "ready",
      rows: merged,
      conversations: countConversations(merged),
      progress: null,
      partial, failed, unavailable, fromTimeline,
      unreconciled: settled.unreconciled,
    };
    cacheDetail(day, ready, settled.extras);
    publish(session, { notices, detail: ready, ...extraState(session, ready, settled.extras) });
    return ready;
  }

  function cacheDetail(day: DayKey, detail: CalendarDetailSnapshot, extras: CalendarConversationExtra): void {
    // A partial read or a directory failure is retried when the day is opened again,
    // never replayed from cache.
    if (detail.partial.length > 0 || detail.failed.length > 0 || detail.unavailable.length > 0
      || detail.directoryFailed) return;
    detailCache.delete(day);
    detailCache.set(day, { detail, extras });
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
      publish(session, {
        mode: "fallback", daysStatus: "unsupported", conversationMonths: {}, conversationMonthsKnown: false,
        detail: emptyDetail(session.snapshot.selectedDay),
      });
      return;
    }
    if (state.status === "error") {
      // A failed read is not an old host. Keep the calendar shape while the day still reads,
      // and give both methods one automatic second try before deciding the host is unusable.
      publish(session, {
        mode: "calendar", daysStatus: "error", days: {}, extraDays: {}, extraConversations: {},
        conversationMonths: {}, conversationMonthsKnown: false,
        firstDay: null, lastDay: null,
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
        mode: "fallback", daysStatus: "error", days: {}, extraDays: {}, extraConversations: {},
        conversationMonths: {}, conversationMonthsKnown: false,
        firstDay: null, lastDay: null,
        slowConversationIds: [], detail: emptyDetail(session.snapshot.selectedDay),
        notices: { directoryPartial: false, cacheError: false, skippedDatabases: [], cacheFull: [] },
      });
      return;
    }
    const result = state.snapshot;
    const days: Record<DayKey, number> = {};
    for (const entry of result.days) if (entry.count > 0) days[entry.day] = entry.count;
    const conversationMonths: Record<MonthKey, ConversationMonthCount[]> = {};
    for (const entry of result.conversationMonths ?? []) {
      if (entry.count <= 0) continue;
      (conversationMonths[entry.month] ??= []).push({
        agentId: entry.agentId,
        title: entry.title,
        count: entry.count,
        lastAt: entry.lastAt,
      });
    }
    publish(session, {
      mode: "calendar", daysStatus: "ready", days, extraDays: {}, extraConversations: {},
      conversationMonths, conversationMonthsKnown: result.conversationMonths !== undefined,
      firstDay: result.firstDay, lastDay: result.lastDay,
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
