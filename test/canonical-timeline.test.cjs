const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const timingEntries = require("./fixtures/real-claude-turn-timing.json");
const deliveryEntries = require("./fixtures/real-claude-agent-message.json");

function turn(index, duration = 21099) {
  const entries = structuredClone(timingEntries);
  const offset = index * 60000;
  for (const entry of entries) {
    entry.timestamp = new Date(Date.parse(entry.timestamp) + offset).toISOString();
    entry.turnId = `sample-turn-${index}`;
  }
  entries.at(-1).timestamp = new Date(Date.parse(entries[0].timestamp) + duration).toISOString();
  return entries;
}
function source() {
  const requests = [];
  const pages = [];
  const paseo = { agents: { ref: () => ({ timeline: { async refetch(options) {
    requests.push(options);
    const page = pages.shift();
    assert.ok(page, "unexpected duplicate read");
    return typeof page === "function" ? page() : page;
  } } }) } };
  const h = createToolHarness("web", { paseo });
  const load = h.load("client/canonical-timeline.ts").loadCanonicalTimeline;
  return { requests, pages, h, read: (revision, host = "sample-host", agent = "sample-agent") => load(paseo, host, agent, revision) };
}
function page(entries, seq, extra = {}) {
  return { entries, endCursor: { epoch: "sample-epoch", seq }, epoch: "sample-epoch", error: null,
    hasOlder: false, hasNewer: false, reset: false, staleCursor: false, gap: false,
    agent: { status: "idle", activeTurn: null }, ...extra };
}

test("first open and several settled turns retain all Worked for durations using only new entries", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const { deriveReplyDurations } = s.h.load("client/reply-duration.ts");
  const all = [...turn(0), ...turn(1, 42000)];
  s.pages.push(page(all, 20));
  const first = s.read("idle:1");
  assert.equal(s.read("idle:1"), first, "rows share the revision promise");
  const initial = await first;
  assert.deepEqual([...initial.durations], [...deriveReplyDurations(all)]);
  assert.deepEqual(s.requests, [{ direction: "tail", limit: 0, projection: "canonical" }]);
  for (let i = 2; i < 5; i++) {
    assert.equal(await s.read("running"), await s.read(`idle:${i - 1}`));
    const next = turn(i, i * 10000);
    s.pages.push(page(next, (i + 1) * 10)); all.push(...next);
    const value = await s.read(`idle:${i}`);
    assert.deepEqual([...value.durations], [...deriveReplyDurations(all)]);
    assert.deepEqual(s.requests.at(-1), { direction: "after", cursor: { epoch: "sample-epoch", seq: i * 10 }, limit: 0, projection: "canonical" });
  }
  assert.equal(s.requests.length, 4, "running revisions never read");
});

test("a turn split across incremental pages preserves prompt, response and trailing-event timing", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const { deriveReplyDurations } = s.h.load("client/reply-duration.ts");
  const entries = turn(0);
  for (let i = 0; i < entries.length; i++) {
    s.pages.push(page([entries[i]], i + 1));
    const result = await s.read(`idle:${i}`);
    assert.deepEqual([...result.durations], [...deriveReplyDurations(entries.slice(0, i + 1))]);
  }
  const trailing = { ...entries[3], timestamp: new Date(Date.parse(entries[0].timestamp) + 30000).toISOString() };
  s.pages.push(page([trailing], 11));
  assert.deepEqual([...(await s.read("idle:trailing")).durations.values()], [30000]);
  s.pages.push(page([], null, { endCursor: null }));
  await s.read("idle:empty");
  s.pages.push(page(turn(1), 21));
  await s.read("idle:next");
  assert.equal(s.requests.at(-1).cursor.seq, 11, "an empty delta retains the last cursor");
});

test("opening while running makes no read; a raced running response leaves the settled cursor intact", async t => {
  const s = source(); t.after(() => s.h.unmount());
  assert.equal((await s.read("running")).durations.size, 0);
  assert.equal(s.requests.length, 0);
  s.pages.push(page(turn(0), 10));
  const settled = await s.read("idle:1");
  s.pages.push(page(turn(1), 20, { agent: { status: "running", activeTurn: { turnId: "sample-active" } } }));
  assert.equal(await s.read("idle:2"), settled);
  s.pages.push(page(turn(1), 20));
  assert.equal((await s.read("idle:3")).durations.size, 2);
  assert.equal(s.requests.at(-1).cursor.seq, 10);
});

