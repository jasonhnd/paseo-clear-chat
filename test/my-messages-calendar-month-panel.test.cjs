const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

/**
 * The calendar's left panel: this month's four numbers and its five busiest conversations.
 * The summary is asserted against the same day counts the cells are drawn from; the ranking
 * against the days RPC's per-conversation counts; the filter against the day list it narrows.
 */

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

function monthCount(agentId, title, count, lastOffset, hour = 9) {
  return { month: "2026-03", agentId, title, count, lastAt: at(lastOffset, hour) };
}

function daysResult(entries, extras = {}) {
  const days = Object.entries(entries)
    .map(([day, count]) => ({ day, count }))
    .sort((left, right) => (left.day < right.day ? -1 : 1));
  return {
    days,
    firstDay: days[0]?.day ?? null,
    lastDay: days[days.length - 1]?.day ?? null,
    conversationMonths: [],
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

function timelineMessage(text, time, seq) {
  return { timestamp: new Date(time).toISOString(), seqStart: seq, item: { type: "user_message", text } };
}

function fakePaseo(directory, histories) {
  return {
    agents: {
      async list() {
        return { entries: directory.map(entry => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref(id) {
        return { timeline: {
          async refetch() {
            return { entries: histories.get(id) ?? [], hasOlder: false, error: null, gap: false, staleCursor: false, startCursor: null };
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
  const h = createToolHarness("web", {
    paseo: fakePaseo(directory, histories),
    ui: { SidebarRow: "Host.SidebarRow" },
    historyRpc,
    locale,
  });
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
  const draw = () => h.draw({
    type: screen.Component,
    props: { ...screenProps, layout: { ...screenProps.layout, compact } },
  });
  const all = (tree, id) => h.nodes(tree, node => node.props.testID === id);
  const one = (tree, id) => all(tree, id)[0];
  return { h, draw, all, one };
}

function historyFor(days, rowsByDay) {
  return {
    days: async () => days,
    day: async input => rowsByDay[input.day] ?? dayResult([]),
  };
}

/** Every testID in document order, so the panel's placement can be read off the tree. */
function testIds(tree, found = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) testIds(child, found);
    return found;
  }
  if (!tree || typeof tree !== "object") return found;
  if (tree.props?.testID) found.push(tree.props.testID);
  testIds(tree.props?.children, found);
  return found;
}

function contains(node, testID) {
  return testIds(node).includes(testID);
}

test("the month summary reads the four numbers from the same day counts the grid draws", async t => {
  const history = historyFor(daysResult({
    "2026-02-27": 9,
    "2026-03-01": 3,
    "2026-03-05": 12,
    "2026-03-09": 2,
  }, { firstDay: "2026-02-27" }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const view = draw();

  assert.equal(h.text(one(view, "my-messages-calendar-month-title")), "This month");
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "17");
  assert.equal(h.text(one(view, "my-messages-calendar-month-days")), "3");
  assert.equal(h.text(one(view, "my-messages-calendar-month-busiest")), "Mar 5 · 12");
  // 17 messages over the 15 days of March that have happened so far.
  assert.equal(h.text(one(view, "my-messages-calendar-month-average")), "1.1");

  // The February cell agrees with the February panel, not with March's totals.
  one(view, "my-messages-calendar-prev").props.onPress();
  const february = draw();
  assert.equal(h.text(one(february, "my-messages-calendar-month-title")), "February 2026");
  assert.equal(h.text(one(february, "my-messages-calendar-month-total")), "9");
  assert.equal(h.text(one(february, "my-messages-calendar-month-days")), "1");
  assert.equal(h.text(one(february, "my-messages-calendar-month-busiest")), "Feb 27 · 9");
  // A month that has ended divides by its own length, not by today's date.
  assert.equal(h.text(one(february, "my-messages-calendar-month-average")), "0.3");
});

test("the busiest day goes to the earlier date when two days tie", async t => {
  const history = historyFor(daysResult({ "2026-01-01": 4, "2026-01-08": 4 }, { firstDay: "2026-01-01" }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  // January is two months back from the frozen March day.
  one(draw(), "my-messages-calendar-prev").props.onPress();
  one(draw(), "my-messages-calendar-prev").props.onPress();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "8");
  assert.equal(h.text(one(view, "my-messages-calendar-month-busiest")), "Jan 1 · 4");
});

test("the top five conversations order by count, then newest, then id", async t => {
  const conversations = [
    monthCount("alpha", "Alpha conversation", 9, -5),
    monthCount("bravo", "Bravo conversation", 9, -3),
    monthCount("charlie", "Charlie conversation", 9, -3),
    monthCount("delta", "Delta conversation", 4, -12),
    monthCount("echo", "Echo conversation", 4, -14),
    monthCount("foxtrot", "Foxtrot conversation", 4, -13),
    monthCount("golf", "Golf conversation", 2, -1),
  ];
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, { conversationMonths: conversations }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, all, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const rows = all(draw(), "my-messages-calendar-top-conversation");
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(node => node.props.accessibilityLabel), [
    "Bravo conversation, 9 messages",
    "Charlie conversation, 9 messages",
    "Alpha conversation, 9 messages",
    "Delta conversation, 4 messages",
    "Foxtrot conversation, 4 messages",
  ]);
  assert.equal(rows.some(node => h.text(node).includes("Golf")), false);
});

test("pressing a conversation filters the day list and pressing it again clears the filter", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  const history = historyFor(
    daysResult({ [dayKey(0)]: 2 }, {
      conversationMonths: [monthCount("alpha", "Alpha conversation", 1, 0), monthCount("beta", "Beta conversation", 1, 0)],
    }),
    { [dayKey(0)]: dayResult([
      { agentId: "alpha", at: at(0, 9), text: "alpha today" },
      { agentId: "beta", at: at(0, 8), text: "beta today" },
    ]) },
  );
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();

  assert.equal(all(draw(), "my-messages-calendar-filter").length, 0);
  assert.equal(all(draw(), "my-messages-screen-row").length, 2);

  all(draw(), "my-messages-calendar-top-conversation")[1].props.onPress();
  const filtered = draw();
  assert.equal(all(filtered, "my-messages-screen-row").length, 1);
  assert.match(h.text(one(filtered, "my-messages-screen-row")), /beta today/);
  assert.match(h.text(one(filtered, "my-messages-calendar-filter")), /^Showing only Beta conversation · Clear/);
  const selected = all(filtered, "my-messages-calendar-top-conversation")
    .find(node => node.props.accessibilityLabel === "Beta conversation, 1 message");
  assert.equal(selected.props.accessibilityState.selected, true);

  selected.props.onPress();
  const restored = draw();
  assert.equal(all(restored, "my-messages-screen-row").length, 2);
  assert.equal(all(restored, "my-messages-calendar-filter").length, 0);
});

test("the filter bar clears the filter and a filtered day says when none of it is here", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("gamma", "Gamma conversation")];
  const history = historyFor(
    daysResult({ [dayKey(0)]: 1 }, {
      conversationMonths: [
        monthCount("alpha", "Alpha conversation", 1, 0),
        monthCount("gamma", "Gamma conversation", 2, -1),
      ],
    }),
    { [dayKey(0)]: dayResult([{ agentId: "alpha", at: at(0, 9), text: "alpha today" }]) },
  );
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();

  // Gamma outranks Alpha this month but said nothing today: the list is empty and says so.
  all(draw(), "my-messages-calendar-top-conversation")[0].props.onPress();
  const filtered = draw();
  assert.equal(all(filtered, "my-messages-screen-row").length, 0);
  assert.match(h.text(filtered), /No messages from this conversation on this day/);
  assert.ok(one(filtered, "my-messages-calendar-filter"));

  one(filtered, "my-messages-calendar-filter").props.onPress();
  const restored = draw();
  assert.equal(all(restored, "my-messages-calendar-filter").length, 0);
  assert.equal(all(restored, "my-messages-screen-row").length, 1);
  assert.match(h.text(one(restored, "my-messages-screen-row")), /alpha today/);
});

test("a month change drops the filter instead of carrying it into another month", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  const history = historyFor(
    daysResult({ "2026-02-10": 2, [dayKey(0)]: 2 }, {
      firstDay: "2026-02-10",
      conversationMonths: [monthCount("alpha", "Alpha conversation", 1, 0), monthCount("beta", "Beta conversation", 1, 0)],
    }),
    {
      [dayKey(0)]: dayResult([
        { agentId: "alpha", at: at(0, 9), text: "alpha today" },
        { agentId: "beta", at: at(0, 8), text: "beta today" },
      ]),
      "2026-02-10": dayResult([{ agentId: "alpha", at: at(-33, 9), text: "alpha in february" }]),
    },
  );
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  all(draw(), "my-messages-calendar-top-conversation")[0].props.onPress();
  assert.equal(all(draw(), "my-messages-calendar-filter").length, 1);

  one(draw(), "my-messages-calendar-prev").props.onPress();
  await flush();
  const view = draw();
  assert.equal(all(view, "my-messages-calendar-filter").length, 0,
    "the filter belongs to the month it was chosen in");
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "2");
  assert.equal(h.text(one(view, "my-messages-calendar-month-busiest")), "Feb 10 · 2");
  assert.equal(all(view, "my-messages-screen-row").length, 2, "the day list is no longer narrowed");
});

test("the panel marks totals and ranking possibly incomplete when a conversation was not read", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  const history = historyFor(
    daysResult({ [dayKey(0)]: 1 }, {
      conversationMonths: [monthCount("alpha", "Alpha conversation", 1, 0)],
      slowConversationIds: ["beta"],
    }),
    { [dayKey(0)]: dayResult([{ agentId: "alpha", at: at(0, 9), text: "alpha today" }]) },
  );
  const { draw, all, one } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  assert.equal(all(draw(), "my-messages-calendar-month-partial").length, 1);

  // A clean answer carries no marker at all: the note cannot be dead copy.
  const clean = historyFor(
    daysResult({ [dayKey(0)]: 1 }, { conversationMonths: [monthCount("alpha", "Alpha conversation", 1, 0)] }),
    { [dayKey(0)]: dayResult([{ agentId: "alpha", at: at(0, 9), text: "alpha today" }]) },
  );
  const second = fixture(t, { historyRpc: clean, directory });
  second.draw();
  await flush();
  assert.equal(second.all(second.draw(), "my-messages-calendar-month-partial").length, 0);
  assert.ok(one(second.draw(), "my-messages-calendar-month-panel"));
});

test("a partial directory or unpublished per-conversation counts also mark the panel incomplete", async t => {
  // The host answered totals but no ranking: the panel must not present an empty list as exact.
  const withoutRanking = historyFor(
    daysResult({ [dayKey(0)]: 1 }),
    { [dayKey(0)]: dayResult([]) },
  );
  const first = fixture(t, { historyRpc: withoutRanking });
  first.draw();
  await flush();
  assert.equal(first.all(first.draw(), "my-messages-calendar-month-partial").length, 1);
  assert.equal(first.all(first.draw(), "my-messages-calendar-top-conversation").length, 0);

  // A partial directory has not seen every conversation even when counts did arrive.
  const partialDirectory = historyFor(
    daysResult({ [dayKey(0)]: 1 }, {
      conversationMonths: [monthCount("alpha", "Alpha conversation", 1, 0)],
      directoryPartial: true,
    }),
    { [dayKey(0)]: dayResult([]) },
  );
  const second = fixture(t, { historyRpc: partialDirectory });
  second.draw();
  await flush();
  assert.equal(second.all(second.draw(), "my-messages-calendar-month-partial").length, 1);
});

test("wide: the calendar stays above a scrolling left column, so it cannot scroll away", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 3 }, {
    conversationMonths: [monthCount("alpha", "Alpha conversation", 3, 0)],
  }), { [dayKey(0)]: dayResult([{ agentId: "alpha", at: at(0, 9), text: "one" }]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const view = draw();
  const scroll = one(view, "my-messages-calendar-left-scroll");
  assert.ok(scroll);
  assert.equal(contains(scroll, "my-messages-calendar-month-panel"), true);
  assert.equal(contains(scroll, "my-messages-calendar-cell"), false,
    "the grid is a sibling above the scroll area, not inside it");

  // Document order: header, grid, panel inside the scroll, then the message list.
  const order = testIds(view);
  assert.ok(order.indexOf("my-messages-calendar-left-scroll") < order.indexOf("my-messages-calendar-month-panel"));
  assert.ok(order.indexOf("my-messages-calendar-month-panel") < order.indexOf("my-messages-screen-list"));
  assert.equal(h.nodes(view, node => node.props.testID === "my-messages-calendar-week").length, 0);
});

test("compact: the panel sits between the week strip and the message list", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [monthCount("alpha", "Alpha conversation", 2, 0)],
  }), { [dayKey(0)]: dayResult([
    { agentId: "alpha", at: at(0, 9), text: "alpha today" },
    { agentId: "alpha", at: at(0, 8), text: "alpha earlier" },
  ]) });
  const { draw, one, all, h } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  assert.ok(one(draw(), "my-messages-calendar-week"), "the narrow screen opens on the week");
  const view = draw();
  const order = testIds(view);
  assert.ok(order.indexOf("my-messages-calendar-week") < order.indexOf("my-messages-calendar-month-panel"));
  assert.ok(order.indexOf("my-messages-calendar-month-panel") < order.indexOf("my-messages-screen-list"));
  assert.ok(one(view, "my-messages-calendar-month-panel"));
  assert.equal(one(view, "my-messages-calendar-left-scroll"), undefined,
    "the compact panel scrolls sideways with the page, not inside a nested vertical scroll");
  // Both of the day's rows are in the list: a zero-row layout would pass a `<= 1` check too.
  assert.equal(all(view, "my-messages-screen-row").length, 2);
  assert.match(h.text(all(view, "my-messages-screen-row")[0]), /alpha today/);

  // The calendar column is bounded, and at 390x844 the list keeps more than two rows of it.
  const screen = h.load("client/components/my-messages-calendar-screen.tsx");
  one(view, "my-messages-calendar-expand").props.onPress();
  const expanded = draw();
  const scroll = one(expanded, "my-messages-calendar-compact-scroll");
  assert.ok(scroll, "the expanded compact month scrolls inside its share of the page");
  assert.equal(scroll.props.style.maxHeight, "58%");
  assert.equal(one(expanded, "my-messages-screen-list").props.style.flex, 1);
  assert.equal(all(expanded, "my-messages-screen-row").length, 2,
    "expanding the month does not drop the day's rows");
  assert.ok(screen.compactMessageListHeight(844) >= screen.COMPACT_LIST_ROW * 2,
    `the list keeps ${screen.compactMessageListHeight(844)}px at 390x844`);
  assert.ok(screen.compactMessageListHeight(667) >= screen.COMPACT_LIST_ROW,
    `the list keeps ${screen.compactMessageListHeight(667)}px on a 667px-tall screen`);
});

