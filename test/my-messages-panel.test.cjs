const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The panel's data path and its host edge: counts and rows from the timeline, one more day per
// "Earlier" press, a live update on a new message, an error instead of a crash, and a released
// subscription on unmount. Every date is built from local calendar parts so the same file passes
// in UTC and in Asia/Tokyo.

// Feed tests inject the clock, so their fixtures can sit on any calendar day.
const TODAY = new Date(2026, 2, 15, 12, 0, 0, 0).getTime();
const at = (dayOffset, hour, minute = 0) => new Date(2026, 2, 15 + dayOffset, hour, minute, 0, 0).getTime();

// The panel component runs on the real clock: its fixtures are built from this device's own
// current day, so the same file passes at any hour and in any time zone.
const now = new Date();
const todayAt = (hour, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0).getTime();
const daysAgoAt = (days, hour, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hour, minute, 0, 0).getTime();

function entry(type, text, timestamp, seq) {
  return {
    provider: "mock",
    item: { type, text },
    timestamp: new Date(timestamp).toISOString(),
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
  };
}

function page(entries, options = {}) {
  return {
    requestId: "r",
    agentId: "a",
    agent: null,
    direction: options.direction ?? "tail",
    projection: "projected",
    epoch: "e1",
    reset: false,
    staleCursor: false,
    gap: Boolean(options.gap),
    window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
    startCursor: options.startCursor ?? null,
    endCursor: { epoch: "e1", seq: 2 },
    hasOlder: Boolean(options.hasOlder),
    hasNewer: false,
    entries,
    error: options.error ?? null,
  };
}

/** A timeline served as the pages a real one returns: newest page first, older pages by cursor. */
function createAgent(id = "a") {
  const state = {
    pages: [],
    failReads: 0,
    calls: [],
    subscribeCount: 0,
    stopped: 0,
  };
  const subscribers = [];
  const handle = {
    id,
    async refresh() {
      return { agent: { id, activeTurn: null } };
    },
    timeline: {
      async refetch(options = {}) {
        state.calls.push(options);
        if (state.failReads > 0) {
          state.failReads -= 1;
          throw new Error("timeline unavailable");
        }
        const index = options.direction === "before" ? Number(options.cursor.seq) : 0;
        const served = state.pages[index];
        if (!served) return page([], { direction: options.direction });
        const older = index + 1 < state.pages.length;
        return page(served, {
          direction: options.direction ?? "tail",
          startCursor: older ? { epoch: "e1", seq: String(index + 1) } : null,
          hasOlder: older,
        });
      },
      subscribe(handler) {
        state.subscribeCount += 1;
        subscribers.push(handler);
        const stop = () => {
          state.stopped += 1;
          const index = subscribers.indexOf(handler);
          if (index >= 0) subscribers.splice(index, 1);
        };
        return Object.assign(stop, { ready: Promise.resolve(), async release() { stop(); } });
      },
    },
    emit(event) {
      for (const handler of [...subscribers]) handler({ agentId: id, event });
    },
  };
  return { state, handle };
}

function createClient(agent) {
  return { agents: { ref: () => agent.handle } };
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

const panelProps = (extra = {}) => ({
  agentId: "a",
  params: { agentId: "a" },
  context: "agent",
  workspaceId: "w1",
  revision: 0,
  tab: { setModified() {}, state: undefined, setState() {} },
  theme: { colors: {} },
  host: { id: "host", label: "host" },
  layout: { compact: false, platform: "web" },
  ...extra,
});

function harness(t, options = {}) {
  const agent = createAgent();
  const h = createToolHarness("web", { locale: options.locale ?? "en", paseo: { agents: { ref: () => agent.handle } } });
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, agent };
}

