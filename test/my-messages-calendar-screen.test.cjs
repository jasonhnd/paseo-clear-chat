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
  const paseo = {
    reads,
    directoryFails: false,
    agents: {
      async list() {
        if (paseo.directoryFails) throw new Error("the conversation directory is unavailable");
        return { entries: directory.map(entry => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref(id) {
        return { timeline: {
          async refetch(options) {
            reads.push({ id, ...options });
            const history = histories.get(id) ?? [];
            if (typeof history === "function") return history(options);
            return { entries: history, hasOlder: false, error: null, gap: false, staleCursor: false, startCursor: null };
          },
        } };
      },
    },
  };
  return paseo;
}

const screenProps = {
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "web" },
  theme: { colors: {} },
  params: {},
};

const DARK_THEME = {
  surface0: "#101418", foreground: "#e6edf3", foregroundMuted: "#8b949e",
  accent: "#3b82f6", accentForeground: "#ffffff", statusDanger: "#f85149",
};

const BASE_PREFERENCES = {
  answerStyle: "none", savedReplies: [], autoFillAnswer: true, showJumpChips: false,
  keepItemLineBreaks: false, dismissedOptionReplies: [], delegatedTools: "", delegatedCodeBlocks: "",
  hiddenTools: "", foldMessagePrefixes: "", enhancedUserBubble: true, assistantMarkdown: true,
  markdownVariant: "document", textScale: 1, foldFinishedSteps: true, foldLongOutputAfter: 15,
  collapsedStepAction: "inline", accent: "blue", customAccentEnabled: false, frostedGlass: false,
};

function fixture(t, options = {}) {
  const {
    historyRpc, locale = "en", compact = false, directory = [], histories = new Map(),
    realTheme = false, themeColors = {}, preferences, immediateTimers = false, directoryError = false,
  } = options;
  const paseo = fakePaseo(directory, histories);
  paseo.directoryFails = directoryError;
  const harnessOptions = { paseo, ui: { SidebarRow: "Host.SidebarRow" }, historyRpc, locale };
  if (realTheme) harnessOptions.themeTokens = true;
  if (preferences) harnessOptions.preferences = preferences;
  const h = createToolHarness("web", harnessOptions);
  const clock = h.load("client/my-messages-clock.ts");
  clock.setMyMessagesClock(() => FROZEN);
  clock.setMyMessagesTimers(immediateTimers
    ? { set(callback) { callback(); return 1; }, clear() {} }
    : { set() { throw new Error("Calendar reads must not schedule timers"); }, clear() {} });
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
    props: { ...screenProps, theme: { colors: themeColors }, layout: { ...screenProps.layout, compact } },
  });
  const all = (tree, id) => h.nodes(tree, node => node.props.testID === id);
  const one = (tree, id) => all(tree, id)[0];
  const cell = (tree, prefix) => all(tree, "my-messages-calendar-cell")
    .find(node => String(node.props.accessibilityLabel).startsWith(prefix));
  const monthCell = (tree, prefix) => all(tree, "my-messages-calendar-year-month")
    .find(node => String(node.props.accessibilityLabel).startsWith(prefix));
  return { h, draw, all, one, cell, monthCell, paseo };
}

/** Read the bubble's column clamp. 100% in the style is one cell. */
function tooltipFrame(style, column, columns, gridWidth) {
  const cell = gridWidth / columns;
  const widthMatch = /^min\((\d+(?:\.\d+)?)px, (\d+(?:\.\d+)?)%\)$/.exec(String(style.width));
  assert.ok(widthMatch, `tooltip width ${style.width}`);
  const width = Math.min(Number(widthMatch[1]), Number(widthMatch[2]) / 100 * cell);
  const leftMatch = /^max\((-?\d+(?:\.\d+)?)%, min\(calc\(50% - (\d+(?:\.\d+)?)px\), calc\((-?\d+(?:\.\d+)?)% - (\d+(?:\.\d+)?)px\)\)\)$/.exec(String(style.left));
  assert.ok(leftMatch, `tooltip left ${style.left}`);
  const percent = value => Number(value) / 100 * cell;
  const cellLeft = Math.max(percent(leftMatch[1]), Math.min(percent(50) - Number(leftMatch[2]), percent(leftMatch[3]) - Number(leftMatch[4])));
  return { rowLeft: cellLeft + column * cell, width };
}

function assertTooltipInside(style, column, columns, gridWidth) {
  const { rowLeft, width } = tooltipFrame(style, column, columns, gridWidth);
  assert.ok(rowLeft >= -0.51, `column ${column} starts at ${rowLeft} on a ${gridWidth} grid`);
  assert.ok(rowLeft + width <= gridWidth + 0.51, `column ${column} ends at ${rowLeft + width} on a ${gridWidth} grid`);
  const cell = gridWidth / columns;
  const tip = Math.min(170, gridWidth);
  const ideal = column * cell + cell / 2 - tip / 2;
  const expected = Math.max(0, Math.min(ideal, Math.max(0, gridWidth - tip)));
  assert.ok(Math.abs(rowLeft - expected) < 0.51, `column ${column} at ${rowLeft}, expected ${expected}`);
}

function pathTo(tree, target) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const path = pathTo(child, target);
      if (path) return path;
    }
  } else if (tree && typeof tree === "object") {
    if (tree === target) return [tree];
    const children = pathTo(tree.props?.children, target);
    if (children) return [tree, ...children];
  }
  return null;
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

/**
 * A keyboard event shaped like React's SyntheticEvent: preventDefault and stopPropagation
 * are prototype methods that write through `this`, so a handler that detaches one throws
 * the same TypeError a browser does.
 */
const KEY_EVENT = Symbol("key-event");
class KeyEvent {
  constructor(key) {
    this.key = key;
    this[KEY_EVENT] = true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }

  preventDefault() {
    if (this[KEY_EVENT] !== true) throw new TypeError("Cannot read properties of undefined (reading 'defaultPrevented')");
    this.defaultPrevented = true;
  }

  stopPropagation() {
    if (this[KEY_EVENT] !== true) throw new TypeError("Cannot read properties of undefined (reading 'propagationStopped')");
    this.propagationStopped = true;
  }
}

function keyEvent(key) {
  return new KeyEvent(key);
}

/**
 * The web Pressable keeps its DOM node in a ref. Hand each cell a fake node so a test can
 * see which one a key press focused, the way a browser would move focus.
 */
function domFocus(all, testID = "my-messages-calendar-cell") {
  const nodes = new Map();
  let focused = null;
  return {
    attach(tree) {
      const seen = new Set();
      for (const node of all(tree, testID)) {
        const label = String(node.props.accessibilityLabel);
        seen.add(label);
        let fake = nodes.get(label);
        if (!fake) {
          fake = { focus() { focused = label; }, ref: null };
          nodes.set(label, fake);
        }
        fake.ref = node.props.ref;
        node.props.ref?.(fake);
      }
      for (const [label, fake] of [...nodes]) {
        if (seen.has(label)) continue;
        nodes.delete(label);
        fake.ref?.(null);
      }
      return focused;
    },
    get focused() { return focused; },
    blur() { focused = null; },
  };
}


