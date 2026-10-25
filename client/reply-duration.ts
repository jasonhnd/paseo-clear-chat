import { useEffect, useState } from "react";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { loadCanonicalTimeline } from "./canonical-timeline";
import { replyKey, type ReplyIdentity } from "./reply-timing";

export { deriveReplyDurations, formatWorkedDuration, type ReplyIdentity } from "./reply-timing";

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
    void loadCanonicalTimeline(paseo, hostId, agentId, revision).then(({ durations }) => {
      if (!cancelled) setLoaded({ requestKey, duration: durations.get(key) });
    });
    return () => { cancelled = true; };
  }, [paseo, hostId, agentId, revision, key, requestKey]);
  return loaded?.requestKey === requestKey ? loaded.duration : undefined;
}