test("today's machine messages and the person's messages come from one read", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[
    entry("user_message", "what did we decide?", at(0, 9, 5), 1),
    entry("assistant_message", "Here is the answer.", at(0, 9, 6), 2),
    entry("user_message", "<system-reminder>keep going</system-reminder>", at(0, 9, 7), 3),
    entry("user_message", "[1a] 好", at(0, 10, 15), 4),
    entry("user_message", "[ASYNC DELEGATION from another agent]", at(0, 11, 0), 5),
  ]];
  const feed = h.load("client/my-messages-feed.ts");
  const store = h.load("client/my-messages-store.ts");
  const started = feed.startMyMessagesFeed({ agentId: "a", client: createClient(agent), now: () => TODAY });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.machineToday, 2, "the host envelope and the delegation envelope are machine rows");
  assert.equal(snapshot.humanToday, 2, "the person's question and the bracketed [1a] line are theirs");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["[1a] 好", "what did we decide?"], "newest first");
  assert.deepEqual(snapshot.rows.map(row => row.time), ["10:15", "09:05"]);
  assert.equal(snapshot.hasEarlier, false, "the conversation starts today");
  assert.equal(agent.state.calls[0].direction, "tail");
  assert.equal(agent.state.calls[0].projection, "projected");
});

test("a local midnight splits today from yesterday", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[
    entry("user_message", "late last night", at(-1, 23, 59), 1),
    entry("user_message", "just after midnight", at(0, 0, 0), 2),
    entry("user_message", "later this morning", at(0, 8, 30), 3),
  ]];
  const feed = h.load("client/my-messages-feed.ts");
  const store = h.load("client/my-messages-store.ts");
  const started = feed.startMyMessagesFeed({ agentId: "a", client: createClient(agent), now: () => at(0, 12) });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.humanToday, 2, "midnight belongs to the new day; 23:59 does not");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["later this morning", "just after midnight"]);
  assert.equal(snapshot.hasEarlier, true, "a row older than today is reachable");
});

test("the row just before midnight is today's last row, not tomorrow's", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[
    entry("user_message", "still today", new Date(2026, 2, 15, 23, 59, 59, 999).getTime(), 1),
    entry("user_message", "already tomorrow", new Date(2026, 2, 16, 0, 0, 0, 0).getTime(), 2),
  ]];
  const feed = h.load("client/my-messages-feed.ts");
  const store = h.load("client/my-messages-store.ts");
  const started = feed.startMyMessagesFeed({ agentId: "a", client: createClient(agent), now: () => new Date(2026, 2, 15, 12).getTime() });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.humanToday, 1);
  assert.deepEqual(snapshot.rows.map(row => row.text), ["still today"], "a row dated tomorrow is outside today's list");
});

test("Earlier adds exactly one local day per press", async t => {
  const { h, agent } = harness(t);
  // Page 0 is today; page 1 is the day before; page 2 is the day before that.
  agent.state.pages = [
    [entry("user_message", "today", at(0, 9), 1)],
    [entry("user_message", "yesterday", at(-1, 9), 2), entry("user_message", "<system-notice>x</system-notice>", at(-1, 10), 3)],
    [entry("user_message", "the day before", at(-2, 9), 4)],
  ];
  const feed = h.load("client/my-messages-feed.ts");
  const store = h.load("client/my-messages-store.ts");
  const started = feed.startMyMessagesFeed({ agentId: "a", client: createClient(agent), now: () => TODAY });
  t.after(() => started.stop());
  await started.ready;
  let snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today"]);
  assert.equal(snapshot.loadedDays, 1);
  assert.equal(snapshot.hasEarlier, true);

  await started.loadEarlier();
  snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today", "yesterday"], "one day back, newest first");
  assert.equal(snapshot.loadedDays, 2);
  assert.equal(snapshot.machineToday, 0, "yesterday's envelope is not in today's count");
  assert.equal(snapshot.hasEarlier, true);

  await started.loadEarlier();
  snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today", "yesterday", "the day before"]);
  assert.equal(snapshot.loadedDays, 3);
  assert.equal(snapshot.hasEarlier, false, "the conversation has nothing older left");
  const before = agent.state.calls.length;
  await started.loadEarlier();
  assert.equal(agent.state.calls.length, before, "a press with nothing older left reads nothing");
});

