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
  // The current host names the count-only records even when there are none; a test that wants
  // an earlier host deletes the field.
  return { rows, counted: [], directoryPartial: false, fromCache: 0, ...extras };
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
});

test("compact: an expanded month leaves the day's list a visible first screen", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [monthCount("alpha", "Alpha conversation", 2, 0)],
    slowConversationIds: ["alpha"],
  }), { [dayKey(0)]: dayResult([
    { agentId: "alpha", at: at(0, 9), text: "alpha today" },
    { agentId: "alpha", at: at(0, 8), text: "alpha earlier" },
  ]) });
  const { draw, one, all, h } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  const screen = h.load("client/components/my-messages-calendar-screen.tsx");
  one(draw(), "my-messages-calendar-expand").props.onPress();
  const expanded = draw();

  // The calendar column is bounded and scrolls inside its share of the page. The page measures
  // the body and caps the column in pixels, so the list's room is fixed arithmetic: the same
  // number the test reads is the number the page draws with.
  const scrollBefore = one(expanded, "my-messages-calendar-compact-scroll");
  assert.ok(scrollBefore, "the expanded compact month scrolls inside its share of the page");
  assert.equal(scrollBefore.props.style.maxHeight, "58%", "the share stands in before the first measure");
  const body = one(expanded, "my-messages-calendar-body");
  const bodyHeight = 704; // 844 - 2*12 - 104: the room under the toolbar at 390x844
  body.props.onLayout({ nativeEvent: { layout: { width: 390, height: bodyHeight } } });
  const measured = draw();
  const scroll = one(measured, "my-messages-calendar-compact-scroll");
  assert.equal(scroll.props.style.maxHeight, screen.compactCalendarMaxHeight(bodyHeight));
  assert.ok(scroll.props.style.maxHeight < bodyHeight, "the bound leaves the list most of the page");
  assert.equal(one(measured, "my-messages-screen-list").props.style.flex, 1);
  assert.equal(all(measured, "my-messages-screen-row").length, 2,
    "expanding the month does not drop the day's rows");
  assert.ok(one(measured, "my-messages-calendar-month-partial"),
    "the may-be-incomplete note is on screen with the month open");

  // The list column carries its floor in production: the summary, the filter bar, the gaps
  // and one whole row, using the row's real height rather than its text alone.
  const column = one(measured, "my-messages-calendar-list-column");
  assert.equal(column.props.style.minHeight, screen.compactListFloor());
  assert.equal(screen.compactListFloor(), screen.COMPACT_LIST_ROW + 56);
  assert.ok(screen.COMPACT_LIST_ROW >= 144,
    "one row holds 16 px padding, a title line, three text lines and the 44 px actions");
  for (const viewport of [844, 667]) {
    const room = screen.compactBodyHeight(viewport);
    const used = screen.compactCalendarMaxHeight(room) + screen.compactListFloor();
    assert.ok(used <= room, `the cap and the list floor fit a ${viewport}px page (${used} of ${room})`);
  }
});

test("narrow: the filter bar and two notices sit above a list that still keeps its floor", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  // A partial directory and a count-only month put both alert lines on screen at once; the
  // day's rows still have to start inside the page.
  const history = historyFor(daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [monthCount("alpha", "Alpha conversation", 2, 0)],
    slowConversationIds: ["alpha"],
    directoryPartial: true,
    cacheFull: ["2026-03"],
  }), {
    [dayKey(0)]: dayResult([
      { agentId: "alpha", at: at(0, 9), text: "alpha today" },
      { agentId: "beta", at: at(0, 8), text: "beta today" },
    ]),
  });
  const { draw, one, all, h } = fixture(t, { historyRpc: history, compact: true, directory });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-expand").props.onPress();
  one(draw(), "my-messages-calendar-body").props.onLayout({ nativeEvent: { layout: { width: 390, height: 704 } } });
  all(draw(), "my-messages-calendar-top-conversation")[0].props.onPress();
  const view = draw();
  const screen = h.load("client/components/my-messages-calendar-screen.tsx");
  assert.ok(one(view, "my-messages-calendar-filter"), "the filter bar is on screen with the list");
  assert.ok(one(view, "my-messages-calendar-notice"), "the unread-conversation line is on screen");
  assert.ok(one(view, "my-messages-calendar-notice-full"), "the count-only archive line is on screen");
  assert.equal(one(view, "my-messages-calendar-list-column").props.style.minHeight, screen.compactListFloor(),
    "the notices and the filter bar do not take the list's floor");
  assert.equal(all(view, "my-messages-screen-row").length, 1, "the filtered list keeps its row");
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
  // A ranking heading that names the month would be wrong on a month that has ended; the
  // Chinese heading names what the list is, not when it is.
  assert.match(h.text(one(draw(), "my-messages-calendar-month-panel")), /消息最多的对话/);
  assert.doesNotMatch(h.text(one(draw(), "my-messages-calendar-month-panel")), /本月常聊的对话/);
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

