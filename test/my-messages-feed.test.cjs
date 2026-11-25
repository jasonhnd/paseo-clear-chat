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
    interceptRead: null,
    activeReads: 0,
    maxActiveReads: 0,
    holdRelease: null,
    opened: [],
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
        state.activeReads += 1;
        state.maxActiveReads = Math.max(state.maxActiveReads, state.activeReads);
        try {
          if (state.holdReads) await state.holdReads;
          if (state.failReads > 0) {
            state.failReads -= 1;
            throw new Error("timeline unavailable");
          }
          const index = options.direction === "before" ? Number(options.cursor.seq) : 0;
          const served = state.pages[index] ?? [];
          const older = index + 1 < state.pages.length;
          const response = page(served, {
            direction: options.direction ?? "tail",
            startCursor: older ? { epoch: "e1", seq: String(index + 1) } : null,
            hasOlder: older,
          });
          return state.interceptRead ? await state.interceptRead(options, response) : response;
        } finally {
          state.activeReads -= 1;
        }
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
          releaseCalls: 0,
          stop() {
            record.releaseCalls += 1;
            if (record.closed) return;
            record.closed = true;
            const index = state.subscriptions.indexOf(record);
            if (index >= 0) state.subscriptions.splice(index, 1);
          },
        };
        state.subscriptions.push(record);
        state.opened.push(record);
        if (!state.holdReady) setImmediate(() => { record.resolve(); });
        return Object.assign(record.stop, {
          ready,
          async release() {
            if (state.holdRelease) await state.holdRelease;
            record.stop();
          },
        });
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
  assert.equal(snapshot.day, KEY(0));
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

