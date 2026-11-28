import type { PaseoApi } from "@getpaseo/client";
import { localDateKey, startOfLocalDay, startOfNextLocalDay } from "../shared/local-day";
import { currentTimers, nowMs } from "./my-messages-clock";
import { classifyUserMessage } from "../shared/user-message-kind";

const DIRECTORY_PAGE_SIZE = 200;
const DIRECTORY_PAGE_LIMIT = 25;
const BASE_PAGES = 40;
const MAX_PAGES = 320;
const READ_RETRIES = 2;
const READ_RETRY_DELAY_MS = 250;
const CACHE_LIMIT = 1_000;
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface Conversation {
  id: string;
  title: string | null;
  lastUserMessageAt: string;
  lastAt: number;
}

interface Message {
  at: number;
  seq: number;
  text: string;
}

export interface MyMessagesScreenRow extends Message {
  agentId: string;
  title: string | null;
}

export interface MyMessagesScreenSnapshot {
  day: string;
  status: "reading" | "ready" | "error";
  rows: readonly MyMessagesScreenRow[];
  conversations: number;
  progress: { done: number; total: number } | null;
  partial: readonly string[];
  failed: readonly string[];
  unavailable: readonly string[];
  directoryPartial: boolean;
}

export const emptyMessagesScreen: MyMessagesScreenSnapshot = {
  day: "", status: "reading", rows: [], conversations: 0, progress: null,
  partial: [], failed: [], unavailable: [], directoryPartial: false,
};

type Agents = PaseoApi["agents"];
type Timeline = ReturnType<Agents["ref"]>["timeline"];
type Cursor = NonNullable<Awaited<ReturnType<Timeline["refetch"]>>["startCursor"]>;
type Request = "refresh" | "retry";

interface ConversationRead {
  rows: readonly Message[];
  partial: boolean;
  unavailable: boolean;
}

interface CacheEntry extends ConversationRead {
  day: string;
  lastUserMessageAt: string;
}

interface ScreenMount {
  hostId: string;
  agents: Agents;
  publish(state: MyMessagesScreenSnapshot): void;
}

interface Session extends ScreenMount {
  pending: Request | null;
  day: string;
  incompleteBudgets: Map<string, number>;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Read the conversation directory, page by page. With `from` set, keep only conversations
 * whose last user message is on or after that instant and stop once a page has no such
 * candidate; without it, read every page so callers can look up titles and slow ids.
 */
async function listDirectory(agents: Agents, from: number | undefined, isOpen: () => boolean) {
  const byId = new Map<string, Conversation>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let directoryPartial = false;
  for (let page = 0; page < DIRECTORY_PAGE_LIMIT && isOpen(); page += 1) {
    const result = await agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: cursor === undefined ? { limit: DIRECTORY_PAGE_SIZE } : { limit: DIRECTORY_PAGE_SIZE, cursor },
    });
    let hasCandidate = false;
    for (const { agent: { id, title, updatedAt, lastUserMessageAt, labels } } of result.entries) {
      const lastAt = Date.parse(lastUserMessageAt ?? "");
      // The host updates these timestamps separately, so either can reach midnight first.
      if (from === undefined || !(Date.parse(updatedAt) < from && (!lastUserMessageAt || lastAt < from))) hasCandidate = true;
      if (!lastUserMessageAt || !(lastAt >= (from ?? Number.NEGATIVE_INFINITY)) || labels?.[PARENT_AGENT_ID_LABEL]?.trim()) continue;
      const previous = byId.get(id);
      if (!previous || lastAt >= previous.lastAt) byId.set(id, { id, title, lastUserMessageAt, lastAt });
    }
    if (!result.pageInfo.hasMore || (from !== undefined && !hasCandidate)) break;
    if (page + 1 === DIRECTORY_PAGE_LIMIT) {
      directoryPartial = true;
      break;
    }
    const next = result.pageInfo.nextCursor;
    if (!next || seenCursors.has(next)) throw new Error("Conversation directory returned an invalid cursor");
    seenCursors.add(next);
    cursor = next;
  }
  const conversations = [...byId.values()].sort((a, b) => b.lastAt - a.lastAt || compareIds(a.id, b.id));
  return { conversations, directoryPartial };
}

export function listConversations(agents: Agents, from: number, isOpen: () => boolean) {
  return listDirectory(agents, from, isOpen);
}

/** The whole directory: titles for any row and the metadata slow conversations need. */
export function listAllConversations(agents: Agents, isOpen: () => boolean) {
  return listDirectory(agents, undefined, isOpen);
}

export async function readConversation(
  agents: Agents, agent: Conversation, from: number, until: number, budget: number, isOpen: () => boolean,
): Promise<ConversationRead | null> {
  const { timeline } = agents.ref(agent.id);
  const rows = new Map<number, Message>();
  let sawUserMessage = false;
  let cursor: Cursor | undefined;
  for (let pages = 1; isOpen(); pages += 1) {
    const page = await timeline.refetch(cursor
      ? { direction: "before", cursor, projection: "projected" }
      : { direction: "tail", projection: "projected" });
    if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
    let crossedMidnight = false;
    for (const { item, timestamp, seqStart } of page.entries) {
      const at = Date.parse(timestamp);
      if (at < from) crossedMidnight = true;
      if (!(at >= from && at < until) || item.type !== "user_message") continue;
      sawUserMessage = true;
      const classified = classifyUserMessage(item.text);
      if (classified.kind === "human") rows.set(seqStart, { at, seq: seqStart, text: classified.text });
    }
    const partial = page.hasOlder && !crossedMidnight;
    if (!partial || pages >= budget) {
      // Machine prompts also confirm that the host could read today's history.
      const unavailable = !partial && !sawUserMessage && agent.lastAt >= from && agent.lastAt < until;
      return { rows: [...rows.values()], partial, unavailable };
    }
    const next = page.startCursor;
    if (!next || (cursor && next.epoch === cursor.epoch && next.seq >= cursor.seq)) {
      throw new Error("Timeline page did not advance its cursor");
    }
    cursor = next;
  }
  return null;
}

