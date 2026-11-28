import type { HistoryConversationMonth } from "../shared/history-rpc";
import { zoneDayKey } from "./history-reader";

/**
 * Messages each conversation contributed to each local month.
 *
 * The input is the merged record set the day cells are counted from (fast rows plus the
 * archive), so the sum over one month equals that month's calendar total. Conversations the
 * reader could not reach are simply absent; the RPC's `slowConversationIds` and
 * `directoryPartial` are what tell the client the ranking may be incomplete.
 *
 * Order is deterministic: month, then count, then the newest message, then id. The client
 * applies its own limit for display.
 */
export function countByConversationMonth(
  messages: readonly { agentId: string; at: number }[],
  timeZone: string | null | undefined,
  titles: ReadonlyMap<string, string | null> = new Map(),
): HistoryConversationMonth[] {
  const counts = new Map<string, HistoryConversationMonth>();
  for (const message of messages) {
    const month = zoneDayKey(message.at, timeZone).slice(0, 7);
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
  return [...counts.values()].sort((left, right) => compareText(left.month, right.month)
    || right.count - left.count
    || right.lastAt - left.lastAt
    || compareText(left.agentId, right.agentId));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