test("the calendar opens on today with counts, summary, rows and the client time zone", async t => {
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

test("a hovered day shows a floating bubble pinned inside the grid edges", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2, [dayKey(-6)]: 2, [dayKey(-5)]: 2, [dayKey(-3)]: 2 }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  assert.equal(h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip").length, 0);

  cell(draw(), "Mar 9 Mon").props.onHoverIn();
  let hovered = draw();
  let tooltip = h.nodes(hovered, node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assert.equal(h.text(tooltip), "Mar 9 Mon · 2 messages");
  assert.equal(tooltip.props.style.position, "absolute");
  assert.equal(tooltip.props.style.bottom, "100%");
  assertTooltipInside(tooltip.props.style, 0, 7, 320);
  assert.ok(pathTo(hovered, tooltip).some(node => node.props?.testID === "my-messages-calendar-cell-wrap"));

  cell(draw(), "Mar 12 Thu").props.onHoverIn();
  tooltip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assertTooltipInside(tooltip.props.style, 3, 7, 320);

  cell(draw(), "Mar 15 Sun").props.onHoverIn();
  tooltip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assertTooltipInside(tooltip.props.style, 6, 7, 320);
});

test("arrow keys move only the keyboard focus, show its bubble, and Enter selects once", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1, [dayKey(-1)]: 1 }), {
    [dayKey(0)]: dayResult([]),
    [dayKey(-1)]: dayResult([{ agentId: "alpha", at: at(-1, 9), text: "focused row" }]),
  });
  const directory = [agent("alpha", "Alpha conversation")];
  const { draw, one, cell, all, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  let tree = draw();
  // A roving tab stop: Tab enters the grid on one cell, not on the container or 42 cells.
  assert.equal(cell(tree, "Mar 15 Sun").props.tabIndex, 0);
  assert.equal(cell(tree, "Mar 14 Sat").props.tabIndex, -1);
  const dom = domFocus(all);
  dom.attach(tree);
  cell(tree, "Mar 15 Sun").props.onFocus();
  const before = history.calls.filter(([kind]) => kind === "day").length;
  one(draw(), "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused.startsWith("Mar 14 Sat"), true, "the arrow key moves DOM focus to the new cell");
  assert.equal(cell(tree, "Mar 14 Sat").props.tabIndex, 0);
  assert.equal(cell(tree, "Mar 15 Sun").props.tabIndex, -1);
  assert.equal(history.calls.filter(([kind]) => kind === "day").length, before, "arrows must not read a day");
  assert.equal(h.text(one(tree, "my-messages-screen-summary")), "Today · Mar 15 Sun");
  const tooltip = h.nodes(tree, node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assert.equal(h.text(tooltip), "Mar 14 Sat · 1 message");

  // A browser hands Enter to the Pressable that holds DOM focus; the grid never sees it.
  cell(tree, "Mar 14 Sat").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Mar 14 Sat · 1 message · 1 conversation");
  const selectedCalls = history.calls.filter(([kind, input]) => kind === "day" && input.day === dayKey(-1)).length;
  assert.equal(selectedCalls, 1, "the focused cell's Enter press is one read");
});

test("arrow focus may cross a month without reading until Enter", async t => {
  const history = historyFor(daysResult({ "2026-01-01": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-01" }),
    { "2026-03-01": dayResult([]), "2026-02-28": dayResult([]) });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  cell(draw(), "Mar 1 Sun").props.onPress();
  await flush();
  const before = history.calls.filter(([kind]) => kind === "day").length;
  one(draw(), "my-messages-calendar-grid").props.onFocus();
  one(draw(), "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "February 2026");
  assert.equal(history.calls.filter(([kind]) => kind === "day").length, before, "focus across a month is not a read");
  cell(draw(), "Feb 28 Sat").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-02-28");
});

test("calendar key handling cancels the browser default with a real event shape", async t => {
  const history = historyFor(daysResult({ [dayKey(-1)]: 1, [dayKey(0)]: 1 }), { [dayKey(0)]: dayResult([]) });
  const { draw, one } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const tree = draw();
  const grid = one(tree, "my-messages-calendar-grid");
  grid.props.onFocus();

  const left = keyEvent("ArrowLeft");
  grid.props.onKeyDown(left);
  assert.equal(left.defaultPrevented, true, "the arrow key's default scroll is cancelled");

  const today = keyEvent("t");
  grid.props.onKeyDown(today);
  assert.equal(today.defaultPrevented, true);

  const enter = keyEvent("Enter");
  grid.props.onKeyDown(enter);
  assert.equal(enter.defaultPrevented, true);
});

test("the grid's Enter branch selects the day the arrow key just focused", async t => {
  const history = historyFor(daysResult({ [dayKey(-1)]: 1, [dayKey(0)]: 1 }), {
    [dayKey(-1)]: dayResult([{ agentId: "alpha", at: at(-1, 9), text: "focused row" }]),
  });
  const directory = [agent("alpha", "Alpha conversation")];
  const { draw, one, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  const tree = draw();
  const grid = one(tree, "my-messages-calendar-grid");
  grid.props.onFocus();
  grid.props.onKeyDown(keyEvent("ArrowLeft"));
  // No redraw between the two keys: a handler that reads the state value sees the old day,
  // while the ref the browser path uses already holds the day under the focus.
  grid.props.onKeyDown(keyEvent("Enter"));
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Mar 14 Sat · 1 message · 1 conversation");
});

test("the year view aggregates months, greys the record edges, switches years and shows a month bubble", async t => {
  const history = historyFor(daysResult({
    "2025-06-01": 2, "2026-01-02": 2, [dayKey(-40)]: 3, [dayKey(0)]: 1,
  }, { firstDay: "2025-06-01" }), { [dayKey(0)]: dayResult([]), "2026-01-01": dayResult([]) });
  const { draw, one, all, monthCell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-title").props.onPress();
  const year = draw();
  assert.equal(all(year, "my-messages-calendar-year-month").length, 12);
  assert.equal(monthCell(year, "January 2026").props.accessibilityState.disabled, false);
  assert.equal(monthCell(year, "December 2026").props.accessibilityState.disabled, true);
  assert.equal(h.text(monthCell(year, "January 2026")), "January 2026\n2 messages");
  assert.equal(one(year, "my-messages-calendar-next").props.accessibilityState.disabled, true);

  monthCell(year, "January 2026").props.onHoverIn();
  const tip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assert.equal(h.text(tip), "January 2026 · 2 messages");
  assert.equal(tip.props.style.position, "absolute");
  assertTooltipInside(tip.props.style, 0, 4, 320);

  monthCell(draw(), "April 2026").props.onHoverIn();
  assertTooltipInside(h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0].props.style, 3, 4, 320);

  one(draw(), "my-messages-calendar-prev").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "2025");
  assert.equal(one(draw(), "my-messages-calendar-prev").props.accessibilityState.disabled, true);
  one(draw(), "my-messages-calendar-next").props.onPress();
  monthCell(draw(), "January 2026").props.onPress();
  await flush();
  const month = draw();
  assert.equal(h.text(one(month, "my-messages-calendar-title")), "January 2026");
  assert.equal(history.calls.at(-1)[1].day, "2026-01-01");
});

test("year view arrows move focus with a bubble and Enter opens that month", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { "2026-02-01": dayResult([]) });
  const { draw, one, monthCell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-title").props.onPress();
  const grid = one(draw(), "my-messages-calendar-year");
  grid.props.onFocus();
  grid.props.onKeyDown(keyEvent("ArrowLeft"));
  grid.props.onKeyDown(keyEvent("ArrowLeft"));
  const tip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assert.equal(h.text(tip), "January 2026 · 1 message");
  one(draw(), "my-messages-calendar-year").props.onKeyDown(keyEvent("ArrowRight"));
  // Enter reaches the Pressable that holds DOM focus, not the grid.
  monthCell(draw(), "February 2026").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "February 2026");
  assert.equal(history.calls.at(-1)[1].day, "2026-02-01");
});

test("month header arrows stop at the first record month and at the current month", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { [dayKey(0)]: dayResult([]), "2026-01-02": dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, true);
  assert.equal(one(draw(), "my-messages-calendar-next").props.style.opacity, 0.35);
  one(draw(), "my-messages-calendar-prev").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "February 2026");
  one(draw(), "my-messages-calendar-prev").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "January 2026");
  assert.equal(one(draw(), "my-messages-calendar-prev").props.accessibilityState.disabled, true);
  one(draw(), "my-messages-calendar-prev").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "January 2026");
});

test("clicking a day then using the arrow keys selects the day under the keyboard focus", async t => {
  const history = historyFor(daysResult({
    [dayKey(-5)]: 1, [dayKey(-6)]: 1, [dayKey(-7)]: 1, [dayKey(0)]: 1,
  }), { [dayKey(-7)]: dayResult([{ agentId: "alpha", at: at(-7, 9), text: "focused row" }]) });
  const directory = [agent("alpha", "Alpha conversation")];
  const { draw, one, cell, all, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  let tree = draw();
  const dom = domFocus(all);
  dom.attach(tree);

  // A mouse click selects and focuses Mar 10.
  cell(tree, "Mar 10 Tue").props.onPress();
  cell(tree, "Mar 10 Tue").props.onFocus();
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused, null, "a mouse click does not move keyboard focus in this harness");

  one(tree, "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  one(tree, "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused.startsWith("Mar 8 Sun"), true, "two left presses focus Mar 8");
  assert.equal(cell(tree, "Mar 8 Sun").props.tabIndex, 0);
  assert.equal(cell(tree, "Mar 10 Tue").props.tabIndex, -1);

  // The focused cell owns Enter in a browser; the grid's key handler never sees it.
  cell(tree, "Mar 8 Sun").props.onPress();
  await flush();
  tree = draw();
  assert.equal(history.calls.at(-1)[1].day, dayKey(-7));
  assert.equal(h.text(one(tree, "my-messages-screen-summary")), "Mar 8 Sun · 1 message · 1 conversation");
  const marTenthReads = history.calls.filter(([kind, input]) => kind === "day" && input.day === dayKey(-5)).length;
  assert.equal(marTenthReads, 1, "Enter must not re-read the day the mouse picked");
});

