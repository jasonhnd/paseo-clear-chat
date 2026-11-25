const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The host edge: which conversation the header button opens, where it opens, and what the
// reader is told when it cannot open anything. The host returns its directories a page at a
// time, so the cases here serve several pages.

function load(t) {
  const h = createToolHarness("web");
  t.after(() => h.dispose());
  return { h, registration: h.load("client/my-messages-registration.ts") };
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** A host whose agent and workspace directories span `pages`, each page served by cursor. */
function createHost(options = {}) {
  const panels = new Map();
  const buttons = new Map();
  const opens = [];
  const removed = [];
  const released = [];
  const notices = [];
  let workspaceUpdates = null;
  const agentPages = options.agentPages ?? [[{ agent: { id: "a", workspaceId: "w1" } }]];
  const workspacePages = options.workspacePages ?? [[{ id: "w1" }]];
  const focusObject = options.focus === null ? null : { id: "composer" };
  const activeAgent = options.activeAgent ?? "a";
  const listPage = (pages, extra = {}) => async input => {
    if (options.failList) throw new Error("directory unavailable");
    const index = input?.page?.cursor ? Number(input.page.cursor) : 0;
    const entries = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return { entries: entries.map(entry => ({ ...entry, ...extra })), pageInfo: { hasMore, nextCursor: hasMore ? String(index + 1) : null } };
  };
  const client = {
    addAgentPanel(value) {
      panels.set(value.id, value);
      return () => removed.push(`panel:${value.id}`);
    },
    ...(options.noHeaderButton ? {} : {
      addHeaderButton(value) {
        buttons.set(value.workspaceId, value);
        return { update() {}, remove() { removed.push(`button:${value.workspaceId}`); } };
      },
    }),
    openPanel(id, input) {
      if (options.failExplorer && input?.location === "explorer") throw new Error("Explorer is unavailable");
      if (options.failOpen) throw new Error("Panel unavailable");
      opens.push({ id, ...input });
    },
    composers(selector) {
      if (!("focused" in selector)) return selector.agentId === activeAgent && focusObject ? [focusObject] : [];
      return focusObject ? [focusObject] : [];
    },
    paseo: {
      workspaces: options.noWorkspaces ? undefined : {
        list: async input => {
          const page = await listPage(workspacePages)(input);
          return { ...page, subscription: { release: async () => { released.push("workspaces"); } } };
        },
        subscribe: handler => {
          workspaceUpdates = handler;
          return () => { workspaceUpdates = null; };
        },
      },
      agents: {
        list: async input => {
          if (options.failAgents) throw new Error("agent directory unavailable");
          const page = await listPage(agentPages)(input);
          return page;
        },
      },
    },
  };
  return {
    client,
    panels,
    buttons,
    opens,
    removed,
    released,
    notices,
    upsertWorkspace(workspace) { if (workspaceUpdates) workspaceUpdates({ kind: "upsert", workspace }); },
  };
}

test("the panel declares the pane beside the conversation and the main-pane tab", async t => {
  const { h, registration } = load(t);
  const host = createHost();
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  const panel = host.panels.get("my-messages");
  assert.ok(panel, "the agent panel is registered");
  assert.deepEqual([...panel.locations], ["explorer", "workspace"]);
  assert.equal(panel.icon, "MessageSquare");
  assert.equal(h.translations.runtime.resolve(panel.title), "What I said");
});

test("the header button opens the panel in the pane beside the conversation", async t => {
  const { registration } = load(t);
  const host = createHost();
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "a", location: "explorer" }]);
});

test("a host that cannot place the panel beside the conversation opens a tab instead", async t => {
  const { registration } = load(t);
  const host = createHost({ failExplorer: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "a", location: "workspace" }],
    "the fallback keeps the panel reachable");
});

test("the header button finds the focused conversation on a later directory page", async t => {
  const { registration } = load(t);
  // Page one carries a second conversation of the same workspace; the focused one is on page two.
  const host = createHost({
    agentPages: [
      [{ agent: { id: "b", workspaceId: "w1" } }],
      [{ agent: { id: "a", workspaceId: "w1" } }],
    ],
    activeAgent: "a",
  });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.equal(host.opens.length, 1);
  assert.equal(host.opens[0].agentId, "a", "the conversation in front, not the one on the first page");
});

