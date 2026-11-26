const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const at = (day, hour = 0, minute = 0) => new Date(2026, 2, 15 + day, hour, minute).getTime();
const iso = time => new Date(time).toISOString();
const FROZEN = at(0, 12);
const settle = () => new Promise(resolve => setImmediate(resolve));

function gate() {
  let open;
  const wait = new Promise(resolve => { open = resolve; });
  return { wait, open };
}

function agent(id, last, extras = {}) {
  return { id, title: id, ...(last === undefined ? {} : { lastUserMessageAt: last === null ? null : iso(last) }), ...extras };
}

function message(text, time, seq, type = "user_message") {
  return { timestamp: iso(time), seqStart: seq, item: { type, text } };
}

function timelinePage(entries, index, count) {
  const hasOlder = index + 1 < count;
  return {
    entries, hasOlder, error: null, gap: false, staleCursor: false,
    startCursor: hasOlder ? { epoch: "test", seq: 1000 - index } : null,
  };
}

function fakeHost(directory = [[]]) {
  const host = {
    directory, histories: new Map(), lists: [], reads: [], active: 0, peak: 0, listFailures: 0,
    paseo: {
      agents: {
        async list(options) {
          host.lists.push(options);
          if (host.listFailures > 0) {
            host.listFailures -= 1;
            throw new Error("Directory unavailable");
          }
          const index = Number(options.page.cursor ?? 0);
          const hasMore = index + 1 < host.directory.length;
          return {
            entries: host.directory[index].map(agent => ({ agent })),
            pageInfo: { hasMore, nextCursor: hasMore ? String(index + 1) : null, prevCursor: null },
          };
        },
        ref(id) {
          return { timeline: {
            async refetch(options) {
              host.reads.push({ id, ...options });
              host.active += 1;
              host.peak = Math.max(host.peak, host.active);
              try {
                const index = options.direction === "before" ? 1001 - options.cursor.seq : 0;
                const history = host.histories.get(id) ?? [[]];
                if (typeof history === "function") return await history(index);
                return timelinePage(history[index], index, history.length);
              } finally {
                host.active -= 1;
              }
            },
          } };
        },
      },
    },
  };
  return host;
}

const readIds = host => host.reads.map(({ id }) => id);
const texts = snapshot => snapshot.rows.map(({ text }) => text);

function harness(t, host, options = {}) {
  const h = createToolHarness("web", { paseo: host.paseo, ui: { SidebarRow: "Host.SidebarRow" }, ...options });
  const clock = h.load("client/my-messages-clock.ts");
  let now = FROZEN;
  clock.setMyMessagesClock(() => now);
  clock.setMyMessagesTimers({
    set() { assert.fail("The screen must not schedule timers"); },
    clear() { assert.fail("The screen did not schedule timers"); },
  });
  t.after(() => {
    h.unmount();
    h.dispose();
    clock.setMyMessagesClock(null);
    clock.setMyMessagesTimers(null);
  });
  return { h, now: () => now, setNow: value => { now = value; } };
}

function feedCase(t, host) {
  const { h, now, setNow } = harness(t, host);
  const { createMyMessagesScreenFeed } = h.load("client/my-messages-screen-feed.ts");
  const feed = createMyMessagesScreenFeed(now);
  t.after(() => feed.stop());
  const mount = (source = host, hostId = "host") => {
    const snapshots = [];
    const session = feed.mount({ agents: source.paseo.agents, hostId, publish: state => snapshots.push(state) });
    return { ...session, snapshots, latest: () => snapshots.at(-1) };
  };
  return { mount, setNow };
}

const screenProps = {
  host: { id: "host", label: "Host" },
  layout: { compact: true, platform: "web" },
  theme: { colors: {} },
  params: {},
};

function register(t, h) {
  const screens = new Map();
  const sidebar = new Map();
  const removed = [];
  const host = {
    addScreen(input) {
      screens.set(input.id, input);
      return () => { removed.push("screen"); screens.delete(input.id); };
    },
    addSidebarHeaderItem(input) {
      sidebar.set(input.id, input);
      return () => { removed.push("sidebar"); sidebar.delete(input.id); };
    },
  };
  const stop = h.load("client/my-messages-screen-registration.tsx").registerMyMessagesScreen(host);
  t.after(() => stop());
  return { screens, sidebar, removed, stop };
}

function screenCase(t, host, options) {
  const { h, setNow } = harness(t, host, options);
  const registration = register(t, h);
  const screen = [...registration.screens.values()][0];
  const draw = () => h.draw({ type: screen.Component, props: screenProps });
  const node = (tree, suffix) => h.nodes(tree, n => n.props.testID === "my-messages-screen-" + suffix)[0];
  return { ...registration, h, setNow, draw, node };
}

