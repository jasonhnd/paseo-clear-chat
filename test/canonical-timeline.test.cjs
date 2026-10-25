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
    entry.seqStart += index * 100;
    entry.seqEnd += index * 100;
    for (const range of entry.sourceSeqRanges) {
      range.startSeq += index * 100;
      range.endSeq += index * 100;
    }
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
function page(entries, seq = Math.max(...entries.map(entry => entry.seqEnd)), extra = {}) {
  return { entries, endCursor: { epoch: "sample-epoch", seq }, epoch: "sample-epoch", error: null,
    hasOlder: false, hasNewer: false, reset: false, staleCursor: false, gap: false,
    agent: { status: "idle", activeTurn: null }, ...extra };
}

test("first open and several settled turns retain all Worked for durations using only new entries", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const { deriveReplyDurations } = s.h.load("client/reply-duration.ts");
  const all = [...turn(0), ...turn(1, 42000)];
  s.pages.push(page(all));
  const first = s.read("idle:1");
  assert.equal(s.read("idle:1"), first, "rows share the revision promise");
  const initial = await first;
  assert.deepEqual([...initial.durations], [...deriveReplyDurations(all)]);
  assert.deepEqual(s.requests, [{ direction: "tail", limit: 0, projection: "canonical" }]);
  for (let i = 2; i < 5; i++) {
    assert.equal(await s.read("running"), await s.read(`idle:${i - 1}`));
    const next = turn(i, i * 10000);
    s.pages.push(page(next)); all.push(...next);
    const value = await s.read(`idle:${i}`);
    assert.deepEqual([...value.durations], [...deriveReplyDurations(all)]);
    assert.deepEqual(s.requests.at(-1), { direction: "after", cursor: { epoch: "sample-epoch", seq: (i - 1) * 100 + 27 }, limit: 0, projection: "canonical" });
  }
  assert.equal(s.requests.length, 4, "running revisions never read");
});

test("a turn split across incremental pages preserves prompt, response and trailing-event timing", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const { deriveReplyDurations } = s.h.load("client/reply-duration.ts");
  const entries = turn(0);
  const startedTool = { ...entries[3], timestamp: entries[2].timestamp, seqEnd: 5,
    sourceSeqRanges: [{ startSeq: 5, endSeq: 5 }] };
  const snapshots = [
    [...entries.slice(0, 3), startedTool],
    entries.slice(0, 5),
    entries.slice(0, 9),
    entries,
  ];
  let cursor = 0;
  for (const [i, full] of snapshots.entries()) {
    // The host re-sends whole projected items with lifecycle events past the cursor.
    const delta = full.filter(entry => entry.seqEnd > cursor);
    s.pages.push(page(delta));
    const result = await s.read(`idle:${i}`);
    assert.deepEqual([...result.durations], [...deriveReplyDurations(full)]);
    cursor = Math.max(...full.map(entry => entry.seqEnd));
  }
  const trailing = { ...entries[3], item: { ...entries[3].item, callId: "sample-trailing-tool" },
    timestamp: new Date(Date.parse(entries[0].timestamp) + 30000).toISOString(),
    seqStart: 28, seqEnd: 28, sourceSeqRanges: [{ startSeq: 28, endSeq: 28 }] };
  s.pages.push(page([trailing]));
  assert.deepEqual([...(await s.read("idle:trailing")).durations.values()], [30000]);
  s.pages.push(page([], null, { endCursor: null }));
  await s.read("idle:empty");
  s.pages.push(page(turn(1)));
  await s.read("idle:next");
  assert.equal(s.requests.at(-1).cursor.seq, 28, "an empty delta retains the last cursor");
});

for (const index of [3, 2]) {
  test(`a re-sent earlier ${index === 3 ? "tool" : "reply"} updates in place without moving the settled label`, async t => {
    const s = source(); t.after(() => s.h.unmount());
    const { deriveReplyDurations } = s.h.load("client/reply-duration.ts");
    const entries = turn(0);
    s.pages.push(page(entries));
    const settled = await s.read("idle:1");
    const updated = { ...entries[index], timestamp: "2026-01-01T12:00:40.000Z", seqEnd: 28,
      sourceSeqRanges: [...entries[index].sourceSeqRanges, { startSeq: 28, endSeq: 28 }] };
    s.pages.push(page([updated]));
    const next = await s.read("idle:2");
    const full = entries.map((entry, i) => i === index ? updated : entry);
    assert.deepEqual([...next.durations], [...deriveReplyDurations(full)]);
    assert.deepEqual([...next.durations], [...settled.durations], "the final reply keeps its label and duration");
    assert.deepEqual([...next.durations.values()], [21099]);
    s.pages.push(page(turn(1)));
    const following = await s.read("idle:3");
    assert.equal(s.requests.at(-1).cursor.seq, 28, "a skipped timing row still advances the cursor");
    assert.deepEqual([...following.durations], [...deriveReplyDurations([...full, ...turn(1)])]);
  });
}

test("a re-sent reply starting at the cached cursor keeps the settled label", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const entries = turn(0);
  entries.at(-1).seqEnd = entries.at(-1).seqStart;
  entries.at(-1).sourceSeqRanges = [{ startSeq: 26, endSeq: 26 }];
  s.pages.push(page(entries));
  const settled = await s.read("idle:1");
  s.pages.push(page([{ ...entries.at(-1), timestamp: "2026-01-01T12:00:40.000Z", seqEnd: 27,
    sourceSeqRanges: [{ startSeq: 26, endSeq: 27 }] }]));
  assert.deepEqual([...(await s.read("idle:2")).durations], [...settled.durations]);
});

