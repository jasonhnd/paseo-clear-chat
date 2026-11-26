const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The host edge: which conversation the header button opens, where it opens, and what the
// reader is told when it cannot open anything. The host returns its directories a page at a
// time, so the cases here serve several pages. Nothing here needs a panel to be mounted: the
// button's own rejection is the feedback, which is what a first press looks like.

const GUIDANCE = {
  en: {
    pick: "Open a conversation in this workspace first, then press this button.",
    directory: "The conversation list could not be read. Try again in a moment.",
  },
  "zh-CN": {
    pick: "先在这个工作区打开一个对话，再点这个按钮。",
    directory: "读不到对话列表，请稍后再试。",
  },
  ja: {
    pick: "このワークスペースで会話を開いてから、このボタンを押してください。",
    directory: "会話の一覧を読めませんでした。しばらくしてからもう一度お試しください。",
  },
};

function load(t, locale = "en") {
  const h = createToolHarness("web", { locale });
  t.after(() => h.dispose());
  return { h, registration: h.load("client/my-messages-registration.ts") };
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function loadWithTimers(t) {
  const { h, registration } = load(t);
  const pending = new Map();
  const delays = [];
  let peakPending = 0;
  h.load("client/my-messages-clock.ts").setMyMessagesTimers({
    set(callback, ms) {
      const handle = {};
      delays.push(ms);
      pending.set(handle, callback);
      peakPending = Math.max(peakPending, pending.size);
      return handle;
    },
    clear(handle) { pending.delete(handle); },
  });
  return {
    registration,
    delays,
    pending,
    get peakPending() { return peakPending; },
    runNext() {
      const next = pending.entries().next().value;
      if (!next) return;
      const [handle, callback] = next;
      pending.delete(handle);
      callback();
    },
  };
}

/** A host whose agent and workspace directories span `pages`, each page served by cursor. */
function createHost(options = {}) {
  const panels = new Map();
  const buttons = new Map();
  const opens = [];
  const removed = [];
  const released = [];
  const listCalls = [];
  let workspaceUpdates = null;
  let workspaceStreamActive = false;
  let workspaceListFailures = options.workspaceListFailures ?? 0;
  const agentPages = options.agentPages ?? [[{ agent: { id: "a", workspaceId: "w1" } }]];
  const workspacePages = options.workspacePages ?? [[{ id: "w1" }]];
  let focusObject = options.focus === null ? null : { id: "composer" };
  const activeAgent = options.activeAgent ?? "a";
  const pagesOf = (pages) => async input => {
    listCalls.push({ kind: pages === agentPages ? "agents" : "workspaces", input });
    if (options.failList) throw new Error("directory unavailable");
    if (pages === workspacePages && workspaceListFailures > 0) {
      workspaceListFailures -= 1;
      throw new Error("workspace directory unavailable");
    }
    const index = input?.page?.cursor ? Number(input.page.cursor) : 0;
    const entries = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    const nextCursor = hasMore ? (options.brokenCursor ? null : String(index + 1)) : null;
    const next = options.onPage?.(index);
    if (next && next.replaceComposer) focusObject = next.replaceComposer;
    return { entries, pageInfo: { hasMore, nextCursor } };
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
    get openAttempts() { return opens.length; },
    composers(selector) {
      if (!("focused" in selector)) return selector.agentId === activeAgent && focusObject ? [focusObject] : [];
      return focusObject ? [focusObject] : [];
    },
    i18n: {
      t(definition, key) {
        const [section, name] = key.split(".");
        return definition.resources[options.locale ?? "en"][section][name];
      },
    },
    paseo: {
      workspaces: options.noWorkspaces ? undefined : {
        list: async input => {
          const page = await pagesOf(workspacePages)(input);
          if (!input?.subscribe) return page;
          workspaceStreamActive = true;
          return { ...page, subscription: { release: async () => {
            workspaceStreamActive = false;
            released.push("workspaces");
          } } };
        },
        subscribe: handler => {
          workspaceUpdates = handler;
          return () => { workspaceUpdates = null; };
        },
      },
      agents: {
        list: async input => {
          if (options.failAgents) throw new Error("agent directory unavailable");
          return pagesOf(agentPages)(input);
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
    listCalls,
    upsertWorkspace(workspace) {
      if (workspaceStreamActive) workspaceUpdates?.({ kind: "upsert", workspace });
    },
  };
}

const press = (host, workspaceId = "w1") => host.buttons.get(workspaceId).button.behavior.onPress();

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
  await press(host);
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "a", location: "explorer" }]);
});