test("the single-conversation fallback waits for the whole directory", async t => {
  const { h, registration } = load(t);
  const notice = h.load("client/my-messages-notice.ts");
  const seen = [];
  notice.setMyMessagesNotice(reason => seen.push(reason));
  t.after(() => notice.setMyMessagesNotice(null));
  // One conversation on each page and none in front: the button must not pick the first one.
  const host = createHost({
    agentPages: [
      [{ agent: { id: "a", workspaceId: "w1" } }],
      [{ agent: { id: "b", workspaceId: "w1" } }],
    ],
    focus: null,
  });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.equal(host.opens.length, 0, "two conversations and none in front opens nothing");
  assert.deepEqual(seen, ["pickConversation"]);
});

test("a workspace with one conversation opens it even when nothing is in front", async t => {
  const { registration } = load(t);
  const host = createHost({ focus: null, agentPages: [[{ agent: { id: "only", workspaceId: "w1" } }]] });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "only", location: "explorer" }]);
});

test("every workspace gets a button, including the ones on later pages", async t => {
  const { registration } = load(t);
  const host = createHost({ workspacePages: [[{ id: "w1" }], [{ id: "w2" }], [{ id: "w3" }]] });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle(12);
  assert.deepEqual([...host.buttons.keys()], ["w1", "w2", "w3"]);
});

test("the last directory page is not read when the first page is complete", async t => {
  const { registration } = load(t);
  const pages = [];
  const listCalls = [];
  const host = createHost({ workspacePages: [[{ id: "w1" }]] });
  const list = host.client.paseo.workspaces.list;
  host.client.paseo.workspaces.list = async input => {
    listCalls.push(input);
    return list(input);
  };
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  assert.equal(listCalls.length, 1, "a one-page workspace directory is read once");
  assert.deepEqual([...host.buttons.keys()], ["w1"]);
});

test("an unreadable directory tells the reader instead of doing nothing", async t => {
  const { h, registration } = load(t);
  const notice = h.load("client/my-messages-notice.ts");
  const seen = [];
  notice.setMyMessagesNotice(reason => seen.push(reason));
  t.after(() => notice.setMyMessagesNotice(null));
  const host = createHost({ failAgents: true });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(() => { stop(); console.warn = original; });
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.equal(host.opens.length, 0);
  assert.deepEqual(seen, ["directory"]);
  assert.ok(warnings.some(line => line.includes("could not read the agent directory")));
});

test("a workspace created later gets its own button", async t => {
  const { registration } = load(t);
  const host = createHost();
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.upsertWorkspace({ id: "w9" });
  assert.deepEqual([...host.buttons.keys()], ["w1", "w9"]);
});

test("stopping the plugin removes the panel, its buttons and the workspace stream", async t => {
  const { registration } = load(t);
  const host = createHost({ workspacePages: [[{ id: "w1" }], [{ id: "w2" }]] });
  const stop = registration.registerMyMessagesPanel(host.client);
  await settle(12);
  stop();
  assert.deepEqual(host.removed.sort(), ["button:w1", "button:w2", "panel:my-messages"]);
  assert.deepEqual(host.released, ["workspaces"]);
});

test("a host without the agent panel API keeps the rest of the plugin working", async t => {
  const { registration } = load(t);
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const stop = registration.registerMyMessagesPanel({});
  console.warn = original;
  assert.equal(typeof stop, "function");
  assert.doesNotThrow(stop);
  assert.equal(warnings.filter(line => line.includes("no agent panel API")).length, 1);
});

test("a host without the header button keeps the panel and does not throw", async t => {
  const { registration } = load(t);
  const host = createHost({ noHeaderButton: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  await settle();
  assert.ok(host.panels.get("my-messages"), "the panel still registers");
  assert.equal(host.buttons.size, 0);
  assert.doesNotThrow(stop);
});

test("a host that cannot list workspaces registers the panel and nothing else", async t => {
  const { registration } = load(t);
  const host = createHost({ noWorkspaces: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  await settle();
  assert.ok(host.panels.get("my-messages"));
  assert.equal(host.buttons.size, 0);
  assert.doesNotThrow(stop);
});
