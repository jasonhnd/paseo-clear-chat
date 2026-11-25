import { MyMessagesPanel } from "./components/my-messages-panel";
import { messages } from "./messages";
import { tellMyMessages, type MyMessagesNoticeReason } from "./my-messages-notice";

/**
 * Where the host can find the panel, and the button that opens it.
 *
 * An agent panel is not listed in the host's own tab menu: the launcher only offers panels
 * that belong to a workspace, so a plugin's per-conversation panel is reachable only through
 * the plugin's own entry point. This module adds that entry point — one header button per
 * workspace — and opens the panel for the conversation the reader has in front.
 *
 * The panel declares two locations. On a wide layout it opens in the explorer pane, which the
 * host puts beside the conversation; the plain workspace location puts a tab in the same pane
 * as the conversation, on top of it. A compact layout has no adjacent pane to reveal, so the
 * host adds the tab to the explorer pane without unhiding it and the tab waits in that pane's
 * tab bar.
 *
 * The header button is workspace-scoped in the plugin API (there is no per-conversation
 * header button), so the button asks which conversation is focused when it is pressed. That
 * keeps one button per workspace instead of one per conversation, and a workspace with a
 * single conversation needs no focus — but only once the whole directory has been read: the
 * host returns agents a page at a time, and the first page may hold neither the focused
 * conversation nor all of a workspace's conversations.
 */

export const MY_MESSAGES_PANEL_ID = "my-messages";
export const MY_MESSAGES_BUTTON_ID = "clear-chat-my-messages";
/** Adjacent desktop pane first; the main-pane tab is the fallback a compact layout needs. */
export const MY_MESSAGES_LOCATIONS = ["explorer", "workspace"] as const;

/** Directory pages one press may read before it stops guessing. */
const MAX_DIRECTORY_PAGES = 25;
const DIRECTORY_PAGE_SIZE = 200;

interface ButtonRegistration {
  update(patch: Record<string, unknown>): void;
  remove(): void;
}

interface PageInfo {
  hasMore?: boolean;
  nextCursor?: string | null;
}

interface WorkspaceEntry {
  id?: string;
}

interface AgentEntry {
  agent?: { id?: string; workspaceId?: string };
}

interface DirectoryPage<Entry> {
  entries?: readonly Entry[];
  pageInfo?: PageInfo;
  subscription?: { release?: () => Promise<void> };
}

interface DirectoryListOptions {
  subscribe?: Record<string, never>;
  page?: { limit: number; cursor?: string };
}