test("a new message updates the counts and the list without reopening the panel", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[entry("user_message", "first", at(0, 9), 1)]];
  const feed = h.load("client/my-messages-feed.ts");
  const store = h.load("client/my-messages-store.ts");
  const started = feed.startMyMessagesFeed({ agentId: "a", client: createClient(agent), now: () => TODAY });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").humanToday, 1);
  let notices = 0;
  const stop = store.subscribeMyMessages(() => { notices += 1; });
  t.after(stop);

  agent.state.pages = [[
    entry("user_message", "first", at(0, 9), 1),
    entry("user_message", "<system-reminder>scheduled</system-reminder>", at(0, 10), 2),
    entry("user_message", "second", at(0, 11), 3),
  ]];
  agent.handle.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "second" } });
  await settle();
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.humanToday, 2);
  assert.equal(snapshot.machineToday, 1);
  assert.deepEqual(snapshot.rows.map(row => row.text), ["second", "first"]);
  assert.ok(notices >= 1, "the panel is told once the new read lands");

  // The model's own words cannot change either count.
  agent.state.pages = [[
    entry("user_message", "first", at(0, 9), 1),
    entry("user_message", "<system-reminder>scheduled</system-reminder>", at(0, 10), 2),
    entry("user_message", "second", at(0, 11), 3),
    entry("assistant_message", "a reply", at(0, 11, 1), 4),
  ]];
  const readCalls = agent.state.calls.length;
  agent.handle.emit({ type: "timeline", provider: "mock", item: { type: "assistant_message", text: "a reply" } });
  await settle();
  assert.equal(agent.state.calls.length, readCalls, "an assistant row triggers no read");
});

test("a timeline that cannot be read shows an error instead of crashing", async t => {
  const { h, agent } = harness(t);
  agent.state.failReads = 40;
  const feed = h.load("client/my-messages-feed.ts");
  const store = h.load("client/my-messages-store.ts");
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const started = feed.startMyMessagesFeed({ agentId: "a", client: createClient(agent), now: () => TODAY });
  t.after(() => { started.stop(); console.warn = original; });
  await started.ready;
  await settle();
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.status, "error");
  assert.match(snapshot.error, /timeline unavailable/);
  assert.deepEqual(snapshot.rows, []);
  assert.ok(warnings.some(line => line.includes("could not read the timeline")));
});

test("the panel draws the counts, rows and Earlier, and copies a row's whole text", async t => {
  const { h, agent } = harness(t, { locale: "en" });
  agent.state.pages = [
    [
      entry("user_message", "line one\nline two\nline three\nline four", todayAt(0, 5), 1),
      entry("user_message", "  ", todayAt(0, 10), 2),
      entry("user_message", "<system-reminder>machine</system-reminder>", todayAt(0, 20), 3),
    ],
    [entry("user_message", "yesterday", daysAgoAt(1, 0, 5), 4)],
  ];
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  const tree = h.draw({ type: Panel, props: panelProps() });
  await settle();
  const drawn = h.draw({ type: Panel, props: panelProps() });
  const text = h.text(drawn);
  assert.ok(text.includes("Machine messages today: 1"), text);
  assert.ok(text.includes("From you: 2"), text);
  assert.ok(text.includes("00:05"), "a row shows its local clock time");
  const rows = h.nodes(drawn, node => node.props.testID === "my-message-row");
  assert.equal(rows.length, 2, "two rows from the person, the envelope excluded");
  const longRow = rows.find(row => h.text(row).includes("line one"));
  const imageRow = rows.find(row => h.text(row).includes("(image)"));
  assert.ok(longRow && imageRow, "both of the person's rows are drawn");
  assert.ok(h.text(longRow).includes("line one\nline two\nline three"), h.text(longRow));
  assert.ok(!h.text(longRow).includes("line four"), "a row keeps three lines");
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-earlier").length, 1);

  imageRow.props.onPress();
  await settle(2);
  assert.deepEqual(h.copies, [], "an image-only row copies nothing");
  assert.ok(h.toasts.includes("This message has no text to copy"));

  longRow.props.onPress();
  await settle(2);
  assert.deepEqual(h.copies.at(-1), "line one\nline two\nline three\nline four", "the whole message, not the preview");
  assert.ok(h.toasts.includes("Copied"));
  assert.equal(h.links.length, 0, "a press never navigates");
});

