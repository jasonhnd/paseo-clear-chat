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
  const state = { pages: [], subscribers: [], subscribeCount: 0, stopped: 0, holdReady: false, rejectNext: null };
  const handle = {
    id,
    async refresh() {
      return { agent: { id, activeTurn: null } };
    },
    timeline: {
      async refetch(options = {}) {
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
        const pending = state.rejectNext;
        state.rejectNext = null;
        if (pending) {
          return Object.assign(() => {}, { ready: Promise.reject(pending), async release() {} });
        }
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

const snapshot = (h) => h.load("client/my-messages-store.ts");

/** The fields every published snapshot carries; a test overrides what it is about. */
const fields = (extra = {}) => ({
  status: "ready",
  day: "2026-03-15",
  coveredFrom: "2026-03-15",
  machineToday: 0,
  humanToday: 0,
  rows: [],
  hasEarlier: false,
  partial: false,
  pendingDay: null,
  earlierBusy: false,
  live: true,
  stale: false,
  error: null,
  ...extra,
});
const row = (text, at, seq = 1) => ({
  key: `${at}:${seq}`, at, seq, day: "2026-03-15", time: "09:00", text, preview: text, truncated: false, empty: false,
});

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

test("the list is virtualized, and still scrolls on a compact layout", async t => {
  const { h, agent } = harness(t);
  agent.state.pages = [[
    entry("user_message", "today", at(0, 9), 1),
    entry("user_message", "later", at(0, 10), 2),
  ]];
  drawPanel(h);
  await settle();
  const drawn = drawPanel(h, { layout: { compact: true, platform: "ios" } });
  const panel = h.nodes(drawn, node => node.props.testID === "my-messages-panel")[0];
  assert.equal(panel.type, "Native.FlatList", "the panel draws a virtualized list");
  assert.equal(panel.props.style.flex, 1, "it fills the tab and scrolls");
  assert.equal(panel.props.data.length, 2, "the rows travel as list data, not as prebuilt children");
  assert.equal(typeof panel.props.renderItem, "function");
  assert.ok(h.text(drawn).includes("today"));
});

test("a day an Earlier press left short is named, and Try again continues it", async t => {
  const { h } = harness(t);
  drawPanel(h);
  await settle();
  snapshot(h).publishMyMessages("a", fields({
    humanToday: 1,
    rows: [row("hello", FROZEN)],
    hasEarlier: true,
    pendingDay: "2026-03-14",
  }));
  const drawn = drawPanel(h);
  const notice = h.nodes(drawn, node => node.props.testID === "my-messages-partial")[0];
  assert.ok(notice, "the unfinished day is named");
  assert.ok(h.text(notice).includes("3/14"), h.text(notice));
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-retry").length, 1);
});

test("a window that was not read completely says so", async t => {
  const { h } = harness(t);
  drawPanel(h);
  await settle();
  snapshot(h).publishMyMessages("a", fields({ humanToday: 1, hasEarlier: true, partial: true }));
  const drawn = drawPanel(h);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-partial").length, 1);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-retry").length, 1);
});

test("counts from an earlier day are not shown as today's", async t => {
  const { h } = harness(t);
  drawPanel(h);
  await settle();
  snapshot(h).publishMyMessages("a", fields({
    day: "2026-03-14",
    machineToday: 4,
    humanToday: 2,
    rows: [row("yesterday", at(-1, 9))],
    status: "error",
    stale: true,
    error: "timeline unavailable",
  }));
  const drawn = drawPanel(h);
  const summary = h.nodes(drawn, node => node.props.testID === "my-messages-summary")[0];
  assert.ok(h.text(summary).includes("earlier day"), h.text(summary));
  assert.ok(!h.text(summary).includes("From you: 2"), "yesterday's count is not labelled as today's");
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-retry").length, 1);
});

test("the read-error copy points at the control that retries", async t => {
  const expected = {
    en: "Select Try again",
    "zh-CN": "点「重试」",
    ja: "「再試行」",
  };
  for (const [locale, copy] of Object.entries(expected)) {
    const { h } = harness(t, { locale });
    drawPanel(h);
    await settle();
    snapshot(h).publishMyMessages("a", fields({ status: "error", live: false, error: "timeline unavailable" }));
    const drawn = drawPanel(h);
    const error = h.nodes(drawn, node => node.props.testID === "my-messages-error")[0];
    assert.ok(error, `${locale}: the failure is shown`);
    assert.ok(h.text(error).includes(copy), `${locale}: ${h.text(error)}`);
    assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-retry").length, 1);
    h.unmount();
    h.dispose();
  }
});

test("the panel offers a retry while live delivery is down, and the retry asks the feed", async t => {
  const { h, agent } = harness(t);
  // Timers the test owns, so the feed's own backoff cannot open a subscription behind our back.
  h.load("client/my-messages-clock.ts").setMyMessagesTimers({ set: () => ({}), clear: () => {} });
  agent.state.pages = [[entry("user_message", "first", at(0, 9), 1)]];
  agent.state.rejectNext = new Error("subscription unavailable");
  drawPanel(h);
  await settle(12);
  const drawn = drawPanel(h);
  assert.equal(h.nodes(drawn, node => node.props.testID === "my-messages-live-error").length, 1, "the panel says the list may be stale");
  const attempts = agent.state.subscribeCount;
  const retry = h.nodes(drawn, node => node.props.testID === "my-messages-retry")[0];
  assert.ok(retry, "the retry control is drawn");
  retry.props.onPress();
  await settle();
  assert.ok(agent.state.subscribeCount > attempts, "the retry asks the host for a subscription again");
});

test("Earlier is disabled while its read is in flight", async t => {
  const { h } = harness(t);
  drawPanel(h);
  await settle();
  snapshot(h).publishMyMessages("a", fields({
    humanToday: 1,
    rows: [row("hello", FROZEN)],
    hasEarlier: true,
    earlierBusy: true,
  }));
  const drawn = drawPanel(h);
  const earlier = h.nodes(drawn, node => node.props.testID === "my-messages-earlier")[0];
  assert.equal(earlier.props.disabled, true, "a second press cannot start a second read");
  assert.equal(earlier.props.accessibilityState.disabled, true);
  assert.ok(h.text(earlier).includes("Reading…"));
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
  const text = h.text(after);
  assert.ok(text.includes("From you: 0"), "the counts restart at today, not yesterday's day: " + text);
  assert.ok(!text.includes("before midnight"), "with no day added, the window is the new day alone");
  assert.equal(snapshot(h).myMessagesSnapshot("a").day, "2026-03-16", "the counts belong to the new day");
  assert.equal(snapshot(h).myMessagesSnapshot("a").coveredFrom, "2026-03-16");
});

test("a row from an earlier day carries its date", async t => {
  const { h } = harness(t);
  drawPanel(h);
  await settle();
  snapshot(h).publishMyMessages("a", fields({
    humanToday: 1,
    rows: [
      row("today", FROZEN),
      { ...row("yesterday", at(-1, 9)), day: "2026-03-14" },
    ],
    hasEarlier: true,
  }));
  const drawn = drawPanel(h);
  const rows = h.nodes(drawn, node => node.props.testID === "my-message-row").map(node => h.text(node));
  assert.ok(rows.some(text => text.includes("09:00") && !text.includes("3/14")), JSON.stringify(rows));
  assert.ok(rows.some(text => text.includes("3/14 09:00")), `an older row is dated: ${JSON.stringify(rows)}`);
});