test("the directory pages with includeArchived and filters by last user message on the local day", async t => {
  const host = fakeHost([
    [agent("yesterday", at(0) - 1), agent("missing")],
    [agent("archived", at(0, 9), { archivedAt: iso(at(0, 10)) }), agent("null", null)],
    [agent("midnight", at(0)), agent("invalid", null, { lastUserMessageAt: "not a date" })],
  ]);
  host.histories.set("archived", [
    [
      message("today", at(0, 9), 6),
      message("[IMPORTANT automated", at(0, 9), 5),
      message("reply", at(0, 8), 4, "assistant_message"),
      message("[OUT-OF-BAND USER MESSAGE]\n  inserted\r\n[/OUT-OF-BAND USER MESSAGE]", at(0, 8), 3),
      message("tomorrow", at(1), 7),
    ],
    [message("previous day inside a kept conversation", at(0) - 1, 2)],
    [message("stop paging before this", at(-1, 16), 1)],
  ]);
  host.histories.set("midnight", [[message("exactly midnight", at(0), 1)]]);
  const session = feedCase(t, host).mount();
  await session.ready;
  assert.deepEqual(host.lists, [undefined, "1", "2"].map(cursor => ({
    filter: { includeArchived: true }, page: cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
  })));
  assert.deepEqual(readIds(host), ["archived", "archived", "midnight"], "only today's agents, including the archive");
  assert.deepEqual(host.reads[0], { id: "archived", direction: "tail", projection: "projected" });
  assert.deepEqual(host.reads[1], { id: "archived", direction: "before", cursor: { epoch: "test", seq: 1000 }, projection: "projected" });
  assert.deepEqual(texts(session.latest()), ["today", "  inserted", "exactly midnight"]);
  assert.deepEqual(session.latest().progress, { done: 2, total: 2 });
});

test("the directory stops at 25 pages and keeps the results it found", async t => {
  const host = fakeHost(Array.from({ length: 26 }, (_, i) => [agent(String(i).padStart(2, "0"), at(0, 9))]));
  const session = feedCase(t, host).mount();
  await session.ready;
  assert.equal(host.lists.length, 25);
  assert.deepEqual(readIds(host), Array.from({ length: 25 }, (_, i) => String(i).padStart(2, "0")));
  assert.equal(session.latest().directoryPartial, true);
});

test("timeline reads are serial and each finished conversation publishes sorted progress", async t => {
  const ids = ["newest-activity", "b", "a"];
  const host = fakeHost([[agent("a", at(0, 10)), agent("newest-activity", at(0, 12)), agent("b", at(0, 11))]]);
  const gates = ids.map(() => gate());
  t.after(() => gates.forEach(g => g.open()));
  const results = [
    [message("oldest row", at(0, 8), 8)],
    [message("lower seq", at(0, 10), 1), message("second id", at(0, 10), 2)],
    [message("first id", at(0, 10), 2)],
  ];
  ids.forEach((id, i) => host.histories.set(id, async index => {
    await gates[i].wait;
    return timelinePage(results[i], index, 1);
  }));
  const session = feedCase(t, host).mount();
  const expected = [["oldest row"], ["second id", "lower seq", "oldest row"], ["first id", "second id", "lower seq", "oldest row"]];
  for (const [i, g] of gates.entries()) {
    await settle();
    assert.equal(host.peak, 1, "only one in-flight timeline read");
    assert.deepEqual(readIds(host), ids.slice(0, i + 1));
    g.open();
    await settle();
    assert.deepEqual(session.latest().progress, { done: i + 1, total: 3 });
    assert.deepEqual(texts(session.latest()), expected[i]);
  }
  await session.ready;
  assert.equal(session.latest().status, "ready");
  assert.deepEqual(session.snapshots.filter(s => s.status === "reading" && s.progress).map(s => s.progress.done), [0, 1, 2, 3]);
});

test("an unchanged complete agent hits the cache across mounts and a changed timestamp misses it", async t => {
  const host = fakeHost([[agent("a", at(0, 9)), agent("b", at(0, 9))]]);
  host.histories.set("a", [[message("first version", at(0, 8), 1)]]);
  const { mount } = feedCase(t, host);
  const initial = mount();
  await initial.ready;
  await initial.refresh();
  assert.deepEqual(readIds(host), ["a", "b"], "a second run reuses unchanged complete entries");
  initial.stop();
  host.directory[0][0] = agent("a", at(0, 9), { title: "Renamed" });
  const reopened = mount();
  await reopened.ready;
  assert.deepEqual(readIds(host), ["a", "b"]);
  assert.equal(reopened.latest().rows[0].title, "Renamed", "use the current directory title on a cache hit");
  host.directory[0][0] = agent("a", at(0, 10));
  host.histories.set("a", [[message("second version", at(0, 10), 2)]]);
  await reopened.refresh();
  assert.deepEqual(readIds(host), ["a", "b", "a"]);
  assert.deepEqual(texts(reopened.latest()), ["second version"]);
});