test("collapsing the month keeps a filter chosen in the month the week strip shows", async t => {
  const directory = [agent("alpha", "Alpha conversation"), agent("beta", "Beta conversation")];
  const history = historyFor(daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [
      { month: "2026-03", agentId: "alpha", title: "Alpha conversation", count: 1, lastAt: at(0, 9) },
      { month: "2026-03", agentId: "beta", title: "Beta conversation", count: 1, lastAt: at(0, 8) },
    ],
  }), {
    [dayKey(0)]: dayResult([
      { agentId: "alpha", at: at(0, 9), text: "alpha today" },
      { agentId: "beta", at: at(0, 8), text: "beta today" },
    ]),
  });
  const { draw, all, one, h } = fixture(t, { historyRpc: history, compact: true, directory });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-expand").props.onPress();
  all(draw(), "my-messages-calendar-top-conversation")[0].props.onPress();
  assert.equal(all(draw(), "my-messages-calendar-filter").length, 1);
  assert.equal(all(draw(), "my-messages-screen-row").length, 1);

  // Collapsing inside the same month is not a month change: the filter still applies.
  one(draw(), "my-messages-calendar-expand").props.onPress();
  const collapsed = draw();
  assert.ok(one(collapsed, "my-messages-calendar-week"));
  assert.equal(h.text(one(collapsed, "my-messages-calendar-month-title")), "This month");
  assert.equal(all(collapsed, "my-messages-calendar-filter").length, 1,
    "a filter chosen in this month survives the collapse");
  assert.equal(all(collapsed, "my-messages-screen-row").length, 1, "the list is still filtered");
  all(collapsed, "my-messages-calendar-filter")[0].props.onPress();
  assert.equal(all(draw(), "my-messages-screen-row").length, 2);
});

test("a failed day RPC keeps the host's count instead of ranking the rows it read", async t => {
  const directory = [agent("hermes", "Hermes chat"), agent("other", "Other chat")];
  const history = {
    days: async () => daysResult({ [dayKey(0)]: 1 }, {
      conversationMonths: [monthCount("hermes", "Hermes chat", 1, 0)],
      slowConversationIds: ["other"],
    }),
    day: async () => { throw new Error("the day read failed"); },
  };
  const histories = new Map([
    ["hermes", [timelineMessage("hermes today", at(0, 9), 1)]],
    ["other", [
      timelineMessage("other one", at(0, 8), 2),
      timelineMessage("other two", at(0, 8, 30), 3),
      timelineMessage("other three", at(0, 7), 4),
    ]],
  ]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "1",
    "the month keeps the host's count, not the rows the failed day read");
  assert.deepEqual(
    all(view, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Hermes chat, 1 message"],
    "a failed day adds nothing to the ranking",
  );
  assert.equal(all(view, "my-messages-screen-row").length, 4, "the day still lists every row it read");
  assert.ok(one(view, "my-messages-calendar-unreconciled"),
    "the day says its count and its rows were not matched");
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0,
    "no archive evidence, so no claim about missing text");
});

test("a count-only archive message is not counted twice when the timeline finds it", async t => {
  const countedAt = at(0, 9);
  const directory = [agent("gone", "Gone chat")];
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    conversationMonths: [monthCount("gone", "Gone chat", 1, 0)],
    slowConversationIds: ["gone"],
  }), {
    // The archive kept this message as a count only: the day says it counted it, but has no
    // row to show for it.
    [dayKey(0)]: dayResult([], { counted: [{ agentId: "gone", at: countedAt }] }),
  });
  const histories = new Map([["gone", [timelineMessage("gone one", countedAt, 1)]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "1",
    "the message the archive counted is not counted again from the timeline");
  assert.deepEqual(
    all(view, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Gone chat, 1 message"],
  );
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0, "nothing is counted without a row");
  assert.equal(all(view, "my-messages-screen-row").length, 1);
});

