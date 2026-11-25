const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The panel's data path. Every case freezes the clock and drives the timers by hand: nothing
// here waits for a real hour or a real second. Dates come from local calendar parts, so the
// same file passes in UTC and in Asia/Tokyo.

const DAY = (dayOffset, hour, minute = 0, second = 0, ms = 0) =>
  new Date(2026, 2, 15 + dayOffset, hour, minute, second, ms).getTime();
const KEY = (dayOffset) => {
  const date = new Date(2026, 2, 15 + dayOffset, 0, 0, 0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

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

/** A timeline served as pages, newest first. Subscription readiness is settled by the test. */
function createAgent(id = "a") {
  const state = {
    pages: [],
    failReads: 0,
    holdReads: null,
    holdReady: false,
    calls: [],
    subscriptions: [],
  };
  const handle = {
    id,
    async refresh() {
      return { agent: { id, activeTurn: null } };
    },
    timeline: {
      async refetch(options = {}) {
        state.calls.push(options);
        if (state.holdReads) await state.holdReads;
        if (state.failReads > 0) {
          state.failReads -= 1;
          throw new Error("timeline unavailable");
        }
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
        let settleReady;
        let failReady;
        const ready = new Promise((resolve, reject) => { settleReady = resolve; failReady = reject; });
        const record = {
          handler,
          ready,
          resolve: () => settleReady(),
          reject: error => failReady(error),
          stop() {
            if (record.closed) return;
            record.closed = true;
            const index = state.subscriptions.indexOf(record);
            if (index >= 0) state.subscriptions.splice(index, 1);
          },
        };
        state.subscriptions.push(record);
        if (!state.holdReady) setImmediate(() => { record.resolve(); });
        return Object.assign(record.stop, { ready, async release() { record.stop(); } });
      },
    },
  };
  return {
    state,
    handle,
    get live() { return state.subscriptions.filter(record => !record.closed); },
    emit(event) {
      for (const record of [...this.live]) record.handler({ agentId: id, event });
    },
  };
}

// A retry sleeps milliseconds; the midnight wake is hours away. Keeping the two apart means a
// case that pumps retries never accidentally fires the day boundary.
const SHORT_MS = 5 * 60 * 1000;

function fakeTimers() {
  const queue = [];
  const pending = () => queue.filter(item => !item.cleared && !item.ran);
  const take = (item) => {
    item.ran = true;
    item.callback();
    return true;
  };
  return {
    set(callback, ms) {
      const item = { callback, ms, cleared: false, ran: false };
      queue.push(item);
      return item;
    },
    clear(item) {
      if (item) item.cleared = true;
    },
    pending,
    runShort() {
      const next = pending()
        .filter(item => item.ms <= SHORT_MS)
        .sort((left, right) => left.ms - right.ms)[0];
      return next ? take(next) : false;
    },
    runLongest() {
      const next = pending().sort((left, right) => right.ms - left.ms)[0];
      return next ? take(next) : false;
    },
    runAll(limit = 100) {
      let ran = 0;
      while (ran < limit && this.runShort()) ran += 1;
      return ran;
    },
  };
}

async function settle(times = 10) {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

async function pump(timers, done, rounds = 40) {
  for (let round = 0; round < rounds; round += 1) {
    await settle(4);
    if (done()) return true;
    timers.runAll(4);
  }
  return done();
}

function fixture(t) {
  const agent = createAgent();
  const h = createToolHarness("web", { paseo: { agents: { ref: () => agent.handle } } });
  t.after(() => { h.unmount(); h.dispose(); });
  return {
    h,
    agent,
    feed: h.load("client/my-messages-feed.ts"),
    store: h.load("client/my-messages-store.ts"),
    client: { agents: { ref: () => agent.handle } },
  };
}

const start = (feed, client, options = {}) => feed.startMyMessagesFeed({
  agentId: "a",
  client,
  now: options.now ?? (() => DAY(0, 12)),
  timers: options.timers ?? fakeTimers(),
  ...(options.budgets ? { budgets: options.budgets } : {}),
  ...(options.foreground ? { foreground: options.foreground } : {}),
});

test("today's machine messages and the person's messages come from one read", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[
    entry("user_message", "what did we decide?", DAY(0, 9, 5), 1),
    entry("assistant_message", "Here is the answer.", DAY(0, 9, 6), 2),
    entry("user_message", "<system-reminder>keep going</system-reminder>", DAY(0, 9, 7), 3),
    entry("user_message", "[1a] 好", DAY(0, 10, 15), 4),
    entry("user_message", "[ASYNC DELEGATION from another agent]", DAY(0, 11), 5),
  ]];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.machineToday, 2, "the host envelope and the delegation envelope are machine rows");
  assert.equal(snapshot.humanToday, 2, "the person's question and the bracketed [1a] line are theirs");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["[1a] 好", "what did we decide?"], "newest first");
  assert.deepEqual(snapshot.rows.map(row => row.time), ["10:15", "09:05"]);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.pendingDay, null);
  assert.equal(snapshot.coveredFrom, KEY(0));
  assert.equal(snapshot.live, true, "a subscription that answered is live");
  assert.equal(snapshot.stale, false);
  assert.equal(agent.state.calls[0].direction, "tail");
});