test("the cache drops its oldest read above 1,000 entries even if that entry was just used", async t => {
  const agents = Array.from({ length: 1001 }, (_, i) => agent(String(i).padStart(4, "0"), at(0, 9)));
  const host = fakeHost(Array.from({ length: 5 }, (_, i) => agents.slice(i * 200, (i + 1) * 200)));
  const session = feedCase(t, host).mount();
  await session.ready;
  assert.equal(host.reads.length, 1000);
  host.directory = [[agents[0]]];
  await session.refresh();
  assert.equal(host.reads.length, 1000);
  host.directory = [[agents.at(-1)]];
  await session.refresh();
  host.directory = [[agents[0], agents[1], agents[2]]];
  await session.refresh();
  assert.deepEqual(readIds(host).slice(1000), ["1000", "0000", "0001", "0002"], "each new read evicts the next oldest read");
});

test("partial and failed agents do not stop the run, and retry grows only their page budgets to 320", async t => {
  const host = fakeHost([[agent("partial", at(0, 11)), agent("failed", at(0, 10)), agent("complete", at(0, 9)), agent("changed", at(0, 8))]]);
  const serve = (name, count) => index => timelinePage(index === 0 ? [message(name, at(0, 7), 1)] : [], index, count);
  host.histories.set("partial", serve("partial row", 321));
  host.histories.set("failed", index => ({ ...timelinePage([], index, 1), error: "Unavailable" }));
  host.histories.set("complete", serve("complete row", 1));
  const session = feedCase(t, host).mount();
  let cursor = 0;
  function counts(expected) {
    const segment = readIds(host).slice(cursor);
    cursor = host.reads.length;
    const byId = {};
    for (const id of segment) byId[id] = (byId[id] ?? 0) + 1;
    assert.deepEqual(byId, expected);
  }
  await session.ready;
  assert.deepEqual(session.latest().partial, ["partial"]);
  assert.deepEqual(session.latest().failed, ["failed"]);
  assert.deepEqual(texts(session.latest()), ["complete row", "partial row"]);
  counts({ partial: 40, failed: 3, complete: 1, changed: 1 });

  host.histories.set("failed", serve("recovered row", 70));
  host.directory[0][3] = agent("changed", at(0, 9, 30));
  host.histories.set("changed", serve("changed row", 41));
  await session.retry();
  counts({ partial: 80, failed: 70, changed: 40 });
  assert.deepEqual(session.latest().partial, ["partial", "changed"]);
  assert.deepEqual(session.latest().failed, []);
  await session.retry();
  counts({ partial: 160, changed: 41 });
  await session.retry();
  counts({ partial: 320 });
  await session.retry();
  counts({ partial: 320 });
});

test("Refresh during a run queues exactly one follow-up", async t => {
  const host = fakeHost([[agent("a", at(0, 9))]]);
  const held = gate();
  t.after(() => held.open());
  host.histories.set("a", async index => {
    await held.wait;
    return timelinePage([], index, 1);
  });
  const session = feedCase(t, host).mount();
  await settle();
  session.refresh();
  session.refresh();
  session.refresh();
  assert.equal(host.lists.length, 1);
  held.open();
  await session.ready;
  assert.equal(host.lists.length, 2);
  assert.deepEqual(readIds(host), ["a"], "the follow-up uses the completed first read");
});

test("unmount suppresses in-flight results and keeps a remount behind the old read", async t => {
  const host = fakeHost([[agent("a", at(0, 11)), agent("b", at(0, 10))]]);
  const held = gate();
  t.after(() => held.open());
  host.histories.set("a", async index => {
    await held.wait;
    return timelinePage([message("discard me", at(0, 10), 1)], index, 2);
  });
  const { mount } = feedCase(t, host);
  const first = mount();
  await settle();
  first.refresh();
  first.stop();
  const count = first.snapshots.length;
  const secondHost = fakeHost([[agent("a", at(0, 11))]]);
  secondHost.histories.set("a", [[message("other host", at(0, 11), 1)]]);
  const second = mount(secondHost, "other");
  await settle();
  assert.equal(secondHost.lists.length, 0, "the new session waits for the old request");
  held.open();
  await second.ready;
  assert.deepEqual(readIds(host), ["a"]);
  assert.equal(first.snapshots.length, count, "no publication after unmount");
  assert.equal(host.lists.length, 1, "no pending follow-up after unmount");
  assert.deepEqual(texts(second.latest()), ["other host"]);
});