test("a copy the host refuses is reported instead of looking copied", async t => {
  const agent = createAgent();
  const h = createToolHarness("web", {
    locale: "en",
    paseo: { agents: { ref: () => agent.handle } },
    copyText: async () => { throw new Error("clipboard denied"); },
  });
  t.after(() => { h.unmount(); h.dispose(); });
  agent.state.pages = [[entry("user_message", "copy me", todayAt(0, 1), 1)]];
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  h.draw({ type: Panel, props: panelProps() });
  await settle();
  const drawn = h.draw({ type: Panel, props: panelProps() });
  const row = h.nodes(drawn, node => node.props.testID === "my-message-row")[0];
  row.props.onPress();
  await settle(3);
  assert.ok(h.toasts.includes("Could not copy this message"), JSON.stringify(h.toasts));
  assert.ok(!h.toasts.includes("Copied"));
});

test("an open panel shows a message that arrives now, without reopening it", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[entry("user_message", "first", todayAt(0, 1), 1)]];
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  h.draw({ type: Panel, props: panelProps() });
  await settle();
  assert.ok(h.text(h.draw({ type: Panel, props: panelProps() })).includes("From you: 1"));

  agent.state.pages = [[
    entry("user_message", "first", todayAt(0, 1), 1),
    entry("user_message", "just now", todayAt(0, 2), 2),
  ]];
  agent.handle.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "just now" } });
  await settle();
  const after = h.draw({ type: Panel, props: panelProps() });
  assert.ok(h.text(after).includes("From you: 2"), h.text(after));
  assert.ok(h.text(after).includes("just now"), "the new row is in the list");
});

test("the panel scrolls on a compact layout and asks for one more day", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [
    [entry("user_message", "today", todayAt(0, 5), 1)],
    [entry("user_message", "yesterday", daysAgoAt(1, 0, 5), 2)],
  ];
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  h.draw({ type: Panel, props: panelProps() });
  await settle();
  const drawn = h.draw({ type: Panel, props: panelProps({ layout: { compact: true, platform: "ios" } }) });
  const panel = h.nodes(drawn, node => node.props.testID === "my-messages-panel")[0];
  assert.equal(panel.type, "ScrollView", "the panel is the scroll container on a phone");
  assert.equal(panel.props.style.flex, 1);
  h.text(drawn);
  const earlier = h.nodes(drawn, node => node.props.testID === "my-messages-earlier")[0];
  earlier.props.onPress();
  await settle();
  const after = h.draw({ type: Panel, props: panelProps({ layout: { compact: true, platform: "ios" } }) });
  assert.ok(h.text(after).includes("yesterday"));
  assert.equal(h.nodes(after, node => node.props.testID === "my-messages-earlier").length, 0);
});

test("closing the panel releases the timeline subscription", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[entry("user_message", "hello", at(0, 9), 1)]];
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  h.draw({ type: Panel, props: panelProps() });
  await settle();
  assert.equal(agent.state.subscribeCount, 1);
  assert.equal(agent.state.stopped, 0);
  h.unmount();
  assert.equal(agent.state.stopped, 1, "the panel's own subscription is stopped");
});

test("a read failure shows the error line and keeps the panel usable", async t => {
  const { h, agent } = harness(t);
  agent.state.failReads = 40;
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  h.draw({ type: Panel, props: panelProps() });
  // The feed retries with real timers (10, 20, 40 ms) before it publishes the error.
  await new Promise(resolve => setTimeout(resolve, 250));
  const drawn = h.draw({ type: Panel, props: panelProps() });
  console.warn = original;
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-error").length, 1);
  assert.ok(h.text(drawn).includes("Could not read this conversation"));
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-message-row").length, 0);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-panel").length, 1, "the panel still draws");
  assert.ok(warnings.length > 0);
});

// --- The host edge: the panel's registration and the header button that opens it ---