/** Only the host methods this feature touches; every one of them is optional on old hosts. */
export interface MyMessagesHost {
  addAgentPanel?: (contribution: {
    id: string;
    title: unknown;
    icon: string;
    locations: readonly string[];
    Component: unknown;
  }) => (() => void) | undefined;
  addHeaderButton?: (contribution: {
    id: string;
    workspaceId: string;
    button: { title: unknown; icon: string; behavior: { kind: "action"; onPress: () => void } };
  }) => ButtonRegistration | undefined;
  openPanel?: (id: string, options: { workspaceId: string; agentId?: string; location?: "workspace" | "explorer" }) => void;
  composers?: (selector: { focused: true } | { agentId: string }) => readonly unknown[];
  paseo?: {
    workspaces?: {
      list?: (options?: DirectoryListOptions) => Promise<DirectoryPage<WorkspaceEntry>>;
      subscribe?: (handler: (update: { kind?: string; workspace?: WorkspaceEntry; id?: string }) => void) => () => void;
    };
    agents?: {
      list?: (options?: DirectoryListOptions) => Promise<DirectoryPage<AgentEntry>>;
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

function agentHasFocusedComposer(host: MyMessagesHost, agentId: string, focused: unknown): boolean {
  if (!focused) return false;
  try {
    return host.composers?.({ agentId })[0] === focused;
  } catch {
    return false;
  }
}

interface WorkspaceConversations {
  /** The conversation whose composer the host reports as focused, if a page held it. */
  focused: string | null;
  /** Every conversation of this workspace the directory returned. */
  ids: string[];
  /** True when the whole directory was read, so `ids` is complete. */
  complete: boolean;
}

/** Reads the agent directory page by page until the focused conversation is found or it ends. */
async function workspaceConversations(host: MyMessagesHost, workspaceId: string): Promise<WorkspaceConversations> {
  const ids: string[] = [];
  const focused = focusedComposer(host);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
    const result = await host.paseo?.agents?.list?.(cursor
      ? { page: { limit: DIRECTORY_PAGE_SIZE, cursor } }
      : { page: { limit: DIRECTORY_PAGE_SIZE } });
    for (const entry of result?.entries ?? []) {
      const agent = entry.agent;
      if (typeof agent?.id !== "string" || agent.workspaceId !== workspaceId) continue;
      if (!ids.includes(agent.id)) ids.push(agent.id);
      if (agentHasFocusedComposer(host, agent.id, focused)) return { focused: agent.id, ids, complete: false };
    }
    const info = result?.pageInfo;
    if (!info?.hasMore || !info.nextCursor) return { focused: null, ids, complete: true };
    cursor = info.nextCursor;
  }
  return { focused: null, ids, complete: false };
}

type ConversationChoice =
  | { agentId: string }
  | { blocked: MyMessagesNoticeReason };

/**
 * Which conversation the button should open.
 *
 * The focused conversation wins wherever it sits in the directory. The single-conversation
 * fallback is only safe once every page has been read: a workspace with two conversations,
 * one of them on a later page, must never open the first one behind the reader's back.
 */
async function chooseConversation(host: MyMessagesHost, workspaceId: string): Promise<ConversationChoice> {
  const found = await workspaceConversations(host, workspaceId);
  if (found.focused) return { agentId: found.focused };
  if (!found.complete) return { blocked: "directory" };
  if (found.ids.length === 1) return { agentId: found.ids[0]! };
  return { blocked: "pickConversation" };
}

/** Every workspace that gets a button, read page by page. */
async function allWorkspaceIds(host: MyMessagesHost): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
    const result = await host.paseo?.workspaces?.list?.(cursor
      ? { page: { limit: DIRECTORY_PAGE_SIZE, cursor } }
      : { page: { limit: DIRECTORY_PAGE_SIZE } });
    for (const entry of result?.entries ?? []) {
      if (typeof entry.id === "string" && entry.id && !ids.includes(entry.id)) ids.push(entry.id);
    }
    const info = result?.pageInfo;
    if (!info?.hasMore || !info.nextCursor) return { ids, complete: true };
    cursor = info.nextCursor;
  }
  return { ids, complete: false };
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
      locations: MY_MESSAGES_LOCATIONS,
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

  /**
   * Opens the panel beside the conversation, and falls back to a tab in the main pane when
   * the host cannot place it there (a compact layout with no explorer pane, for instance).
   */
  const openBeside = (workspaceId: string, agentId: string): void => {
    try {
      client.openPanel?.(MY_MESSAGES_PANEL_ID, { workspaceId, agentId, location: "explorer" });
      return;
    } catch (error) {
      warn("could not open the panel beside the conversation", error);
    }
    try {
      client.openPanel?.(MY_MESSAGES_PANEL_ID, { workspaceId, agentId, location: "workspace" });
    } catch (error) {
      warn("could not open the panel", error);
    }
  };

  const openFor = (workspaceId: string): void => {
    void (async () => {
      let choice: ConversationChoice;
      try {
        choice = await chooseConversation(client, workspaceId);
      } catch (error) {
        warn("could not read the agent directory", error);
        if (!stopped) tellMyMessages("directory");
        return;
      }
      if (stopped) return;
      if ("blocked" in choice) {
        tellMyMessages(choice.blocked);
        return;
      }
      openBeside(workspaceId, choice.agentId);
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
    void workspaces.list({ subscribe: {}, page: { limit: DIRECTORY_PAGE_SIZE } }).then(first => {
      if (stopped) {
        void first.subscription?.release?.().catch(() => {});
        return;
      }
      workspaceStream = first.subscription ?? null;
      for (const entry of first.entries ?? []) ensureButton(entry.id);
      // A workspace created later gets its button without reopening the app.
      if (typeof workspaces.subscribe === "function") {
        const stop = workspaces.subscribe(update => {
          if (update?.kind === "upsert") ensureButton(update.workspace?.id ?? update.id);
        });
        if (typeof stop === "function") stopUpdates = stop;
      }
      // A long directory does not fit in one page: the rest of the workspaces get their
      // buttons from the pages after it.
      if (first.pageInfo?.hasMore) {
        void allWorkspaceIds(client).then(rest => {
          if (stopped) return;
          for (const id of rest.ids) ensureButton(id);
        }).catch(error => warn("could not read the rest of the workspace directory", error));
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
