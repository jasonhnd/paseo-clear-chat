import type { PaseoApi } from "@getpaseo/client";
import type { HistoryConversation } from "./history-reader";

/**
 * The conversation list the history reader works from.
 *
 * It is the same directory the "What I said" screen reads: every agent the daemon will list,
 * archived included, one page at a time. Unlike that screen, this never stops early on
 * "older than today" — the calendar asks about all of history, so every page is walked.
 * Child agents are skipped: their work belongs to the parent conversation, and a sub-agent
 * reuses no Hermes session of its own to count.
 *
 * A page limit reached with more pages left returns `directoryPartial: true`, the same flag
 * the screen sets. A missing or repeated cursor is a broken directory, and is thrown, exactly
 * as the screen throws, so the RPC rejects and the client shows its error state rather than
 * silently counting part of the history.
 */

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** Same page the screen uses; the daemon's default and maximum for this request. */
const PAGE_SIZE = 200;
/** 50 pages is 10,000 conversations, well past any directory seen on a real host. */
const PAGE_LIMIT = 50;

export interface HistoryConversationList {
  conversations: HistoryConversation[];
  /** True when the walk stopped at the page limit with more pages still reported. */
  directoryPartial: boolean;
}

export async function listHistoryConversations(paseo: PaseoApi): Promise<HistoryConversationList> {
  const found = new Map<string, HistoryConversation>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let directoryPartial = false;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
    });
    for (const { agent } of result.entries) {
      if (!agent?.id || found.has(agent.id)) continue;
      if (agent.labels?.[PARENT_AGENT_ID_LABEL]?.trim()) continue;
      found.set(agent.id, {
        id: agent.id,
        sessionId: agent.runtimeInfo?.sessionId ?? null,
        lastActiveAt: lastActiveAt(agent),
      });
    }
    if (!result.pageInfo?.hasMore) break;
    if (page + 1 === PAGE_LIMIT) {
      directoryPartial = true;
      break;
    }
    const next = result.pageInfo.nextCursor;
    if (!next || seenCursors.has(next)) {
      throw new Error("Conversation directory returned an invalid cursor");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return { conversations: [...found.values()], directoryPartial };
}

function lastActiveAt(agent: { lastUserMessageAt?: string | null; updatedAt?: string }): number {
  const lastMessage = Date.parse(agent.lastUserMessageAt ?? "");
  if (Number.isFinite(lastMessage)) return lastMessage;
  const updated = Date.parse(agent.updatedAt ?? "");
  return Number.isFinite(updated) ? updated : 0;
}
