import React from "react";
import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { OptionCard } from "./components/option-card";
import { buildThemeTokens } from "./components/theme-tokens";
import { messages } from "./messages";
import { getOptionSession, optionSessionAgentIds, subscribeOptionSession, useOptionSession } from "./option-session";
import { getEnhancerPreferences, subscribeEnhancerPreferences, useEnhancerPreferences } from "./preferences";

function OptionPillContent(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const session = useOptionSession(agentId);
  const preferences = useEnhancerPreferences();
  if (!session || !preferences.showAnswerCard) return null;
  return <OptionCard agentId={agentId} at={session.at} tokens={buildThemeTokens(props.theme.colors, preferences)} popover close={props.close} />;
}

export function installOptionPills(client: PluginClientContext): () => void {
  // Older supported hosts do not expose composer pills.
  if (typeof client.addComposerPill !== "function") return () => {};
  const registrations = new Map<string, { pill: ReturnType<PluginClientContext["addComposerPill"]>; count: number; at: number }>();
  const pending = new Map<string, object>();
  let stopped = false;
  const label = (count: number) => messages.message("answerCard.pill", { count });
  const reconcile = () => {
    const eligible = new Set(getEnhancerPreferences().showAnswerCard ? optionSessionAgentIds() : []);
    for (const [agentId, registration] of registrations) {
      if (!eligible.has(agentId)) { registration.pill.remove(); registrations.delete(agentId); }
    }
    for (const agentId of pending.keys()) if (!eligible.has(agentId)) pending.delete(agentId);
    for (const agentId of eligible) {
      const session = getOptionSession(agentId);
      if (!session || session.dismissed) continue;
      const count = session.set.questions.filter((_, index) => session.choices[index] === undefined).length;
      const current = registrations.get(agentId);
      if (current && current.at !== session.at) { current.pill.remove(); registrations.delete(agentId); }
      else if (current) {
        if (current.count !== count) { current.pill.update({ label: label(count), title: label(count) }); current.count = count; }
        continue;
      }
      if (pending.has(agentId)) continue;
      const request = {};
      pending.set(agentId, request);
      const handle = client.paseo.agents.ref(agentId);
      void handle.refresh().then(result => {
        if (stopped || pending.get(agentId) !== request) return;
        pending.delete(agentId);
        const latest = getOptionSession(agentId);
        const workspaceId = result?.agent.workspaceId;
        if (!workspaceId || !latest || latest.dismissed || !getEnhancerPreferences().showAnswerCard) return;
        const count = latest.set.questions.filter((_, index) => latest.choices[index] === undefined).length;
        const pill = client.addComposerPill({
          id: "open-questions", workspaceId, agentId,
          button: { title: label(count), label: label(count), icon: "MessageSquare", behavior: { kind: "popover", Content: OptionPillContent } },
        });
        registrations.set(agentId, { pill, count, at: latest.at });
      }).catch(() => { if (pending.get(agentId) === request) pending.delete(agentId); });
    }
  };
  const stopSessions = subscribeOptionSession(reconcile);
  const stopPreferences = subscribeEnhancerPreferences(reconcile);
  reconcile();
  return () => {
    stopped = true;
    stopSessions(); stopPreferences(); pending.clear();
    for (const { pill } of registrations.values()) pill.remove();
    registrations.clear();
  };
}
