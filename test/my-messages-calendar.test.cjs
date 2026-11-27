const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { createTsModules } = require("./helpers/ts-modules.cjs");

const calendar = createTsModules().load(join(resolve(__dirname, ".."), "client/my-messages-calendar.ts"));

test("the month grid starts on Monday and pads both ends of a six-week month", () => {
  const november = calendar.buildMonthGrid(2026, 11);
  assert.equal(november.length, 42);
  // 1 November 2026 is a Sunday: six blanks, then the 1st in the Sunday column.
  assert.deepEqual(november.slice(0, 7), [null, null, null, null, null, null, "2026-11-01"]);
  assert.equal(november[35], "2026-11-30");
  assert.deepEqual(november.slice(36), Array(6).fill(null));

  const december = calendar.buildMonthGrid(2026, 12);
  // 1 December 2026 is a Tuesday: one blank before it, and no January day in the grid.
  assert.deepEqual(december.slice(0, 2), [null, "2026-12-01"]);
  assert.equal(december[31], "2026-12-31");
  assert.deepEqual(december.slice(32), Array(10).fill(null));

  const january = calendar.buildMonthGrid(2027, 1);
  // 1 January 2027 is a Friday, so the month crosses the year inside one grid.
  assert.deepEqual(january.slice(0, 5), [null, null, null, null, "2027-01-01"]);
  assert.equal(january[34], "2027-01-31");
});

test("February 2024 shows the leap day and nothing from March", () => {
  const february = calendar.buildMonthGrid(2024, 2);
  assert.equal(february[3], "2024-02-01");
  assert.equal(february[31], "2024-02-29");
  assert.equal(february.filter(day => day === null).length, 42 - 29);
  assert.equal(calendar.daysInMonth(2024, 2), 29);
  assert.equal(calendar.daysInMonth(2026, 2), 28);
});

