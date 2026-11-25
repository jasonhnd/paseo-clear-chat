const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The panel's data path. Every case freezes the clock and drives the timers by hand: nothing
// here waits for a real hour or a real second. Dates come from local calendar parts, so the
// same file passes in UTC and in Asia/Tokyo.

const DAY = (dayOffset, hour, minute = 0, second = 0, ms = 0) =>
  new Date(2026, 2, 15 + dayOffset, hour, minute, second, ms).getTime();

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

/**
 * A timeline served as pages, newest first. A subscription's `ready` is a promise the test
 * settles, so the order "read still running, subscription 1 errors, subscription 2 answers"
 * can be reproduced exactly.
 */
function createAgent(id = "a") {
  const state = {
    pages: [],
    failReads: 0,
    holdReads: null,
    /** When true, a subscription's `ready` waits for the test; otherwise it resolves at once. */
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
    /** Runs the shortest pending delay under `SHORT_MS`, so retries run and the midnight wake does not. */
    runShort() {
      const next = pending()
        .filter(item => item.ms <= SHORT_MS)
        .sort((left, right) => left.ms - right.ms)[0];
      return next ? take(next) : false;
    },
    /** Runs the pending timer farthest in the future, which is the midnight wake. */
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

async function settle(times = 8) {
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
  assert.equal(snapshot.pendingDayAt, null);
  assert.equal(snapshot.live, true, "a subscription that answered is live");
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
  assert.equal(snapshot.hasEarlier, true, "a row older than today is reachable");
});

test("a page that ends exactly at midnight is read further", async t => {
  const { feed, store, client, agent } = fixture(t);
  // 201 rows: the tail page holds 200 of them and the two oldest share midnight exactly.
  const tail = [];
  for (let index = 0; index < 198; index += 1) {
    tail.push(entry("user_message", `row ${index}`, DAY(0, 12, 0, 0, 0) + index * 1000, index + 1));
  }
  tail.push(entry("user_message", "midnight one", DAY(0, 0, 0, 0, 0), 199));
  tail.push(entry("user_message", "midnight two", DAY(0, 0, 0, 0, 0), 200));
  agent.state.pages = [tail, [entry("user_message", "before midnight", DAY(-1, 23, 0), 201)]];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, false, "a page ending exactly at midnight does not finish the day");
  assert.equal(snapshot.humanToday, 200, "both midnight rows belong to today");
  assert.equal(agent.state.calls.filter(call => call.direction === "before").length, 1,
    "the read walked past the page that ended at midnight");
});

test("the panel re-reads when the local day turns over", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "before midnight", DAY(0, 22), 1)]];
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  const started = start(feed, client, { now: () => clock, timers });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").humanToday, 1);
  const wake = timers.pending();
  assert.equal(wake.length, 1, "one timer waits for the next local midnight");
  assert.ok(wake[0].ms > 0 && wake[0].ms <= 2 * 60 * 1000, `wakes within a minute of midnight, got ${wake[0].ms} ms`);

  clock = DAY(1, 0, 0, 5);
  timers.runLongest();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").humanToday === 0), "the new day is counted from zero");
  const snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows, [], "yesterday's rows leave today's list");
  assert.equal(snapshot.hasEarlier, true, "yesterday is still reachable");
});

test("a midnight wake re-arms even when the read it starts fails", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "before midnight", DAY(0, 22), 1)]];
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  const started = start(feed, client, { now: () => clock, timers });
  t.after(() => started.stop());
  await started.ready;

  agent.state.failReads = 40;
  clock = DAY(1, 0, 0, 5);
  timers.runLongest();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").status === "error"), "the failed read is reported");
  assert.ok(timers.pending().some(item => item.ms > SHORT_MS), "another midnight wake is armed anyway");
});

test("a read begun before midnight and resolved after it is thrown away and read again", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "just before midnight", DAY(0, 23, 59, 59), 1)]];
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const started = start(feed, client, { now: () => clock, timers });
  t.after(() => started.stop());
  await settle();
  // Midnight passes while the read is open, then the read lands.
  clock = DAY(1, 0, 0, 1);
  release();
  await settle(14);
  const snapshot = store.myMessagesSnapshot("a");
  assert.ok(agent.state.calls.length >= 2, "the read was repeated after the day changed");
  assert.equal(snapshot.humanToday, 0, "yesterday's message is not counted as today's");
  assert.deepEqual(snapshot.rows, []);
  const wake = timers.pending().filter(item => item.ms > SHORT_MS);
  assert.equal(wake.length, 1, "the next wake is armed against the new day, not the stale start");
  assert.ok(wake[0].ms > 60 * 60 * 1000, `a day away, got ${wake[0].ms} ms`);
});

test("a foreground signal re-reads while another read is still running", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  const listeners = new Set();
  const foreground = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const started = start(feed, client, { foreground });
  t.after(() => started.stop());
  await settle();
  assert.equal(agent.state.calls.length, 1, "the first read is still running");

  agent.state.pages = [[
    entry("user_message", "first", DAY(0, 9), 1),
    entry("user_message", "while away", DAY(0, 10), 2),
  ]];
  for (const listener of listeners) listener();
  release();
  await settle(14);
  assert.ok(agent.state.calls.length >= 2, "coming back to the foreground asks for another read");
  assert.equal(store.myMessagesSnapshot("a").humanToday, 2);
});