test("arrow keys keep moving focus after crossing a month boundary", async t => {
  const history = historyFor(daysResult({
    "2026-01-01": 1, [dayKey(0)]: 1,
  }, { firstDay: "2026-01-01" }), {
    "2026-03-01": dayResult([]), "2026-02-28": dayResult([]), "2026-02-27": dayResult([]), "2026-02-20": dayResult([]),
  });
  const { draw, one, cell, all, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  let tree = draw();
  const dom = domFocus(all);
  dom.attach(tree);
  cell(tree, "Mar 1 Sun").props.onPress();
  cell(tree, "Mar 1 Sun").props.onFocus();
  await flush();
  tree = draw();
  dom.attach(tree);

  one(tree, "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(h.text(one(tree, "my-messages-calendar-title")), "February 2026");
  assert.equal(dom.focused.startsWith("Feb 28 Sat"), true, "the new month's cell takes DOM focus once it mounts");

  one(tree, "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused.startsWith("Feb 27 Fri"), true, "arrows still work after the month changed");

  one(tree, "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowUp"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused.startsWith("Feb 20 Fri"), true);
  const tabStops = all(tree, "my-messages-calendar-cell").filter(node => node.props.tabIndex === 0);
  assert.equal(tabStops.length, 1, "the month grid has one tab stop");
  assert.equal(tabStops[0].props.accessibilityLabel.startsWith("Feb 20 Fri"), true);

  cell(tree, "Feb 20 Fri").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-02-20");
});

test("the year view keeps one tab stop and skips months with no records", async t => {
  const history = historyFor(daysResult({ "2025-06-01": 1, "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2025-06-01" }),
    { "2025-07-01": dayResult([]), [dayKey(0)]: dayResult([]) });
  const { draw, one, all, monthCell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-title").props.onPress();
  one(draw(), "my-messages-calendar-prev").props.onPress();
  draw();
  let tree = draw();
  assert.equal(h.text(one(tree, "my-messages-calendar-title")), "2025");
  const dom = domFocus(all, "my-messages-calendar-year-month");
  dom.attach(tree);
  // March is the visible month but before the first record; focus snaps to June.
  assert.equal(monthCell(tree, "January 2025").props.tabIndex, -1);
  assert.equal(monthCell(tree, "June 2025").props.tabIndex, 0);
  const tabStops = all(tree, "my-messages-calendar-year-month").filter(node => node.props.tabIndex === 0);
  assert.equal(tabStops.length, 1, "the year grid has one tab stop");
  assert.equal(tabStops[0].props.accessibilityLabel.startsWith("June 2025"), true);

  one(tree, "my-messages-calendar-year").props.onKeyDown(keyEvent("ArrowRight"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused.startsWith("July 2025"), true);
  assert.equal(monthCell(tree, "July 2025").props.tabIndex, 0);

  one(tree, "my-messages-calendar-year").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  one(tree, "my-messages-calendar-year").props.onKeyDown(keyEvent("ArrowLeft"));
  await flush();
  tree = draw();
  dom.attach(tree);
  assert.equal(dom.focused.startsWith("June 2025"), true, "grey months are skipped, not focused");

  monthCell(tree, "July 2025").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2025-07-01");
});

test("slow conversation counts stay stable when today is visited five times", async t => {
  const today = dayKey(0);
  const directory = [agent("fast", "Fast conversation", at(0, 9)), agent("slow", "Slow conversation", at(0, 10))];
  const histories = new Map([["slow", [timelineMessage("slow row", at(0, 10), 1)]]]);
  const history = historyFor(daysResult({ [today]: 1, [dayKey(-5)]: 1 }, { slowConversationIds: ["slow"] }), {
    [today]: dayResult([{ agentId: "fast", at: at(0, 9), text: "fast row" }]),
    [dayKey(-5)]: dayResult([]),
  });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  assert.equal(cell(draw(), "Mar 15 Sun").props.accessibilityLabel, "Mar 15 Sun, 2 messages");
  cell(draw(), "Mar 10 Tue").props.onPress();
  await flush();
  const labels = [];
  for (let step = 0; step < 5; step += 1) {
    one(draw(), "my-messages-calendar-today").props.onPress();
    await flush();
    labels.push(cell(draw(), "Mar 15 Sun").props.accessibilityLabel);
  }
  assert.deepEqual(labels, Array(5).fill("Mar 15 Sun, 2 messages"));

  one(draw(), "my-messages-calendar-title").props.onPress();
  for (let step = 0; step < 5; step += 1) {
    one(draw(), "my-messages-calendar-title").props.onPress();
    one(draw(), "my-messages-calendar-title").props.onPress();
  }
  const march = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-year-month")
    .find(node => String(node.props.accessibilityLabel).startsWith("March 2026"));
  assert.equal(h.text(march), "March 2026\n3 messages");
});

test("an incomplete slow read offers Retry and is not cached as finished", async t => {
  const today = dayKey(0);
  const directory = [agent("fast", "Fast conversation", at(0, 9)), agent("slow", "Slow conversation", at(0, 10))];
  const histories = new Map([["slow", () => { throw new Error("timeline unavailable"); }]]);
  const history = historyFor(daysResult({ [today]: 1 }, { slowConversationIds: ["slow"] }), {
    [today]: dayResult([{ agentId: "fast", at: at(0, 9), text: "fast row" }]),
  });
  const { draw, one, h } = fixture(t, { historyRpc: history, directory, histories, immediateTimers: true });
  draw();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-incomplete")), "This list may be incomplete.");
  assert.ok(one(draw(), "my-messages-screen-retry"), "the warning has a Retry button");

  histories.set("slow", [timelineMessage("slow row", at(0, 10), 1)]);
  one(draw(), "my-messages-screen-retry").props.onPress();
  await flush();
  const recovered = draw();
  assert.equal(one(recovered, "my-messages-screen-incomplete"), undefined);
  assert.match(h.text(one(recovered, "my-messages-screen-row")), /slow row/);
});

test("a count-only day explains missing text and never claims zero conversations", async t => {
  const history = historyFor(daysResult({ [dayKey(-1)]: 3 }, { cacheFull: ["2026-03"] }), {
    [dayKey(-1)]: dayResult([], { cacheFull: ["2026-03"] }),
  });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  cell(draw(), "Mar 14 Sat").props.onPress();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-screen-summary")), "Mar 14 Sat · 3 messages");
  assert.equal(h.text(one(view, "my-messages-calendar-count-only")),
    "3 messages from this day were counted but their text was not kept");
  assert.doesNotMatch(h.text(view), /Nothing from you on this day/);
  assert.ok(one(view, "my-messages-calendar-notice-full"));
});

test("a host with no history RPC falls back to the previous today-only page", async t => {
  const directory = [agent("alpha", "Alpha conversation")];
  const histories = new Map([["alpha", [timelineMessage("today through the timeline", at(0, 9), 1)]]]);
  const { draw, one, h } = fixture(t, { directory, histories });
  draw();
  await flush();
  draw();
  await flush();
  const view = draw();
  assert.equal(one(view, "my-messages-calendar-grid"), undefined);
  assert.match(h.text(one(view, "my-messages-screen-summary")), /From you today: 1/);
  assert.match(h.text(one(view, "my-messages-screen-row")), /today through the timeline/);
});

test("a host that reports unknown-method keeps the previous today-only page", async t => {
  const directory = [agent("alpha", "Alpha conversation")];
  const histories = new Map([["alpha", [timelineMessage("via timeline", at(0, 9), 1)]]]);
  const unavailable = async () => { throw Object.assign(new Error("no such method"), { code: "METHOD_NOT_FOUND" }); };
  const { draw, one, h } = fixture(t, {
    historyRpc: { days: unavailable, day: unavailable }, directory, histories,
  });
  draw();
  await flush();
  draw();
  await flush();
  const view = draw();
  assert.equal(one(view, "my-messages-calendar-grid"), undefined);
  assert.match(h.text(one(view, "my-messages-screen-summary")), /From you today: 1/);
});

test("a transient day-count failure keeps the calendar skeleton when the day RPC answers", async t => {
  const today = dayKey(0);
  const directory = [agent("alpha", "Alpha conversation", at(0, 9))];
  const days = daysResult({ [today]: 1 });
  let failDays = true;
  const history = {
    calls: [],
    days: async () => { history.calls.push(["days"]); if (failDays) throw Object.assign(new Error("handler failed"), { code: "handler_error" }); return days; },
    day: async input => { history.calls.push(["day", input]); return dayResult([{ agentId: "alpha", at: at(0, 9), text: "rpc row" }]); },
  };
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  const failed = draw();
  assert.ok(one(failed, "my-messages-calendar-grid"), "the calendar shape stays visible");
  assert.ok(one(failed, "my-messages-calendar-days-failed"));
  assert.match(h.text(one(failed, "my-messages-screen-row")), /rpc row/);
  assert.equal(history.calls.filter(([kind]) => kind === "days").length, 1, "a working day RPC needs no retry");

  failDays = false;
  one(failed, "my-messages-calendar-days-retry").props.onPress();
  await flush();
  const recovered = draw();
  assert.equal(one(recovered, "my-messages-calendar-days-failed"), undefined);
  assert.equal(cell(recovered, "Mar 15 Sun").props.accessibilityLabel, "Mar 15 Sun, 1 message");
});

test("a host that rejects both history methods falls back to the today page after one retry", async t => {
  const directory = [agent("alpha", "Alpha conversation", at(0, 9))];
  const histories = new Map([["alpha", [timelineMessage("today through the timeline", at(0, 9), 1)]]]);
  let daysCalls = 0;
  let dayCalls = 0;
  const unavailable = async () => { throw Object.assign(new Error("handler failed"), { code: "handler_error" }); };
  const history = {
    days: async () => { daysCalls += 1; return unavailable(); },
    day: async () => { dayCalls += 1; return unavailable(); },
  };
  const { draw, one, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  draw();
  await flush();
  const view = draw();
  assert.equal(one(view, "my-messages-calendar-grid"), undefined, "no dead calendar with an unusable Retry");
  assert.match(h.text(one(view, "my-messages-screen-summary")), /From you today: 1/);
  assert.equal(daysCalls, 2, "the days read is retried exactly once before falling back");
  assert.equal(dayCalls, 2, "the day read is retried exactly once before falling back");
});

test("a day RPC that answered before keeps the skeleton when both reads fail later", async t => {
  const today = dayKey(0);
  const directory = [agent("alpha", "Alpha conversation", at(0, 9))];
  const days = daysResult({ [today]: 1 });
  const day = dayResult([{ agentId: "alpha", at: at(0, 9), text: "rpc row" }]);
  let failing = false;
  const history = {
    days: async () => { if (failing) throw Object.assign(new Error("handler failed"), { code: "handler_error" }); return days; },
    day: async () => { if (failing) throw Object.assign(new Error("handler failed"), { code: "handler_error" }); return day; },
  };
  const { draw, one } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  failing = true;
  one(draw(), "my-messages-screen-refresh").props.onPress();
  await flush();
  const failed = draw();
  assert.ok(one(failed, "my-messages-calendar-grid"), "a host that worked before keeps the calendar");
  assert.ok(one(failed, "my-messages-calendar-days-failed"));
});

test("the notice line covers partial, cache and skipped database fields", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }, {
    directoryPartial: true, cacheError: true, skippedDatabases: ["profiles/work/state.db"],
  }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const notice = one(draw(), "my-messages-calendar-notice");
  assert.equal(notice.props.accessibilityRole, "alert");
  assert.equal(h.text(notice), "Some conversations could not be read, so some counts may be incomplete.");
});

test("the compact strip expands by month, collapses by week and greys at the edges", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }), {
    [dayKey(0)]: dayResult([]), "2026-03-08": dayResult([]),
  });
  const { draw, one, h } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  assert.ok(one(draw(), "my-messages-calendar-week"));
  one(draw(), "my-messages-calendar-expand").props.onPress();
  assert.equal(one(draw(), "my-messages-calendar-week"), undefined);
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, true);
  one(draw(), "my-messages-calendar-prev").props.onPress();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "February 2026");
  one(draw(), "my-messages-calendar-next").props.onPress();

  one(draw(), "my-messages-calendar-expand").props.onPress();
  assert.ok(one(draw(), "my-messages-calendar-week"));
  one(draw(), "my-messages-calendar-prev").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-03-08");
});