test("re-reading a day that was not cached replaces its ranking rows instead of adding them", async t => {
  const directory = [agent("hermes", "Hermes chat"), agent("other", "Other chat"), agent("silent", "Silent chat")];
  const history = historyFor(daysResult({ "2026-02-10": 1, [dayKey(0)]: 1 }, {
    conversationMonths: [monthCount("hermes", "Hermes chat", 1, 0)],
    slowConversationIds: ["other", "silent"],
  }), {
    [dayKey(0)]: dayResult([{ agentId: "hermes", at: at(0, 9), text: "hermes today" }]),
    "2026-02-10": dayResult([]),
  });
  let otherReads = 0;
  const histories = {
    get(id) {
      // The silent conversation answers nothing, so its day is never cached and is read again.
      if (id === "silent") return [];
      if (id !== "other") return [];
      otherReads += 1;
      return otherReads === 1
        ? [timelineMessage("other first", at(0, 8), 2)]
        : [
            timelineMessage("other one", at(0, 8), 2),
            timelineMessage("other two", at(0, 8, 30), 3),
            timelineMessage("other three", at(0, 7), 4),
          ];
    },
  };
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-month-total")), "2");

  // Step away to February and back: the day is read again, and the second answer is larger.
  one(draw(), "my-messages-calendar-prev").props.onPress();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Feb 10")).props.onPress();
  await flush();
  one(draw(), "my-messages-calendar-next").props.onPress();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Mar 15")).props.onPress();
  await flush();
  const second = draw();
  assert.ok(otherReads >= 2, `the day was read again (${otherReads} reads)`);
  assert.equal(h.text(one(second, "my-messages-calendar-month-total")), "4",
    "the second read replaces the first day's rows instead of adding to them");
  assert.deepEqual(
    all(second, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Other chat, 3 messages", "Hermes chat, 1 message"],
  );
});

test("a host without per-conversation counts still says the ranking is unavailable after a day is opened", async t => {
  const days = daysResult({ [dayKey(0)]: 1 }, { slowConversationIds: ["other"] });
  delete days.conversationMonths;
  const directory = [agent("hermes", "Hermes chat"), agent("other", "Other chat")];
  const history = historyFor(days, {
    [dayKey(0)]: dayResult([{ agentId: "hermes", at: at(0, 9), text: "hermes today" }]),
  });
  const histories = new Map([["other", [timelineMessage("other one", at(0, 8), 2)]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "2");
  assert.equal(all(view, "my-messages-calendar-top-conversation").length, 1);
  assert.equal(h.text(one(view, "my-messages-calendar-month-no-ranking")),
    "The ranking for this month is not available from this host.",
    "a ranking filled in by opening a day is not the host's ranking");
  assert.equal(all(view, "my-messages-calendar-month-partial").length, 1);
  assert.equal(all(view, "my-messages-calendar-month-empty").length, 0);
});

test("a failed day read keeps its five counted messages and adds none of the two rows", async t => {
  // The day's five messages live in the archive for a session the timeline cannot read. The
  // other conversation's two rows are real, but with no day answer there is no record to pair
  // them with, so the day keeps the host's five and says the two lists were not matched.
  const directory = [agent("gone", "Gone chat"), agent("fresh", "Fresh chat")];
  let dayCalls = 0;
  const history = {
    days: async () => daysResult({ "2026-02-10": 1, [dayKey(0)]: 5 }, {
      firstDay: "2026-02-10",
      conversationMonths: [monthCount("gone", "Gone chat", 5, 0)],
      slowConversationIds: ["gone"],
    }),
    day: async () => { dayCalls += 1; throw new Error("the day read failed"); },
  };
  const histories = new Map([["fresh", [
    timelineMessage("fresh one", at(0, 8), 7),
    timelineMessage("fresh two", at(0, 8, 30), 8),
  ]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "5",
    "the cell and the summary keep the five counted messages without adding the two rows");
  assert.deepEqual(
    all(view, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Gone chat, 5 messages"],
  );
  assert.equal(all(view, "my-messages-screen-row").length, 2, "the day still lists what it read");
  assert.ok(one(view, "my-messages-calendar-unreconciled"),
    "the day says its count and its rows were not matched");
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0,
    "the unexplained five are not described as missing text");

  // The failed day is not cached: opening it again asks the day RPC again.
  const before = dayCalls;
  one(view, "my-messages-calendar-prev").props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Feb 10")).props.onPress();
  await flush();
  one(draw(), "my-messages-calendar-next").props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Mar 15")).props.onPress();
  await flush();
  assert.ok(dayCalls > before, `the failed day was read again (${dayCalls} calls)`);
});

test("a failed day read that cannot attribute its rows says so instead of guessing", async t => {
  // Both conversations already have messages this month, so the failed day's count could
  // belong to either. The ranking keeps the host's numbers and the day says it could not
  // match them, rather than spreading the difference by recency.
  const directory = [agent("alpha", "Alpha chat"), agent("beta", "Beta chat")];
  const history = {
    days: async () => daysResult({ [dayKey(0)]: 5 }, {
      conversationMonths: [
        monthCount("alpha", "Alpha chat", 3, 0),
        monthCount("beta", "Beta chat", 2, -1),
      ],
      slowConversationIds: ["alpha", "beta"],
    }),
    day: async () => { throw new Error("the day read failed"); },
  };
  const histories = new Map([["beta", [
    timelineMessage("beta one", at(0, 8), 7),
    timelineMessage("beta two", at(0, 8, 30), 8),
  ]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "5",
    "the ranking is not padded beyond what the host counted");
  assert.deepEqual(
    all(view, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Alpha chat, 3 messages", "Beta chat, 2 messages"],
  );
  assert.ok(one(view, "my-messages-calendar-unreconciled"),
    "the day says its count and its rows were not matched");
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0,
    "an unmatched day does not claim a count-only number it cannot place");
});

test("a count-only record at an instant with two rows leaves the day unmatched", async t => {
  const shared = at(0, 9);
  const directory = [agent("gone", "Gone chat")];
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    conversationMonths: [monthCount("gone", "Gone chat", 1, 0)],
    slowConversationIds: ["gone"],
  }), {
    [dayKey(0)]: dayResult([], { counted: [{ agentId: "gone", at: shared }] }),
  });
  // One archived copy the count already holds, plus a different message written in the same
  // millisecond. Which row is the archived one cannot be told, so neither is added: the count
  // stays at the host's one and the day says the two lists were not matched.
  const histories = new Map([["gone", [
    timelineMessage("archived copy", shared, 1),
    timelineMessage("new message", shared, 2),
  ]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "1",
    "a same-millisecond pair is not split by guessing which row is the record");
  assert.deepEqual(
    all(view, "my-messages-calendar-top-conversation").map(node => node.props.accessibilityLabel),
    ["Gone chat, 1 message"],
  );
  assert.equal(all(view, "my-messages-screen-row").length, 2);
  assert.ok(one(view, "my-messages-calendar-unreconciled"),
    "the day says its count and its rows were not matched");
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0,
    "the ambiguity is not also read as lost text");
});

test("two identical messages in the same millisecond stay two rows", async t => {
  const shared = at(0, 9);
  const directory = [agent("gone", "Gone chat")];
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    conversationMonths: [monthCount("gone", "Gone chat", 1, 0)],
    slowConversationIds: ["gone"],
  }), {
    [dayKey(0)]: dayResult([{ agentId: "gone", at: shared, text: "same words" }]),
  });
  const histories = new Map([["gone", [
    timelineMessage("same words", shared, 1),
    timelineMessage("same words", shared, 2),
  ]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "2",
    "the archive's one copy matches one of the two identical rows");
  assert.equal(all(view, "my-messages-screen-row").length, 2, "both messages are listed");
});

test("a count-only record does not swallow a different message in the same millisecond", async t => {
  const shared = at(0, 9);
  const directory = [agent("gone", "Gone chat")];
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    conversationMonths: [monthCount("gone", "Gone chat", 1, 0)],
    slowConversationIds: ["gone"],
  }), {
    [dayKey(0)]: dayResult([], { counted: [{ agentId: "gone", at: shared }] }),
  });
  // Only the other message comes back: it may be the one the archive counted, or a second
  // message the count never saw. With nothing to tell them apart the count stays, the row
  // is listed, and the day says it could not match them instead of claiming one.
  const histories = new Map([["gone", [timelineMessage("different words", shared, 1)]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "1",
    "the count is not padded with a row that may already be in it");
  assert.equal(all(view, "my-messages-screen-row").length, 1, "the row is still listed");
  assert.ok(one(view, "my-messages-calendar-unreconciled"),
    "the day says its count and its rows were not matched");
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0,
    "it does not also claim the text was lost");
});

test("a failed day read with nothing to list is marked unmatched and read again on reopen", async t => {
  // No conversation is listed, so the fallback reads nothing at all and the day has no
  // failure of its own: without the unmatched flag it would look settled and be cached.
  const directory = [];
  let dayCalls = 0;
  const history = {
    days: async () => daysResult({ "2026-02-10": 1, [dayKey(0)]: 3 }, {
      firstDay: "2026-02-10",
      conversationMonths: [
        { month: "2026-02", agentId: "alpha", title: "Alpha chat", count: 1, lastAt: at(-33, 9) },
        monthCount("alpha", "Alpha chat", 3, 0),
      ],
      slowConversationIds: ["alpha"],
    }),
    day: async input => {
      dayCalls += 1;
      if (input.day !== dayKey(0) || dayCalls === 1) throw new Error("the day read failed");
      return dayResult([
        { agentId: "alpha", at: at(0, 9), text: "alpha today" },
        { agentId: "alpha", at: at(0, 8), text: "alpha earlier" },
        { agentId: "alpha", at: at(0, 7), text: "alpha earliest" },
      ]);
    },
  };
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  const failed = draw();
  assert.equal(h.text(one(failed, "my-messages-calendar-month-total")), "3",
    "the day keeps the count the host reported");
  assert.equal(all(failed, "my-messages-screen-row").length, 0);
  assert.ok(one(failed, "my-messages-calendar-unreconciled"),
    "a count with nothing listed is not presented as settled");
  assert.equal(all(failed, "my-messages-calendar-count-only").length, 0,
    "no archive evidence, so no claim about missing text");
  assert.doesNotMatch(h.text(failed), /Nothing from you on this day/);

  // Step away and back: the unmatched day was not cached, so the day RPC is asked again.
  one(failed, "my-messages-calendar-prev").props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Feb 10")).props.onPress();
  await flush();
  one(draw(), "my-messages-calendar-next").props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Mar 15")).props.onPress();
  await flush();
  const recovered = draw();
  assert.equal(all(recovered, "my-messages-screen-row").length, 3, "the reopened day lists its rows");
  assert.equal(all(recovered, "my-messages-calendar-unreconciled").length, 0);
});

test("a month with nothing read yet is not called empty while a conversation is unread", async t => {
  // The day read is zero and the host omitted the per-conversation counts; one conversation
  // was never read. That is "not ranked", not "no messages in this month".
  const days = daysResult({}, { slowConversationIds: ["alpha"] });
  delete days.conversationMonths;
  const directory = [agent("alpha", "Alpha chat")];
  const history = historyFor(days, { [dayKey(0)]: dayResult([]) });
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  const view = draw();
  assert.equal(all(view, "my-messages-calendar-month-empty").length, 0,
    "an unread month is never called empty");
  assert.ok(one(view, "my-messages-calendar-month-no-ranking"));
  assert.ok(one(view, "my-messages-calendar-month-partial"));

  // The same zero with the per-conversation field present but incomplete: the ranking holds
  // only what was read, which is a third state again.
  const partial = historyFor(daysResult({}, { slowConversationIds: ["alpha"], conversationMonths: [] }),
    { [dayKey(0)]: dayResult([]) });
  const second = fixture(t, { historyRpc: partial, directory });
  second.draw();
  await flush();
  const partialView = second.draw();
  assert.equal(second.all(partialView, "my-messages-calendar-month-empty").length, 0);
  assert.equal(second.h.text(second.one(partialView, "my-messages-calendar-month-partial-ranking")),
    "Only what has been read is ranked. This month may have more conversations.");
});

test("another conversation's count-only record does not hide the filter's empty answer", async t => {
  const directory = [agent("alpha", "Alpha chat"), agent("other", "Other chat")];
  const history = historyFor(daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [
      monthCount("alpha", "Alpha chat", 1, 0),
      monthCount("other", "Other chat", 1, 0),
    ],
  }), {
    [dayKey(0)]: dayResult([{ agentId: "alpha", at: at(0, 9), text: "alpha today" }], {
      counted: [{ agentId: "other", at: at(0, 7) }],
    }),
  });
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-count-only")),
    "1 message from this day was counted but its text was not kept");
  all(draw(), "my-messages-calendar-top-conversation")
    .find(node => String(node.props.accessibilityLabel).startsWith("Alpha")).props.onPress();
  const filtered = draw();
  assert.equal(all(filtered, "my-messages-screen-row").length, 1);
  assert.match(h.text(one(filtered, "my-messages-calendar-filter")), /Showing only Alpha chat · Clear/);
  assert.equal(all(filtered, "my-messages-calendar-count-only").length, 0,
    "alpha has no count-only message of its own, so the day-wide number is not shown");

  // Filter to the conversation whose message the archive counted only.
  all(filtered, "my-messages-calendar-top-conversation")
    .find(node => String(node.props.accessibilityLabel).startsWith("Other")).props.onPress();
  const other = draw();
  assert.equal(all(other, "my-messages-screen-row").length, 0);
  assert.equal(h.text(one(other, "my-messages-calendar-count-only")),
    "1 message from this day was counted but its text was not kept",
    "this conversation's count-only message is named");

  // The same day with no rows at all takes the settled-empty path; its count-only records
  // must survive that path, or the filter would call the conversation that owns one empty.
  const empty = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    conversationMonths: [
      monthCount("alpha", "Alpha chat", 1, 0),
      monthCount("other", "Other chat", 1, 0),
    ],
  }), { [dayKey(0)]: dayResult([], { counted: [{ agentId: "other", at: at(0, 7) }] }) });
  const third = fixture(t, { historyRpc: empty, directory });
  third.draw();
  await flush();
  third.all(third.draw(), "my-messages-calendar-top-conversation")
    .find(node => String(node.props.accessibilityLabel).startsWith("Other")).props.onPress();
  const emptyFiltered = third.draw();
  assert.equal(third.h.text(third.one(emptyFiltered, "my-messages-calendar-count-only")),
    "1 message from this day was counted but its text was not kept",
    "the settled-empty path still knows whose record it is");
  assert.doesNotMatch(third.h.text(emptyFiltered), /No messages from this conversation on this day/);
});