test("each retry reads further than the attempt before it", async t => {
  const { feed, store, client, agent } = fixture(t);
  // Three pages of today, with a budget of one page: only a retry can reach the end.
  agent.state.pages = [
    [entry("user_message", "row a", DAY(0, 11), 1)],
    [entry("user_message", "row b", DAY(0, 10), 2)],
    [entry("user_message", "row c", DAY(0, 9), 3)],
  ];
  const started = start(feed, client, { budgets: { basePages: 1, maxPages: 64 } });
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
  const beforeRefresh = agent.state.calls.length;
  agent.emit({ type: "timeline", item: { type: "assistant_message", text: "live" } });
  await settle();
  assert.equal(agent.state.calls.length - beforeRefresh, 3, "the next timeline event uses the successful budget");
  assert.equal(store.myMessagesSnapshot("a").partial, false);
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
  assert.ok(await pump(timers, () => agent.state.opened.length === 2), "the replacement opened");

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
  assert.ok(await pump(timers, () => agent.state.opened.length === 2), "the replacement opened");
  agent.live[0].resolve();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").humanToday === 2), "the catch-up read lands");
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

  clock = DAY(1, 0, 0, 5);
  timers.runLongest();
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").humanToday === 0), "the new day is counted from zero");
  const snapshot = store.myMessagesSnapshot("a");
  assert.deepEqual(snapshot.rows, [], "only the new day is shown");
  assert.equal(snapshot.day, KEY(1));
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
  assert.ok(await pump(timers, () => agent.state.opened.length === 2), "the replacement opened");
  const second = agent.live[0];
  assert.ok(second && second !== first, "a replacement subscription was opened");
  second.resolve();
  await settle();
  first.handler({ agentId: "a", event: { type: "error", error: "late failure from old subscription" } });
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

test("the snapshot holds only today's rows", async t => {
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


function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function foregroundSignal() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}

const tailCalls = agent => agent.state.calls.filter(call => call.direction === "tail").length;
const texts = snapshot => snapshot.rows.map(row => row.text);

test("a foreground read crossing midnight cannot add yesterday to today", async t => {
  const { feed, store, client, agent } = fixture(t);
  const foreground = foregroundSignal();
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  const yesterday = entry("user_message", "before midnight", DAY(0, 22), 1);
  agent.state.pages = [[yesterday]];
  const started = start(feed, client, { foreground, timers, now: () => clock });
  t.after(() => started.stop());
  await started.ready;

  const gate = deferred();
  agent.state.interceptRead = (_call, page) => gate.promise.then(() => page);
  foreground.emit();
  await settle();
  assert.equal(tailCalls(agent), 2, "the foreground read started on the old day");
  assert.equal(agent.state.activeReads, 1, "the old day's response is held");

  agent.state.interceptRead = null;
  clock = DAY(1, 0, 0, 5);
  agent.state.pages = [[entry("user_message", "after midnight", DAY(1, 0, 0, 1), 2), yesterday]];
  assert.equal(timers.runLongest(), true, "the midnight trigger overlaps the held read");
  gate.resolve();
  await settle();

  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.day, KEY(1));
  assert.deepEqual(texts(snapshot), ["after midnight"], "a rollover cannot add yesterday's row");
  assert.equal(snapshot.humanToday, 1);
  assert.equal(tailCalls(agent), 3, "the midnight trigger and discard share one new-day read");
});

test("retained counts stay stale through repeated rollover failures", async t => {
  const { feed, store, client, agent } = fixture(t);
  const foreground = foregroundSignal();
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  agent.state.pages = [[entry("user_message", "yesterday", DAY(0, 22), 1)]];
  const started = start(feed, client, { foreground, timers, now: () => clock });
  t.after(() => started.stop());
  await started.ready;

  clock = DAY(1, 3);
  agent.state.failReads = 4;
  assert.equal(timers.runLongest(), true);
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").status === "error"));
  assert.equal(store.myMessagesSnapshot("a").stale, true, "the first failure leaves old counts stale");

  const calls = tailCalls(agent);
  agent.state.failReads = 4;
  foreground.emit();
  assert.ok(await pump(timers, () => tailCalls(agent) === calls + 4 && agent.state.activeReads === 0));
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.day, KEY(0), "failed reads do not change the counts' day");
  assert.equal(snapshot.humanToday, 1, "the earlier count is still retained");
  assert.equal(snapshot.stale, true, "the second failure must not make yesterday's counts current");
});

test("a terminal read failure still drains a queued restoration refresh", async t => {
  const { feed, store, client, agent } = fixture(t);
  const foreground = foregroundSignal();
  const timers = fakeTimers();
  const first = entry("user_message", "first", DAY(0, 9), 1);
  agent.state.pages = [[first]];
  const started = start(feed, client, { foreground, timers });
  t.after(() => started.stop());
  await started.ready;

  const lastAttempt = deferred();
  const statuses = [];
  const unsubscribe = store.subscribeMyMessages(() => statuses.push(store.myMessagesSnapshot("a").status));
  t.after(unsubscribe);
  agent.state.failReads = 3;
  agent.state.interceptRead = () => lastAttempt.promise;
  foreground.emit();
  assert.ok(await pump(timers, () => tailCalls(agent) === 5 && agent.state.activeReads === 1),
    "the fourth attempt is still in flight");

  agent.state.interceptRead = null;
  agent.state.pages = [[entry("user_message", "recovered", DAY(0, 10), 2), first]];
  agent.emit({ type: "subscription_restored" });
  await settle();
  assert.equal(tailCalls(agent), 5, "restoration queues, but cannot start a concurrent read");
  lastAttempt.reject(new Error("last attempt failed"));
  await settle();

  assert.ok(statuses.includes("error"), "the terminal failure was published");
  assert.equal(tailCalls(agent), 6, "the queued restoration must start one fresh tail read");
  assert.deepEqual(texts(store.myMessagesSnapshot("a")), ["recovered", "first"]);
  assert.equal(agent.state.maxActiveReads, 1);
});

test("a partial rollover replaces longer rows from yesterday with today's rows", async t => {
  const { feed, store, client, agent } = fixture(t);
  const timers = fakeTimers();
  let clock = DAY(0, 23, 59, 59);
  const yesterday = [
    entry("user_message", "yesterday late", DAY(0, 22), 2),
    entry("user_message", "yesterday early", DAY(0, 9), 1),
  ];
  agent.state.pages = [yesterday];
  const started = start(feed, client, { timers, now: () => clock });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(store.myMessagesSnapshot("a").rows.length, 2);

  clock = DAY(1, 1);
  agent.state.pages = [
    [entry("user_message", "today's tail", DAY(1, 0, 59), 100)],
    ...Array.from({ length: 40 }, (_, i) => [entry("assistant_message", "output", DAY(1, 0, 30), 99 - i)]),
    yesterday,
  ];
  assert.equal(timers.runLongest(), true);
  assert.ok(await pump(timers, () => store.myMessagesSnapshot("a").day === KEY(1)));
  const snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, true, "the page budget was exhausted");
  assert.deepEqual(texts(snapshot), ["today's tail"], "partial reads never retain rows from the previous day");
  assert.equal(snapshot.humanToday, 1);
  assert.equal(snapshot.stale, false);
});