test("the compact week arrows clamp to the first record and to today", async t => {
  const history = historyFor(daysResult({ "2026-03-09": 1, [dayKey(0)]: 1 }, { firstDay: "2026-03-09" }),
    { [dayKey(0)]: dayResult([]), "2026-03-09": dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  assert.equal(one(draw(), "my-messages-calendar-prev").props.accessibilityState.disabled, false);
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, true);
  one(draw(), "my-messages-calendar-prev").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-03-09");
  assert.equal(one(draw(), "my-messages-calendar-prev").props.accessibilityState.disabled, true);
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, false);
  one(draw(), "my-messages-calendar-next").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Today · Mar 15 Sun");
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, true);
});

test("the compact week arrows move one week at a time instead of stopping six days early", async t => {
  const first = dayKey(-11);
  const history = historyFor(daysResult({ [first]: 1, [dayKey(-8)]: 1, [dayKey(0)]: 1 }, { firstDay: first }), {
    [dayKey(0)]: dayResult([]), [dayKey(-8)]: dayResult([]), [dayKey(-1)]: dayResult([]), [first]: dayResult([]),
  });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-expand").props.onPress();
  cell(draw(), "Mar 7 Sat").props.onPress();
  await flush();
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, false,
    "a selected day in the previous week can still reach today");
  one(draw(), "my-messages-calendar-next").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-03-14");
  one(draw(), "my-messages-calendar-next").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Today · Mar 15 Sun");
  assert.equal(one(draw(), "my-messages-calendar-next").props.accessibilityState.disabled, true);

  one(draw(), "my-messages-calendar-prev").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, "2026-03-08");
  one(draw(), "my-messages-calendar-prev").props.onPress();
  await flush();
  assert.equal(history.calls.at(-1)[1].day, first);
  assert.equal(one(draw(), "my-messages-calendar-prev").props.accessibilityState.disabled, true);
});

test("a gated older day cannot overwrite the day selected after it", async t => {
  const today = dayKey(0);
  const older = dayKey(-2);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const history = {
    calls: [],
    days: async () => daysResult({ [older]: 1, [dayKey(-3)]: 1, [today]: 1 }),
    day: async input => {
      history.calls.push(input.day);
      if (input.day === older) { await gate; return dayResult([{ agentId: "old", at: at(-2, 9), text: "old row" }]); }
      return dayResult([{ agentId: "new", at: at(-2, 10), text: "new row" }]);
    },
  };
  const directory = [agent("old", "Old conversation"), agent("new", "New conversation")];
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  cell(draw(), "Mar 13 Fri").props.onPress();
  await settle();
  cell(draw(), "Mar 12 Thu").props.onPress();
  await flush();
  release();
  await flush();
  const view = draw();
  assert.equal(h.text(one(view, "my-messages-screen-summary")), "Mar 12 Thu · 1 message · 1 conversation");
  assert.match(h.text(one(view, "my-messages-screen-row")), /new row/);
  assert.doesNotMatch(h.text(view), /old row/);
});

test("arrow keys never focus a day before the first record", async t => {
  const history = historyFor(daysResult({ [dayKey(-5)]: 1, [dayKey(0)]: 1 }, { firstDay: dayKey(-5) }),
    { [dayKey(-5)]: dayResult([]) });
  const { draw, one, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  cell(draw(), "Mar 10 Tue").props.onPress();
  await flush();
  const before = history.calls.filter(([kind]) => kind === "day").length;
  one(draw(), "my-messages-calendar-grid").props.onFocus();
  one(draw(), "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
  const tooltip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  assert.equal(h.text(tooltip), "Mar 10 Tue · 1 message");
  cell(draw(), "Mar 10 Tue").props.onPress();
  await flush();
  assert.equal(history.calls.filter(([kind]) => kind === "day").length, before);
});

test("one message uses singular labels in the cell, bubble, summary and year view", async t => {
  const history = historyFor(daysResult({ [dayKey(-1)]: 1, "2026-01-02": 1 }, { firstDay: "2026-01-02" }), {
    [dayKey(-1)]: dayResult([{ agentId: "alpha", at: at(-1, 9), text: "one row" }]),
  });
  const directory = [agent("alpha", "Alpha conversation")];
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory });
  draw();
  await flush();
  const view = draw();
  assert.equal(cell(view, "Mar 14 Sat").props.accessibilityLabel, "Mar 14 Sat, 1 message");
  cell(view, "Mar 14 Sat").props.onHoverIn();
  assert.equal(h.text(h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0]),
    "Mar 14 Sat · 1 message");
  cell(draw(), "Mar 14 Sat").props.onPress();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-screen-summary")), "Mar 14 Sat · 1 message · 1 conversation");
  one(draw(), "my-messages-calendar-title").props.onPress();
  assert.equal(h.text(h.nodes(draw(), node => node.props.testID === "my-messages-calendar-year-month")
    .find(node => String(node.props.accessibilityLabel).startsWith("January 2026"))), "January 2026\n1 message");
});