test("a host that omits the count-only list keeps the day's count and does not cache it", async t => {
  // An earlier host answers the day RPC without `counted`. It may still count messages whose
  // text it no longer keeps, so the two rows the timeline found cannot be proven new.
  const days = daysResult({ "2026-02-10": 1, [dayKey(0)]: 1 }, {
    firstDay: "2026-02-10",
    conversationMonths: [monthCount("gone", "Gone chat", 1, 0)],
    slowConversationIds: ["gone"],
  });
  const day = dayResult([]);
  delete day.counted;
  let dayCalls = 0;
  const history = {
    days: async () => days,
    day: async () => { dayCalls += 1; return day; },
  };
  const directory = [agent("gone", "Gone chat")];
  const histories = new Map([["gone", [timelineMessage("gone one", at(0, 9), 1)]]]);
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-calendar-month-total")), "1",
    "a missing count-only list is not read as an empty one");
  assert.equal(all(view, "my-messages-calendar-count-only").length, 0,
    "the day does not claim the text was lost without a named record");
  assert.ok(one(view, "my-messages-calendar-unreconciled"));
  assert.ok(one(view, "my-messages-screen-incomplete"),
    "the day says its list may be incomplete");

  const before = dayCalls;
  one(view, "my-messages-calendar-prev").props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Feb 10")).props.onPress();
  await flush();
  one(draw(), "my-messages-calendar-next").props.onPress();
  await flush();
  all(draw(), "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith("Mar 15")).props.onPress();
  await flush();
  assert.ok(dayCalls > before, "a day with no count-only list is read again, not cached");
});