test("the panel's labels follow the interface language", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [monthCount("alpha", "Alpha conversation", 2, 0)],
  }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-month-title")), "This month");
  h.setLocale("zh-CN");
  assert.equal(h.text(one(draw(), "my-messages-calendar-month-title")), "本月小结");
  assert.equal(h.text(one(draw(), "my-messages-calendar-month-days")), "1");
  h.setLocale("ja");
  assert.equal(h.text(one(draw(), "my-messages-calendar-month-title")), "今月のまとめ");
});

test("a historical month names itself and does not borrow the current month's wording", async t => {
  const history = historyFor(daysResult({ "2026-02-10": 2 }, {
    firstDay: "2026-02-10",
    conversationMonths: [monthCount("alpha", "Alpha conversation", 2, -33)],
  }), { "2026-02-10": dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history, locale: "ja" });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-prev").props.onPress();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-title")), "2026年2月");
  const top = h.nodes(view, node => node.props.testID === "my-messages-calendar-month-panel")
    .map(node => h.text(node)).join("");
  assert.match(top, /メッセージの多い会話/);
  assert.doesNotMatch(top, /よく話した会話/);

  // An empty historical month must not say "still nothing this month".
  const empty = historyFor(daysResult({ "2026-01-05": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-05" }),
    { [dayKey(0)]: dayResult([]), "2026-01-05": dayResult([]) });
  const second = fixture(t, { historyRpc: empty, locale: "ja" });
  second.draw();
  await flush();
  second.one(second.draw(), "my-messages-calendar-prev").props.onPress();
  const february = second.draw();
  assert.equal(second.h.text(second.one(february, "my-messages-calendar-month-empty")),
    "この月にメッセージはありません");
});