test("Chinese and Japanese month titles use the locale's own year-month order", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { [dayKey(0)]: dayResult([]), "2026-01-02": dayResult([]) });
  const { draw, one, monthCell, h } = fixture(t, { historyRpc: history, locale: "zh-CN" });
  draw();
  await flush();
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "2026年3月");
  one(draw(), "my-messages-calendar-title").props.onPress();
  assert.equal(h.text(monthCell(draw(), "2026年1月")), "2026年1月\n1 条");
  monthCell(draw(), "2026年1月").props.onHoverIn();
  assert.equal(h.text(h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0]),
    "2026年1月 · 1 条");
  h.setLocale("ja");
  assert.equal(h.text(one(draw(), "my-messages-calendar-title")), "2026");
  assert.ok(monthCell(draw(), "2026年1月"));
});

test("the legend uses the same rounded square as the cells", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  const squares = h.nodes(one(draw(), "my-messages-calendar-legend"),
    node => node.type === "View" && node.props.style?.width === 12);
  assert.equal(squares.length, 5);
  assert.equal(squares.every(node => node.props.style.borderRadius === 4), true);
});

test("the calendar follows the Clear Chat text scale and custom accent", async t => {
  const preferences = { ...BASE_PREFERENCES, textScale: 1.5, customAccentEnabled: true, customAccent: "#ff0000" };
  const history = historyFor(daysResult({ [dayKey(0)]: 1 }), { [dayKey(0)]: dayResult([]) });
  const { draw, one, cell, h } = fixture(t, {
    historyRpc: history, realTheme: true, themeColors: DARK_THEME, preferences,
  });
  draw();
  await flush();
  const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(DARK_THEME, preferences);
  assert.equal(one(draw(), "my-messages-screen-summary").props.style.fontSize, tokens.fs(14));
  assert.equal(tokens.fs(14), 21);
  const today = cell(draw(), "Mar 15 Sun");
  const fill = h.nodes(today, node => node.props?.testID === "my-messages-calendar-cell-fill")[0];
  assert.equal(fill.props.style.backgroundColor === tokens.accent, false);
  assert.equal(today.props.style.minHeight, 54);
});

test("an unparseable theme accent keeps four levels through an opacity wash", async t => {
  const themeColors = { ...DARK_THEME, accent: "oklch(0.7 0.2 250)" };
  const history = historyFor(daysResult({
    [dayKey(-5)]: 1, [dayKey(-4)]: 3, [dayKey(-3)]: 5, [dayKey(-2)]: 7, [dayKey(0)]: 1,
  }), { [dayKey(0)]: dayResult([]) });
  const { draw, cell, h } = fixture(t, { historyRpc: history, realTheme: true, themeColors });
  draw();
  await flush();
  const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(themeColors, BASE_PREFERENCES);
  cell(draw(), "Mar 14 Sat").props.onPress();
  await flush();
  const low = cell(draw(), "Mar 10 Tue");
  assert.equal(low.props.style.backgroundColor, tokens.surface0);
  const wash = h.nodes(low, node => node.props.testID === "my-messages-calendar-level-wash")[0];
  assert.ok(wash.props.style.opacity >= 0.4);
  const busier = h.nodes(cell(draw(), "Mar 13 Fri"), node => node.props.testID === "my-messages-calendar-level-wash")[0];
  assert.ok(busier.props.style.opacity > wash.props.style.opacity);
  const today = cell(draw(), "Mar 15 Sun");
  assert.equal(today.props.style.borderWidth, 0);
  assert.ok(h.nodes(today, node => node.props?.testID === "my-messages-calendar-today-dot")[0]);
});

test("a directory failure marks the day incomplete and offers Retry", async t => {
  const day = dayKey(-1);
  const directory = [agent("fast", "Fast conversation", at(-1, 9)), agent("slow", "Slow conversation", at(-1, 10))];
  const histories = new Map([["slow", [timelineMessage("slow row", at(-1, 10), 1)]]]);
  const history = historyFor(daysResult({ [day]: 2 }, { slowConversationIds: ["slow"] }), {
    [day]: dayResult([{ agentId: "fast", at: at(-1, 9), text: "fast row" }]),
  });
  const { draw, one, cell, h, paseo } = fixture(t, {
    historyRpc: history, directory, histories, directoryError: true,
  });
  draw();
  await flush();
  cell(draw(), "Mar 14 Sat").props.onPress();
  await flush();
  const view = draw();
  assert.ok(one(view, "my-messages-screen-incomplete"), "a missing directory is not silent");
  assert.ok(one(view, "my-messages-screen-retry"));
  assert.match(h.text(one(view, "my-messages-screen-row")), /Untitled conversation/);

  paseo.directoryFails = false;
  one(view, "my-messages-screen-retry").props.onPress();
  await flush();
  const recovered = draw();
  assert.equal(one(recovered, "my-messages-screen-incomplete"), undefined);
  assert.match(h.text(recovered), /Slow conversation/);
  assert.match(h.text(recovered), /slow row/);
});

test("today and the keyboard focus ring stay visible on the darkest level", async t => {
  const light = {
    surface0: "#ffffff", foreground: "#1f2328", foregroundMuted: "#59636e",
    accent: "#0969da", accentForeground: "#ffffff", statusDanger: "#cf222e",
  };
  for (const themeColors of [DARK_THEME, light]) {
    const history = historyFor(daysResult({
      [dayKey(-5)]: 1, [dayKey(-4)]: 3, [dayKey(-3)]: 5, [dayKey(-2)]: 7, [dayKey(0)]: 1,
    }), { [dayKey(0)]: dayResult([]) });
    const { draw, one, cell, all, h } = fixture(t, { historyRpc: history, realTheme: true, themeColors });
    draw();
    await flush();
    const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(themeColors, BASE_PREFERENCES);
    let tree = draw();
    // Leaving today selects another day, so today keeps only its own ring.
    cell(tree, "Mar 14 Sat").props.onPress();
    await flush();
    tree = draw();
    const today = cell(tree, "Mar 15 Sun");
    const dot = h.nodes(today, node => node.props?.testID === "my-messages-calendar-today-dot")[0];
    assert.ok(dot);
    assert.notEqual(today.props.style.borderWidth, 3);
    const chosen = cell(tree, "Mar 14 Sat");
    assert.equal(chosen.props.style.borderWidth, 2);
    assert.equal(chosen.props.style.borderStyle, "solid");

    const dom = domFocus(all);
    dom.attach(tree);
    cell(tree, "Mar 14 Sat").props.onFocus();
    one(tree, "my-messages-calendar-grid").props.onKeyDown(keyEvent("ArrowLeft"));
    await flush();
    tree = draw();
    dom.attach(tree);
    const focused = cell(tree, "Mar 13 Fri");
    assert.equal(focused.props.style.outlineWidth, 2);
    assert.equal(focused.props.style.outlineStyle, "dashed");
    assert.notEqual(focused.props.style.borderWidth, 3);
    if (focused.props.style.borderWidth) assert.equal(focused.props.style.borderStyle, "dashed");
    assert.equal(h.nodes(focused, node => node.props?.testID === "my-messages-calendar-today-dot").length, 0);
  }
});

test("a failed day read never lowers the count shown on the cell", async t => {
  const day = dayKey(-1);
  const directory = [agent("alpha", "Alpha conversation", at(-1, 10))];
  const histories = new Map([["alpha", [
    timelineMessage("one", at(-1, 9), 1), timelineMessage("two", at(-1, 10), 2),
  ]]]);
  const history = {
    days: async () => daysResult({ [day]: 3, [dayKey(0)]: 1 }),
    day: async input => {
      if (input.day === day) throw Object.assign(new Error("handler failed"), { code: "handler_error" });
      return dayResult([]);
    },
  };
  const { draw, one, cell, h } = fixture(t, { historyRpc: history, directory, histories });
  draw();
  await flush();
  cell(draw(), "Mar 14 Sat").props.onPress();
  await flush();
  const view = draw();
  assert.equal(cell(view, "Mar 14 Sat").props.accessibilityLabel, "Mar 14 Sat, 3 messages",
    "a short timeline read must not subtract from the fast count");
  assert.match(h.text(one(view, "my-messages-screen-summary")), /3 messages/);
});