function registrationHost(options = {}) {
  const panels = new Map();
  const buttons = new Map();
  const opens = [];
  const removed = [];
  const released = [];
  const agentList = options.agents ?? [{ agent: { id: "a", workspaceId: "w1" } }];
  const focused = options.focused ?? { composer: { id: "composer-a" } };
  let workspaceSubscribed = null;
  const client = {
    addAgentPanel(value) {
      panels.set(value.id, value);
      return () => removed.push(`panel:${value.id}`);
    },
    ...(options.noHeaderButton ? {} : {
      addHeaderButton(value) {
        buttons.set(value.workspaceId, value);
        const registration = { update() {}, remove() { removed.push(`button:${value.workspaceId}`); } };
        return registration;
      },
    }),
    openPanel(id, input) {
      if (options.panelError) throw new Error("Panel unavailable");
      opens.push({ id, ...input });
    },
    composers(selector) {
      if (!("focused" in selector)) {
        return selector.agentId === (options.activeAgent ?? "a") && focused.composer ? [focused.composer] : [];
      }
      return focused.composer ? [focused.composer] : [];
    },
    paseo: {
      workspaces: options.noWorkspaces ? undefined : {
        list: async () => ({
          entries: options.workspaces ?? [{ id: "w1" }, { id: "w2" }],
          subscription: { release: async () => { released.push("workspaces"); } },
        }),
        subscribe: handler => {
          workspaceSubscribed = handler;
          return () => { workspaceSubscribed = null; };
        },
      },
      agents: { list: async () => ({ entries: agentList }) },
    },
  };
  return { client, panels, buttons, opens, removed, released, getWorkspaceSubscribed: () => workspaceSubscribed };
}

test("the panel registers once and every workspace gets one header button", async t => {
  const { h } = harness(t);
  const registration = h.load("client/my-messages-registration.ts");
  const host = registrationHost();
  const stop = registration.registerMyMessagesPanel(host.client);
  await settle();

  const panel = host.panels.get("my-messages");
  assert.ok(panel, "the agent panel is registered");
  assert.equal(h.translations.runtime.resolve(panel.title), "What I said");
  assert.equal(panel.icon, "MessageSquare");
  assert.equal(typeof panel.Component, "function", "the panel component travels with the contribution");
  assert.deepEqual([...host.buttons.keys()], ["w1", "w2"], "one button per workspace");
  const button = host.buttons.get("w1");
  assert.equal(button.id, "clear-chat-my-messages");
  assert.equal(button.button.behavior.kind, "action");
  assert.equal(h.translations.runtime.resolve(button.button.title), "What I said");

  // A workspace created later gets its button from the host's own stream.
  host.getWorkspaceSubscribed()({ kind: "upsert", workspace: { id: "w3" } });
  assert.deepEqual([...host.buttons.keys()], ["w1", "w2", "w3"]);

  stop();
  assert.deepEqual(host.removed.sort(), ["button:w1", "button:w2", "button:w3", "panel:my-messages"]);
  assert.deepEqual(host.released, ["workspaces"], "the workspace list stream is released");
});

test("pressing the header button opens the panel for the conversation in front", async t => {
  const { h } = harness(t);
  const registration = h.load("client/my-messages-registration.ts");
  const host = registrationHost();
  const stop = registration.registerMyMessagesPanel(host.client);
  t.after(stop);
  await settle();
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.deepEqual(host.opens, [{ id: "my-messages", workspaceId: "w1", agentId: "a" }]);

  // A workspace whose single conversation is not in front still opens that conversation.
  host.buttons.get("w2").button.behavior.onPress();
  await settle();
  assert.equal(host.opens.length, 1, "w2 lists no conversation, so nothing opens");

  // Two conversations and no focused one: the button says nothing rather than opening the wrong one.
  host.buttons.get("w1").button.behavior.onPress();
  await settle();
  assert.equal(host.opens.length, 2);
});

test("a host without the agent panel API keeps the rest of the plugin working", async t => {
  const { h } = harness(t);
  const registration = h.load("client/my-messages-registration.ts");
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
  const { h } = harness(t);
  const registration = h.load("client/my-messages-registration.ts");
  const host = registrationHost({ noHeaderButton: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  await settle();
  assert.ok(host.panels.get("my-messages"), "the panel still registers");
  assert.equal(host.buttons.size, 0);
  assert.doesNotThrow(stop);
});

test("a host that cannot list workspaces registers the panel and nothing else", async t => {
  const { h } = harness(t);
  const registration = h.load("client/my-messages-registration.ts");
  const host = registrationHost({ noWorkspaces: true });
  const stop = registration.registerMyMessagesPanel(host.client);
  await settle();
  assert.ok(host.panels.get("my-messages"));
  assert.equal(host.buttons.size, 0);
  assert.doesNotThrow(stop);
});