test("a local midnight splits today from yesterday", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[
    entry("user_message", "late last night", DAY(-1, 23, 59), 1),
    entry("user_message", "just after midnight", DAY(0, 0, 0), 2),
    entry("user_message", "later this morning", DAY(0, 8, 30), 3),
  ]];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.humanToday, 2, "midnight belongs to the new day; 23:59 does not");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["later this morning", "just after midnight"]);
  assert.equal(snapshot.hasEarlier, true);
});

test("a page that ends exactly at midnight is read further, even when the midnight row is older", async t => {
  const { feed, store, client, agent } = fixture(t);
  // The tail page ends with one row exactly at midnight; the other midnight row is on the
  // older page, so stopping at the tail would lose it.
  const tail = [];
  for (let index = 0; index < 199; index += 1) {
    tail.push(entry("user_message", `row ${index}`, DAY(0, 12, 0, 0, 0) + index * 1000, index + 1));
  }
  tail.push(entry("user_message", "midnight on the tail page", DAY(0, 0, 0, 0, 0), 200));
  agent.state.pages = [
    tail,
    [
      entry("user_message", "midnight on the older page", DAY(0, 0, 0, 0, 0), 201),
      entry("user_message", "before midnight", DAY(-1, 23, 0), 202),
    ],
  ];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, false, "the day was read to a timestamp strictly before midnight");
  assert.equal(snapshot.humanToday, 201, "both midnight rows belong to today");
  assert.deepEqual(
    snapshot.rows.map(row => row.text).filter(text => text.startsWith("midnight")),
    ["midnight on the older page", "midnight on the tail page"],
    "the older page's midnight row is kept, and equal timestamps order by sequence",
  );
  assert.equal(agent.state.calls.filter(call => call.direction === "before").length, 1,
    "the read walked past the page that ended at midnight");
});

test("Earlier is offered when the host has older pages, before any older message is seen", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("assistant_message", "a reply", DAY(0, 9), 1), entry("user_message", "today", DAY(0, 10), 2)],
    [entry("assistant_message", "older output", DAY(-1, 9), 3)],
  ];
  const started = start(feed, client, { budgets: { pagesPerDay: 1, maxPages: 50 } });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.hasEarlier, true, "unread pages could still hold the person's messages");
  await started.loadEarlier();
  const wider = store.myMessagesSnapshot("a");
  assert.equal(wider.coveredFrom, KEY(-1), "the press widened the window even with nothing to show");
  assert.deepEqual(wider.rows.map(row => row.text), ["today"], "a day with no human message adds no row");
});

