const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The panel's data path. Every case freezes the clock and, where a retry or a midnight wake is
// involved, drives the timers by hand: nothing here waits for a real hour or a real second.
// Dates are built from local calendar parts, so the same file passes in UTC and in Asia/Tokyo.

const DAY = (dayOffset, hour, minute = 0, second = 0) =>
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
    gap: Boolean(options.gap),
    window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
    startCursor: options.startCursor ?? null,
    endCursor: { epoch: "e1", seq: 2 },
    hasOlder: Boolean(options.hasOlder),
    hasNewer: false,
    entries,
    error: options.error ?? null,
  };
}

/** A timeline served as the pages a real one returns: the newest page first, older pages by cursor. */
function createAgent(id = "a") {
  const state = {
    pages: [],
    failReads: 0,
    failSubscribes: 0,
    holdReads: null,
    calls: [],
    subscribeCount: 0,
    stopped: 0,
    subscribers: [],
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
        state.subscribeCount += 1;
        if (state.failSubscribes > 0) {
          state.failSubscribes -= 1;
          return Object.assign(() => {}, {
            ready: Promise.reject(new Error("subscription unavailable")),
            async release() {},
          });
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
    emit(event) {
      for (const handler of [...state.subscribers]) handler({ agentId: id, event });
    },
  };
  return { state, handle, emit: event => handle.emit(event) };
}

function createClient(agent) {
  return { agents: { ref: () => agent.handle } };
}

// A retry sleeps milliseconds; the midnight wake is hours away. Keeping the two apart means a
// case that pumps retries never accidentally fires the day boundary.
const SHORT_MS = 5 * 60 * 1000;

/** Timers a test runs itself: no case here waits for a real delay. */
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

/** Runs queued timers until `done()` holds, or the rounds run out. */
async function pump(timers, done, rounds = 40) {
  for (let round = 0; round < rounds; round += 1) {
    await settle(4);
    if (done()) return true;
    timers.runAll(4);
  }
  return done();
}

function fixture(t, options = {}) {
  const agent = createAgent();
  const h = createToolHarness("web", { paseo: { agents: { ref: () => agent.handle } } });
  t.after(() => { h.unmount(); h.dispose(); });
  return {
    h,
    agent,
    feed: h.load("client/my-messages-feed.ts"),
    store: h.load("client/my-messages-store.ts"),
    client: createClient(agent),
  };
}

test("today's machine messages and the person's messages come from one read", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[
    entry("user_message", "what did we decide?", DAY(0, 9, 5), 1),
    entry("assistant_message", "Here is the answer.", DAY(0, 9, 6), 2),
    entry("user_message", "<system-reminder>keep going</system-reminder>", DAY(0, 9, 7), 3),
    entry("user_message", "[1a] 好", DAY(0, 10, 15), 4),
    entry("user_message", "[ASYNC DELEGATION from another agent]", DAY(0, 11), 5),
  ]];
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.machineToday, 2, "the host envelope and the delegation envelope are machine rows");
  assert.equal(snapshot.humanToday, 2, "the person's question and the bracketed [1a] line are theirs");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["[1a] 好", "what did we decide?"], "newest first");
  assert.deepEqual(snapshot.rows.map(row => row.time), ["10:15", "09:05"]);
  assert.equal(snapshot.partial, false);
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
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.humanToday, 2, "midnight belongs to the new day; 23:59 does not");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["later this morning", "just after midnight"]);
  assert.equal(snapshot.hasEarlier, true, "a row older than today is reachable");
});

test("a read and the rows it publishes use one clock value", async t => {
  const { feed, store, client, agent } = fixture(t);
  // The message sits just before midnight; the second read of the clock would be after it.
  agent.state.pages = [[entry("user_message", "still today", DAY(0, 23, 59, 59), 1)]];
  const values = [DAY(0, 23, 59, 59), DAY(1, 0, 0, 1), DAY(1, 0, 0, 1)];
  let calls = 0;
  const started = feed.startMyMessagesFeed({
    agentId: "a",
    client,
    now: () => values[Math.min(calls++, values.length - 1)],
    timers: fakeTimers(),
  });
  t.after(() => started.stop());
  await started.ready;
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(calls, 1, "one read takes one clock value");
  assert.equal(snapshot.humanToday, 1, "the row is today's, by the clock the read used");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["still today"]);
});

test("the panel re-reads when the local day turns over", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "before midnight", DAY(0, 22), 1)]];
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => clock, timers });
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

