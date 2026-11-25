const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The panel body. The clock is frozen for every case, so a fixture never depends on the hour a
// test happens to run at, and the day-rollover case drives its own timers.

const FROZEN = new Date(2026, 2, 15, 12, 0, 0, 0).getTime();
const at = (dayOffset, hour, minute = 0, second = 0) =>
  new Date(2026, 2, 15 + dayOffset, hour, minute, second, 0).getTime();

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
    gap: false,
    window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
    startCursor: options.startCursor ?? null,
    endCursor: { epoch: "e1", seq: 2 },
    hasOlder: Boolean(options.hasOlder),
    hasNewer: false,
    entries,
    error: null,
  };
}

function createAgent(id = "a") {
  const state = { pages: [], calls: [], subscribers: [], subscribeCount: 0, stopped: 0 };
  const handle = {
    id,
    async refresh() {
      return { agent: { id, activeTurn: null } };
    },
    timeline: {
      async refetch(options = {}) {
        state.calls.push(options);
        const index = options.direction === "before" ? Number(options.cursor.seq) : 0;
        const served = state.pages[index] ?? [];
        const older = index + 1 < state.pages.length;
        return page(served, {
          direction: options.direction ?? "tail",
          startCursor: older ? { epoch: "e1", seq: String(index + 1) } : null,
          hasOlder: older,
        });
      },
      subscribe(handler) {
        state.subscribeCount += 1;
        state.subscribers.push(handler);
        const stop = () => {
          state.stopped += 1;
          const index = state.subscribers.indexOf(handler);
          if (index >= 0) state.subscribers.splice(index, 1);
        };
        return Object.assign(stop, { ready: Promise.resolve(), async release() { stop(); } });
      },
    },
  };
  return { state, handle };
}

async function settle(times = 10) {
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
  const h = createToolHarness("web", {
    locale: options.locale ?? "en",
    paseoClients: undefined,
    paseo: { agents: { ref: () => agent.handle } },
    ...(options.copyText ? { copyText: options.copyText } : {}),
  });
  // Freeze the shared clock before the panel's feed reads it.
  h.load("client/my-messages-clock.ts").setMyMessagesClock(() => FROZEN);
  t.after(() => {
    const clockModule = h.load("client/my-messages-clock.ts");
    clockModule.setMyMessagesClock(null);
    clockModule.setMyMessagesTimers(null);
    h.unmount();
    h.dispose();
  });
  return { h, agent };
}

const drawPanel = (h, extra = {}) => {
  const Panel = h.load("client/components/my-messages-panel.tsx").MyMessagesPanel;
  return h.draw({ type: Panel, props: panelProps(extra) });
};

test("the panel shows the counts and the person's messages, and copies one exactly", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[
    entry("user_message", "  spaced first\r\nsecond line  ", at(0, 9, 5), 1),
    entry("user_message", "  ", at(0, 10), 2),
    entry("user_message", "<system-reminder>machine</system-reminder>", at(0, 10, 30), 3),
  ]];
  drawPanel(h);
  await settle();
  const drawn = drawPanel(h);
  const text = h.text(drawn);
  assert.ok(text.includes("Machine messages today: 1"), text);
  assert.ok(text.includes("From you: 2"), text);
  assert.ok(text.includes("09:05"), "a row shows its local clock time");
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-partial").length, 0);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-live-error").length, 0);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-retry").length, 0);

  const rows = h.nodes(drawn, node => node.props.testID === "my-message-row");
  assert.equal(rows.length, 2, "two rows from the person, the envelope excluded");
  const spaced = rows.find(row => h.text(row).includes("spaced first"));
  const image = rows.find(row => h.text(row).includes("(image)"));
  assert.ok(spaced && image, "both of the person's rows are drawn");

  spaced.props.onPress();
  await settle(3);
  assert.equal(h.copies.at(-1), "  spaced first\r\nsecond line  ", "the whole message, exactly as sent");
  assert.ok(h.toasts.includes("Copied"));

  image.props.onPress();
  await settle(3);
  assert.equal(h.copies.length, 1, "a row with no text copies nothing");
  assert.ok(h.toasts.includes("This message has no text to copy"));
  assert.equal(h.links.length, 0, "a press never navigates");
});

test("a partially read day says so", async t => {
  const { h } = harness(t);
  drawPanel(h);
  await settle();
  const store = h.load("client/my-messages-store.ts");
  store.publishMyMessages("a", {
    status: "ready",
    loadedDays: 1,
    machineToday: 0,
    humanToday: 1,
    rows: [{ key: "1:1", at: FROZEN, seq: 1, time: "09:00", text: "hello", preview: "hello", truncated: false, empty: false }],
    hasEarlier: true,
    partial: true,
    live: true,
    error: null,
  });
  const drawn = drawPanel(h);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-partial").length, 1);
});

test("the panel offers a retry while live delivery is down, and the retry asks the feed", async t => {
  const { h, agent } = harness(t);
  drawPanel(h);
  await settle();
  const store = h.load("client/my-messages-store.ts");
  store.publishMyMessages("a", {
    status: "ready",
    loadedDays: 1,
    machineToday: 0,
    humanToday: 0,
    rows: [],
    hasEarlier: false,
    partial: false,
    live: false,
    error: null,
  });
  const drawn = drawPanel(h);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-live-error").length, 1);
  const attempts = agent.state.subscribeCount;
  const retry = h.nodes(drawn, node => node.props.testID === "my-messages-retry")[0];
  assert.ok(retry, "the retry control is drawn");
  retry.props.onPress();
  await settle();
  assert.ok(agent.state.subscribeCount > attempts, "the retry asks the host for a subscription again");
});