test("an Earlier read cannot be overwritten by a refresh that raced it", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "the day before", DAY(-2, 9), 3)],
  ];
  const started = start(feed, client, { budgets: { pagesPerDay: 5, maxPages: 50 } });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").humanToday, 1);

  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const press = started.loadEarlier();
  // A new message arrives while the Earlier read is out; its refresh queued behind it.
  agent.state.pages = [
    [
      entry("user_message", "today", DAY(0, 9), 1),
      entry("user_message", "arrived later", DAY(0, 10), 4),
    ],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "the day before", DAY(-2, 9), 3)],
  ];
  agent.state.holdReads = null;
  agent.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "arrived later" } });
  release();
  await press;
  await settle(14);
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.humanToday, 2, "the newer live snapshot is not rolled back by the older read");
  assert.equal(snapshot.coveredFrom, KEY(-1), "and the wider window the reader asked for is kept");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["arrived later", "today", "yesterday"]);
});

test("a pending Earlier day is a date, and it survives midnight", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday late", DAY(-1, 23), 2)],
    [entry("user_message", "yesterday noon", DAY(-1, 12), 3)],
    [entry("user_message", "yesterday morning", DAY(-1, 6), 4)],
  ];
  let clock = DAY(0, 12);
  const timers = fakeTimers();
  const started = start(feed, client, {
    now: () => clock,
    timers,
    // One page per day of window: the first press cannot reach the whole of yesterday.
    budgets: { pagesPerDay: 1, maxPages: 8 },
  });
  t.after(() => started.stop());
  await started.ready;

  await started.loadEarlier();
  let snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.coveredFrom, KEY(0), "a day read only partly does not join the window");
  assert.equal(snapshot.pendingDay, KEY(-1), "the day that is still short is named by its date");

  // Midnight passes: the pending target must still be that calendar day.
  clock = DAY(1, 0, 30);
  const before = store.myMessagesSnapshot("a");
  assert.equal(before.pendingDay, KEY(-1), "midnight does not move the day the reader asked for");

  // Retry reads that same day, with a doubled budget.
  started.retry();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").coveredFrom === KEY(-1)), "the pending day is read, not today again");
  snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.pendingDay, null);
  assert.deepEqual(snapshot.rows.map(row => row.text),
    ["today", "yesterday late", "yesterday noon", "yesterday morning"],
    "the day the reader asked for is now in the window, beside today");
});

test("each retry reads further than the attempt before it", async t => {
  const { feed, store, client, agent } = fixture(t);
  // Three pages of today, with a budget of one page per day: only a retry can reach the end.
  agent.state.pages = [
    [entry("user_message", "row a", DAY(0, 11), 1)],
    [entry("user_message", "row b", DAY(0, 10), 2)],
    [entry("user_message", "row c", DAY(0, 9), 3)],
  ];
  const started = start(feed, client, { budgets: { pagesPerDay: 1, maxPages: 64 } });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").partial, true, "one page does not cover the day");
  const first = store.myMessagesSnapshot("a").rows.length;

  started.retry();
  await settle(14);
  const second = store.myMessagesSnapshot("a");
  assert.ok(second.rows.length > first || !second.partial, "the retry read further than the first attempt");

  started.retry();
  await settle(14);
  const third = store.myMessagesSnapshot("a");
  assert.equal(third.partial, false, "the third attempt reaches the beginning of the conversation");
  assert.equal(third.humanToday, 3);
});

test("a refresh that stops short keeps the rows already shown and marks them partial", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
  ];
  const started = start(feed, client, { budgets: { pagesPerDay: 8, maxPages: 64 } });
  t.after(() => started.stop());
  await started.ready;
  assert.deepEqual(store.myMessagesSnapshot("a").rows.map(row => row.text), ["today"]);

  // The next refresh may only read one page; it must not shrink the visible window silently.
  const second = feed.startMyMessagesFeed({
    agentId: "b",
    client,
    now: () => DAY(0, 12),
    timers: fakeTimers(),
    budgets: { pagesPerDay: 1, maxPages: 1 },
  });
  t.after(() => second.stop());
  await second.ready;
  const snapshot = store.myMessagesSnapshot("b");
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.rows.length, 1, "what was read is still shown");
});