test("a day with more pages than one read reports partial, and Earlier continues from the cursor", async t => {
  const { feed, store, client, agent } = fixture(t);
  // 45 pages of the person's messages, all today: more than one read may spend.
  const pages = [];
  for (let index = 0; index < 45; index += 1) {
    const minute = 44 - index;
    pages.push([
      entry("user_message", `message ${index}-a`, DAY(0, 0, minute, 10), index * 2 + 1),
      entry("user_message", `message ${index}-b`, DAY(0, 0, minute, 20), index * 2 + 2),
    ]);
  }
  agent.state.pages = pages;
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => started.stop());
  await started.ready;

  let snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, true, "an unfinished read says so");
  assert.equal(snapshot.humanToday, 80, "40 pages of two rows");
  assert.equal(snapshot.rows.length, 80);
  assert.equal(snapshot.hasEarlier, true);

  const before = agent.state.calls.length;
  await started.loadEarlier();
  const press = agent.state.calls.slice(before);
  assert.equal(press[0].direction, "before", "a press continues from the cursor, not from the tail");
  assert.deepEqual(press[0].cursor, { epoch: "e1", seq: "40" });
  snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, false, "the day is covered now");
  assert.equal(snapshot.humanToday, 90, "every row of the day is counted");
  assert.equal(snapshot.rows.length, 90);
});

test("a failed Earlier read leaves the visible day where it was", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "the day before", DAY(-2, 9), 3)],
  ];
  const timers = fakeTimers();
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").loadedDays, 1);

  // Four attempts spend four failures; the fifth read would still fail, which is the last.
  agent.state.failReads = 5;
  const failed = started.loadEarlier();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").status === "error"), "the failure is reported");
  await failed;
  assert.equal(store.myMessagesSnapshot("a").loadedDays, 1, "a failed read does not move the day");

  agent.state.failReads = 0;
  const retried = started.loadEarlier();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").loadedDays === 2), "the next press adds one day");
  await retried;
  const snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows.map(row => row.text), ["today", "yesterday"], "exactly one more day");
});

test("live updates recover after repeated subscription failures", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  agent.state.failSubscribes = 4;
  const timers = fakeTimers();
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers });
  t.after(() => started.stop());

  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").live === true), "live delivery comes back");
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.status, "ready", "the rows were read while live delivery was down");
  assert.ok(agent.state.subscribeCount >= 5, `kept trying, saw ${agent.state.subscribeCount} attempts`);

  agent.state.pages = [[
    entry("user_message", "first", DAY(0, 9), 1),
    entry("user_message", "after the outage", DAY(0, 10), 2),
  ]];
  agent.emit({ type: "timeline", provider: "mock", item: { type: "user_message", text: "after the outage" } });
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").humanToday === 2), "a new message arrives again");
});

test("two mounts of one panel share one feed, and the last close forgets it", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "hello", DAY(0, 9), 1)]];
  const first = feed.acquireMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  const second = feed.acquireMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => { first.stop(); second.stop(); });
  await settle();
  assert.equal(agent.state.subscribeCount, 1, "one conversation, one subscription");
  assert.equal(store.myMessagesSnapshot("a").rows.length, 1);

  first.stop();
  assert.equal(agent.state.stopped, 0, "the second reader keeps the feed alive");
  second.stop();
  assert.equal(agent.state.stopped, 1);
  const forgotten = store.myMessagesSnapshot("a");
  assert.equal(forgotten.status, "loading", "a closed conversation keeps no rows");
  assert.deepEqual(forgotten.rows, []);
});

test("overlapping updates run one refresh and one follow-up, not one per event", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = [[entry("user_message", "first", DAY(0, 9), 1)]];
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
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

test("closing the panel stops a page walk that is still running", async t => {
  const { feed, client, agent } = fixture(t);
  agent.state.pages = [
    [entry("user_message", "today", DAY(0, 9), 1)],
    [entry("user_message", "yesterday", DAY(-1, 9), 2)],
    [entry("user_message", "older", DAY(-2, 9), 3)],
  ];
  let release;
  agent.state.holdReads = new Promise(resolve => { release = resolve; });
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => started.stop());
  await settle();
  assert.equal(agent.state.calls.length, 1, "the walk is waiting on its first page");
  started.stop();
  release();
  await settle(12);
  assert.equal(agent.state.calls.length, 1, "a closed panel asks for no further page");
});

test("two messages in the same millisecond list newest sequence first", async t => {
  const { feed, store, client, agent } = fixture(t);
  const sameMillisecond = DAY(0, 9);
  agent.state.pages = [[
    entry("user_message", "first", sameMillisecond, 1),
    entry("user_message", "second", sameMillisecond, 2),
  ]];
  const started = feed.startMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers: fakeTimers() });
  t.after(() => started.stop());
  await started.ready;
  assert.deepEqual(store.myMessagesSnapshot("a").rows.map(row => row.text), ["second", "first"]);
});