test("the next local day drops a cache entry even if its directory timestamp is unchanged", async t => {
  const host = fakeHost([[agent("a", at(1, 9))]]);
  host.histories.set("a", [[message("yesterday", at(0, 11), 1), message("new day", at(1, 9), 2)]]);
  const { mount, setNow } = feedCase(t, host);
  const session = mount();
  await session.ready;
  assert.deepEqual(texts(session.latest()), ["yesterday"]);
  setNow(at(1, 12));
  await session.refresh();
  assert.deepEqual(texts(session.latest()), ["new day"]);
  assert.deepEqual(readIds(host), ["a", "a"]);
});

test("a directory failure offers Try again and the retry starts a fresh listing", async t => {
  const host = fakeHost();
  host.listFailures = 1;
  const { h, draw, node } = screenCase(t, host);
  draw();
  await settle();
  const failed = draw();
  assert.match(h.text(node(failed, "incomplete")), /conversation list could not be read/i);
  assert.equal(h.text(node(failed, "retry")), "Try again");
  assert.equal(host.reads.length, 0);
  node(failed, "retry").props.onPress();
  await settle();
  const recovered = draw();
  assert.equal(node(recovered, "retry"), undefined);
  assert.match(h.text(recovered), /Nothing from you today yet/);
  assert.equal(host.lists.length, 2);
});

test("the screen renders progressive rows and queues Try again for an incomplete result", async t => {
  const host = fakeHost([[agent("long", at(0, 11)), agent("next", at(0, 10))]]);
  const held = gate();
  t.after(() => held.open());
  host.histories.set("long", index =>
    timelinePage(index === 0 ? [message("visible before the next conversation", at(0, 11), 1)] : [], index, 42));
  host.histories.set("next", async index => {
    await held.wait;
    return timelinePage([message("next conversation", at(0, 10), 1)], index, 1);
  });
  const { h, draw, node } = screenCase(t, host);
  draw();
  await settle();
  const progressive = draw();
  assert.equal(h.text(node(progressive, "progress")), "Reading 1 of 2…");
  assert.equal(h.text(node(progressive, "summary")), "From you today: 1 · in 1 conversations");
  assert.match(h.text(node(progressive, "row")), /visible before the next conversation/);
  assert.equal(h.text(node(progressive, "incomplete")), "This list may be incomplete.");
  node(progressive, "retry").props.onPress();
  assert.equal(host.lists.length, 1);
  held.open();
  await settle();
  const complete = draw();
  assert.equal(node(complete, "retry"), undefined);
  assert.equal(node(complete, "progress"), undefined);
  assert.equal(h.text(node(complete, "summary")), "From you today: 2 · in 2 conversations");
  assert.equal(readIds(host).filter(id => id === "long").length, 40 + 42);
  assert.equal(readIds(host).filter(id => id === "next").length, 1);
});

test("the compact screen wraps titles, shows local times, and copies an original or explains image-only rows", async t => {
  const host = fakeHost([[agent("a", at(0, 11), { title: "A conversation with a long title that can wrap on a phone" }), agent("b", at(0, 10), { title: null })]]);
  const original = "  first line\r\nsecond line\r\nthird line\r\nfourth line  ";
  host.histories.set("a", [[message(original, at(0, 9, 5), 1)]]);
  host.histories.set("b", [[message("", at(0, 10), 1)]]);
  const { h, draw, node } = screenCase(t, host, { width: 390, copyText: () => {
    if (h.copies.length === 2) throw new Error("Clipboard unavailable");
  } });
  draw();
  await settle();
  const view = draw();
  assert.equal(h.text(node(view, "summary")), "From you today: 2 · in 2 conversations");
  const list = node(view, "list");
  assert.equal(list.type, "Native.FlatList");
  assert.equal(list.props.style.flex, 1);
  assert.equal(list.props.contentContainerStyle.paddingHorizontal, 12);
  const rows = h.nodes(view, n => n.props.testID === "my-messages-screen-row");
  const [image, text] = rows;
  assert.match(h.text(image), /Untitled conversation\n10:00\n\(image\)/);
  assert.match(h.text(text), /09:05/);
  assert.doesNotMatch(h.text(text), /fourth line/);
  assert.ok(h.nodes(text, n => n.type === "Text" && n.props.style.flex === 1 && n.props.numberOfLines === undefined).length);
  assert.equal(h.nodes(text, n => n.props.numberOfLines === 3).length, 1);
  image.props.onPress();
  await settle();
  assert.deepEqual(h.copies, []);
  assert.deepEqual(h.toasts, ["This message has no text to copy"]);
  text.props.onPress();
  await settle();
  assert.deepEqual(h.copies, [original]);
  assert.equal(h.toasts.at(-1), "Copied");
  text.props.onPress();
  await settle();
  assert.equal(h.toasts.at(-1), "Could not copy this message");
  assert.deepEqual(h.links, []);
});

