import type { HistoryConversationMonth } from "../shared/history-rpc";
import { zoneDayKey } from "./history-reader";

/**
 * The days RPC's two aggregates, built in one pass.
 *
 * The day cells and the month ranking read the same merged records, so each record's local
 * day is converted once and its month is the first seven characters of that day key.
 * Converting the records twice — once for the cells, once for the ranking — ran the zone
 * conversion twice per message. `dayKey` is injectable so a test can count the conversions.
 *
 * Conversations the reader could not reach are simply absent; the RPC's
 * `slowConversationIds` and `directoryPartial` are what tell the client the ranking may be
 * incomplete. Order is deterministic: month, then count, then the newest message, then id.
 * The client applies its own limit for display.
 */
export interface HistoryDayAndMonthCounts {
  days: Array<{ day: string; count: number }>;
  firstDay: string | null;
  lastDay: string | null;
  conversationMonths: HistoryConversationMonth[];
}

export function countDaysAndConversationMonths(
  messages: readonly { agentId: string; at: number }[],
  timeZone: string | null | undefined,
  titles: ReadonlyMap<string, string | null> = new Map(),
  dayKey: (at: number, timeZone: string | null | undefined) => string = zoneDayKey,
): HistoryDayAndMonthCounts {
  const days = new Map<string, number>();
  const counts = new Map<string, HistoryConversationMonth>();
  for (const message of messages) {
    const day = dayKey(message.at, timeZone);
    days.set(day, (days.get(day) ?? 0) + 1);
    const month = day.slice(0, 7);
    const key = `${month}\u0000${message.agentId}`;
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
      if (message.at > entry.lastAt) entry.lastAt = message.at;
    } else {
      counts.set(key, {
        month,
        agentId: message.agentId,
        title: titles.get(message.agentId) ?? null,
        count: 1,
        lastAt: message.at,
      });
    }
  }
  const dayList = [...days.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([day, count]) => ({ day, count }));
  return {
    days: dayList,
    firstDay: dayList[0]?.day ?? null,
    lastDay: dayList.at(-1)?.day ?? null,
    conversationMonths: [...counts.values()].sort((left, right) => compareText(left.month, right.month)
      || right.count - left.count
      || right.lastAt - left.lastAt
      || compareText(left.agentId, right.agentId)),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