test("a copy the host refuses is reported instead of looking copied", async t => {
  const { h, agent } = harness(t, { copyText: async () => { throw new Error("clipboard denied"); } });
  agent.state.pages = [[entry("user_message", "copy me", at(0, 9), 1)]];
  drawPanel(h);
  await settle();
  const drawn = drawPanel(h);
  const row = h.nodes(drawn, node => node.props.testID === "my-message-row")[0];
  row.props.onPress();
  await settle(3);
  assert.ok(h.toasts.includes("Could not copy this message"), JSON.stringify(h.toasts));
  assert.ok(!h.toasts.includes("Copied"));
});

test("the panel scrolls on a compact layout", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[entry("user_message", "today", at(0, 9), 1)]];
  drawPanel(h);
  await settle();
  const drawn = drawPanel(h, { layout: { compact: true, platform: "ios" } });
  const panel = h.nodes(drawn, node => node.props.testID === "my-messages-panel")[0];
  assert.equal(panel.type, "ScrollView", "the panel is the scroll container on a phone");
  assert.equal(panel.props.style.flex, 1);
  assert.ok(h.text(drawn).includes("today"));
});

test("closing the panel releases the timeline subscription", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[entry("user_message", "hello", at(0, 9), 1)]];
  drawPanel(h);
  await settle();
  assert.equal(agent.state.subscribeCount, 1);
  assert.equal(agent.state.stopped, 0);
  h.unmount();
  assert.equal(agent.state.stopped, 1, "the panel's own subscription is stopped");
});

test("an open panel turns over at midnight, on its own timer", async t => {
  // A frozen clock the test advances, and timers the test fires: nothing waits a real day.
  const queue = [];
  const timers = {
    set(callback, ms) {
      const item = { callback, ms, cleared: false, ran: false };
      queue.push(item);
      return item;
    },
    clear(item) {
      if (item) item.cleared = true;
    },
  };
  const runLongest = () => {
    const next = queue
      .filter(item => !item.cleared && !item.ran)
      .sort((left, right) => right.ms - left.ms)[0];
    if (!next) return false;
    next.ran = true;
    next.callback();
    return true;
  };

  const { h, agent } = harness(t);
  const clockModule = h.load("client/my-messages-clock.ts");
  let clock = at(0, 23, 59, 59);
  clockModule.setMyMessagesClock(() => clock);
  clockModule.setMyMessagesTimers(timers);
  agent.state.pages = [[
    entry("user_message", "before midnight", at(0, 22), 1),
    entry("user_message", "earlier today", at(0, 9), 2),
  ]];
  drawPanel(h);
  await settle();
  assert.ok(h.text(drawPanel(h)).includes("From you: 2"));

  clock = at(1, 0, 0, 5);
  assert.equal(runLongest(), true, "a timer waits for the next local midnight");
  await settle(12);
  const after = drawPanel(h);
  assert.ok(h.text(after).includes("From you: 0"), h.text(after));
  assert.ok(!h.text(after).includes("before midnight"), "yesterday's rows leave today's list");
});

test("the header button's guidance reaches the panel's toast in every language", async t => {
  const expected = {
    en: "Open a conversation in this workspace first, then press this button.",
    "zh-CN": "先在这个工作区打开一个对话，再点这个按钮。",
    ja: "このワークスペースで会話を開いてから、このボタンを押してください。",
  };
  for (const [locale, copy] of Object.entries(expected)) {
    const { h } = harness(t, { locale });
    drawPanel(h);
    await settle();
    const registration = h.load("client/my-messages-registration.ts");
    const host = registrationHost({
      agents: [
        [{ agent: { id: "a", workspaceId: "w1" } }],
        [{ agent: { id: "b", workspaceId: "w1" } }],
      ],
      focus: null,
    });
    const stop = registration.registerMyMessagesPanel(host.client);
    await settle();
    host.buttons.get("w1").button.behavior.onPress();
    await settle(6);
    assert.equal(host.opens.length, 0, `${locale}: no conversation is opened`);
    assert.ok(h.toasts.includes(copy), `${locale}: ${JSON.stringify(h.toasts)}`);
    stop();
    h.unmount();
    h.dispose();
  }
});

// A registration host whose agent directory spans pages, so the button has to walk it.
function registrationHost(options = {}) {
  const panels = new Map();
  const buttons = new Map();
  const opens = [];
  const agentPages = options.agents ?? [[{ agent: { id: "a", workspaceId: "w1" } }]];
  const focusObject = options.focus === null ? null : { id: "composer-a" };
  const activeAgent = options.activeAgent ?? "a";
  const listPage = pages => async input => {
    const index = input?.page?.cursor ? Number(input.page.cursor) : 0;
    const entries = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return { entries, pageInfo: { hasMore, nextCursor: hasMore ? String(index + 1) : null } };
  };
  const client = {
    addAgentPanel(value) {
      panels.set(value.id, value);
      return () => {};
    },
    addHeaderButton(value) {
      buttons.set(value.workspaceId, value);
      return { update() {}, remove() {} };
    },
    openPanel(id, input) {
      opens.push({ id, ...input });
    },
    composers(selector) {
      if (!("focused" in selector)) return selector.agentId === activeAgent && focusObject ? [focusObject] : [];
      return focusObject ? [focusObject] : [];
    },
    paseo: {
      workspaces: {
        list: async () => ({ entries: [{ id: "w1" }], pageInfo: { hasMore: false, nextCursor: null } }),
        subscribe: () => () => {},
      },
      agents: { list: listPage(agentPages) },
    },
  };
  return { client, panels, buttons, opens };
}
