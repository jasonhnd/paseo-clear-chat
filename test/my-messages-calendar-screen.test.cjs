const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const FROZEN = new Date(2026, 2, 15, 12).getTime();
const settle = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await settle(); await settle(); await settle(); };

function dayKey(offset) {
  const date = new Date(2026, 2, 15 + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function at(offset, hour = 9, minute = 0) {
  return new Date(2026, 2, 15 + offset, hour, minute).getTime();
}

function agent(id, title, lastUserMessageAt = at(0, 10)) {
  return {
    id, title, updatedAt: new Date(lastUserMessageAt).toISOString(),
    lastUserMessageAt: new Date(lastUserMessageAt).toISOString(), labels: {},
  };
}

function timelineMessage(text, time, seq) {
  return { timestamp: new Date(time).toISOString(), seqStart: seq, item: { type: "user_message", text } };
}

function daysResult(entries, extras = {}) {
  const days = Object.entries(entries)
    .map(([day, count]) => ({ day, count }))
    .sort((left, right) => (left.day < right.day ? -1 : 1));
  return {
    days,
    firstDay: days[0]?.day ?? null,
    lastDay: days[days.length - 1]?.day ?? null,
    fastConversations: 1,
    slowConversationIds: [],
    skippedDatabases: [],
    directoryPartial: false,
    fromCache: 0,
    readMs: 3,
    ...extras,
  };
}

function dayResult(rows, extras = {}) {
  return { rows, directoryPartial: false, fromCache: 0, ...extras };
}

function fakePaseo(directory, histories) {
  const reads = [];
  return {
    reads,
    agents: {
      async list() {
        return { entries: directory.map(entry => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref(id) {
        return { timeline: {
          async refetch(options) {
            reads.push({ id, ...options });
            const entries = histories.get(id) ?? [];
            return { entries, hasOlder: false, error: null, gap: false, staleCursor: false, startCursor: null };
          },
        } };
      },
    },
  };
}

const screenProps = {
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "web" },
  theme: { colors: {} },
  params: {},
};

function fixture(t, options = {}) {
  const { historyRpc, locale = "en", compact = false, directory = [], histories = new Map() } = options;
  const paseo = fakePaseo(directory, histories);
  const h = createToolHarness("web", { paseo, ui: { SidebarRow: "Host.SidebarRow" }, historyRpc, locale });
  const clock = h.load("client/my-messages-clock.ts");
  clock.setMyMessagesClock(() => FROZEN);
  clock.setMyMessagesTimers({ set() { throw new Error("Calendar reads must not schedule timers"); }, clear() {} });
  t.after(() => { h.unmount(); h.dispose(); clock.setMyMessagesClock(null); clock.setMyMessagesTimers(null); });
  const screens = new Map();
  const stop = h.load("client/my-messages-screen-registration.tsx").registerMyMessagesScreen({
    addScreen(screen) { screens.set(screen.id, screen); return () => {}; },
    addSidebarHeaderItem: () => () => {},
  });
  t.after(stop);
  const screen = [...screens.values()][0];
  const draw = () => h.draw({ type: screen.Component, props: { ...screenProps, layout: { ...screenProps.layout, compact } } });
  const all = (tree, id) => h.nodes(tree, node => node.props.testID === id);
  const one = (tree, id) => all(tree, id)[0];
  const cell = (tree, prefix) => all(tree, "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith(prefix));
  const monthCell = (tree, prefix) => all(tree, "my-messages-calendar-year-month")
    .find(node => String(node.props.accessibilityLabel).startsWith(prefix));
  return { h, draw, all, one, cell, monthCell, paseo };
}

function historyFor(days, rowsByDay) {
  const calls = [];
  return {
    calls,
    days: async input => { calls.push(["days", input]); return days; },
    day: async input => {
      calls.push(["day", input]);
      return rowsByDay[input.day] ?? dayResult([]);
    },
  };
}

test("the calendar opens on today with its counts, summary and rows", async t => {
  const today = dayKey(0);
  const marchTenth = dayKey(-5);
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  const history = historyFor(daysResult({
    [dayKey(-30)]: 4, [marchTenth]: 2, [dayKey(-4)]: 5, [today]: 2,
  }), {
    [today]: dayResult([
      { agentId: "alpha", at: at(0, 9), text: "today first" },
      { agentId: "beta", at: at(0, 8), text: "today second" },
    ]),
    [marchTenth]: dayResult([{ agentId: "alpha", at: at(-5, 10), text: "the tenth" }]),
  });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  const view = draw();

  assert.equal(h.text(one(view, "my-messages-screen-summary")), "Today · Mar 15 Sun");
  assert.equal(history.calls[0][0], "days");
  assert.equal(history.calls[1][0], "day");
  assert.equal(history.calls[1][1].day, today);
  assert.equal(history.calls[1][1].timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(cell(view, "Mar 15 Sun").props.accessibilityLabel, "Mar 15 Sun, 2 messages");
  assert.equal(cell(view, "Mar 14 Sat").props.accessibilityLabel, "Mar 14 Sat, no messages");
  assert.match(h.text(one(view, "my-messages-screen-row")), /today first/);
  assert.equal(h.nodes(view, node => node.props.testID === "my-messages-screen-row").length, 2);

  cell(view, "Mar 10 Tue").props.onPress();
  await flush();
  const selected = draw();
  assert.equal(history.calls.at(-1)[1].day, marchTenth);
  assert.equal(h.text(one(selected, "my-messages-screen-summary")), "Mar 10 Tue · 2 messages · 1 conversation");
  assert.match(h.text(one(selected, "my-messages-screen-row")), /the tenth/);

  one(selected, "my-messages-calendar-today").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Today · Mar 15 Sun");
});

test("hovering a day shows its date and count", async t => {
  const today = dayKey(0);
  const history = historyFor(daysResult({ [today]: 2, [dayKey(-5)]: 2 }), { [today]: dayResult([]) });
  const { draw, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  cell(draw(), "Mar 10 Tue").props.onHoverIn();
  const tooltip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assert.equal(h.text(tooltip), "Mar 10 Tue · 2 messages");
});

test("the year view aggregates months and disables months outside the record", async t => {
  const history = historyFor(daysResult({
    "2026-01-02": 2, [dayKey(-40)]: 3, [dayKey(0)]: 1,
  }, { firstDay: "2026-01-02" }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, all, monthCell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-title").props.onPress();
  const year = draw();
  assert.equal(h.nodes(year, node => node.props.testID === "my-messages-calendar-year-month").length, 12);
  assert.equal(monthCell(year, "January 2026").props.accessibilityState.disabled, false);
  assert.equal(monthCell(year, "December 2026").props.accessibilityState.disabled, true);
  assert.equal(h.text(monthCell(year, "January 2026")), "January\n2 messages");
  monthCell(year, "January 2026").props.onHoverIn();
  assert.equal(h.text(h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0]),
    "January 2026 · 2 messages");
  one(draw(), "my-messages-calendar-next").props.onPress();
  const nextYear = draw();
  assert.equal(h.text(one(nextYear, "my-messages-calendar-title")), "2027");
  assert.equal(all(nextYear, "my-messages-calendar-year-month").every(node => node.props.accessibilityState.disabled), true);
  one(nextYear, "my-messages-calendar-prev").props.onPress();
  monthCell(draw(), "January 2026").props.onPress();
  await flush();
  const month = draw();
  assert.equal(h.text(one(month, "my-messages-calendar-title")), "January 2026");
  assert.equal(history.calls.at(-1)[1].day, "2026-01-02", "the first recorded day opens with the month");
});

test("arrow keys move the selection across months and the header follows", async t => {
  const history = historyFor(daysResult({ "2026-01-01": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-01" }),
    { "2026-03-01": dayResult([]), "2026-02-28": dayResult([]), "2026-03-08": dayResult([]) });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  cell(draw(), "Mar 1 Sun").props.onPress();
  await flush();
  const march = draw();
  one(march, "my-messages-calendar-grid").props.onKeyDown({ key: "ArrowLeft" });
  await flush();
  const february = draw();
  assert.equal(h.text(one(february, "my-messages-calendar-title")), "February 2026");
  assert.equal(history.calls.at(-1)[1].day, "2026-02-28");

  one(february, "my-messages-calendar-grid").props.onKeyDown({ key: "ArrowRight" });
  await flush();
  const back = draw();
  one(back, "my-messages-calendar-grid").props.onKeyDown({ key: "ArrowDown" });
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-03-08");
});

test("year view arrows move the month focus and Enter opens that month", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { "2026-02-01": dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-title").props.onPress();
  const year = draw();
  one(year, "my-messages-calendar-year").props.onKeyDown({ key: "ArrowLeft" });
  one(draw(), "my-messages-calendar-year").props.onKeyDown({ key: "ArrowLeft" });
  one(draw(), "my-messages-calendar-year").props.onKeyDown({ key: "ArrowRight" });
  one(draw(), "my-messages-calendar-year").props.onKeyDown({ key: "Enter" });
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "February 2026");
  assert.equal(history.calls.at(-1)[1].day, "2026-02-01");
});

test("month navigation carries December into January of the next year", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  for (let step = 0; step < 9; step += 1) one(draw(), "my-messages-calendar-next").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "December 2026");
  one(draw(), "my-messages-calendar-next").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "January 2027");
});

test("slow conversations add their day's rows and count without a duplicate", async t => {
  const today = dayKey(0);
  const directory = [
    agent("fast", "Fast conversation", at(0, 9)),
    agent("slow", "Slow conversation", at(0, 10)),
  ];
  const histories = new Map([["slow", [timelineMessage("slow row", at(0, 10), 1)]]]);
  const history = historyFor(daysResult({ [today]: 1 }, { slowConversationIds: ["slow"] }), {
    [today]: dayResult([{ agentId: "fast", at: at(0, 9), text: "fast row" }]),
  });
  const { draw, one, cell, paseo, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  const rows = h.nodes(view, node => node.props.testID === "my-messages-screen-row");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => h.text(row).split("\n").at(-1)), ["slow row", "fast row"]);
  assert.equal(h.text(one(view, "my-messages-screen-summary")), "Today · Mar 15 Sun");
  assert.equal(cell(view, "Mar 15 Sun").props.accessibilityLabel, "Mar 15 Sun, 2 messages");
  assert.deepEqual(paseo.reads.map(read => read.id), ["slow"], "only the slow conversation is re-read");
});

test("a failed day RPC falls back to the timeline for that selected day", async t => {
  const today = dayKey(0);
  const directory = [agent("alpha", "Alpha conversation", at(0, 9))];
  const histories = new Map([["alpha", [timelineMessage("timeline fallback row", at(0, 9), 1)]]]);
  const days = daysResult({ [today]: 1 });
  const history = {
    days: async () => days,
    day: async () => { throw Object.assign(new Error("handler failed"), { code: "handler_error" }); },
  };
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.match(h.text(one(view, "my-messages-screen-row")), /timeline fallback row/);
  assert.equal(cell(view, "Mar 15 Sun").props.accessibilityLabel, "Mar 15 Sun, 1 messages");
});

test("the notice line appears when the directory or cache is partial", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, { directoryPartial: true, cacheError: true }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const notice = one(draw(), "my-messages-calendar-notice");
  assert.equal(notice.props.accessibilityRole, "alert");
  assert.equal(h.text(notice), "Some conversations could not be read, so some counts may be incomplete.");
});

test("a host without the history RPC keeps the previous today-only page", async t => {
  const directory = [agent("alpha", "Alpha conversation")];
  const histories = new Map([["alpha", [timelineMessage("today through the timeline", at(0, 9), 1)]]]);
  const { draw, one, h } = fixture(t, { directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(one(view, "my-messages-calendar-grid"), undefined);
  assert.match(h.text(one(view, "my-messages-screen-summary")), /From you today: 1/);
  assert.match(h.text(one(view, "my-messages-screen-row")), /today through the timeline/);
});

test("the compact layout uses a week strip that expands, then collapses after a pick", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1, [dayKey(-5)]: 2 }), {
    [dayKey(0)]: dayResult([]),
    [dayKey(-5)]: dayResult([]),
  });
  const { draw, one, all, h } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  assert.equal(one(draw(), "my-messages-calendar-week") !== undefined, true);
  assert.equal(one(draw(), "my-messages-calendar-grid"), undefined);
  one(draw(), "my-messages-calendar-expand").props.onPress();
  assert.equal(one(draw(), "my-messages-calendar-grid") !== undefined, true);
  assert.equal(one(draw(), "my-messages-calendar-week"), undefined);
  const target = all(draw(), "my-messages-calendar-cell").find(node => node.props.accessibilityLabel.startsWith("Mar 10 Tue"));
  target.props.onPress();
  await flush();
  assert.equal(one(draw(), "my-messages-calendar-week") !== undefined, true);
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Mar 10 Tue · 2 messages · 0 conversations");
});

test("Chinese and Japanese labels follow the locale", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history, locale: "zh-CN" });
  draw();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "2026年3月");
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "今天 · 3月15日 周日");
  assert.equal(h.text(one(draw(), "my-messages-calendar-legend")), "少\n多");
  h.setLocale("ja");
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "2026年3月");
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "今日 · 3月15日 日");
});