test("opening while running makes no read; a raced running response leaves the settled cursor intact", async t => {
  const s = source(); t.after(() => s.h.unmount());
  assert.equal((await s.read("running")).durations.size, 0);
  assert.equal(s.requests.length, 0);
  s.pages.push(page(turn(0)));
  const settled = await s.read("idle:1");
  s.pages.push(page(turn(1), 127, { agent: { status: "running", activeTurn: { turnId: "sample-active" } } }));
  assert.equal(await s.read("idle:2"), settled);
  s.pages.push(page(turn(1)));
  assert.equal((await s.read("idle:3")).durations.size, 2);
  assert.equal(s.requests.at(-1).cursor.seq, 27);
});

for (const flag of ["reset", "staleCursor", "gap"]) {
  test(`${flag}: a complete replacement read clears old timing and sender identities`, async t => {
    const s = source(); t.after(() => s.h.unmount());
    s.pages.push(page([...turn(0), ...deliveryEntries]));
    const first = await s.read("idle:1");
    assert.equal(first.messages.size, 1);
    s.pages.push(page(turn(0, 42000), 27, { [flag]: true, epoch: "sample-new-epoch", endCursor: { epoch: "sample-new-epoch", seq: 27 } }));
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
  s.pages.push(page(turn(0))); await s.read("idle:1");
  s.pages.push(page([], null, { staleCursor: true, hasOlder: true }), page(turn(1), 127, { epoch: "sample-replaced" }));
  assert.deepEqual([...(await s.read("idle:2")).durations.values()], [21099]);
  assert.deepEqual(s.requests.map(r => r.direction), ["tail", "after", "tail"]);
  assert.equal(await s.read("idle:2"), await s.read("idle:2"));
  assert.equal(s.requests.length, 3);
});

test("timing and missing sender lookups share one read and merge deliveries across revisions", async t => {
  const s = source(); t.after(() => s.h.unmount());
  const firstDelivery = deliveryEntries.find(e => e.item.agentMessage);
  s.pages.push(page([...turn(0), ...deliveryEntries]));
  const initial = await s.read("idle:1");
  assert.deepEqual(initial.messages.get(firstDelivery.item.callId).sender, firstDelivery.item.agentMessage.sender);
  const secondDelivery = structuredClone(firstDelivery);
  secondDelivery.item.callId = "paseo-agent-message:sample-next";
  secondDelivery.item.agentMessage.sender = { id: "sample-next-sender", title: "Next sender" };
  secondDelivery.seqStart = secondDelivery.seqEnd = 30;
  secondDelivery.sourceSeqRanges = [{ startSeq: 30, endSeq: 30 }];
  const updatedDelivery = structuredClone(firstDelivery);
  updatedDelivery.item.agentMessage.sender.title = "Updated sender";
  updatedDelivery.seqEnd = 31;
  updatedDelivery.sourceSeqRanges.push({ startSeq: 31, endSeq: 31 });
  s.pages.push(page([updatedDelivery, secondDelivery, ...turn(1)]));
  const [a, b] = await Promise.all([s.read("idle:2"), s.read("idle:2")]);
  assert.equal(a, b);
  assert.equal(a.messages.size, 2);
  assert.equal(a.messages.get(firstDelivery.item.callId).sender.title, "Updated sender", "re-sent deliveries still upsert by callId");
  assert.equal(a.messages.get(secondDelivery.item.callId).sender.title, "Next sender");
  assert.equal(a.durations.size, initial.durations.size + 1);
  assert.equal(s.requests.length, 2);
});

test("hosts and replacement agent IDs do not borrow a previous cursor", async t => {
  const s = source(); t.after(() => s.h.unmount());
  for (const [host, agent] of [["first", "first"], ["second", "first"], ["second", "replacement"]]) {
    s.pages.push(page(turn(0))); await s.read("idle:1", host, agent);
  }
  assert.deepEqual(s.requests.map(r => r.direction), ["tail", "tail", "tail"]);
});

test("overlapping settled revisions serialize cursor updates without losing turns", async t => {
  const s = source(); t.after(() => s.h.unmount());
  let resolveRead;
  s.pages.push(() => new Promise(resolve => { resolveRead = resolve; }), page(turn(1)));
  const first = s.read("idle:1");
  const second = s.read("idle:2");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.requests.length, 1);
  resolveRead(page(turn(0)));
  assert.equal((await first).durations.size, 1);
  assert.equal((await second).durations.size, 2);
  assert.equal(s.requests[1].direction, "after");
  assert.equal(s.requests[1].cursor.seq, 27);
});

test("a failed delta preserves settled labels and retries from the same cursor on the next revision", async t => {
  const s = source(); t.after(() => s.h.unmount());
  s.pages.push(page(turn(0)));
  const first = await s.read("idle:1");
  s.pages.push(() => { throw Error("Sample network unavailable"); });
  assert.equal(await s.read("idle:2"), first);
  assert.equal(await s.read("idle:2"), first);
  s.pages.push(page(turn(1)));
  assert.equal((await s.read("idle:3")).durations.size, 2);
  assert.deepEqual(s.requests.map(r => r.direction), ["tail", "after", "after"]);
  assert.equal(s.requests.at(-1).cursor.seq, 27);
});