test("a partial read retains longer rows only on the same day", async t => {
  const { feed, store, client, agent } = fixture(t);
  const first = entry("user_message", "first", DAY(0, 9), 1);
  const second = entry("user_message", "second", DAY(0, 10), 2);
  agent.state.pages = [[first, second]];
  const started = start(feed, client, { budgets: { basePages: 1, maxPages: 4 } });
  t.after(() => started.stop());
  await started.ready;

  const third = entry("user_message", "third", DAY(0, 11), 3);
  agent.state.pages = [[third], [second, first]];
  agent.emit({ type: "replacement", epoch: "e2" });
  await settle();
  let snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, true);
  assert.deepEqual(texts(snapshot), ["second", "first"], "a shorter partial read preserves the longer list already displayed");
  assert.equal(snapshot.humanToday, 1, "partial counts describe what the current read found");

  agent.state.pages = [[third, second], [first]];
  agent.emit({ type: "replacement", epoch: "e3" });
  await settle();
  snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, true);
  assert.deepEqual(texts(snapshot), ["third", "second"], "an equally long partial read replaces the list");

  agent.state.pages = [[third]];
  agent.emit({ type: "replacement", epoch: "e4" });
  await settle();
  snapshot = store.myMessagesSnapshot("a");
  assert.equal(snapshot.partial, false);
  assert.deepEqual(texts(snapshot), ["third"], "a complete read always replaces the list");
});

test("Retry doubles the tail budget only up to its cap", async t => {
  const { feed, store, client, agent } = fixture(t);
  agent.state.pages = Array.from({ length: 4 }, (_, i) => [
    entry("user_message", `row ${i}`, DAY(0, 10), 10 - i),
  ]);
  const started = start(feed, client, { budgets: { basePages: 2, maxPages: 3 } });
  t.after(() => started.stop());
  await started.ready;
  assert.equal(agent.state.calls.length, 2);

  started.retry();
  await settle();
  assert.equal(agent.state.calls.length, 5);
  assert.equal(store.myMessagesSnapshot("a").partial, true);
  started.retry();
  await settle();
  assert.equal(agent.state.calls.length, 8, "the capped budget does not grow on later retries");
});

test("replacement waits for release, and closing during release cannot reopen the feed", async t => {
  const { feed, store, client, agent } = fixture(t);
  const timers = fakeTimers();
  const started = feed.acquireMyMessagesFeed({ agentId: "a", client, now: () => DAY(0, 12), timers });
  t.after(() => started.stop());
  await started.ready;
  const first = agent.live[0];

  const release = deferred();
  agent.state.holdRelease = release.promise;
  agent.emit({ type: "error", error: "lost" });
  assert.equal(timers.runShort(), true);
  await settle();
  assert.equal(agent.state.opened.length, 1, "the previous release must finish before opening a replacement");
  assert.equal(agent.live[0], first);
  started.retry();
  started.stop();
  release.resolve();
  await settle();
  assert.equal(first.releaseCalls, 1, "the previous handle was released exactly once");
  assert.equal(agent.state.opened.length, 1, "no new handle can open after the last panel closed");
  assert.equal(agent.live.length, 0);
  assert.equal(store.myMessagesSnapshot("a").status, "loading");
});

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

function localKey(at) {
  const date = new Date(at);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(part => String(part).padStart(2, "0"))
    .join("-");
}