function parsedColor(color) {
  const value = String(color).trim();
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map(channel => channel + channel).join("");
    if (!/^[0-9a-f]{6}/i.test(hex)) return null;
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  const body = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (!body) return null;
  const parts = body.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

/** The colour a cell actually paints: a translucent fill over the page. */
function paintedOn(color, under) {
  const top = parsedColor(color);
  const base = parsedColor(under);
  if (!top || !base) return color;
  const channel = (value, below) => Math.round(value * top.a + below * (1 - top.a));
  return `rgb(${channel(top.r, base.r)}, ${channel(top.g, base.g)}, ${channel(top.b, base.b)})`;
}

function colorChannels(color) {
  const parsed = parsedColor(color);
  return parsed ? [parsed.r, parsed.g, parsed.b] : null;
}

/** WCAG contrast of two opaque colours, computed here rather than by the palette. */
function luminance(color) {
  const linear = value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const channels = colorChannels(color);
  if (!channels) throw new Error(`unreadable colour ${color}`);
  return 0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
}

function contrastRatio(first, second) {
  const left = luminance(first);
  const right = luminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function hslSaturation(color) {
  const channels = colorChannels(color);
  if (!channels) throw new Error(`unreadable colour ${color}`);
  const [r, g, b] = channels.map(value => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  if (max === min) return 0;
  const delta = max - min;
  return light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
}

function chromaOf(color) {
  const channels = colorChannels(color);
  if (!channels) throw new Error(`unreadable colour ${color}`);
  return Math.max(...channels) - Math.min(...channels);
}

/** How far `from` moved from `to`, per channel. A neutral step moves them together. */
function channelStep(from, to) {
  const left = colorChannels(from);
  const right = colorChannels(to);
  if (!left || !right) throw new Error(`unreadable step ${from} -> ${to}`);
  return left.map((value, index) => value - right[index]);
}

test("day numbers stay at least 4.5 to 1 on every heat level without losing the dark theme", async t => {
  const light = {
    surface0: "#ffffff", foreground: "#1f2328", foregroundMuted: "#59636e",
    accent: "#1f8a5b", accentForeground: "#ffffff", statusDanger: "#cf222e",
  };
  const history = historyFor(daysResult({
    [dayKey(-5)]: 1, [dayKey(-4)]: 3, [dayKey(-3)]: 5, [dayKey(-2)]: 7, [dayKey(0)]: 1,
  }), { [dayKey(0)]: dayResult([]) });
  for (const themeColors of [light, DARK_THEME]) {
    const { draw, cell, h } = fixture(t, { historyRpc: history, realTheme: true, themeColors });
    draw();
    await flush();
    const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(themeColors, BASE_PREFERENCES);
    // Leave today so its cell keeps the heat colour instead of the selected fill.
    cell(draw(), "Mar 10 Tue").props.onPress();
    await flush();
    const tree = draw();
    const samples = [
      ["Mar 14 Sat", 0], ["Mar 15 Sun", 1], ["Mar 11 Wed", 2], ["Mar 12 Thu", 3], ["Mar 13 Fri", 4],
    ];
    for (const [label, level] of samples) {
      const node = cell(tree, label);
      const ink = h.nodes(node, child => child.type === "Text")[0].props.style.color;
      const background = paintedOn(node.props.style.backgroundColor, tokens.surface0);
      const ratio = contrastRatio(ink, background);
      const previousInk = level >= 3 ? tokens.accentForeground : tokens.foreground;
      const previous = contrastRatio(previousInk, background);
      assert.ok(ratio >= 4.5, `${label} contrast ${ratio.toFixed(2)} is below 4.5`);
      assert.ok(ratio + 1e-9 >= previous, `${label} contrast ${ratio.toFixed(2)} is worse than ${previous.toFixed(2)}`);
    }
  }
});

test("a quiet month inside the record range is a dim cell, not a greyed-out month", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, one, monthCell, h } = fixture(t, { historyRpc: history, realTheme: true, themeColors: DARK_THEME });
  draw();
  await flush();
  one(draw(), "my-messages-calendar-title").props.onPress();
  const tree = draw();
  const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(DARK_THEME, BASE_PREFERENCES);
  const february = monthCell(tree, "February 2026");
  const december = monthCell(tree, "December 2026");
  assert.equal(february.props.accessibilityState.disabled, false);
  assert.equal(december.props.accessibilityState.disabled, true);
  assert.equal(february.props.style.opacity, 1);
  assert.equal(december.props.style.opacity, 0.35);
  assert.equal(february.props.style.borderWidth, 1);
  assert.equal(february.props.style.borderColor, tokens.border);
  assert.notEqual(february.props.style.backgroundColor, december.props.style.backgroundColor);
});

test("wide header arrows stay at the text size", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, one } = fixture(t, { historyRpc: history, compact: false });
  draw();
  await flush();
  for (const id of ["my-messages-calendar-prev", "my-messages-calendar-next"]) {
    const style = one(draw(), id).props.style;
    assert.equal(style.minWidth, undefined, id);
    assert.equal(style.minHeight, undefined, id);
  }
});

test("empty cells sit between the page and the four heat levels", async t => {
  // Built-in host themes: the measured dark page, the light page, and the other dark pages.
  const themes = [
    {
      surface0: "#181B1A", foreground: "#fafafa", foregroundMuted: "#A1A5A4",
      accent: "#20744A", accentForeground: "#ffffff", statusDanger: "#c64f43",
    },
    {
      surface0: "#ffffff", foreground: "#1a1a1e", foregroundMuted: "#71717a",
      accent: "#20744A", accentForeground: "#ffffff", statusDanger: "#b04138",
    },
    {
      surface0: "#161820", foreground: "#fafafa", foregroundMuted: "#9a9db0",
      accent: "#3b6fcf", accentForeground: "#ffffff", statusDanger: "#c44a52",
    },
    {
      surface0: "#282c34", foreground: "#fafafa", foregroundMuted: "#c8ccd8",
      accent: "#3570e0", accentForeground: "#ffffff", statusDanger: "#c44a55",
    },
    {
      surface0: "#000000", foreground: "#fafafa", foregroundMuted: "#a1a1aa",
      accent: "#20744A", accentForeground: "#ffffff", statusDanger: "#c44a4a",
    },
  ];
  const history = historyFor(daysResult({
    "2025-07-02": 1, "2025-09-02": 6, "2025-10-02": 3, "2025-11-02": 9, "2025-12-02": 50,
    [dayKey(-5)]: 1, [dayKey(-4)]: 4, [dayKey(-3)]: 7, [dayKey(-2)]: 30,
  }, { firstDay: "2025-07-02" }), { [dayKey(0)]: dayResult([]) });
  for (const themeColors of themes) {
    const preferences = { ...BASE_PREFERENCES, accent: "host" };
    const { draw, one, cell, monthCell, h } = fixture(t, {
      historyRpc: history, realTheme: true, themeColors, preferences,
    });
    draw();
    await flush();
    const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(themeColors, preferences);
    const page = paintedOn(tokens.surface0, tokens.surface0);
    const paint = node => paintedOn(node.props.style.backgroundColor, page);
    const direction = luminance(page) < 0.5 ? 1 : -1;
    const check = (empty, busy, pane) => {
      const emptyPaint = paint(empty);
      const levels = [page, emptyPaint, ...busy.map(paint)].map(luminance);
      for (let index = 1; index < levels.length; index += 1) {
        assert.ok(direction * (levels[index] - levels[index - 1]) > 0,
          `${pane} order on ${themeColors.surface0}: ${levels.join(", ")}`);
      }
      const gap = contrastRatio(emptyPaint, page);
      assert.ok(gap >= 1.1 && gap <= 1.25, `${pane} page gap ${gap.toFixed(3)} on ${themeColors.surface0}`);
      const step = channelStep(emptyPaint, page);
      const spread = Math.max(...step) - Math.min(...step);
      assert.ok(spread <= 8, `${pane} empty step ${step.join(",")} is not neutral`);
      if (pane === "month") {
        const paints = [emptyPaint, ...busy.map(paint)];
        const firstGap = contrastRatio(paints[1], paints[0]);
        assert.ok(firstGap >= 1.35, `${pane} empty-to-first ${firstGap.toFixed(3)} on ${themeColors.surface0}`);
        for (let index = 2; index < paints.length; index += 1) {
          const stepGap = contrastRatio(paints[index], paints[index - 1]);
          assert.ok(stepGap >= 1.3, `${pane} step ${index - 1} gap ${stepGap.toFixed(3)} on ${themeColors.surface0}`);
        }
        const accentSpread = chromaOf(themeColors.accent);
        if (accentSpread >= 30) {
          assert.ok(chromaOf(paints[1]) + 0.5 >= Math.min(48, accentSpread * 0.45),
            `${pane} first level chroma ${chromaOf(paints[1])} on ${themeColors.surface0}`);
        }
      }
      if (chromaOf(themeColors.accent) >= 40) {
        assert.ok(chromaOf(paint(busy[0])) > chromaOf(emptyPaint) + 8,
          `${pane} first level is not more chromatic than the empty cell`);
      }
      for (const node of busy) {
        for (const text of h.nodes(node, child => child.type === "Text")) {
          assert.ok(contrastRatio(text.props.style.color, paint(node)) >= 4.5,
            `${pane} text contrast on ${themeColors.surface0}`);
        }
      }
      assert.equal(empty.props.accessibilityState.disabled, false);
      if (pane === "month") assert.equal(empty.props.style.borderWidth, 0);
    };
    const month = draw();
    const emptyDay = cell(month, "Mar 14 Sat");
    check(emptyDay, ["Mar 10", "Mar 11", "Mar 12", "Mar 13"].map(label => cell(month, label)), "month");
    const future = cell(month, "Mar 16 Mon");
    assert.equal(future.props.accessibilityState.disabled, true);
    assert.equal(future.props.style.opacity, 0.35);
    assert.notEqual(paint(future), paint(emptyDay));
    const swatches = h.nodes(one(month, "my-messages-calendar-legend"), node =>
      node.props?.style?.width === 12 && node.props?.style?.height === 12);
    assert.equal(swatches.length, 5);
    assert.equal(paintedOn(swatches[0].props.style.backgroundColor, page), paint(emptyDay));

    one(draw(), "my-messages-calendar-title").props.onPress();
    const thisYear = draw();
    const february = monthCell(thisYear, "February 2026");
    const december = monthCell(thisYear, "December 2026");
    assert.equal(february.props.accessibilityState.disabled, false);
    assert.equal(december.props.accessibilityState.disabled, true);
    assert.equal(december.props.style.opacity, 0.35);
    assert.notEqual(paint(february), paint(december));
    one(draw(), "my-messages-calendar-prev").props.onPress();
    const year = draw();
    check(
      monthCell(year, "August 2025"),
      ["July 2025", "September 2025", "November 2025", "December 2025"].map(label => monthCell(year, label)),
      "year",
    );
  }
});

