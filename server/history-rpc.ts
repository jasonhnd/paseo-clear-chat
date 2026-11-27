import type { PluginServerContext } from "@getpaseo/plugin/server";
import { historyDayRpc, historyDaysRpc } from "../shared/history-rpc";
import {
  HistoryArchive,
  archiveKey,
  countByDay,
  rowsOnDay,
  type ArchiveMerge,
} from "./history-archive";
import { listHistoryConversations } from "./history-conversations";
import { readHistoryData, zoneDayKey, type HistoryMessageRow } from "./history-reader";

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
 * Each handler reads Hermes first, merges those rows into the plugin's archive, and answers
 * from the archive: a day Hermes has pruned still has its count and its text. If the archive
 * is unavailable (directory cannot be created, a write fails), the answer comes from the
 * fast rows alone and carries `cacheError: true`; the RPC itself still succeeds.
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
      const merged = await archive.merge(fast.messages);
      const flags = archiveFlags(merged);
      if (merged.cacheError) {
        return {
          ...countByDay(fast.messages, input.timeZone),
          fastConversations: fast.fastConversations,
          slowConversationIds: fast.slowConversationIds,
          skippedDatabases: fast.skippedDatabases,
          directoryPartial,
          readMs: fast.readMs,
          fromCache: 0,
          ...flags,
        };
      }
      const fastKeys = keysOf(fast.messages);
      const fromCache = merged.messages.reduce(
        (count, record) => count + (fastKeys.has(record.key) ? 0 : 1), 0,
      );
      return {
        ...countByDay(merged.messages, input.timeZone),
        fastConversations: fast.fastConversations,
        slowConversationIds: fast.slowConversationIds,
        skippedDatabases: fast.skippedDatabases,
        directoryPartial,
        readMs: fast.readMs,
        fromCache,
        ...flags,
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
      // the requested local day belong in that day's month file and answer.
      const fastDay = fast.messages.filter(row => zoneDayKey(row.at, input.timeZone) === input.day);
      const merged = await archive.merge(fastDay);
      const flags = archiveFlags(merged);
      if (merged.cacheError) {
        return { rows: rowsOnDay(fastDay, input.day, input.timeZone), directoryPartial, fromCache: 0, ...flags };
      }
      const fastKeys = keysOf(fastDay);
      const records = merged.messages
        .filter(record => typeof record.text === "string" && record.text.length > 0
          && zoneDayKey(record.at, input.timeZone) === input.day)
        .sort((left, right) => right.at - left.at
          || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
          || ((left.text ?? "") < (right.text ?? "") ? -1 : (left.text ?? "") > (right.text ?? "") ? 1 : 0));
      const fromCache = records.reduce(
        (count, record) => count + (fastKeys.has(record.key) ? 0 : 1), 0,
      );
      return {
        rows: records.map(record => ({ agentId: record.agentId, at: record.at, text: record.text! })),
        directoryPartial,
        fromCache,
        ...flags,
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

function keysOf(messages: readonly HistoryMessageRow[]): Set<string> {
  return new Set(messages.map(message => archiveKey(message.sessionId, message.at, message.text)));
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
