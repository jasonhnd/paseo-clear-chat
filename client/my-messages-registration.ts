import { MyMessagesPanel } from "./components/my-messages-panel";
import { messages } from "./messages";

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
 * as the conversation, on top of it. On a compact layout the host reveals its Explorer
 * overlay when the tab lands there, so the panel covers the conversation for as long as that
 * overlay is open.
 *
 * The header button is workspace-scoped in the plugin API (there is no per-conversation
 * header button), so the button asks which conversation is focused when it is pressed. That
 * keeps one button per workspace instead of one per conversation, and a workspace with a
 * single conversation needs no focus — but only once the whole directory has been read: the
 * host returns agents a page at a time, and the first page may hold neither the focused
 * conversation nor all of a workspace's conversations.
 *
 * The action returns a promise and rejects with a localized sentence when there is no
 * conversation to open. The host turns a rejected button action into its own toast, so the
 * first press — with no panel open to say anything — still tells the reader what to do.
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

export type BlockedReason = "pickConversation" | "directory";

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
    button: { title: unknown; icon: string; behavior: { kind: "action"; onPress: () => void | Promise<void> } };
  }) => ButtonRegistration | undefined;
  openPanel?: (id: string, options: { workspaceId: string; agentId?: string; location?: "workspace" | "explorer" }) => void;
  composers?: (selector: { focused: true } | { agentId: string }) => readonly unknown[];
  i18n?: { t(definition: typeof messages, key: string): string };
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

/** A sentence in the app language, resolved when the reader presses the button. */
function guidance(client: MyMessagesHost, reason: BlockedReason): string {
  const key = `myMessages.${reason}`;
  try {
    const text = client.i18n?.t(messages, key);
    if (typeof text === "string" && text) return text;
  } catch (error) {
    warn("could not translate its guidance", error);
  }
  return messages.resources.en.myMessages[reason];
}

/** The conversation in front of the reader, as the host resolves it. */
function focusedComposer(host: MyMessagesHost): unknown | null {
  try {
    return host.composers?.({ focused: true })[0] ?? null;
  } catch {
    return null;
  }
}

interface WorkspaceConversations {
  /** The conversation whose composer the host reports as focused, if any. */
  focused: string | null;
  /** Every conversation of this workspace the directory returned. */
  ids: string[];
  /** True only when the whole directory was read: a broken cursor or the page cap is not. */
  complete: boolean;
}

/**
 * Reads the agent directory page by page, then decides in one synchronous step which of its
 * conversations is the one in front.
 *
 * The comparison happens at the end on purpose: the host caches composer handles by state
 * object, so a handle captured before several page requests can be stale by the time they
 * finish even though the same conversation is still selected.
 */
async function workspaceConversations(host: MyMessagesHost, workspaceId: string): Promise<WorkspaceConversations> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
    const result = await host.paseo?.agents?.list?.(cursor
      ? { page: { limit: DIRECTORY_PAGE_SIZE, cursor } }
      : { page: { limit: DIRECTORY_PAGE_SIZE } });
    for (const entry of result?.entries ?? []) {
      const agent = entry.agent;
      if (typeof agent?.id !== "string" || agent.workspaceId !== workspaceId) continue;
      if (!ids.includes(agent.id)) ids.push(agent.id);
    }
    const info = result?.pageInfo;
    if (!info?.hasMore) {
      complete = true;
      break;
    }
    // A directory that says there is more without a cursor is not a complete directory.
    if (!info.nextCursor) break;
    cursor = info.nextCursor;
  }
  let focused: string | null = null;
  const handle = focusedComposer(host);
  if (handle) {
    for (const id of ids) {
      try {
        if (host.composers?.({ agentId: id })[0] === handle) {
          focused = id;
          break;
        }
      } catch { /* One unrunnable selector must not hide the others. */ }
    }
  }
  return { focused, ids, complete };
}

type ConversationChoice =
  | { agentId: string }
  | { blocked: BlockedReason };

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

/**
 * The rest of the workspace directory, continuing from the cursor the first page returned.
 *
 * Returns what it read plus whether it saw the end. A cursor that goes missing while the host
 * still says there is more, or the page cap, leaves `complete: false` — the caller registers
 * the buttons it has and says so in the log rather than pretending the list was whole.
 */
async function moreWorkspaceIds(
  host: MyMessagesHost,
  firstCursor: string,
): Promise<{ ids: string[]; complete: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined = firstCursor;
  for (let page = 0; page < MAX_DIRECTORY_PAGES && cursor; page += 1) {
    const result: DirectoryPage<WorkspaceEntry> | undefined =
      await host.paseo?.workspaces?.list?.({ page: { limit: DIRECTORY_PAGE_SIZE, cursor } });
    for (const entry of result?.entries ?? []) {
      if (typeof entry.id === "string" && entry.id && !ids.includes(entry.id)) ids.push(entry.id);
    }
    const info: PageInfo | undefined = result?.pageInfo;
    if (!info?.hasMore) return { ids, complete: true };
    if (!info.nextCursor) {
      warn("workspace directory has more pages but no cursor; the list may be partial");
      return { ids, complete: false };
    }
    cursor = info.nextCursor;
  }
  warn("workspace directory hit the page cap; the list may be partial");
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
    let besideFailure: unknown = null;
    try {
      client.openPanel?.(MY_MESSAGES_PANEL_ID, { workspaceId, agentId, location: "explorer" });
      return;
    } catch (error) {
      besideFailure = error;
      warn("could not open the panel beside the conversation", error);
    }
    try {
      client.openPanel?.(MY_MESSAGES_PANEL_ID, { workspaceId, agentId, location: "workspace" });
    } catch (error) {
      warn("could not open the panel", error);
      // Nothing opened: the host's action handler turns this into its own toast.
      throw error ?? besideFailure;
    }
  };

  /**
   * The button's action. Its rejection is the feedback: the host shows the message in its own
   * toast, which works on the very first press, before any panel is open.
   */
  const openFor = async (workspaceId: string): Promise<void> => {
    let choice: ConversationChoice;
    try {
      choice = await chooseConversation(client, workspaceId);
    } catch (error) {
      warn("could not read the agent directory", error);
      // A directory that cannot be read is not an empty one: say so, do not guess.
      throw new Error(guidance(client, "directory"));
    }
    if (stopped) return;
    if ("blocked" in choice) throw new Error(guidance(client, choice.blocked));
    openBeside(workspaceId, choice.agentId);
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
      // buttons from the page after this one, not by starting over.
      const next = first.pageInfo?.hasMore ? first.pageInfo.nextCursor : null;
      if (next) {
        void moreWorkspaceIds(client, next).then(rest => {
          if (stopped) return;
          for (const id of rest.ids) ensureButton(id);
        }).catch(error => warn("could not read the rest of the workspace directory", error));
      } else if (first.pageInfo?.hasMore) {
        warn("workspace directory has more pages but no cursor; the list may be partial");
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
