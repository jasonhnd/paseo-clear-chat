import { translate as t } from "./translation";
import { useEffect, useState } from "react";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { buildLiveToolCallData } from "./tool-call-data";
import { parseSystemEnvelope } from "./system-envelope";

type Paseo = ReturnType<typeof usePaseo>;
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type Entry = TimelinePage["entries"][number];

export type ReplyIdentity =
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; callId?: string; name: string };

function replyKey(item: ReplyIdentity, at: number): string {
  return JSON.stringify([item.type, at, item.type === "assistant_message" ? item.text : item.callId ?? item.name]);
}

/** Same flooring and units as the host's utils/time.ts:formatDuration. */
export function formatWorkedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return t("duration.workedZero");
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return t("duration.workedSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? t("duration.workedMinutesSeconds", { minutes, seconds: seconds % 60 }) : t("duration.workedMinutes", { minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? t("duration.workedHoursMinutes", { hours, minutes: minutes % 60 }) : t("duration.workedHours", { hours });
}

/**
 * Match host turn membership and elapsed time using the canonical timeline,
 * before replacements erase assistant_message. Only the last reply in each
 * visible response gets a label. Intermediate messages keep their own Copy.
 */
export function deriveReplyDurations(entries: readonly Entry[], running = false): Map<string, number> {
  const result = new Map<string, number>();
  let previous: Entry | undefined;
  let userAt: number | null = null;
  let lastAt = NaN;
  let turnReplies: Entry[] = [];
  let responseReply: Entry | undefined;
  const timings = new Map<Entry, number>();
  const closeTurn = () => {
    if (userAt !== null && Number.isFinite(userAt) && Number.isFinite(lastAt)) {
      for (const entry of turnReplies) timings.set(entry, Math.max(0, lastAt - userAt));
    }
  };
  const closeResponse = () => {
    const duration = responseReply && timings.get(responseReply);
    if (responseReply && duration !== undefined) {
      result.set(replyKey(responseReply.item as ReplyIdentity, Date.parse(responseReply.timestamp)), duration);
    }
    responseReply = undefined;
  };
  for (const entry of entries) {
    const sameTurn = previous && (previous.turnId !== undefined && entry.turnId !== undefined
      ? previous.turnId === entry.turnId : entry.item.type !== "user_message");
    if (!sameTurn) {
      closeTurn();
      if (entry.item.type === "user_message") closeResponse();
      userAt = entry.item.type === "user_message" ? Date.parse(entry.timestamp) : null;
      turnReplies = [];
    }
    lastAt = Date.parse(entry.timestamp);
    const item = entry.item;
    const isReply = item.type === "assistant_message" ? !parseSystemEnvelope(item.text)
      : item.type === "tool_call" && Boolean(buildLiveToolCallData(item).finalReply);
    if (isReply) {
      turnReplies.push(entry);
      responseReply = entry;
    }
    previous = entry;
  }
  // An active response has no final elapsed time yet; earlier responses do.
  if (!running) {
    closeTurn();
    closeResponse();
  }
  return result;
}

interface CachedTiming {
  revision: string;
  durations: Promise<Map<string, number>>;
}

// One read per host/agent revision, shared by every reply. Cache only derived
// timings, never a second copy of the conversation or any persistent data.
const caches = new WeakMap<Paseo, Map<string, CachedTiming>>();
const EMPTY = new Map<string, number>();

function loadDurations(paseo: Paseo, hostId: string, agentId: string, revision: string): Promise<Map<string, number>> {
  let cache = caches.get(paseo);
  if (!cache) { cache = new Map(); caches.set(paseo, cache); }
  const key = JSON.stringify([hostId, agentId]);
  const cached = cache.get(key);
  if (cached?.revision === revision) return cached.durations;
  const durations = Promise.resolve().then(async () => {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 0, projection: "canonical" });
    if (page.error || page.gap) throw new Error("Turn timing unavailable");
    return deriveReplyDurations(page.entries,
      revision === "running" || page.agent?.status === "running" || Boolean(page.agent?.activeTurn) || page.hasNewer);
  }).catch(() => {
    if (cache.get(key)?.durations === durations) cache.delete(key);
    return EMPTY;
  });
  cache.set(key, { revision, durations });
  // A long-lived plugin instance must not retain every visited conversation.
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return durations;
}

/** The SDK renderer props omit turn context; recover it through its read-only API. */
export function useReplyDuration(hostId: string, agentId: string, at: Date, reply: ReplyIdentity | null): number | undefined {
  const paseo = usePaseo();
  const revision = useAgent(agentId, agent => agent.status === "running" ? "running" : `${agent.status}:${agent.updatedAt}`) ?? "unknown";
  const key = reply ? replyKey(reply, at.getTime()) : null;
  const requestKey = JSON.stringify([hostId, agentId, revision, key]);
  const [loaded, setLoaded] = useState<{ requestKey: string; duration?: number } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void loadDurations(paseo, hostId, agentId, revision).then(durations => {
      if (!cancelled) setLoaded({ requestKey, duration: durations.get(key) });
    });
    return () => { cancelled = true; };
  }, [paseo, hostId, agentId, revision, key, requestKey]);
  return loaded?.requestKey === requestKey ? loaded.duration : undefined;
}
