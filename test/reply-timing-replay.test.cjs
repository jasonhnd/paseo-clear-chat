const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const start = "2026-01-01T12:00:00.000Z";
const later = "2026-01-01T12:00:17.000Z";
const replay = "2026-01-01T12:01:00.100Z";

function timeline(times, ids = true) {
  const items = [
    { type: "user_message", text: "Sample prompt" },
    { type: "assistant_message", text: "Sample interim" },
    { type: "assistant_message", text: "Sample reply" },
  ];
  return items.map((item, index) => ({
    item, timestamp: times[index], seqStart: index + 1, seqEnd: index + 1,
    ...(ids ? { turnId: "sample-turn" } : {}),
  }));
}

function timing() {
  const h = createToolHarness();
  return { h, ...h.load("client/reply-timing.ts") };
}

for (const ids of [true, false]) {
  test(`timestamps determine elapsed time with turn IDs ${ids ? "present" : "absent"}`, t => {
    const { h, deriveReplyDurations, formatWorkedDuration } = timing();
    t.after(() => h.unmount());
    const original = timeline([start, start, later], ids);
    const changed = timeline([replay, replay, replay], ids);
    const first = [...deriveReplyDurations(original).values()];
    const second = [...deriveReplyDurations(changed).values()];
    assert.deepEqual(first, [17000]);
    assert.deepEqual(second, [0]);
    assert.equal(formatWorkedDuration(first[0]), "17s");
    assert.equal(formatWorkedDuration(second[0]), "0s");
    assert.deepEqual(original.map(entry => entry.item), changed.map(entry => entry.item));
  });

  test(`timestamp edge cases with turn IDs ${ids ? "present" : "absent"}`, t => {
    const { h, deriveReplyDurations } = timing();
    t.after(() => h.unmount());
    for (const [times, expected] of [
      [[undefined, start, later], []],
      [["invalid", start, later], []],
      [[start, start, undefined], []],
      [[start, start, "invalid"], []],
      [[start, undefined, later], [17000]],
      [[start, "invalid", later], [17000]],
      [[start, start, start], [0]],
      [[later, start, start], [0]],
      [[start, later, "2026-01-01T12:00:05.000Z"], [5000]],
    ]) {
      assert.deepEqual([...deriveReplyDurations(timeline(times, ids)).values()], expected, JSON.stringify(times));
    }
  });

  test(`partial pages preserve timing with turn IDs ${ids ? "present" : "absent"}`, t => {
    const { h, createReplyTiming, deriveReplyDurations } = timing();
    t.after(() => h.unmount());
    const entries = timeline([start, start, later], ids);
    const incremental = createReplyTiming();
    incremental.append(entries.slice(0, 1));
    assert.equal(incremental.snapshot().size, 0);
    incremental.append(entries.slice(1, 2));
    assert.deepEqual([...incremental.snapshot().values()], [0]);
    incremental.append(entries.slice(2));
    assert.deepEqual([...incremental.snapshot()], [...deriveReplyDurations(entries)]);
    assert.deepEqual([...incremental.snapshot().values()], [17000]);
    assert.equal(deriveReplyDurations(entries.slice(1)).size, 0);
  });
}

test("turn IDs affect boundaries independently of timestamp values", t => {
  const { h, deriveReplyDurations } = timing();
  t.after(() => h.unmount());
  const withIds = timeline([start, start, later]);
  withIds[1].item = { type: "user_message", text: "Additional sample prompt" };
  const withoutIds = withIds.map(({ turnId, ...entry }) => entry);
  assert.deepEqual([...deriveReplyDurations(withIds).values()], [17000]);
  assert.deepEqual([...deriveReplyDurations(withoutIds).values()], [17000]);
  withoutIds[1].timestamp = "2026-01-01T12:00:05.000Z";
  withIds[1].timestamp = withoutIds[1].timestamp;
  assert.deepEqual([...deriveReplyDurations(withIds).values()], [17000]);
  assert.deepEqual([...deriveReplyDurations(withoutIds).values()], [12000]);
  withIds[2].turnId = "different-turn";
  assert.equal(deriveReplyDurations(withIds).size, 0);
});

test("incomplete full history is rejected before timing is calculated", async t => {
  const entries = timeline([start, start, later]);
  const requests = [];
  const paseo = { agents: { ref: () => ({ timeline: { async refetch(options) {
    requests.push(options);
    return { entries: entries.slice(1), hasOlder: true, hasNewer: false, error: null,
      agent: { status: "idle", activeTurn: null } };
  } } }) } };
  const h = createToolHarness("web", { paseo });
  t.after(() => h.unmount());
  const { loadCanonicalTimeline } = h.load("client/canonical-timeline.ts");
  const result = await loadCanonicalTimeline(paseo, "sample-host", "sample-agent", "idle:1");
  assert.equal(result.durations.size, 0);
  assert.equal(requests.length, 1);
});
