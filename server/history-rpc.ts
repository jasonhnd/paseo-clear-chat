import type { PluginServerContext } from "@getpaseo/plugin/server";
import { historyDayRpc, historyDaysRpc } from "../shared/history-rpc";
import {
  HistoryArchive,
  rowsOnDay,
  type ArchiveMerge,
} from "./history-archive";
import { listHistoryConversations } from "./history-conversations";
import { countDaysAndConversationMonths } from "./history-conversation-months";
import { readHistoryData, zoneDayKey } from "./history-reader";

/**
 * The two history RPCs, registered only when the host accepts them.
 *
 * Registration is additive: a host without `handle`, or with a `handle` that refuses this
 * contract shape, keeps settings and every other feature, and the client wrapper reports the
 * reader as unsupported instead of the plugin failing to load. The same goes for the
 * handler's own work: when `context.paseo.agents.list` fails, the call rejects, which the
 * client wrapper turns into an error state.
 *
 * Both contracts have the same shape, so a host that accepts the first accepts the second.
 * Paseo's plugin context has no way to withdraw a registered contract, so a host that refused
 * the second would leave the first registered. The handlers share a completion flag set only
 * after both registrations succeed; an incomplete registration refuses every call, so the
 * daemon never serves half a surface. The client also asks for both calls or neither
 * (`createHistorySource` reports unsupported unless both exist).
 *
 * The days RPC reads Hermes, aligns the archive with every session that read completed, and
 * answers from the archive. The day RPC is read-only: it answers the fast rows for the
 * sessions this read completed plus the archived rows of sessions Hermes no longer has, and
 * writes nothing. If the archive is unavailable, the answer comes from the fast rows alone
 * and carries `cacheError: true`; the RPC itself still succeeds.
 */

export interface HistoryHandlerOptions {
  /** Injected by tests so no test ever opens the real Hermes data directory. */
  root?: string;
  /** Paseo home for the archive; injected by tests, defaulted from PASEO_HOME at merge time. */
  home?: string;
  /** Month size cap for the archive; injected small by tests. */
  maxMonthBytes?: number;
  now?: () => number;
}

export function registerHistoryHandlers(
  server: Pick<PluginServerContext, "handle"> | null | undefined,
  options: HistoryHandlerOptions = {},
): boolean {
  if (!server || typeof server.handle !== "function") return false;
  // Set only after both registrations succeed; a handler that runs before then refuses.
  const registration = { complete: false };
  const archive = new HistoryArchive({
    home: options.home,
    maxMonthBytes: options.maxMonthBytes,
    now: options.now,
  });
  try {
    server.handle(historyDaysRpc, async (input, context) => {
      requireCompleteRegistration(registration);
      const { conversations, directoryPartial } = await listHistoryConversations(context.paseo);
      const fast = readHistoryData({ conversations, root: options.root, timeZone: input.timeZone });
      // A partial directory has not seen every conversation; the sessions it did not see
      // are not proof that Hermes dropped them, so only the read set is authoritative.
      const authoritative = directoryPartial ? fast.readSessions : fast.presentSessions;
      const merged = await archive.merge(fast.messages, fast.readSessions, authoritative);
      const presentSessions = new Set(authoritative);
      // One pass over the merged records answers both the day cells and the month ranking:
      // each message's local day is converted once and its month comes from that day key.
      const counts = countDaysAndConversationMonths(
        merged.messages,
        input.timeZone,
        new Map(conversations.map(conversation => [conversation.id, conversation.title ?? null])),
      );
      return {
        days: counts.days,
        firstDay: counts.firstDay,
        lastDay: counts.lastDay,
        conversationMonths: counts.conversationMonths,
        fastConversations: fast.fastConversations,
        slowConversationIds: fast.slowConversationIds,
        skippedDatabases: fast.skippedDatabases,
        directoryPartial,
        readMs: fast.readMs,
        fromCache: merged.messages.reduce(
          (count, record) => count + (presentSessions.has(record.sessionId) ? 0 : 1), 0,
        ),
        ...archiveFlags(merged),
      };
    });
    server.handle(historyDayRpc, async (input, context) => {
      requireCompleteRegistration(registration);
      const { conversations, directoryPartial } = await listHistoryConversations(context.paseo);
      const fast = readHistoryData(
        { conversations, root: options.root, timeZone: input.timeZone },
        input.day,
      );
      // The reader's day window reaches into the neighbouring days on purpose; only rows on
      // the requested local day belong in that day's answer.
      const fastDay = fast.messages.filter(row => zoneDayKey(row.at, input.timeZone) === input.day);
      const store = await archive.read();
      if (store.cacheError) {
        return {
          rows: rowsOnDay(fastDay, input.day, input.timeZone),
          counted: [],
          directoryPartial,
          fromCache: 0,
          cacheError: true,
        };
      }
      // Use the same authoritative set as history.days: a partial directory cannot prove
      // that an unlisted session was dropped, so its archive rows stay visible.
      const presentSessions = new Set(directoryPartial ? fast.readSessions : fast.presentSessions);
      // A session still in a complete database is Hermes's (whether or not a conversation
      // points at it), so only sessions missing from every readable database come from the
      // archive: Hermes deleted them, or their database is unreadable now.
      const archived = store.messages.filter(record => !presentSessions.has(record.sessionId)
        && typeof record.text === "string" && record.text.length > 0
        && zoneDayKey(record.at, input.timeZone) === input.day);
      // A count-only record has no row to show but its message is already in `history.days`.
      // Naming it lets the client drop the same message when the timeline finds it again.
      const counted = store.messages.filter(record => !presentSessions.has(record.sessionId)
        && (typeof record.text !== "string" || record.text.length === 0)
        && zoneDayKey(record.at, input.timeZone) === input.day)
        .map(record => ({ agentId: record.agentId, at: record.at }));
      const rows = [
        ...rowsOnDay(fastDay, input.day, input.timeZone),
        ...rowsOnDay(archived, input.day, input.timeZone),
      ].sort((left, right) => right.at - left.at
        || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
        || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
      return {
        rows,
        counted,
        directoryPartial,
        fromCache: archived.length,
      };
    });
    registration.complete = true;
    return true;
  } catch {
    // A host can expose `handle` for its own contract set and reject these methods. The
    // reader then stays unavailable; nothing else in the plugin depends on it.
    registration.complete = false;
    return false;
  }
}

function archiveFlags(merged: ArchiveMerge): { cacheError?: boolean; cacheFull?: string[] } {
  return {
    ...(merged.cacheError ? { cacheError: true as const } : {}),
    ...(merged.cacheFull.length > 0 ? { cacheFull: merged.cacheFull } : {}),
  };
}

function requireCompleteRegistration(registration: { complete: boolean }): void {
  if (!registration.complete) throw new Error("Clear Chat history reader is unavailable");
}