test("all three locales define the calendar text with matching interpolation", () => {
  const keys = {
    today: [], previousMonth: [], nextMonth: [], previousYear: [], nextYear: [],
    showMonth: [], hideMonth: [], showYear: [], showMonthView: [], less: [], more: [],
    dayCellLabel: ["date", "count"], dayCellEmpty: ["date"], dayTooltip: ["date", "count"],
    monthTotal: ["count"], yearMonthLabel: ["month", "year", "count"], todaySummary: ["date"],
    daySummary: ["date", "messages", "conversations"], daySummaryOne: ["date", "messages"],
    daySummaryMessages: ["date", "messages"], dayEmpty: [], dayLoading: [], dayFailed: [],
    unavailable: ["count"], notice: [],
  };
  for (const locale of ["en", "zh-CN", "ja"]) {
    const { myMessages } = require("../client/locales/" + locale + ".json");
    for (const [key, placeholders] of Object.entries(keys)) {
      const value = myMessages.calendar[key];
      assert.ok(value?.trim(), locale + " calendar." + key);
      assert.deepEqual([...value.matchAll(/{{(\w+)}}/g)].map(match => match[1]).sort(), [...placeholders].sort());
    }
  }
  const { myMessages: chinese } = require("../client/locales/zh-CN.json");
  assert.equal(chinese.calendar.todaySummary, "今天 · {{date}}");
  assert.equal(chinese.calendar.less, "少");
  assert.equal(chinese.calendar.more, "多");
});

test("a day picked while the counts are still loading keeps the calendar and its count", async t => {
  const today = dayKey(0);
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const history = {
    days: async () => { await gate; return daysResult({ [today]: 2 }); },
    day: async () => dayResult([{ agentId: "alpha", at: at(0, 9), text: "picked early" }]),
  };
  const directory = [agent("alpha", "Alpha conversation")];
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await settle();
  cell(draw(), "Mar 15 Sun").props.onPress();
  await settle();
  open();
  await flush();
  const view = draw();
  assert.equal(cell(view, "Mar 15 Sun").props.accessibilityLabel, "Mar 15 Sun, 2 messages");
  assert.match(h.text(one(view, "my-messages-screen-row")), /picked early/);
  assert.equal(one(view, "my-messages-screen-summary").props.children, "Today · Mar 15 Sun");
});