test("seeded interleavings coalesce and discard against the history and clock oracle", async t => {
  for (let seed = 1; seed <= 24; seed += 1) {
    await t.test(`seed ${seed}`, async t => {
      const { feed, store, client, agent } = fixture(t);
      const random = mulberry32(seed);
      const foreground = foregroundSignal();
      const timers = fakeTimers();
      const includeMidnightTrigger = seed % 2 === 0;
      let clock = DAY(0, 23, 59, 59);
      const history = [];
      const add = (at, kind, text) => history.push({ at, kind, text, seq: history.length + 1 });
      const lastFirst = (a, b) => b.at - a.at || b.seq - a.seq;
      function setPages() {
        const entries = history.slice().sort(lastFirst).map(row => entry(
          row.kind === "assistant" ? "assistant_message" : "user_message",
          row.text, row.at, row.seq,
        ));
        agent.state.pages = [];
        for (let i = 0; i < entries.length; i += 4) agent.state.pages.push(entries.slice(i, i + 4));
      }
      function checkOracle(label) {
        const day = localKey(clock);
        const today = history.filter(row => localKey(row.at) === day);
        const expected = today.filter(row => row.kind === "human").sort(lastFirst);
        const actual = store.myMessagesSnapshot("a");
        assert.equal(actual.day, day, `${label}: day matches the clock`);
        assert.equal(actual.status, "ready", `${label}: a read finished`);
        assert.equal(actual.stale, false, `${label}: the snapshot is current`);
        assert.equal(actual.partial, false, `${label}: the read reached the day boundary`);
        assert.equal(actual.humanToday, expected.length, `${label}: human count`);
        assert.equal(actual.machineToday, today.filter(row => row.kind === "machine").length, `${label}: machine count`);
        assert.deepEqual(actual.rows.map(({ text, seq }) => ({ text, seq })),
          expected.map(({ text, seq }) => ({ text, seq })), `${label}: exact newest-first rows`);
      }

      add(DAY(-1, 23), "human", "previous day");
      add(DAY(0, 8), "human", "first");
      add(DAY(0, 11), "machine", "[IMPORTANT initial notice]");
      add(DAY(0, 12), "assistant", "answer");
      setPages();
      const started = feed.acquireMyMessagesFeed({ agentId: "a", client, foreground, timers, now: () => clock });
      t.after(() => started.stop());
      await started.ready;
      checkOracle("initial read");

      async function holdForegroundTail() {
        const gate = deferred();
        const before = tailCalls(agent);
        agent.state.interceptRead = (_call, page) => gate.promise.then(() => page);
        foreground.emit();
        await settle(2);
        assert.equal(tailCalls(agent), before + 1, "the foreground tail started");
        assert.equal(agent.state.activeReads, 1, "the tail is still in flight");
        agent.state.interceptRead = null;
        return { gate, before };
      }

      const sameDay = await holdForegroundTail();
      const tie = DAY(0, 13, 0, 0, Math.floor(random() * 1000));
      add(tie, "human", "one event");
      add(tie, "human", "another event in the same millisecond");
      add(tie, "machine", "[IMPORTANT delivered during the read]");
      setPages();

      const steps = [
        () => agent.emit({ type: "timeline", item: { type: "user_message", text: "one event" } }),
        () => started.retry(),
        () => foreground.emit(),
        () => {
          const wakes = timers.pending();
          assert.equal(wakes.length, 1, "only a midnight wake is armed before the error");
          agent.emit({ type: "error", error: "disconnected" });
          assert.equal(store.myMessagesSnapshot("a").live, false, "the subscription error took the feed offline");
          assert.equal(timers.pending().length, 2, "the error armed a replacement timer");
          agent.emit({ type: "subscription_restored" });
          assert.equal(store.myMessagesSnapshot("a").live, true, "the restore event took it back online");
          assert.deepEqual(timers.pending(), wakes, "restoration canceled only the replacement timer");
        },
      ];
      while (steps.length > 0) {
        const [trigger] = steps.splice(Math.floor(random() * steps.length), 1);
        trigger();
        await settle(1);
        assert.equal(agent.state.activeReads, 1, "each trigger overlaps the held response");
        assert.equal(tailCalls(agent), sameDay.before + 1, "no trigger starts a concurrent tail read");
      }
      sameDay.gate.resolve();
      await settle();
      assert.equal(tailCalls(agent), sameDay.before + 2, "overlapping triggers produce exactly one follow-up");
      checkOracle("coalesced follow-up");

      const unpublished = "old day update held across midnight";
      add(DAY(0, 22), "human", unpublished);
      setPages();
      const rollover = await holdForegroundTail();
      const published = [];
      const unsubscribe = store.subscribeMyMessages(() => published.push(texts(store.myMessagesSnapshot("a"))));
      t.after(unsubscribe);

      clock = DAY(1, 0, 0, 5);
      add(DAY(1, 0, 0, 1), "human", "new day");
      add(DAY(1, 0, 0, 1), "machine", "CONTEXT: new day");
      setPages();
      if (includeMidnightTrigger) {
        assert.equal(timers.runLongest(), true, "the independent midnight timer fires while the tail is gated");
      }
      await settle(1);
      assert.equal(tailCalls(agent), rollover.before + 1, "no new-day read overlaps the old one");
      rollover.gate.resolve();
      await settle();
      assert.ok(published.length > 0, "publication was observed after the day changed");
      assert.ok(published.every(rows => !rows.includes(unpublished)), "a response for the previous day was never published");
      assert.equal(tailCalls(agent), rollover.before + 2, "the day change causes one fresh tail even without a timer event");
      checkOracle("rollover");
      assert.equal(agent.state.maxActiveReads, 1, "all page reads were serialized");

      started.stop();
      assert.equal(agent.state.opened.length, 1, "a restore on the same handle did not open a duplicate");
      assert.equal(agent.state.opened[0].releaseCalls, 1, "the last close released the handle exactly once");
      assert.equal(agent.live.length, 0, "closing leaves no subscription");
    });
  }
});