test("day and month arithmetic carries across a year boundary", () => {
  assert.equal(calendar.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(calendar.addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(calendar.addMonths("2026-12", 1), "2027-01");
  assert.equal(calendar.addMonths("2027-01", -1), "2026-12");
  assert.equal(calendar.moveDay("2026-12-31", "right"), "2027-01-01");
  assert.equal(calendar.moveDay("2027-01-01", "left"), "2026-12-31");
  assert.equal(calendar.moveDay("2026-11-30", "down"), "2026-12-07");
  assert.deepEqual(calendar.buildWeek("2026-03-15"), [
    "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15",
  ]);
});

test("the four levels come from nearest-rank quartiles over positive days", () => {
  const thresholds = calendar.quartileThresholds([1, 2, 3, 4, 5]);
  assert.deepEqual(thresholds, [2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(count => calendar.countLevel(count, thresholds)), [0, 1, 1, 2, 3, 4]);
  assert.deepEqual(calendar.quartileThresholds([]), [Infinity, Infinity, Infinity]);
  assert.equal(calendar.countLevel(7, calendar.quartileThresholds([])), 1, "no history keeps a positive count at level 1");
  assert.deepEqual(calendar.quartileThresholds([0, 0, 4]), [4, 4, 4]);
});

test("year totals aggregate local days and grey out months outside the record", () => {
  const totals = calendar.monthTotals([
    { day: "2025-12-31", count: 4 },
    { day: "2026-01-02", count: 2 },
    { day: "2026-03-05", count: 7 },
    { day: "2026-03-06", count: 1 },
    { day: "2026-03-07", count: 0 },
  ]);
  assert.deepEqual(totals, { "2025-12": 4, "2026-01": 2, "2026-03": 8 });
  const months = calendar.buildYear(2026, totals, "2026-01-02", "2026-03-15");
  assert.equal(months.length, 12);
  assert.deepEqual(months.map(month => month.total), [2, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(months.map(month => month.selectable), [
    true, true, true, false, false, false, false, false, false, false, false, false,
  ]);
  assert.equal(calendar.buildYear(2025, totals, "2026-01-02", "2026-03-15").every(month => !month.selectable), true);
  assert.equal(calendar.buildYear(2026, totals, null, "2026-03-15")[0].selectable, true,
    "without a first day only the future is disabled");
});

test("day selection refuses the future and the days before the first record", () => {
  assert.equal(calendar.selectableDay("2026-03-15", "2026-01-02", "2026-03-15"), true);
  assert.equal(calendar.selectableDay("2026-03-16", "2026-01-02", "2026-03-15"), false);
  assert.equal(calendar.selectableDay("2026-01-01", "2026-01-02", "2026-03-15"), false);
  assert.equal(calendar.selectableDay("2026-01-01", null, "2026-03-15"), true);
});

test("year keyboard movement follows the grid columns and clamps at both ends", () => {
  assert.equal(calendar.moveMonthFocus(0, "left", 4), 0);
  assert.equal(calendar.moveMonthFocus(11, "right", 4), 11);
  assert.equal(calendar.moveMonthFocus(5, "up", 4), 1);
  assert.equal(calendar.moveMonthFocus(1, "down", 4), 5);
  assert.equal(calendar.moveMonthFocus(3, "up", 2), 1);
  assert.equal(calendar.moveMonthFocus(10, "down", 2), 11);
});

test("the RPC and timeline rows merge by message identity, not by page sequence", () => {
  const feed = createTsModules().load(join(resolve(__dirname, ".."), "client/my-messages-calendar-feed.ts"));
  const rpc = [
    { agentId: "a", at: 1000, seq: 0, text: "same message", title: null },
    { agentId: "a", at: 900, seq: 0, text: "only in the RPC", title: null },
  ];
  const timeline = [
    { agentId: "a", at: 1000, seq: 7, text: "same message", title: "A" },
    { agentId: "a", at: 800, seq: 8, text: "only in the timeline", title: "A" },
  ];
  const merged = feed.mergeCalendarRows(rpc, timeline);
  assert.deepEqual(merged.map(row => row.text), ["same message", "only in the RPC", "only in the timeline"]);
  assert.equal(merged[0].title, null, "the first occurrence keeps its row data");
});

const feedModule = createTsModules().load(join(resolve(__dirname, ".."), "client/my-messages-calendar-feed.ts"));
const settle = () => new Promise(resolve => setImmediate(resolve));

function feedDays(days) {
  const entries = Object.entries(days).map(([day, count]) => ({ day, count })).sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    days: entries, firstDay: entries[0]?.day ?? null, lastDay: entries.at(-1)?.day ?? null,
    fastConversations: 1, slowConversationIds: [], skippedDatabases: [], directoryPartial: false,
    fromCache: 0, readMs: 1,
  };
}

test("displayed counts add the overwritten fallback delta once", () => {
  assert.equal(feedModule.displayedDayCount({ day: 3 }, { day: 1 }, "day"), 4);
  assert.equal(feedModule.displayedDayCount({ day: 3 }, { day: -1 }, "day"), 2);
  assert.equal(feedModule.displayedDayCount({ day: 3 }, {}, "day"), 3);
});

test("a stopped calendar session never publishes a late days answer", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const snapshots = [];
  const feed = feedModule.createMyMessagesCalendarFeed(() => 1000);
  const session = feed.mount({
    hostId: "host",
    agents: {},
    history: { available: true, timeZone: "UTC", days: () => gate, day: async () => ({ status: "ready", snapshot: { rows: [], directoryPartial: false, fromCache: 0 } }) },
    publish: state => snapshots.push(state),
  });
  await settle();
  const before = snapshots.length;
  session.stop();
  release({ status: "ready", snapshot: feedDays({ "2026-03-15": 1 }) });
  await settle();
  assert.equal(snapshots.length, before, "no publication after stop");
  feed.stop();
});

test("the detail cache keeps at most 120 days and re-reads the evicted day", async () => {
  const days = {};
  for (let index = 0; index < 121; index += 1) {
    const date = new Date(2026, 0, 1 + index);
    days[`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`] = 1;
  }
  let dayCalls = 0;
  const feed = feedModule.createMyMessagesCalendarFeed(() => new Date(2026, 2, 15, 12).getTime());
  const session = feed.mount({
    hostId: "host",
    agents: {},
    history: {
      available: true, timeZone: "UTC",
      days: async () => ({ status: "ready", snapshot: feedDays(days) }),
      day: async () => { dayCalls += 1; return { status: "ready", snapshot: { rows: [], directoryPartial: false, fromCache: 0 } }; },
    },
    publish: () => {},
  });
  await session.ready;
  const keys = Object.keys(days).filter(day => day !== "2026-03-15").sort();
  for (const day of keys) {
    session.select(day);
    await settle();
  }
  const afterAll = dayCalls;
  session.select("2026-03-15");
  await settle();
  assert.equal(dayCalls, afterAll + 1, "the oldest day was evicted and read again");
  feed.stop();
});
