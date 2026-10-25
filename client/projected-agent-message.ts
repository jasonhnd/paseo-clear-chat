import { useEffect, useMemo, useState } from "react";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { agentSenderTitle, isAgentMessageCall, parseAgentDelivery, type AgentDelivery } from "./agent-message";
import type { LiveToolCallPayload } from "./tool-call-data";
import { loadCanonicalTimeline } from "./canonical-timeline";

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
    void loadCanonicalTimeline(paseo, hostId, agentId, revision).then(({ messages }) => {
      if (!cancelled) setLoaded({ requestKey, message: messages.get(callId) });
    });
    return () => { cancelled = true; };
  }, [paseo, hostId, agentId, revision, callId, requestKey]);
  const message = useMemo(() => parseAgentDelivery(data.agentMessage)
    ?? (callId && loaded?.requestKey === requestKey ? loaded.message : undefined),
  [data.agentMessage, callId, loaded, requestKey]);
  // The public host snapshot can supply the title omitted at delivery time.
  // Unknown or unloaded senders yield null; never substitute their ID.
  const title = useAgent(message?.sender.id ?? "", agent => agent.title);
  return useMemo(() => {
    if (!message) return undefined;
    const ids = [message.sender.id, data.callId, agentId];
    const name = agentSenderTitle(message.sender.title, ...ids) ?? agentSenderTitle(title, ...ids);
    return { ...message, sender: { id: message.sender.id, ...(name ? { title: name } : {}) } };
  }, [message, title, data.callId, agentId]);
}