test("heat levels move toward busy when they would cover the empty cell", t => {
  const h = createToolHarness("web", { themeTokens: true });
  t.after(() => h.dispose());
  const { buildLevelPalette, emptyCellFill } = h.load("client/components/my-messages-calendar-views.tsx");
  const { buildThemeTokens } = h.load("client/components/theme-tokens.ts");
  const preferences = { ...BASE_PREFERENCES, accent: "host" };
  for (const theme of [
    {
      surface0: "#181B1A", foreground: "#fafafa", foregroundMuted: "#A1A5A4",
      accent: "#1c221f", accentForeground: "#ffffff", statusDanger: "#c64f43",
    },
    {
      surface0: "#ffffff", foreground: "#1a1a1e", foregroundMuted: "#71717a",
      accent: "#f3f6f4", accentForeground: "#ffffff", statusDanger: "#b04138",
    },
  ]) {
    const tokens = buildThemeTokens(theme, preferences);
    const palette = buildLevelPalette(tokens);
    const page = paintedOn(tokens.surface0, tokens.surface0);
    const empty = paintedOn(emptyCellFill(tokens, palette), page);
    const levels = [1, 2, 3, 4].map(level => paintedOn(palette.backgrounds[level], page));
    const direction = luminance(page) < 0.5 ? 1 : -1;
    const values = [page, empty, ...levels].map(color => luminance(color));
    for (let index = 1; index < values.length; index += 1) {
      assert.ok(direction * (values[index] - values[index - 1]) > 0,
        `order on ${theme.surface0}: ${values.join(", ")}`);
    }
    const gap = contrastRatio(empty, page);
    assert.ok(gap >= 1.1 && gap <= 1.25, `page gap ${gap.toFixed(3)} on ${theme.surface0}`);
    const firstGap = contrastRatio(levels[0], empty);
    assert.ok(firstGap >= 1.35, `empty-to-first ${firstGap.toFixed(3)} on ${theme.surface0}`);
    for (let index = 1; index < levels.length; index += 1) {
      const stepGap = contrastRatio(levels[index], levels[index - 1]);
      assert.ok(stepGap >= 1.3, `step ${index} gap ${stepGap.toFixed(3)} on ${theme.surface0}`);
      assert.ok(contrastRatio(palette.text[index + 1], levels[index]) >= 4.5,
        `level ${index + 1} text on ${theme.surface0}`);
    }
    assert.ok(contrastRatio(palette.text[1], levels[0]) >= 4.5, `level 1 text on ${theme.surface0}`);
  }
});

test("selection, saturation and marker rings hold on the host themes", t => {
  const h = createToolHarness("web", { themeTokens: true });
  t.after(() => h.dispose());
  const views = h.load("client/components/my-messages-calendar-views.tsx");
  const { buildThemeTokens } = h.load("client/components/theme-tokens.ts");
  const themes = [
    { surface0: "#ffffff", foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#20744A", accentForeground: "#ffffff", statusDanger: "#b04138" },
    { surface0: "#181B1A", foreground: "#fafafa", foregroundMuted: "#A1A5A4", accent: "#20744A", accentForeground: "#ffffff", statusDanger: "#c64f43" },
    { surface0: "#18181b", foreground: "#fafafa", foregroundMuted: "#a1a1aa", accent: "#e4e4e7", accentForeground: "#18181b", statusDanger: "#c44a4a" },
    { surface0: "#161820", foreground: "#fafafa", foregroundMuted: "#9a9db0", accent: "#3b6fcf", accentForeground: "#ffffff", statusDanger: "#c44a52" },
    { surface0: "#1f1f1e", foreground: "#fafafa", foregroundMuted: "#ada9a5", accent: "#d97757", accentForeground: "#ffffff", statusDanger: "#cf513e" },
    { surface0: "#282c34", foreground: "#fafafa", foregroundMuted: "#c8ccd8", accent: "#3570e0", accentForeground: "#ffffff", statusDanger: "#c44a55" },
    { surface0: "#000000", foreground: "#fafafa", foregroundMuted: "#a1a1aa", accent: "#20744A", accentForeground: "#ffffff", statusDanger: "#c44a4a" },
  ];
  const presets = [null, "#10b981", "#8b5cf6", "#f59e0b", "#f43f5e"];
  const preferences = { ...BASE_PREFERENCES, accent: "host" };
  for (const theme of themes) {
    for (const preset of presets) {
      const colors = { ...theme, accent: preset ?? theme.accent };
      const tokens = buildThemeTokens(colors, preferences);
      const palette = views.buildLevelPalette(tokens);
      const page = paintedOn(tokens.surface0, tokens.surface0);
      const empty = paintedOn(views.emptyCellFill(tokens, palette), page);
      const levels = [1, 2, 3, 4].map(level => paintedOn(palette.backgrounds[level], page));
      let previousSat = hslSaturation(levels[0]);
      for (let index = 1; index < levels.length; index += 1) {
        const saturation = hslSaturation(levels[index]);
        assert.ok(saturation + 0.03 >= previousSat,
          `saturation ${previousSat.toFixed(2)} to ${saturation.toFixed(2)} on ${colors.surface0} ${colors.accent}`);
        previousSat = saturation;
      }
      for (const fill of [empty, ...levels]) {
        const dot = views.todayMark(fill, tokens);
        assert.ok(contrastRatio(dot, fill) >= 3, `today dot ${contrastRatio(dot, fill).toFixed(2)} on ${colors.surface0}`);
        const ring = views.markerRing(fill, page, tokens);
        if (ring.inner) {
          assert.ok(contrastRatio(ring.inner, fill) >= 3, `inner ring on ${colors.surface0}`);
          assert.ok(contrastRatio(ring.outer, page) >= 3, `outer ring on ${colors.surface0}`);
        } else {
          assert.ok(contrastRatio(ring.outer, fill) >= 3, `ring versus fill on ${colors.surface0} ${colors.accent}`);
          assert.ok(contrastRatio(ring.outer, page) >= 3, `ring versus page on ${colors.surface0}`);
        }
      }
    }
  }
});

test("a selected day keeps its heat fill and the same cell box", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2, [dayKey(-1)]: 2 }), { [dayKey(0)]: dayResult([]) });
  const { draw, cell, h } = fixture(t, { historyRpc: history, realTheme: true, themeColors: DARK_THEME });
  draw();
  await flush();
  const selected = cell(draw(), "Mar 15 Sun");
  const twin = cell(draw(), "Mar 14 Sat");
  const fill = h.nodes(selected, node => node.props?.testID === "my-messages-calendar-cell-fill")[0];
  assert.ok(fill, "selected fill is missing");
  assert.equal(fill.props.style.backgroundColor, twin.props.style.backgroundColor);
  assert.equal(selected.props.style.minHeight, twin.props.style.minHeight);
  assert.equal(selected.props.style.borderWidth, 2);
  assert.equal(selected.props.style.padding, 1);
  assert.equal(twin.props.style.borderWidth, 0);
});

