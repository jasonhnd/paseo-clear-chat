import type { usePaseo } from "@getpaseo/plugin/client";
import { isAgentMessageCall, parseAgentDelivery, type AgentDelivery } from "./agent-message";
import { createReplyTiming } from "./reply-timing";

type Paseo = ReturnType<typeof usePaseo>;
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type Page = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
interface DerivedTimeline {
  durations: Map<string, number>;
  messages: Map<string, AgentDelivery>;
}
interface CachedTimeline {
  revision?: string;
  pending: Promise<DerivedTimeline>;
  value: DerivedTimeline;
  cursor?: NonNullable<Page["endCursor"]>;
  timing: ReturnType<typeof createReplyTiming>;
}
const caches = new WeakMap<Paseo, Map<string, CachedTimeline>>();
const empty = (): DerivedTimeline => ({ durations: new Map(), messages: new Map() });

/** Share one incremental read across timing and delivery lookups, retaining only derived data. */
export function loadCanonicalTimeline(paseo: Paseo, hostId: string, agentId: string, revision: string): Promise<DerivedTimeline> {
  let cache = caches.get(paseo);
  if (!cache) { cache = new Map(); caches.set(paseo, cache); }
  const key = JSON.stringify([hostId, agentId]);
  let cached = cache.get(key);
  // Running rows use the last settled map, including when first opened mid-turn.
  if (revision === "running") return Promise.resolve(cached?.value ?? empty());
  if (cached?.revision === revision) return cached.pending;
  if (!cached) {
    const value = empty();
    cached = { value, pending: Promise.resolve(value), timing: createReplyTiming() };
    cache.set(key, cached);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }
  const state = cached;
  const previous = state.pending;
  state.revision = revision;
  state.pending = previous.then(async () => {
    const timeline = paseo.agents.ref(agentId).timeline;
    const cursor = state.cursor;
    let page = await timeline.refetch(cursor
      ? { direction: "after", cursor, limit: 0, projection: "canonical" }
      : { direction: "tail", limit: 0, projection: "canonical" });
    let reset = !cursor || page.reset || page.staleCursor || page.gap || (page.epoch && page.epoch !== cursor.epoch);
    // A stale cursor can already return a complete replacement tail. Use it
    // directly; otherwise allow exactly one full recovery read.
    if (cursor && reset && (page.error || page.hasOlder || page.hasNewer)) {
      page = await timeline.refetch({ direction: "tail", limit: 0, projection: "canonical" });
      reset = true;
    }
    if (page.error || page.hasNewer || (reset && page.hasOlder)) throw new Error("Canonical timeline unavailable");
    // An idle request may race the next turn. Leave the settled cursor intact.
    if (page.agent?.status === "running" || page.agent?.activeTurn) return state.value;
    const timing = reset ? createReplyTiming() : state.timing;
    const messages = new Map(reset ? [] : state.value.messages);
    timing.append(page.entries);
    for (const { item } of page.entries) {
      if (item.type !== "tool_call" || !isAgentMessageCall(item)) continue;
      const message = parseAgentDelivery(item.agentMessage);
      if (message) messages.set(item.callId, message);
    }
    state.timing = timing;
    state.cursor = page.endCursor ?? (reset ? undefined : cursor);
    state.value = { durations: timing.snapshot(), messages };
    return state.value;
  }).catch(() => state.value);
  return state.pending;
}