test("the first subscription that succeeds after a failure catches up", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  agent.state.holdReady = true;
  const timers = fakeTimers();
  const started = start(feed, client, { timers });
  t.after(() => started.stop());
  await settle(10);
  assert.equal(store.myMessagesSnapshot("a").humanToday, 1, "the first read landed");
  const first = agent.state.subscriptions[0];
  first.reject(new Error("subscription unavailable"));
  await pump(timers, () => agent.state.subscriptions.length >= 2, 6);

  // A message arrives before the replacement answers.
  agent.state.pages = [[
    entry("user_message", "first", DAY(0, 9), 1),
    entry("user_message", "while offline", DAY(0, 10), 2),
  ]];
  const readsBefore = agent.state.calls.length;
  agent.live[0].resolve();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").humanToday === 2),
    "the first successful subscription after a failure reads again");
  assert.ok(agent.state.calls.length > readsBefore);
});

test("a subscription that comes back reads again", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  const timers = fakeTimers();
  const started = start(feed, client, { timers });
  t.after(() => started.stop());
  await started.ready;
  agent.state.pages = [[
    entry("user_message", "first", DAY(0, 9), 1),
    entry("user_message", "while offline", DAY(0, 10), 2),
  ]];
  agent.emit({ type: "error", error: new Error("lost") });
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").live === false), "the loss is reported");
  await pump(timers, () => agent.state.subscriptions.length >= 2, 8);
  agent.live[0].resolve();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").humanToday === 2), "the catch-up read lands");
});

test("a failed rollover read marks the retained counts as stale", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "before midnight", DAY(0, 22), 1)]];
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  const started = start(feed, client, { now: () => clock, timers });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").stale, false);

  agent.state.failReads = 40;
  clock = DAY(1, 0, 0, 5);
  timers.runLongest();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").status === "error"), "the failure is reported");
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.stale, true, "yesterday's counts are not shown as today's");
  assert.ok(timers.pending().some(item => item.ms > SHORT_MS), "another midnight wake is armed anyway");
});

test("foreground re-anchors the midnight wake even when its read fails", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  const listeners = new Set();
  const foreground = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const timers = fakeTimers();
  let clock = DAY(0, 12);
  const started = start(feed, client, { foreground, timers, now: () => clock });
  t.after(() => started.stop());
  await started.ready;
  const before = timers.pending().filter(item => item.ms > SHORT_MS)[0];
  assert.ok(before, "a midnight wake is armed");

  // A new day while the app was in the background, an hour later than the old wake assumed,
  // and the read that follows fails. The wake must be re-anchored to the new clock anyway.
  clock = DAY(1, 13);
  agent.state.failReads = 40;
  for (const listener of listeners) listener();
  await pump(timers, () => store.myMessagesSnapshot("a").status === "error");
  const wakes = timers.pending().filter(item => item.ms > SHORT_MS);
  assert.equal(wakes.length, 1, "the wake was re-armed against the current clock");
  assert.ok(wakes[0].ms < 11.5 * 60 * 60 * 1000, `midnight is 11 hours away at 13:00, got ${wakes[0].ms} ms`);
});

test("a stale subscription cannot mark a healthy one down", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  const timers = fakeTimers();
  agent.state.holdReady = true;
  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const started = start(feed, client, { timers });
  t.after(() => started.stop());
  await settle();
  assert.equal(agent.live.length, 1, "one subscription is opened");
  const first = agent.state.subscriptions[0];

  first.handler({ agentId: "a", event: { type: "error", error: new Error("lost") } });
  first.reject(new Error("subscription unavailable"));
  await pump(timers, () => agent.state.subscriptions.length >= 2, 6);
  const second = agent.live[0];
  assert.ok(second && second !== first, "a replacement subscription was opened");
  second.resolve();
  await settle();

  release();
  await settle(12);
  assert.equal(store.myMessagesSnapshot("a").live, true, "the healthy subscription keeps the panel live");
  assert.equal(agent.live.length, 1, "the failed subscription did not start a third one");
  started.stop();
  assert.equal(agent.live.length, 0, "closing the panel releases the one subscription that is left");
});

