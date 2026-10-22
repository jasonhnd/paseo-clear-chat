import { useEffect, useState } from "react";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { isAgentMessageCall, parseAgentDelivery, type AgentDelivery } from "./agent-message";
import type { LiveToolCallPayload } from "./tool-call-data";

type Paseo = ReturnType<typeof usePaseo>;
type Messages = Map<string, AgentDelivery>;
interface CachedMessages {
  revision: string;
  messages: Promise<Messages>;
  attempted: Set<string>;
}
const caches = new WeakMap<Paseo, Map<string, CachedMessages>>();
const EMPTY: Messages = new Map();

// Retain only delivery provenance, with one shared read per host/agent revision.
// A new delivery absent from that revision's read can trigger a fresh read.
function loadMessages(paseo: Paseo, hostId: string, agentId: string, revision: string, callId: string): Promise<Messages> {
  let cache = caches.get(paseo);
  if (!cache) { cache = new Map(); caches.set(paseo, cache); }
  const key = JSON.stringify([hostId, agentId]);
  const read = (attempted: Set<string>): CachedMessages => {
    const entry: CachedMessages = { revision, attempted, messages: Promise.resolve().then(async () => {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 0, projection: "canonical" });
      if (page.error || page.gap) throw new Error("Delivery provenance unavailable");
      const messages: Messages = new Map();
      for (const { item } of page.entries) {
        if (item.type !== "tool_call" || !isAgentMessageCall(item)) continue;
        const message = parseAgentDelivery(item.agentMessage);
        if (message) messages.set(item.callId, message);
      }
      return messages;
    }).catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
      return EMPTY;
    }) };
    cache.set(key, entry);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    return entry;
  };
  const cached = cache.get(key);
  if (!cached || cached.revision !== revision) return read(new Set([callId])).messages;
  return cached.messages.then(messages => {
    if (messages.has(callId) || cached.attempted.has(callId)) return messages;
    const latest = cache.get(key);
    if (latest !== cached) return latest?.revision === revision ? latest.messages : messages;
    return read(new Set([...cached.attempted, callId])).messages;
  });
}

/** The host's plugin projection drops agentMessage; its read-only API retains it. */
export function useProjectedAgentMessage(hostId: string, agentId: string, data: LiveToolCallPayload): AgentDelivery | undefined {
  const paseo = usePaseo();
  const revision = useAgent(agentId, agent => agent.status === "running" ? "running" : `${agent.status}:${agent.updatedAt}`) ?? "unknown";
  const callId = isAgentMessageCall(data) && !parseAgentDelivery(data.agentMessage) ? data.callId : undefined;
  const requestKey = JSON.stringify([hostId, agentId, revision, callId]);
  const [loaded, setLoaded] = useState<{ requestKey: string; message?: AgentDelivery } | null>(null);
  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    void loadMessages(paseo, hostId, agentId, revision, callId).then(messages => {
      if (!cancelled) setLoaded({ requestKey, message: messages.get(callId) });
    });
    return () => { cancelled = true; };
  }, [paseo, hostId, agentId, revision, callId, requestKey]);
  return callId && loaded?.requestKey === requestKey ? loaded.message : undefined;
}