test("day rollover keeps yesterday's rows visibly stale until manual Refresh", async t => {
  const host = fakeHost([[agent("a", at(0, 11))]]);
  host.histories.set("a", [[message("previous day", at(0, 11), 1)]]);
  const { h, setNow, draw, node } = screenCase(t, host);
  draw();
  await settle();
  assert.match(h.text(node(draw(), "summary")), /From you today: 1/);
  setNow(at(1, 1));
  await settle();
  assert.equal(host.lists.length, 1, "crossing midnight does not start a read");
  const stale = draw();
  assert.match(h.text(node(stale, "summary")), /from an earlier day/);
  assert.match(h.text(node(stale, "row")), /previous day/);
  assert.equal(h.text(node(stale, "refresh")), "Refresh");
  host.directory = [[agent("a", at(1, 1))]];
  host.histories.set("a", [[message("current day", at(1, 1), 2)]]);
  node(stale, "refresh").props.onPress();
  await settle();
  assert.match(h.text(node(draw(), "summary")), /From you today: 1/);
  assert.match(h.text(node(draw(), "row")), /current day/);
});

test("the client entry registers the localized screen and SidebarRow and removes both on stop", async t => {
  const host = fakeHost();
  const { h } = harness(t, host, { locale: "zh-CN" });
  const screens = new Map();
  const sidebar = new Map();
  const stop = h.load("index.client.tsx").default({
    i18n: h.translations.runtime, paseo: host.paseo, rpc() {},
    addSettingsScreen() {},
    addScreen(value) { screens.set(value.id, value); return () => screens.delete(value.id); },
    addSidebarHeaderItem(value) { sidebar.set(value.id, value); return () => sidebar.delete(value.id); },
  });
  assert.equal(screens.size, 1);
  assert.equal(sidebar.size, 1);
  const [screen] = screens.values();
  const [item] = sidebar.values();
  assert.deepEqual(screen.title, item.title);
  assert.equal(h.translations.runtime.resolve(item.title), "我说的话");
  const opened = [];
  const draw = currentScreen => h.draw({ type: item.Component, props: {
    ...screenProps, currentScreen, openScreen: input => opened.push(input), openPopover() {},
  } });
  const row = draw(null);
  assert.equal(row.type, "Host.SidebarRow");
  assert.equal(row.props.icon, "MessageSquare");
  assert.equal(row.props.label, "我说的话");
  assert.equal(row.props.active, false);
  row.props.onPress();
  assert.deepEqual(opened, [{ screenId: screen.id }]);
  h.setLocale("ja");
  const active = draw({ screenId: screen.id, params: {} });
  assert.equal(active.props.active, true);
  assert.equal(active.props.label, "自分の発言");
  await stop();
  assert.equal(screens.size, 0);
  assert.equal(sidebar.size, 0);
});

test("missing either host method registers nothing and warns only once", t => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = original; });
  const { h } = harness(t, fakeHost());
  const { registerMyMessagesScreen } = h.load("client/my-messages-screen-registration.tsx");
  const never = () => assert.fail("A missing API must skip both registrations");
  for (const client of [{ addScreen: never }, { addSidebarHeaderItem: never }, {}]) {
    assert.doesNotThrow(() => registerMyMessagesScreen(client)());
  }
  assert.equal(warnings.filter(warning => /no screen or sidebar header API/.test(warning)).length, 1);
});

test("all three locales have the new text with matching interpolation", () => {
  const keys = {
    screenSummary: ["conversations", "messages"], screenProgress: ["done", "total"],
    screenLoading: [], screenIncomplete: [], screenStale: [], screenRefresh: [], screenUntitled: [],
  };
  for (const locale of ["en", "zh-CN", "ja"]) {
    const { myMessages } = require("../client/locales/" + locale + ".json");
    for (const [key, placeholders] of Object.entries(keys)) {
      const value = myMessages[key];
      assert.ok(value?.trim(), locale + " " + key);
      assert.deepEqual([...value.matchAll(/{{(\w+)}}/g)].map(match => match[1]).sort(), placeholders);
    }
  }
});
