import React, { useEffect } from "react";
import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext, PluginText } from "@getpaseo/plugin/client";
import { OptionCard } from "./components/option-card";
import { buildThemeTokens } from "./components/theme-tokens";
import { clearOptionPopovers, getOptionSession, getOptionSessionAgents, setOptionPopoverOpen, subscribeOptionSession } from "./option-session";
import { getEnhancerPreferences, subscribeEnhancerPreferences, useEnhancerPreferences } from "./preferences";
import { messages } from "./messages";

function QuestionPopover(props: PluginButtonContentProps) {
  const preferences = useEnhancerPreferences();
  const agentId = props.context === "agent" ? props.agentId : null;
  useEffect(() => {
    if (agentId === null) return;
    setOptionPopoverOpen(agentId, true);
    return () => setOptionPopoverOpen(agentId, false);
  }, [agentId]);
  if (props.context !== "agent") return null;
  const { theme, close } = props;
  const session = getOptionSession(props.agentId);
  if (!session) return null;
  return <OptionCard agentId={props.agentId} at={session.at} tokens={buildThemeTokens(theme.colors, preferences)} popover onSent={close} />;
}

type Entry = { at: number; count: number; registration?: PluginButtonRegistration<PluginText> };

export function installOptionPills(client: PluginClientContext): () => void {
  const add = client.addComposerPill;
  if (typeof add !== "function") return () => {};
  const entries = new Map<string, Entry>();
  let disposed = false;
  const remove = (agentId: string) => {
    const entry = entries.get(agentId);
    entries.delete(agentId);
    entry?.registration?.remove();
  };
  const countFor = (agentId: string) => {
    const session = getOptionSession(agentId)!;
    return session.set.questions.filter((_, i) => session.choices[i] === undefined).length;
  };
  const reconcile = () => {
    if (disposed) return;
    const agents = getEnhancerPreferences().showAnswerCard ? getOptionSessionAgents() : [];
    for (const [agentId, entry] of entries) {
      const session = getOptionSession(agentId);
      if (!agents.includes(agentId) || !session || session.dismissed || session.at !== entry.at) remove(agentId);
    }
    for (const agentId of agents) {
      const session = getOptionSession(agentId);
      if (!session || session.dismissed) continue;
      const count = countFor(agentId);
      const existing = entries.get(agentId);
      if (existing) {
        if (existing.count !== count) { existing.count = count; existing.registration?.update({ label: messages.message("answerCard.openQuestions", { count }) }); }
        continue;
      }
      const entry: Entry = { at: session.at, count };
      entries.set(agentId, entry);
      void client.paseo.agents.ref(agentId).refresh().then(snapshot => {
        if (disposed || entries.get(agentId) !== entry) return;
        const workspaceId = snapshot?.agent.workspaceId;
        if (!workspaceId) { entries.delete(agentId); return; }
        try {
          entry.registration = add.call(client, {
            id: "open-questions", workspaceId, agentId,
            button: { title: messages.message("answerCard.pillTitle"), label: messages.message("answerCard.openQuestions", { count: entry.count }), icon: "MessageCircle", behavior: { kind: "popover", Content: QuestionPopover } },
          });
        } catch { entries.delete(agentId); }
      }).catch(() => { if (entries.get(agentId) === entry) entries.delete(agentId); });
    }
  };
  const stopSessions = subscribeOptionSession(reconcile);
  const stopPreferences = subscribeEnhancerPreferences(reconcile);
  reconcile();
  return () => {
    disposed = true;
    stopSessions(); stopPreferences();
    for (const agentId of entries.keys()) remove(agentId);
    clearOptionPopovers();
  };
}