test("two mounts of one panel share one feed, and a double release counts once", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "hello", DAY(0, 9), 1)]];
  const first = feed.acquireMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  const second = feed.acquireMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => { first.stop(); second.stop(); });
  await settle();
  assert.equal(agent.state.subscriptions.length, 1, "one conversation, one subscription");
  assert.equal(store.myMessagesSnapshot("a").rows.length, 1);

  first.stop();
  first.stop();
  assert.equal(agent.live.length, 1, "a handle that stops twice still leaves the other reader's feed alone");
  second.stop();
  first.stop();
  assert.equal(agent.live.length, 0);
  assert.equal(store.myMessagesSnapshot("a").status, "loading", "a closed conversation keeps no rows");
});

test("two quick Earlier presses read once and add one day", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "the day before", DAY(-2, 9), 3)],
  ];
  const started = start(feed, client, { budgets: { pagesPerDay: 6, maxPages: 40 } });
  t.after(() => started.stop());
  await started.ready;

  let gate;
  agent.state.holdReads = new Promise(resolve => { gate = resolve; });
  const first = started.loadEarlier();
  const second = started.loadEarlier();
  await settle(4);
  agent.state.holdReads = null;
  gate();
  await Promise.all([first, second]);
  await settle(14);
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.coveredFrom, KEY(-1), "two presses add one day, not two");
  assert.equal(snapshot.pendingDay, null);
});

test("closing the panel stops a page walk that is still running", async t => {
  const { feed, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "older", DAY(-2, 9), 3)],
  ];
  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const started = start(feed, client);
  t.after(() => started.stop());
  await settle();
  assert.equal(agent.state.calls.length, 1, "the walk is waiting on its first page");
  started.stop();
  release();
  await settle(12);
  assert.equal(agent.state.calls.length, 1, "a closed panel asks for no further page");
});

test("the snapshot holds only the visible window's rows", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "older", DAY(-3, 9), 3)],
  ];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today"]);
  assert.equal(snapshot.hasEarlier, true);
  assert.equal("entries" in snapshot, false, "no timeline pages travel with the snapshot");
});

test("two messages in the same millisecond list newest sequence first", async t => {
  const { feed, store, client, agent } = fixture(t);
  const sameMillisecond = DAY(0, 9);
  agent.state.pages = [[
    entry("user_message", "first", sameMillisecond, 1),
    entry("user_message", "second", sameMillisecond, 2),
  ]];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  assert.deepEqual(store.myMessagesSnapshot("a").rows.map(row => row.text), ["second", "first"]);
});