test("the compact header arrows are at least a 44 pixel target", async t => {
  const history = historyFor(daysResult({ "2026-01-02": 1, [dayKey(0)]: 1 }, { firstDay: "2026-01-02" }),
    { [dayKey(0)]: dayResult([]) });
  const { draw, one } = fixture(t, { historyRpc: history, compact: true });
  draw();
  await flush();
  for (const id of ["my-messages-calendar-prev", "my-messages-calendar-next"]) {
    const style = one(draw(), id).props.style;
    assert.ok(style.minWidth >= 44, `${id} minWidth ${style.minWidth}`);
    assert.ok(style.minHeight >= 44, `${id} minHeight ${style.minHeight}`);
  }
});

test("all three locales define the calendar text with matching interpolation", () => {
  const keys = {
    today: [], previousMonth: [], nextMonth: [], previousYear: [], nextYear: [],
    showMonth: [], hideMonth: [], showYear: [], showMonthView: [], less: [], more: [],
    dayCellLabel: ["date", "count"], dayCellLabelOne: ["date"], dayCellEmpty: ["date"],
    dayTooltip: ["date", "count"], dayTooltipOne: ["date"],
    monthTotal: ["count"], monthTotalOne: [], yearMonthLabel: ["month", "count"], yearMonthLabelOne: ["month"],
    todaySummary: ["date"], daySummary: ["date", "messages", "conversations"],
    daySummaryOne: ["date", "messages"], daySummarySingle: ["date"], daySummaryMessages: ["date", "messages"],
    dayEmpty: [], dayLoading: [], dayFailed: [], readFailed: [], noticeCacheFull: [],
    countOnly: ["count"], countOnlyOne: [],
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
  assert.equal(chinese.calendar.readFailed, "日历暂时读不到，可能有日子缺失。");
});

test("a selected heat fill stays within six pixels of the neighbouring cell", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2, [dayKey(-1)]: 2 }), { [dayKey(0)]: dayResult([]) });
  const { draw, cell, monthCell, one, h } = fixture(t, { historyRpc: history, realTheme: true, themeColors: DARK_THEME });
  draw();
  await flush();
  const tree = draw();
  const selected = cell(tree, "Mar 15 Sun");
  const twin = cell(tree, "Mar 14 Sat");
  const fill = h.nodes(selected, node => node.props?.testID === "my-messages-calendar-cell-fill")[0];
  assert.ok(fill, "selected fill is missing");
  const gapX = selected.props.style.paddingHorizontal ?? selected.props.style.padding ?? 0;
  const gapY = selected.props.style.paddingVertical ?? selected.props.style.padding ?? 0;
  const shrink = side => ((selected.props.style.borderWidth || 0) + side) * 2 - (twin.props.style.borderWidth || 0) * 2;
  assert.ok(shrink(gapX) <= 6, `selected fill is ${shrink(gapX)}px narrower than the neighbour`);
  assert.ok(shrink(gapY) <= 6, `selected fill is ${shrink(gapY)}px shorter than the neighbour`);
  assert.equal(fill.props.style.position, "absolute");
  assert.equal(fill.props.style.left, gapX);
  assert.equal(fill.props.style.right, gapX);
  assert.equal(fill.props.style.top, gapY);
  assert.equal(fill.props.style.bottom, gapY);
  assert.notEqual(fill.props.style.backgroundColor, selected.props.style.backgroundColor);
  assert.equal(fill.props.style.backgroundColor, twin.props.style.backgroundColor);
  assert.equal(selected.props.style.minHeight, twin.props.style.minHeight);
  assert.equal(selected.props.style.borderStyle, "solid");
  assert.equal(selected.props.style.outlineWidth, 2);
  assert.equal(selected.props.style.outlineStyle, "dashed");
  assert.equal(selected.props.style.outlineOffset, 2);
  const number = h.nodes(selected, node => node.type === "Text")[0];
  const parent = pathTo(tree, number).at(-2);
  assert.equal(parent.props.testID, "my-messages-calendar-cell");
  const wrap = pathTo(tree, selected).find(node => node.props?.testID === "my-messages-calendar-cell-wrap");
  const twinWrap = pathTo(tree, twin).find(node => node.props?.testID === "my-messages-calendar-cell-wrap");
  assert.equal(wrap.props.style.width, twinWrap.props.style.width);
  assert.equal(wrap.props.style.padding, twinWrap.props.style.padding);

  one(tree, "my-messages-calendar-title").props.onPress();
  const year = draw();
  const march = monthCell(year, "March 2026");
  const april = monthCell(year, "April 2026");
  const monthFill = h.nodes(march, node => node.props?.testID === "my-messages-calendar-month-fill")[0];
  assert.ok(monthFill, "month fill is missing");
  const monthGap = march.props.style.padding ?? 0;
  const monthShrink = ((march.props.style.borderWidth || 0) + monthGap) * 2 - (april.props.style.borderWidth || 0) * 2;
  assert.ok(monthShrink <= 6, `the open month is ${monthShrink}px smaller than its neighbour`);
  assert.equal(monthFill.props.style.position, "absolute");
  assert.equal(monthFill.props.style.left, monthGap);
  assert.equal(monthFill.props.style.top, monthGap);
  assert.equal(monthFill.props.style.right, monthGap);
  assert.equal(monthFill.props.style.bottom, monthGap);
  assert.notEqual(monthFill.props.style.backgroundColor, march.props.style.backgroundColor);
  assert.equal(march.props.style.minHeight, april.props.style.minHeight);
  assert.equal(march.props.style.borderStyle, "solid");
  assert.equal(march.props.style.outlineStyle, "dashed");
  assert.equal(march.props.style.outlineWidth, 2);
});

test("hover tooltips stay inside the grid on every column", async t => {
  const history = historyFor(daysResult({ [dayKey(0)]: 2, "2026-01-02": 1 }, { firstDay: "2026-01-02" }),
    { [dayKey(0)]: dayResult([]) });
  const days = ["Mar 9 Mon", "Mar 10 Tue", "Mar 11 Wed", "Mar 12 Thu", "Mar 13 Fri", "Mar 14 Sat", "Mar 15 Sun"];
  const widths = [160, 220, 280, 360, 520];
  const { draw, cell, h } = fixture(t, { historyRpc: history });
  draw();
  await flush();
  for (const [column, label] of days.entries()) {
    cell(draw(), label).props.onHoverIn();
    const tip = h.nodes(draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
    assert.equal(tip.props.style.position, "absolute");
    for (const width of widths) assertTooltipInside(tip.props.style, column, 7, width);
  }

  const compact = fixture(t, { historyRpc: history, compact: true });
  compact.draw();
  await flush();
  compact.cell(compact.draw(), "Mar 10 Tue").props.onHoverIn();
  const weekTip = compact.h.nodes(compact.draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
  for (const width of widths) assertTooltipInside(weekTip.props.style, 1, 7, width);

  const { draw: drawYear, monthCell, one, h: yearH } = fixture(t, { historyRpc: history });
  drawYear();
  await flush();
  one(drawYear(), "my-messages-calendar-title").props.onPress();
  const months = ["January 2026", "February 2026", "March 2026", "April 2026"];
  for (const [column, label] of months.entries()) {
    monthCell(drawYear(), label).props.onHoverIn();
    const tip = yearH.nodes(drawYear(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
    for (const width of widths) assertTooltipInside(tip.props.style, column, 4, width);
  }

  const narrow = fixture(t, { historyRpc: history, compact: true });
  narrow.draw();
  await flush();
  narrow.one(narrow.draw(), "my-messages-calendar-title").props.onPress();
  for (const [column, label] of ["January 2026", "February 2026"].entries()) {
    narrow.monthCell(narrow.draw(), label).props.onHoverIn();
    const tip = narrow.h.nodes(narrow.draw(), node => node.props.testID === "my-messages-calendar-tooltip")[0];
    for (const width of widths) assertTooltipInside(tip.props.style, column, 2, width);
  }
});
