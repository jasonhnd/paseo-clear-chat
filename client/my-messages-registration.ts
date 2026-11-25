import { MyMessagesPanel } from "./components/my-messages-panel";
import { messages } from "./messages";

/**
 * Where the host can find the panel.
 *
 * An agent panel is not listed in the host's own tab menu: the launcher only offers panels
 * that belong to a workspace, so a plugin's per-conversation panel is reachable only through
 * the plugin's own entry point. This module adds that entry point — one header button per
 * workspace — and opens the panel for the conversation the reader has in front.
 *
 * The header button is workspace-scoped in the plugin API (there is no per-conversation
 * header button), so the button asks which conversation is focused when it is pressed. That
 * keeps one button per workspace instead of one per conversation, and a workspace with a
 * single conversation needs no focus at all.
 */

export const MY_MESSAGES_PANEL_ID = "my-messages";
export const MY_MESSAGES_BUTTON_ID = "clear-chat-my-messages";

interface ButtonRegistration {
  update(patch: Record<string, unknown>): void;
  remove(): void;
}

interface WorkspaceEntry {
  id?: string;
}

interface AgentEntry {
  agent?: { id?: string; workspaceId?: string };
}

/** Only the host methods this feature touches; every one of them is optional on old hosts. */
export interface MyMessagesHost {
  addAgentPanel?: (contribution: {
    id: string;
    title: unknown;
    icon: string;
    Component: unknown;
  }) => (() => void) | undefined;
  addHeaderButton?: (contribution: {
    id: string;
    workspaceId: string;
    button: { title: unknown; icon: string; behavior: { kind: "action"; onPress: () => void } };
  }) => ButtonRegistration | undefined;
  openPanel?: (id: string, options: { workspaceId: string; agentId?: string }) => void;
  composers?: (selector: { focused: true } | { agentId: string }) => readonly unknown[];
  paseo?: {
    workspaces?: {
      list?: (options?: { subscribe: Record<string, never> }) => Promise<{
        entries?: readonly WorkspaceEntry[];
        subscription?: { release?: () => Promise<void> };
      }>;
      subscribe?: (handler: (update: { kind?: string; workspace?: WorkspaceEntry; id?: string }) => void) => () => void;
    };
    agents?: {
      list?: (options?: { subscribe: Record<string, never> }) => Promise<{ entries?: readonly AgentEntry[] }>;
    };
  };
}

function warn(message: string, detail?: unknown): void {
  console.warn(`Clear Chat my-messages panel ${message}`, detail);
}

/** The conversation in front of the reader, as the host resolves it. */
function focusedComposer(host: MyMessagesHost): unknown | null {
  try {
    return host.composers?.({ focused: true })[0] ?? null;
  } catch {
    return null;
  }
}

/** `{ workspaceId, agentId }` for the conversation in front, or null when it cannot be named. */
async function focusedConversation(host: MyMessagesHost, workspaceId: string): Promise<string | null> {
  let entries: readonly AgentEntry[] = [];
  try {
    entries = (await host.paseo?.agents?.list?.())?.entries ?? [];
  } catch (error) {
    warn("could not list the conversations of this workspace", error);
    return null;
  }
  const inWorkspace = entries
    .map(entry => entry.agent)
    .filter((agent): agent is { id: string; workspaceId?: string } => typeof agent?.id === "string" && agent.workspaceId === workspaceId);
  const focused = focusedComposer(host);
  if (focused) {
    for (const agent of inWorkspace) {
      try {
        if (host.composers?.({ agentId: agent.id })[0] === focused) return agent.id;
      } catch { /* One unrunnable selector must not hide the others. */ }
    }
  }
  // A workspace with one conversation has nothing to disambiguate.
  if (inWorkspace.length === 1) return inWorkspace[0]!.id;
  return null;
}

/**
 * Registers the panel and the header button that opens it.
 *
 * Returns the cleanup the host calls when the plugin stops. A host without the agent-panel
 * API keeps every other Clear Chat surface: the panel is the only thing that goes away, and
 * the reason is said once.
 */
export function registerMyMessagesPanel(client: MyMessagesHost): () => void {
  if (typeof client.addAgentPanel !== "function") {
    warn("is unavailable: this host has no agent panel API");
    return () => {};
  }
  const title = messages.message("myMessages.title");
  // A duplicate contribution (a second start without a stop) throws in the host; the panel is
  // not worth taking the answer card down for, so a failed registration only loses the panel.
  let removePanel: (() => void) | undefined;
  try {
    removePanel = client.addAgentPanel({
      id: MY_MESSAGES_PANEL_ID,
      title,
      icon: "MessageSquare",
      Component: MyMessagesPanel,
    });
  } catch (error) {
    warn("could not register the panel", error);
    return () => {};
  }

  if (typeof client.addHeaderButton !== "function" || typeof client.openPanel !== "function") {
    // An old host keeps the panel registered; nothing here can open it, and saying so on
    // every start would fill the host log with a line the reader cannot act on.
    return () => { removePanel?.(); };
  }

  const buttons = new Map<string, ButtonRegistration>();
  let workspaceStream: { release?: () => Promise<void> } | null = null;
  let stopUpdates: (() => void) | null = null;
  let stopped = false;

  const openFor = (workspaceId: string) => {
    void (async () => {
      const agentId = await focusedConversation(client, workspaceId);
      if (stopped) return;
      if (!agentId) {
        warn("cannot tell which conversation of this workspace is in front");
        return;
      }
      try {
        client.openPanel?.(MY_MESSAGES_PANEL_ID, { workspaceId, agentId });
      } catch (error) {
        warn("could not open the panel", error);
      }
    })();
  };

  const ensureButton = (workspaceId: string | undefined) => {
    if (stopped || !workspaceId || buttons.has(workspaceId)) return;
    try {
      const registration = client.addHeaderButton?.({
        id: MY_MESSAGES_BUTTON_ID,
        workspaceId,
        button: { title, icon: "MessageSquare", behavior: { kind: "action", onPress: () => openFor(workspaceId) } },
      });
      if (registration) buttons.set(workspaceId, registration);
    } catch (error) {
      // One workspace the host refuses must not stop the others from getting a button.
      warn("could not add the header button", error);
    }
  };

  const workspaces = client.paseo?.workspaces;
  if (workspaces?.list) {
    void workspaces.list({ subscribe: {} }).then(result => {
      if (stopped) {
        void result.subscription?.release?.().catch(() => {});
        return;
      }
      workspaceStream = result.subscription ?? null;
      for (const entry of result.entries ?? []) ensureButton(entry.id);
      // A workspace created later gets its button without reopening the app.
      if (typeof workspaces.subscribe === "function") {
        const stop = workspaces.subscribe(update => {
          if (update?.kind === "upsert") ensureButton(update.workspace?.id ?? update.id);
        });
        if (typeof stop === "function") stopUpdates = stop;
      }
    }).catch(error => {
      warn("could not list workspaces", error);
    });
  }

  return () => {
    stopped = true;
    stopUpdates?.();
    stopUpdates = null;
    const stream = workspaceStream;
    workspaceStream = null;
    if (stream?.release) void stream.release().catch(() => {});
    for (const registration of buttons.values()) registration.remove();
    buttons.clear();
    removePanel?.();
  };
}
