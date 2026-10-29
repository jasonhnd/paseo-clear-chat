const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const start = "2026-01-01T00:00:00.000Z";
const at = ms => new Date(Date.parse(start) + ms).toISOString();
function timeline(withIds = true) {
  return [
    { item: { type: "user_message", text: "Synthetic prompt" }, timestamp: at(0), seqStart: 1, seqEnd: 1 },
    { item: { type: "assistant_message", text: "Synthetic interim" }, timestamp: at(5000), seqStart: 2, seqEnd: 2 },
    { item: { type: "assistant_message", text: "Synthetic final" }, timestamp: at(17000), seqStart: 3, seqEnd: 3 },
  ].map(entry => ({ ...entry, ...(withIds ? { turnId: "synthetic-turn" } : {}) }));
}
function timing(t) {
  const h = createToolHarness();
  t.after(() => h.unmount());
  const api = h.load("client/reply-timing.ts");
  const values = input => [...api.deriveReplyDurations(input).values()];
  return { ...api, values };
}

for (const withIds of [true, false]) {
  test(`synthetic replay changes timing independently of ${withIds ? "present" : "absent"} turn IDs`, t => {
    const { values, formatWorkedDuration } = timing(t);
    const original = timeline(withIds);
    const shifted = structuredClone(original);
    shifted.forEach(entry => { entry.timestamp = at(Date.parse(entry.timestamp) - Date.parse(start) + 60000); });
    const replay = structuredClone(original);
    replay.forEach(entry => { entry.timestamp = at(60000); });
    assert.deepEqual(original.map(entry => entry.item), replay.map(entry => entry.item));
    assert.deepEqual(values(original), [17000]);
    assert.deepEqual(values(shifted), [17000], "a uniform timestamp shift preserves elapsed time");
    assert.deepEqual(values(replay), [0], "equal endpoints are indistinguishable from a zero-length turn");
    assert.deepEqual([values(original), values(replay)].map(([ms]) => formatWorkedDuration(ms)), ["17s", "0s"]);
  });
}

test("turn ID changes alone affect boundaries only when both adjacent IDs are present", t => {
  const { values } = timing(t);
  const original = timeline();
  const missing = original.map(({ turnId, ...entry }) => entry);
  assert.deepEqual(values(original), values(missing));
  const split = structuredClone(original);
  split[2].turnId = "synthetic-other-turn";
  assert.deepEqual(values(split), [], "a new identified turn without a prompt cannot borrow timing");
  delete split[2].turnId;
  assert.deepEqual(values(split), [17000], "missing ID falls back to the user-message boundary");
});

for (const withIds of [true, false]) {
  test(`missing, invalid, equal and out-of-order timestamps with ${withIds ? "present" : "absent"} turn IDs`, t => {
    const { values } = timing(t);
    for (const position of [0, 2]) {
      for (const timestamp of [undefined, "invalid"]) {
        const entries = timeline(withIds);
        if (timestamp === undefined) delete entries[position].timestamp;
        else entries[position].timestamp = timestamp;
        assert.deepEqual(values(entries), [], `invalid endpoint ${position} must not supply a duration`);
      }
    }
    const equal = timeline(withIds);
    equal[2].timestamp = equal[0].timestamp;
    assert.deepEqual(values(equal), [0]);
    const reversed = timeline(withIds);
    reversed[2].timestamp = at(-1000);
    assert.deepEqual(values(reversed), [0], "the established endpoint clamp is retained");
    const unordered = timeline(withIds);
    unordered[1].timestamp = at(30000);
    const before = JSON.stringify(unordered);
    assert.deepEqual(values(unordered), [17000], "the final event, not the maximum timestamp, closes the turn");
    assert.equal(JSON.stringify(unordered), before);
    unordered[1].timestamp = "invalid";
    assert.deepEqual(values(unordered), [17000], "intermediate timestamps are not endpoints");
  });
}

test("incremental pages preserve endpoints and an incomplete tail is rejected", async t => {
  const h = createToolHarness();
  t.after(() => h.unmount());
  const { createReplyTiming, deriveReplyDurations } = h.load("client/reply-timing.ts");
  for (const withIds of [true, false]) {
    for (const equal of [false, true]) {
      const entries = timeline(withIds);
      if (equal) entries.forEach(entry => { entry.timestamp = at(60000); });
      for (const cut of [1, 2]) {
        const state = createReplyTiming();
        state.append(entries.slice(0, cut));
        state.append(entries.slice(cut));
        assert.deepEqual([...state.snapshot()], [...deriveReplyDurations(entries)]);
      }
    }
  }
  const entries = timeline();
  const pages = [
    { entries: entries.slice(1), hasOlder: true, hasNewer: false, error: null },
    { entries, hasOlder: false, hasNewer: false, error: null },
  ];
  const requests = [];
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async options => {
    requests.push(options); return pages.shift();
  } } }) } };
  const load = h.load("client/canonical-timeline.ts").loadCanonicalTimeline;
  assert.equal((await load(paseo, "host", "agent", "idle:1")).durations.size, 0);
  assert.deepEqual([...(await load(paseo, "host", "agent", "idle:2")).durations.values()], [17000]);
  assert.deepEqual(requests.map(request => request.direction), ["tail", "tail"]);
});
