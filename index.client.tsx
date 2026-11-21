import { publishAnswerMetadata } from "./client/answer-state-events";
import { messages } from "./client/messages";
import { initializeClientTranslations, translate as t } from "./client/translation";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { requireHostMethods, STARTUP_MESSAGES } from "./shared/startup-diagnostics";
import { ClearChatSettingsPage } from "./client/settings-page";
import { setOptionSender, setAnswerDraftStore, setAnswerStatePublisher } from "./client/option-session";
import { startAnswerFeed } from "./client/answer-feed";
import { createAnswerPill, type AnswerPillFocus } from "./client/answer-pill";
import { AnswerPillContent } from "./client/components/answer-pill-content";
import {
  initializeEnhancerPreferences,
  getEnhancerPreferences,
  getStoredAnswerDraft,
  storeAnswerDraft,
  clearStoredAnswerDraft,
  subscribeEnhancerPreferences,
} from "./client/preferences";
import { subscribeOptionSession } from "./client/option-session";

/**
 * How often the plugin looks for the conversation in front of the user.
 *
 * The host has no focused-agent hook for plugins: `composers({ focused: true })` resolves the
 * focused composer, but a plugin can only observe it from a component it mounts, and a card
 * keeps its pin across layouts (a composer item never mounts on compact layouts). A timer is
 * therefore the only layout-independent trigger. Each tick is a synchronous resolve; the agent
 * list is read only when the resolved composer is not the one cached.
 */
const FOCUS_POLL_MS = 750;

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

  const stopAnswerPill = registerAnswerPill(client);

  return () => {
    stopAnswerPill();
    setOptionSender(null);
  };
}

/**
 * The answer card as a composer pill above the input.
 *
 * The host matches a pin to a composer by agent id, so a pin registered for one conversation
 * never draws in another. Hosts without `addComposerPill` (and hosts whose composer surface is
 * not readable) keep every other screen: the pin is the only thing that goes away.
 */
function registerAnswerPill(client: PluginClientContext): () => void {
  const pillApi = (client as unknown as { addComposerPill?: (input: unknown) => { update(patch: Record<string, unknown>): void; remove(): void } }).addComposerPill;
  const composerApi = (client as unknown as { composers?: (selector: { focused: true } | { agentId: string }) => readonly unknown[] }).composers;
  if (typeof pillApi !== "function" || typeof composerApi !== "function") return () => {};
  const composers = composerApi;

  const focusedComposer = (): unknown | null => {
    try { return composers({ focused: true })[0] ?? null; } catch { return null; }
  };
  // The agent list is only read when the composer in front is not the cached one, so typing
  // (which rebuilds the composer handle) costs no round trip.
  const agentList = async (): Promise<{ id: string; workspaceId: string }[]> => {
    try {
      const result = await (client.paseo.agents as unknown as { list?: () => Promise<{ entries?: readonly { agent?: { id?: string; workspaceId?: string } }[] }> }).list?.();
      const entries = result?.entries ?? [];
      const found: { id: string; workspaceId: string }[] = [];
      for (const entry of entries) {
        if (entry.agent?.id && entry.agent.workspaceId) found.push({ id: entry.agent.id, workspaceId: entry.agent.workspaceId });
      }
      return found;
    } catch (error) {
      console.warn("Clear Chat answer pin could not list agents", error);
      return [];
    }
  };

  let cachedComposer: unknown = null;
  let cachedAgent: AnswerPillFocus | null = null;

  const resolveFocusedAgent = async (): Promise<AnswerPillFocus | null> => {
    const composer = focusedComposer();
    if (!composer) {
      cachedComposer = null;
      cachedAgent = null;
      return null;
    }
    if (composer === cachedComposer && cachedAgent) return cachedAgent;
    if (cachedAgent) {
      try {
        if (composers({ agentId: cachedAgent.agentId })[0] === composer) {
          cachedComposer = composer;
          return cachedAgent;
        }
      } catch { /* Fall through to the agent list. */ }
    }
    for (const agent of await agentList()) {
      try {
        if (composers({ agentId: agent.id })[0] === composer) {
          cachedComposer = composer;
          cachedAgent = { workspaceId: agent.workspaceId, agentId: agent.id };
          return cachedAgent;
        }
      } catch { /* One unresolvable agent must not hide the others. */ }
    }
    cachedComposer = null;
    cachedAgent = null;
    return null;
  };

  const pill = createAnswerPill({
    focusedAgent: resolveFocusedAgent,
    register: input => pillApi(input),
    showAnswerCard: () => getEnhancerPreferences().showAnswerCard !== false,
    // The feed reads this host's timeline; `serverId` only names the default client.
    startFeed: agentId => startAnswerFeed({ serverId: "", agentId, client: client.paseo }).stop,
    title: () => t("answerCard.pillTitle"),
    label: card => card
      ? t("answerCard.pillLabel", { chosen: card.answeredCount, total: card.questionCount })
      : t("answerCard.pillTitle"),
    content: AnswerPillContent,
    subscribe: listener => {
      const stopSessions = subscribeOptionSession(listener);
      const stopPreferences = subscribeEnhancerPreferences(listener);
      return () => { stopSessions(); stopPreferences(); };
    },
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    await pill.refresh();
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, FOCUS_POLL_MS);
    // A pending timer must not keep a test process (or a quitting app) alive.
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    pill.stop();
  };
}