test("every refresh replaces the snapshot instead of trusting an older one", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[
    entry("user_message", "first", DAY(0, 9), 1),
    entry("user_message", "second", DAY(0, 10), 2),
  ]];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").humanToday, 2);

  // The conversation was rebuilt: only one row exists now, and an epoch change says so.
  agent.state.pages = [[entry("user_message", "only row", DAY(0, 11), 9)]];
  agent.emit({ type: "replacement", provider: "mock" });
  await settle(12);
  const snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["only row"], "the rebuilt conversation replaces the old rows");
  assert.equal(snapshot.humanToday, 1);
});

test("Earlier reads a day that is larger than a background refresh may spend", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday late", DAY(-1, 23), 2)],
    [entry("user_message", "yesterday noon", DAY(-1, 12), 3)],
    [entry("user_message", "yesterday morning", DAY(-1, 6), 4)],
    [entry("user_message", "the day before", DAY(-2, 9), 5)],
  ];
  const started = start(feed, client, { budgets: { background: 2, earlier: 20 } });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").loadedDays, 1);

  await started.loadEarlier();
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.loadedDays, 2, "the day is covered, so the window grows");
  assert.equal(snapshot.pendingDayAt, null);
  assert.deepEqual(snapshot.rows.map(row => row.text),
    ["today", "yesterday late", "yesterday noon", "yesterday morning"]);
});

test("an Earlier read that stops short names the day and Retry continues it", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday late", DAY(-1, 23), 2)],
    [entry("user_message", "yesterday noon", DAY(-1, 12), 3)],
    [entry("user_message", "yesterday morning", DAY(-1, 6), 4)],
  ];
  const budgets = { background: 4, earlier: 2 };
  const started = start(feed, client, { budgets });
  t.after(() => started.stop());
  await started.ready;

  await started.loadEarlier();
  let snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.loadedDays, 1, "a day read only partly does not join the window");
  assert.equal(snapshot.pendingDayAt, DAY(-1, 0), "the day that is still short is named");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today"], "the window still shows what it covered");
  assert.equal(snapshot.partial, false, "the visible window itself is complete");
  assert.equal(snapshot.hasEarlier, true);

  // The retry reads that same day again, and this time it fits.
  budgets.earlier = 20;
  started.retry();
  await settle(12);
  snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.loadedDays, 2, "the pending day is committed once it is covered");
  assert.equal(snapshot.pendingDayAt, null);
  assert.deepEqual(snapshot.rows.map(row => row.text),
    ["today", "yesterday late", "yesterday noon", "yesterday morning"]);
});

test("two quick Earlier presses read once and add one day", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "the day before", DAY(-2, 9), 3)],
  ];
  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const started = start(feed, client, { budgets: { background: 4, earlier: 4 } });
  t.after(() => started.stop());
  release();
  await settle(12);
  assert.equal(store.myMessagesSnapshot("a").loadedDays, 1);

  let gate;
  agent.state.holdReads = new Promise(resolve => { gate = resolve; });
  const first = started.loadEarlier();
  const second = started.loadEarlier();
  release = gate;
  await settle(4);
  gate();
  await Promise.all([first, second]);
  await settle(12);
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.loadedDays, 2, "two presses add one day, not two");
  assert.equal(snapshot.pendingDayAt, null);
});

test("a failed Earlier read leaves the visible day where it was", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "the day before", DAY(-2, 9), 3)],
  ];
  const timers = fakeTimers();
  const started = start(feed, client, { timers });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").loadedDays, 1);

  agent.state.failReads = 5;
  const failed = started.loadEarlier();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").status === "error"), "the failure is reported");
  await failed;
  assert.equal(store.myMessagesSnapshot("a").loadedDays, 1, "a failed read does not move the day");

  agent.state.failReads = 0;
  const retried = started.loadEarlier();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").loadedDays === 2), "the next press adds one day");
  await retried;
  assert.deepEqual(store.myMessagesSnapshot("a").rows.map(row => row.text), ["today", "yesterday"]);
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

  // The first subscription fails while the read is still open, and a second one answers.
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
  const forgotten = store.myMessagesSnapshot("a");
  assert.equal(forgotten.status, "loading", "a closed conversation keeps no rows");
  assert.deepEqual(forgotten.rows, []);
});

test("overlapping updates run one refresh and one follow-up, not one per event", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  const started = start(feed, client);
  t.after(() => started.stop());
  await started.ready;
  const before = agent.state.calls.length;

  agent.state.pages = [[
    entry("user_message", "first", DAY(0, 9), 1),
    entry("user_message", "second", DAY(0, 10), 2),
    entry("user_message", "third", DAY(0, 11), 3),
  ]];
  agent.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "second" } });
  agent.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "third" } });
  agent.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "third" } });
  await settle(12);
  const tails = agent.state.calls.slice(before).filter(call => call.direction === "tail").length;
  assert.equal(tails, 2, "three events share one refresh and queue one more");
  assert.equal(store.myMessagesSnapshot("a").humanToday, 3);
});

test("live delivery comes back after repeated subscription failures", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  agent.state.holdReady = true;
  const timers = fakeTimers();
  const started = start(feed, client, { timers });
  t.after(() => started.stop());
  await settle();
  // Every subscription handed out so far fails; the retry keeps opening new ones.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = agent.state.subscriptions.at(-1);
    if (current && !current.closed) current.reject(new Error("subscription unavailable"));
    await pump(timers, () => agent.state.subscriptions.length > attempt + 1, 6);
  }
  const last = agent.state.subscriptions.at(-1);
  last.resolve();
  await settle();
  assert.equal(store.myMessagesSnapshot("a").live, true, "live delivery comes back");
  assert.equal(store.myMessagesSnapshot("a").status, "ready", "the rows were read while it was down");
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
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today"], "older days are not kept in the snapshot");
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