// --- Random interleavings ------------------------------------------------------------------
//
// A seeded shuffle of the things that can happen to an open panel: new messages, Earlier
// presses, retries, midnight, and subscription failures. Whatever the order, the panel must
// end up describing one window consistently, and closing it must leave nothing subscribed.

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function keyOf(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("any order of events, Earlier, retry, midnight and subscription failures settles consistently", async () => {
  const SEEDS = 200;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const random = mulberry32(seed);
    const agent = createAgent();
    const h = createToolHarness("web", { paseo: { agents: { ref: () => agent.handle } } });
    const feed = h.load("client/my-messages-feed.ts");
    const store = h.load("client/my-messages-store.ts");
    const timers = fakeTimers();
    let clock = DAY(0, 12);
    let sequence = 1;

    // Four pages of mixed rows, newest first: today, yesterday, the day before.
    const rowsByDay = new Map();
    const add = (at, kind, text) => {
      const key = keyOf(at);
      if (!rowsByDay.has(key)) rowsByDay.set(key, []);
      rowsByDay.get(key).push({ at, kind, text, seq: sequence++ });
    };
    add(DAY(0, 9), "human", "today first");
    add(DAY(0, 10), "machine", "<system-reminder>x</system-reminder>");
    add(DAY(0, 11), "assistant", "a reply");
    add(DAY(-1, 9), "human", "yesterday");
    add(DAY(-2, 9), "human", "the day before");
    const publishPages = () => {
      const all = [...rowsByDay.values()].flat().sort((a, b) => b.at - a.at || b.seq - a.seq);
      agent.state.pages = [
        all.slice(0, 2),
        all.slice(2, 4),
        all.slice(4),
      ].map(chunk => chunk.map(row => entry(
        row.kind === "human" ? "user_message" : row.kind === "machine" ? "user_message" : "assistant_message",
        row.text, row.at, row.seq,
      )));
    };
    publishPages();

    const started = feed.startMyMessagesFeed({
      agentId: "a",
      client: { agents: { ref: () => agent.handle } },
      now: () => clock,
      timers,
      budgets: { pagesPerDay: 2, maxPages: 12 },
      foreground: { subscribe: () => () => {} },
    });
    await settle(6);

    const ops = [
      () => { add(DAY(0, 12, 0, 0, random() * 1000 | 0), "human", `later ${seed}-${sequence}`); publishPages(); agent.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "later" } }); },
      () => { void started.loadEarlier(); },
      () => { started.retry(); },
      () => { clock = DAY(1, 0, 0, 5); timers.runLongest(); },
      () => { const live = agent.live[0]; if (live) live.reject(new Error("subscription unavailable")); },
      () => { clock = DAY(0, 13); agent.emit({ type: "subscription_restored", provider: "mock" }); },
    ];
    const steps = 6 + (seed % 4);
    for (let step = 0; step < steps; step += 1) {
      ops[Math.floor(random() * ops.length)]();
      await settle(6);
      timers.runAll(6);
      await settle(4);
    }
    // Let the queue drain, then close.
    await settle(16);
    timers.runAll(12);
    await settle(12);
    started.stop();
    assert.equal(agent.live.length, 0, `seed ${seed}: closing leaves no subscription`);

    const snapshot = store.myMessagesSnapshot("a");
    const today = keyOf(clock);
    const dayStart = (key) => {
      const [y, m, d] = key.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    };
    if (snapshot.status === "ready" && !snapshot.partial && snapshot.coveredFrom && snapshot.coveredFrom <= today) {
      const windowStart = dayStart(snapshot.coveredFrom);
      const tomorrow = dayStart(today) + 26 * 60 * 60 * 1000;
      const expected = [...rowsByDay.values()].flat()
        .filter(row => row.kind === "human" && row.at >= windowStart && row.at < dayStart(keyOf(dayStart(today) + 26 * 60 * 60 * 1000)))
        .sort((a, b) => b.at - a.at || b.seq - a.seq)
        .map(row => row.text);
      assert.deepEqual(snapshot.rows.map(row => row.text), expected, `seed ${seed}: the window is exactly re-read`);
      const todayRows = [...rowsByDay.values()].flat().filter(row => keyOf(row.at) === today);
      assert.equal(snapshot.humanToday, todayRows.filter(row => row.kind === "human").length, `seed ${seed}: today's count`);
      assert.equal(snapshot.machineToday, todayRows.filter(row => row.kind === "machine").length, `seed ${seed}: machine count`);
      assert.equal(snapshot.day, today, `seed ${seed}: the counts belong to the current day`);
      void tomorrow;
    }
    if (snapshot.pendingDay !== null) {
      assert.ok(snapshot.pendingDay < snapshot.coveredFrom, `seed ${seed}: a pending day is older than the window`);
    }
    h.dispose();
  }
});
