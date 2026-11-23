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
  areEnhancerPreferencesReady,
  getEnhancerPreferences,
  getEnhancerPreferencesError,
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
const LIST_RETRY_MS = 3000;

/** One line per distinct reason: the pin is the card's only mount, so silence hides a bug. */
function warnOnce(key: string, message: string, detail?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message, detail);
}
const warned = new Set<string>();

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
  // Both calls go through the client object. Today the host closes over its own install record
  // and never reads `this`, so this is only a cheap guard against a host that does.
  const host = client as unknown as {
    addComposerPill?: (input: unknown) => { update(patch: Record<string, unknown>): void; remove(): void };
    composers?: (selector: { focused: true } | { agentId: string }) => readonly unknown[];
  };
  if (typeof host.addComposerPill !== "function" || typeof host.composers !== "function") {
    warnOnce("missing-api", "Clear Chat answer pin is unavailable: this host has no composer pill API");
    return () => {};
  }
  const composers = (selector: { focused: true } | { agentId: string }) => host.composers!(selector);
  const addComposerPill = (input: unknown) => host.addComposerPill!(input);

  /**
   * The card switch, in all three states the preferences can be in: still reading (wait, ask the
   * host for nothing), the read failed (the default is on: keep working and say so once), and
   * read (use the stored value). One predicate: the pill registration and the agent-list guard
   * must never disagree.
   */
  const showAnswerCard = () => {
    if (areEnhancerPreferencesReady()) return getEnhancerPreferences().showAnswerCard !== false;
    if (getEnhancerPreferencesError() === null) return false;
    warnOnce("preferences-failed", "Clear Chat answer pin keeps the default because the settings read failed");
    return getEnhancerPreferences().showAnswerCard !== false;
  };
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
  // A host that lists no agents must not be asked on every tick.
  let listRetryAt = 0;

  const resolveFocusedAgent = async (): Promise<AnswerPillFocus | null> => {
    // The switch is read before anything else: a turned-off pin, or one whose stored value is
    // still loading, must not spend an agent list.
    if (!showAnswerCard()) {
      cachedComposer = null;
      cachedAgent = null;
      return null;
    }
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
    if (Date.now() < listRetryAt) return null;
    const agents = await agentList();
    if (!agents.length) {
      // An empty list is a host state, not a transient miss: ask again later, and say so once.
      listRetryAt = Date.now() + LIST_RETRY_MS;
      warnOnce("empty-list", "Clear Chat answer pin found no agents on this host; retrying in the background");
      return null;
    }
    for (const agent of agents) {
      try {
        if (composers({ agentId: agent.id })[0] === composer) {
          cachedComposer = composer;
          cachedAgent = { workspaceId: agent.workspaceId, agentId: agent.id };
          listRetryAt = 0;
          return cachedAgent;
        }
      } catch { /* One unresolvable agent must not hide the others. */ }
    }
    // The composer belongs to an agent the list does not carry (background or archived): the
    // pin stays away and the list is not read again on every tick.
    listRetryAt = Date.now() + LIST_RETRY_MS;
    warnOnce("no-match", "Clear Chat answer pin cannot match the focused composer to a listed agent");
    cachedComposer = null;
    cachedAgent = null;
    return null;
  };

  const pill = createAnswerPill({
    focusedAgent: resolveFocusedAgent,
    register: addComposerPill,
    showAnswerCard,
    // The pin only needs the newest reply, so the feed reads the tail page first; `serverId`
    // only names the default client.
    startFeed: agentId => startAnswerFeed({ serverId: "", agentId, client: client.paseo, history: "tail" }).stop,
    // Plugin messages, not resolved strings: the host re-resolves them on a language switch.
    // The button is at most 160 px wide with one line: a short label keeps the count visible,
    // and the full name goes to the tooltip and screen readers.
    title: card => messages.message("answerCard.pillTitle", { chosen: card.answeredCount, total: card.questionCount }),
    label: card => messages.message("answerCard.pillLabel", { chosen: card.answeredCount, total: card.questionCount }),
    content: AnswerPillContent,
    subscribe: listener => {
      const stopSessions = subscribeOptionSession(listener);
      const stopPreferences = subscribeEnhancerPreferences(listener);
      return () => { stopSessions(); stopPreferences(); };
    },
    agentStatus: watchAgentStatus,
  });

  // `useAgent` is React-only. The pin is not, so it reads the same status from the agent
  // handle the host already keeps: `current()` when a snapshot is cached, otherwise one
  // refresh and the handle's own updates. An unknown status does not hide the button.
  const agentStatuses = new Map<string, string>();
  let watchedAgentId: string | null = null;
  let stopStatusWatch: (() => void) | null = null;
  interface AgentStatusHandle {
    readonly status?: string | null;
    current?: () => { readonly status?: string | null } | null;
    refresh?: () => Promise<{ agent?: { readonly status?: string | null } } | null>;
    subscribe?: (handler: (update: { agent?: { readonly status?: string | null } }) => void) => () => void;
  }
  function rememberStatus(agentId: string, status: unknown): void {
    if (typeof status !== "string" || agentStatuses.get(agentId) === status) return;
    agentStatuses.set(agentId, status);
    void pill.refresh();
  }
  function watchAgentStatus(agentId: string): string | null {
    if (watchedAgentId !== agentId) {
      stopStatusWatch?.();
      stopStatusWatch = null;
      watchedAgentId = agentId;
      let handle: AgentStatusHandle | null = null;
      try { handle = client.paseo.agents.ref(agentId) as AgentStatusHandle; } catch { handle = null; }
      if (handle) {
        const known = handle.current?.()?.status ?? handle.status;
        if (typeof known === "string") agentStatuses.set(agentId, known);
        try {
          const stop = handle.subscribe?.(update => rememberStatus(agentId, update?.agent?.status));
          if (typeof stop === "function") stopStatusWatch = stop;
        } catch { /* A host that does not stream updates still answers `current()`. */ }
        if (!agentStatuses.has(agentId) && handle.refresh) {
          void handle.refresh().then(result => rememberStatus(agentId, result?.agent?.status ?? handle?.current?.()?.status)).catch(() => {});
        }
      }
    }
    return agentStatuses.get(agentId) ?? null;
  }

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
    stopStatusWatch?.();
    stopStatusWatch = null;
    pill.stop();
  };
}