for (const flag of ["reset", "staleCursor", "gap"]) {
  test(`${flag}: a complete replacement read clears old timing and sender identities`, async t => {
    const s = source(); t.after(() => s.h.unmount());
    s.pages.push(page([...turn(0), ...deliveryEntries], 20));
    const first = await s.read("idle:1");
    assert.equal(first.messages.size, 1);
    s.pages.push(page(turn(1, 42000), 10, { [flag]: true, epoch: "sample-new-epoch", endCursor: { epoch: "sample-new-epoch", seq: 10 } }));
    const next = await s.read("idle:2");
    assert.deepEqual([...next.durations.values()], [42000]);
    assert.equal(next.messages.size, 0);
    assert.equal(s.requests.length, 2, "the reset response already contains the one full read");
    s.pages.push(page([], null, { epoch: "sample-new-epoch", endCursor: null }));
    await s.read("idle:3");
    assert.equal(s.requests.at(-1).cursor.epoch, "sample-new-epoch");
  });
}

test("an incomplete invalid-cursor response permits only one full recovery read", async t => {
  const s = source(); t.after(() => s.h.unmount());
  s.pages.push(page(turn(0), 10)); await s.read("idle:1");
  s.pages.push(page([], null, { staleCursor: true, hasOlder: true }), page(turn(1), 10, { epoch: "sample-replaced" }));
  assert.deepEqual([...(await s.read("idle:2")).durations.values()], [21099]);
  assert.deepEqual(s.requests.map(r => r.direction), ["tail", "after", "tail"]);
  assert.equal(await s.read("idle:2"), await s.read("idle:2"));
  assert.equal(s.requests.length, 3);
});

test("timing and missing sender lookups share one read and merge deliveries across revisions", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const firstDelivery = deliveryEntries.find(e => e.item.agentMessage);
  s.pages.push(page([...turn(0), ...deliveryEntries], 20));
  const initial = await s.read("idle:1");
  assert.deepEqual(initial.messages.get(firstDelivery.item.callId).sender, firstDelivery.item.agentMessage.sender);
  const secondDelivery = structuredClone(firstDelivery);
  secondDelivery.item.callId = "paseo-agent-message:sample-next";
  secondDelivery.item.agentMessage.sender = { id: "sample-next-sender", title: "Next sender" };
  s.pages.push(page([secondDelivery, ...turn(1)], 31));
  const [a, b] = await Promise.all([s.read("idle:2"), s.read("idle:2")]);
  assert.equal(a, b);
  assert.equal(a.messages.size, 2);
  assert.equal(a.messages.get(secondDelivery.item.callId).sender.title, "Next sender");
  assert.equal(a.durations.size, initial.durations.size + 1);
  assert.equal(s.requests.length, 2);
});

test("hosts and replacement agent IDs do not borrow a previous cursor", async t => {
  const s = source(); t.after(() => s.h.unmount());
  for (const [host, agent] of [["first", "first"], ["second", "first"], ["second", "replacement"]]) {
    s.pages.push(page(turn(0), 10)); await s.read("idle:1", host, agent);
  }
  assert.deepEqual(s.requests.map(r => r.direction), ["tail", "tail", "tail"]);
});

test("overlapping settled revisions serialize cursor updates without losing turns", async t => {
  const s = source(); t.after(() => s.h.unmount());
  let resolveRead;
  s.pages.push(() => new Promise(resolve => { resolveRead = resolve; }), page(turn(1), 20));
  const first = s.read("idle:1");
  const second = s.read("idle:2");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.requests.length, 1);
  resolveRead(page(turn(0), 10));
  assert.equal((await first).durations.size, 1);
  assert.equal((await second).durations.size, 2);
  assert.equal(s.requests[1].direction, "after");
  assert.equal(s.requests[1].cursor.seq, 10);
});

test("a failed delta preserves settled labels and retries from the same cursor on the next revision", async t => {
  const s = source(); t.after(() => s.h.unmount());
  s.pages.push(page(turn(0), 10));
  const first = await s.read("idle:1");
  s.pages.push(() => { throw Error("Sample network unavailable"); });
  assert.equal(await s.read("idle:2"), first);
  assert.equal(await s.read("idle:2"), first);
  s.pages.push(page(turn(1), 20));
  assert.equal((await s.read("idle:3")).durations.size, 2);
  assert.deepEqual(s.requests.map(r => r.direction), ["tail", "after", "after"]);
  assert.equal(s.requests.at(-1).cursor.seq, 10);
});