test("a host that cannot place the panel beside the conversation opens a tab instead", async t => {
  const { registration } = load(t);
  const host = createHost({ failExplorer: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  await press(host);
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "a", location: "workspace" }],
    "the fallback keeps the panel reachable");
});

test("with no panel open and no conversation selected, the button rejects with guidance", async t => {
  for (const locale of ["en", "zh-CN", "ja"]) {
    const { registration } = load(t, locale);
    // Two conversations, neither in front, and nothing to carry a toast: exactly a first press.
    const host = createHost({
      locale,
      agentPages: [
        [{ agent: { id: "a", workspaceId: "w1" } }],
        [{ agent: { id: "b", workspaceId: "w1" } }],
      ],
      focus: null,
    });
    const stop = registration.registerMyMessagesPanel(host.client);
    await settle();
    const action = press(host);
    assert.ok(action instanceof Promise, `${locale}: the action returns a promise the host can await`);
    await assert.rejects(action, error => {
      assert.equal(error.message, GUIDANCE[locale].pick, `${locale}: localized guidance`);
      return true;
    });
    assert.equal(host.opens.length, 0, `${locale}: nothing is opened`);
    stop();
    host.client && t.diagnostic?.(`${locale} ok`);
  }
});

test("an unreadable directory rejects with its own guidance", async t => {
  const { registration } = load(t);
  const host = createHost({ locale: "en", failAgents: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  await assert.rejects(press(host), error => error.message === GUIDANCE.en.directory);
  assert.equal(host.opens.length, 0);
});

test("a directory that says there is more without a cursor is not a complete one", async t => {
  const { registration } = load(t);
  // One conversation on the first page, a second one behind a cursor the host never sends.
  const host = createHost({
    agentPages: [[{ agent: { id: "a", workspaceId: "w1" } }], [{ agent: { id: "b", workspaceId: "w1" } }]],
    focus: null,
    brokenCursor: true,
  });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  await assert.rejects(press(host), error => error.message === GUIDANCE.en.directory,
    "an incomplete directory must not fall back to its first conversation");
  assert.equal(host.opens.length, 0);
});

test("when both placements fail the error reaches the host", async t => {
  const { registration } = load(t);
  const host = createHost({ failExplorer: true, failOpen: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  await assert.rejects(press(host), error => error.message === "Panel unavailable",
    "the host's action handler turns this into its own toast");
  assert.equal(host.opens.length, 0);
});

test("a workspace directory with a broken cursor is reported as partial, not whole", async t => {
  const { registration } = load(t);
  const host = createHost({ workspacePages: [[{ id: "w1" }], [{ id: "w2" }]], brokenCursor: true });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(() => { stop(); console.warn = original; });
  await settle(12);
  assert.deepEqual([...host.buttons.keys()], ["w1"], "only the pages that were actually read get buttons");
  assert.ok(warnings.some(line => line.includes("no cursor")), `said so: ${JSON.stringify(warnings)}`);
});

test("the header button finds the focused conversation on a later directory page", async t => {
  const { registration } = load(t);
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
  await press(host);
  assert.equal(host.opens.length, 1);
  assert.equal(host.opens[0].agentId, "a", "the conversation in front, not the one on the first page");
});

test("a composer handle replaced during the read is still matched", async t => {
  const { registration } = load(t);
  // The host rebuilds composer handles as the draft changes; the read spans two pages, and the
  // handle is replaced after the first one while the same conversation stays selected.
  const host = createHost({
    agentPages: [
      [{ agent: { id: "b", workspaceId: "w1" } }],
      [{ agent: { id: "a", workspaceId: "w1" } }],
    ],
    activeAgent: "a",
    onPage: index => (index === 0 ? { replaceComposer: { id: "composer-after-typing" } } : undefined),
  });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  await press(host);
  assert.equal(host.opens.length, 1);
  assert.equal(host.opens[0].agentId, "a", "the fresh handle is compared, not the one from before the read");
});

test("the single-conversation fallback waits for the whole directory", async t => {
  const { registration } = load(t);
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
  await assert.rejects(press(host), error => error.message === GUIDANCE.en.pick,
    "two conversations and none in front must not open the first one");
  assert.equal(host.opens.length, 0);
});

test("a workspace with one conversation opens it even when nothing is in front", async t => {
  const { registration } = load(t);
  const host = createHost({ focus: null, agentPages: [[{ agent: { id: "only", workspaceId: "w1" } }]] });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  await press(host);
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "only", location: "explorer" }]);
});

test("every workspace gets a button, and the rest is read from the first page's cursor", async t => {
  const { registration } = load(t);
  const host = createHost({ workspacePages: [[{ id: "w1" }], [{ id: "w2" }], [{ id: "w3" }]] });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle(12);
  assert.deepEqual([...host.buttons.keys()], ["w1", "w2", "w3"]);
  const cursors = host.listCalls.filter(call => call.kind === "workspaces").map(call => call.input?.page?.cursor ?? null);
  assert.deepEqual(cursors, [null, "1", "2"], "the rest is read by cursor, not by starting over");
  assert.deepEqual(host.opens, []);
});

test("a one-page workspace directory is read once", async t => {
  const { registration } = load(t);
  const host = createHost({ workspacePages: [[{ id: "w1" }]] });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  assert.equal(host.listCalls.filter(call => call.kind === "workspaces").length, 1);
  assert.deepEqual([...host.buttons.keys()], ["w1"]);
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

test("a failed first workspace list retries and registers the header button", async t => {
  const { registration, delays, pending, runNext } = loadWithTimers(t);
  const host = createHost({ workspaceListFailures: 1 });
  t.after(registration.registerMyMessagesPanel(host.client));
  await settle();
  assert.equal(host.buttons.size, 0, "the first listing failed");

  runNext();
  await settle();
  assert.ok(host.buttons.has("w1"), "the second listing registers the button");
  assert.equal(host.listCalls.length, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(pending.size, 0);
});

test("a workspace listing recovers on a later capped retry and starts delivering updates", async t => {
  const clock = loadWithTimers(t);
  const host = createHost({ workspaceListFailures: 5 });
  t.after(clock.registration.registerMyMessagesPanel(host.client));
  for (const delay of [500, 1000, 2000, 30_000, 30_000]) {
    await settle();
    host.upsertWorkspace({ id: "w9" });
    assert.equal(host.buttons.size, 0, "failed subscribed listings do not deliver updates");
    assert.equal(clock.pending.size, 1, `one workspace retry is pending at ${delay} ms`);
    assert.equal(clock.delays.at(-1), delay);
    clock.runNext();
  }
  await settle();

  assert.equal(host.listCalls.length, 6);
  assert.deepEqual([...host.buttons.keys()], ["w1"], "the successful listing registers the header button");
  assert.equal(clock.pending.size, 0, "success stops the retries");
  assert.equal(clock.peakPending, 1, "retry timers never overlap");
  host.upsertWorkspace({ id: "w9" });
  assert.ok(host.buttons.has("w9"), "the successful subscribed listing enables upserts");
});

test("stopping during capped workspace list backoff cancels the scheduled retry", async t => {
  const { registration, delays, pending, runNext } = loadWithTimers(t);
  const host = createHost({ workspaceListFailures: Infinity });
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  for (let i = 0; i < 3; i += 1) {
    runNext();
    await settle();
  }
  assert.equal(host.listCalls.length, 4);
  assert.equal(pending.size, 1, "the fourth failure schedules a capped retry");
  assert.equal(delays.at(-1), 30_000);

  stop();
  assert.equal(pending.size, 0, "stopping clears the backoff timer");
  runNext();
  await settle();
  assert.equal(host.listCalls.length, 4, "no listing starts after stop");
  host.upsertWorkspace({ id: "w9" });
  assert.equal(host.buttons.size, 0);
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
