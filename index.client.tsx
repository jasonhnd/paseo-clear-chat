import { publishAnswerMetadata } from "./client/answer-state-events";
import { messages } from "./client/messages";
import { initializeClientTranslations, translate as t } from "./client/translation";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { requireHostMethods, STARTUP_MESSAGES } from "./shared/startup-diagnostics";
import { ClearChatSettingsPage } from "./client/settings-page";
import { setOptionSender, setAnswerDraftStore, setAnswerStatePublisher } from "./client/option-session";
import {
  initializeEnhancerPreferences,
  getStoredAnswerDraft,
  storeAnswerDraft,
  clearStoredAnswerDraft,
} from "./client/preferences";

export default function contribute(client: PluginClientContext) {
  initializeClientTranslations(client);
  try {
    requireHostMethods(client, ["rpc", "addSettingsScreen"]);
    return registerClient(client);
  } catch (error) {
    if (error instanceof Error && error.message === STARTUP_MESSAGES.incompatibleHost) throw new Error(t("startup.incompatibleHost"));
    throw new Error(t("startup.startupFailed"));
  }
}

function registerClient(client: PluginClientContext) {
  setOptionSender((agentId, text) => client.paseo.agents.ref(agentId).send(text));
  void initializeEnhancerPreferences((contract, input) => client.rpc(contract, input));
  // Drafts of an unfinished answer card live in host settings, one entry per card.
  setAnswerDraftStore({ read: getStoredAnswerDraft, write: storeAnswerDraft, clear: clearStoredAnswerDraft });
  // Open-question counts are stored on the agent so a later surface can list them.
  setAnswerStatePublisher({
    initialize(agentId, pending, total) {
      try {
        const composer = (client as unknown as { composers?: (selector: { agentId: string }) => readonly { agent?: { metadata?: Record<string, unknown> }; setMetadata?: (patch: Record<string, unknown>) => Promise<void> }[] }).composers?.({ agentId })?.[0];
        if (!composer?.setMetadata || composer.agent?.metadata?.clearChat !== undefined) return;
        void publishAnswerMetadata(agentId, () => composer.setMetadata!({ clearChat: { pending, total, updatedAt: new Date().toISOString() } }))
          .catch(error => console.warn("Clear Chat answer metadata write failed", error));
      } catch (error) { console.warn("Clear Chat answer metadata write failed", error); }
    },
    publish(agentId, pending, total) {
      try {
        const composers = (client as unknown as { composers?: (selector: { agentId: string }) => readonly { setMetadata?: (patch: Record<string, unknown>) => Promise<void> }[] }).composers;
        const composer = composers?.({ agentId })?.[0];
        if (!composer?.setMetadata) return;
        void publishAnswerMetadata(agentId, () => composer.setMetadata!({ clearChat: { pending, total, updatedAt: new Date().toISOString() } }))
          .catch(error => console.warn("Clear Chat answer metadata write failed", error));
      } catch (error) { console.warn("Clear Chat answer metadata write failed", error); }
    },
  });

  client.addSettingsScreen({
    id: "chat-presentation",
    title: messages.message("settings.title"),
    icon: "Blocks",
    Component: ClearChatSettingsPage,
  });

  return () => {
    setOptionSender(null);
  };
}