test("another conversation's day-wide number does not appear on a filtered conversation", async t => {
  // The day counted two messages; only alpha's row came back, and this host does not name its
  // count-only records. Filtering to beta must not hand it alpha's difference as its own.
  const days = daysResult({ [dayKey(0)]: 2 }, {
    conversationMonths: [
      monthCount("alpha", "Alpha chat", 1, 0),
      monthCount("beta", "Beta chat", 1, 0),
    ],
  });
  const day = dayResult([{ agentId: "alpha", at: at(0, 9), text: "alpha today" }]);
  delete day.counted;
  const history = { days: async () => days, day: async () => day };
  const directory = [agent("alpha", "Alpha chat"), agent("beta", "Beta chat")];
  const { draw, all, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  all(draw(), "my-messages-calendar-top-conversation")
    .find(node => String(node.props.accessibilityLabel).startsWith("Beta")).props.onPress();
  const filtered = draw();
  assert.equal(all(filtered, "my-messages-screen-row").length, 0);
  assert.equal(all(filtered, "my-messages-calendar-count-only").length, 0,
    "alpha's record is not shown as beta's");
  assert.equal(all(filtered, "my-messages-calendar-unreconciled").length, 0,
    "the day-wide unmatched line is not part of beta's empty state");
  assert.ok(one(filtered, "my-messages-screen-incomplete"),
    "the list still says it may be incomplete");
  assert.doesNotMatch(h.text(filtered), /No messages from this conversation on this day/,
    "a host that cannot name its records does not prove the conversation empty");
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