export async function readWithRetries(
  read: () => ReturnType<typeof readConversation>, isOpen: () => boolean, waitToRetry: () => Promise<void>,
) {
  for (let attempt = 0; attempt <= READ_RETRIES && isOpen(); attempt += 1) {
    try {
      return await read();
    } catch {
      // Restart at the tail so a stale cursor never carries over to the next attempt.
      if (attempt < READ_RETRIES && isOpen()) await waitToRetry();
    }
  }
  return null;
}

/** The plugin owns the cache and queue, even when the screen unmounts and remounts. */
export function createMyMessagesScreenFeed(now: () => number = nowMs) {
  const cache = new Map<string, CacheEntry>();
  let cacheHost: string | null = null;
  let active: Session | null = null;
  let running: Promise<void> | null = null;
  let cancelReadDelay: (() => void) | null = null;
  let stopped = false;

  function waitToRetry(): Promise<void> {
    const timers = currentTimers();
    return new Promise(resolve => {
      const finish = () => {
        cancelReadDelay = null;
        resolve();
      };
      const timer = timers.set(finish, READ_RETRY_DELAY_MS);
      cancelReadDelay = () => {
        timers.clear(timer);
        finish();
      };
    });
  }

  function closeActiveSession() {
    active = null;
    cancelReadDelay?.();
  }

  async function run(session: Session, mode: Request): Promise<void> {
    const isOpen = () => active === session;
    const startedAt = now();
    const day = localDateKey(startedAt);
    const from = startOfLocalDay(startedAt);
    const until = startOfNextLocalDay(startedAt);
    if (cacheHost !== session.hostId) {
      cache.clear();
      cacheHost = session.hostId;
    }
    for (const [id, entry] of cache) {
      if (entry.day !== day) cache.delete(id);
    }
    if (session.day !== day) {
      session.day = day;
      session.incompleteBudgets.clear();
    }
    let state = { ...emptyMessagesScreen, day };
    session.publish(state);

    let directory;
    try {
      directory = await listConversations(session.agents, from, isOpen);
    } catch {
      if (isOpen()) session.publish({ ...state, status: "error" });
      return;
    }
    if (!isOpen()) return;
    const { conversations, directoryPartial } = directory;
    const total = conversations.length;
    state = { ...state, progress: { done: 0, total }, directoryPartial };
    session.publish(state);

    const previousBudgets = session.incompleteBudgets;
    session.incompleteBudgets = new Map();
    for (const [index, agent] of conversations.entries()) {
      if (!isOpen()) return;
      const previousBudget = previousBudgets.get(agent.id);
      const budget = previousBudget === undefined ? BASE_PAGES
        : mode === "retry" ? Math.min(previousBudget * 2, MAX_PAGES) : previousBudget;
      const cached = cache.get(agent.id);
      let entry: CacheEntry | null;
      if (cached && !cached.partial && cached.lastUserMessageAt === agent.lastUserMessageAt) {
        entry = cached;
      } else {
        const result = await readWithRetries(
          () => readConversation(session.agents, agent, from, until, budget, isOpen),
          isOpen,
          waitToRetry,
        );
        if (!isOpen()) return;
        entry = result && { ...result, day, lastUserMessageAt: agent.lastUserMessageAt };
        // Insertion order tracks actual reads, so a cache hit does not postpone eviction.
        cache.delete(agent.id);
        if (entry && !entry.unavailable) cache.set(agent.id, entry);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      }
      if (!entry || entry.partial) session.incompleteBudgets.set(agent.id, budget);
      const rows = entry?.rows.length
        ? [...state.rows, ...entry.rows.map(row => ({ ...row, agentId: agent.id, title: agent.title }))]
          .sort((a, b) => b.at - a.at || b.seq - a.seq || compareIds(a.agentId, b.agentId))
        : state.rows;
      state = {
        ...state,
        rows,
        conversations: state.conversations + (entry?.rows.length ? 1 : 0),
        progress: { done: index + 1, total },
        partial: entry?.partial ? [...state.partial, agent.id] : state.partial,
        failed: entry ? state.failed : [...state.failed, agent.id],
        unavailable: entry?.unavailable ? [...state.unavailable, agent.id] : state.unavailable,
      };
      session.publish(state);
    }
    if (isOpen()) session.publish({ ...state, status: "ready" });
  }

  function request(session: Session, mode: Request): Promise<void> {
    if (active !== session) return Promise.resolve();
    if (mode === "retry" || session.pending === null) session.pending = mode;
    // A single drain owns the lock until the last in-flight request settles.
    running ??= Promise.resolve().then(async () => {
      try {
        while (active?.pending) {
          const session = active;
          const mode = active.pending;
          session.pending = null;
          await run(session, mode);
        }
      } finally {
        running = null;
      }
    });
    return running;
  }

  return {
    mount(input: ScreenMount) {
      const session: Session = { ...input, pending: null, day: "", incompleteBudgets: new Map() };
      if (!stopped) {
        closeActiveSession();
        active = session;
      }
      return {
        ready: request(session, "refresh"),
        refresh: () => request(session, "refresh"),
        retry: () => request(session, "retry"),
        stop() { if (active === session) closeActiveSession(); },
      };
    },
    stop() {
      stopped = true;
      closeActiveSession();
      cache.clear();
    },
  };
}