test("a conversation read by opening a day is in the ranking, so the list adds up to the summary", async t => {
  // Hermes has one message on the day; opening it reads three more from another
  // conversation. The cell and the summary count four, so the ranking must count four too.
  const directory = [agent("hermes", "Hermes chat"), agent("other", "Other chat")];
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    conversationMonths: [monthCount("hermes", "Hermes chat", 1, 0)],
    slowConversationIds: ["other"],
  }), { [dayKey(0)]: dayResult([{ agentId: "hermes", at: at(0, 9), text: "hermes today" }]) });
  const histories = new Map([["other", [
    timelineMessage("other one", at(0, 8), 1),
    timelineMessage("other two", at(0, 8, 30), 2),
    timelineMessage("other three", at(0, 7), 3),
  ]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();

  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "4");
  assert.deepEqual(
    all(view, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Other chat, 3 messages", "Hermes chat, 1 message"],
  );
  const ranked = 3 + 1;
  assert.equal(ranked, Number(h.text(one(view, "my-messages-calendar-month-total"))),
    "the ranking's counts add up to the summary's total");
  assert.equal(all(view, "my-messages-screen-row").length, 4, "the day lists what was read");

  // Re-reading the same day replaces its contribution instead of adding it again.
  const cells = all(view, "my-messages-calendar-cell");
  const other = cells.find(node => String(node.props.accessibilityLabel).startsWith("Mar 14"));
  assert.ok(other, "the grid offers another day to step to");
  other.props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Mar 15")).props.onPress();
  await flush();
  const again = draw();
  assert.equal(h.text(one(again, "my-messages-calendar-month-total")), "4");
  assert.deepEqual(
    all(again, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Other chat, 3 messages", "Hermes chat, 1 message"],
  );
});

test("collapsing the compact month returns the panel to the week's month and drops its filter", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  const history = historyFor(daysResult({ "2026-02-10": 2, [dayKey(0)]: 2 }, {
    firstDay: "2026-02-10",
    conversationMonths: [
      { month: "2026-02", agentId: "alpha", title: "Alpha conversation", count: 2, lastAt: at(-33, 9) },
      { month: "2026-03", agentId: "alpha", title: "Alpha conversation", count: 1, lastAt: at(0, 9) },
      { month: "2026-03", agentId: "beta", title: "Beta conversation", count: 1, lastAt: at(0, 8) },
    ],
  }), {
    [dayKey(0)]: dayResult([
      { agentId: "alpha", at: at(0, 9), text: "alpha today" },
      { agentId: "beta", at: at(0, 8), text: "beta today" },
    ]),
    "2026-02-10": dayResult([{ agentId: "alpha", at: at(-33, 9), text: "alpha in february" }]),
  });
  const { draw, all, one, h } = fixture(t, { historyRpc: history, compact: true, directory });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-expand").props.onPress();

  // Browse February while the week strip stays on March's selected day, and filter there.
  one(draw(), "my-messages-calendar-prev").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-month-title")), "February 2026");
  all(draw(), "my-messages-calendar-top-conversation")[0].props.onPress();
  assert.equal(all(draw(), "my-messages-calendar-filter").length, 1);

  // Collapsing shows March again: the panel follows the week strip and the filter is gone.
  one(draw(), "my-messages-calendar-expand").props.onPress();
  const collapsed = draw();
  assert.ok(one(collapsed, "my-messages-calendar-week"));
  assert.equal(h.text(one(collapsed, "my-messages-calendar-month-title")), "This month");
  assert.equal(h.text(one(collapsed, "my-messages-calendar-month-total")), "2");
  assert.equal(all(collapsed, "my-messages-calendar-filter").length, 0);
  assert.equal(all(collapsed, "my-messages-screen-row").length, 2, "the day's list is not filtered");
});

test("a host that answers totals without the ranking says so instead of calling the month empty", async t => {
  const days = daysResult({ [dayKey(0)]: 1 });
  // An older host simply omits the field; the fixture must not smuggle an empty array in.
  delete days.conversationMonths;
  assert.equal("conversationMonths" in days, false);
  const history = historyFor(days, { [dayKey(0)]: dayResult([{ agentId: "alpha", at: at(0, 9), text: "alpha today" }]) });
  const { draw, all, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "1");
  assert.equal(all(view, "my-messages-calendar-month-empty").length, 0,
    "a month with a message is not called empty");
  assert.equal(h.text(one(view, "my-messages-calendar-month-no-ranking")),
    "The ranking for this month is not available from this host.");
  assert.equal(all(view, "my-messages-calendar-month-partial").length, 1);

  // A month that really has nothing still says so, with no ranking note beside it.
  const blank = historyFor(daysResult({ "2026-01-05": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-05" }),
    { [dayKey(0)]: dayResult([]), "2026-01-05": dayResult([]) });
  const second = fixture(t, { historyRpc: blank });
  second.draw();
  await flush();
  second.one(second.draw(), "my-messages-calendar-prev").props.onPress();
  const february = second.draw();
  assert.equal(second.h.text(second.one(february, "my-messages-calendar-month-empty")),
    "No messages in this month");
  assert.equal(second.all(february, "my-messages-calendar-month-no-ranking").length, 0);
});

test("monthSummary counts only its own month and divides by elapsed days", () => {
  const h = createToolHarness("web");
  const { monthSummary, topConversations } = h.load("client/my-messages-calendar.ts");
  const summary = monthSummary(
    { "2026-02-28": 100, "2026-03-01": 5, "2026-03-05": 5 },
    "2026-03",
    "2026-03-15",
  );
  assert.deepEqual(
    {
      total: summary.total,
      days: summary.daysWithMessages,
      busiest: summary.busiestDay,
      busiestCount: summary.busiestCount,
      elapsed: summary.elapsedDays,
    },
    { total: 10, days: 2, busiest: "2026-03-01", busiestCount: 5, elapsed: 15 },
    "a tie keeps the earlier day and another month's counts stay out",
  );
  assert.ok(Math.abs(summary.dailyAverage - 10 / 15) < 1e-9);
  assert.equal(monthSummary({ "2026-02-01": 7 }, "2026-02", "2026-03-15").elapsedDays, 28);

  const entries = [
    { agentId: "b", title: null, count: 2, lastAt: 10 },
    { agentId: "a", title: null, count: 2, lastAt: 10 },
    { agentId: "c", title: null, count: 2, lastAt: 20 },
    { agentId: "d", title: null, count: 3, lastAt: 1 },
  ];
  assert.deepEqual(topConversations(entries, 99).map(entry => entry.agentId), ["d", "c", "a", "b"]);
  assert.deepEqual(topConversations(entries, 1).map(entry => entry.agentId), ["d"]);
  h.dispose();
});
