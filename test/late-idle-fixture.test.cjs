"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const frames = require("./fixtures/late-idle/frames.json");
const { deliverLateIdle } = require("./fixtures/late-idle/deliver.cjs");
const { AgentUpdateMessageSchema } = require("@getpaseo/protocol/messages");

const snapshot = frame => frame.payload.agent;

test("synthetic state frames match the protocol without losing fields", () => {
  assert.deepEqual(Object.keys(frames), ["running", "olderIdle", "newerIdle"]);
  for (const frame of Object.values(frames)) {
    const result = AgentUpdateMessageSchema.safeParse(frame);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data, frame, "validation must preserve the complete frame");
    assert.deepEqual(JSON.parse(JSON.stringify(frame)), frame);
    assert.equal(frame.type, "agent_update");
    assert.equal(frame.payload.kind, "upsert");
    assert.equal(snapshot(frame).provider, "synthetic");
    assert.equal(snapshot(frame).model, null);
    assert.equal(snapshot(frame).persistence, null);
  }
});

test("late older idle follows a newer running frame for the same agent", () => {
  const { running, olderIdle } = frames;
  assert.equal(snapshot(running).id, snapshot(olderIdle).id);
  assert.equal(running.payload.generation, olderIdle.payload.generation);
  assert.deepEqual([running.payload.seq, olderIdle.payload.seq], [2, 1]);
  assert.ok(Date.parse(snapshot(running).updatedAt) > Date.parse(snapshot(olderIdle).updatedAt));
  assert.equal(snapshot(running).status, "running");
  assert.equal(snapshot(running).activeTurn.turnId, "synthetic-turn");
  assert.equal(snapshot(olderIdle).status, "idle");
  assert.equal(snapshot(olderIdle).activeTurn, null);
});

test("newer idle is a distinct control after the running frame", () => {
  const { running, newerIdle } = frames;
  assert.equal(snapshot(running).id, snapshot(newerIdle).id);
  assert.equal(running.payload.generation, newerIdle.payload.generation);
  assert.deepEqual([running.payload.seq, newerIdle.payload.seq], [2, 3]);
  assert.ok(Date.parse(snapshot(newerIdle).updatedAt) > Date.parse(snapshot(running).updatedAt));
  assert.equal(snapshot(newerIdle).status, "idle");
  assert.equal(snapshot(newerIdle).activeTurn, null);
});

// This model stands in for a host consumer; the plugin does not own the card.
function consumer() {
  let latest;
  return {
    async deliver(frame) {
      if (!latest || frame.payload.seq > latest.payload.seq) latest = frame;
    },
    readCard() { return latest?.payload.agent; },
  };
}

test("a gated late idle delivery leaves the running card intact", { timeout: 10000 }, async () => {
  const host = consumer();
  let releaseObservation;
  const observationGate = new Promise(resolve => { releaseObservation = resolve; });
  let observedRunning;
  const runningObserved = new Promise(resolve => { observedRunning = resolve; });
  const deliveries = [];
  const replay = deliverLateIdle({
    async deliver(frame) { deliveries.push(frame.payload.seq); await host.deliver(frame); },
    async observeRunning() {
      assert.deepEqual(host.readCard(), snapshot(frames.running));
      observedRunning();
      await observationGate;
    },
  });
  let deadline;
  try {
    await Promise.race([
      runningObserved,
      replay,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("late-idle state was not reached")), 5000);
      }),
    ]);
    assert.deepEqual(deliveries, [2], "the stale frame waits for the observation gate");
  } finally {
    clearTimeout(deadline);
    releaseObservation();
  }
  await replay;
  assert.deepEqual(deliveries, [2, 1]);
  assert.deepEqual(host.readCard(), snapshot(frames.running), "the running card survives the stale idle update");
});

test("the consumer accepts a newer idle update", async () => {
  const host = consumer();
  await host.deliver(structuredClone(frames.running));
  assert.deepEqual(host.readCard(), snapshot(frames.running));
  await host.deliver(structuredClone(frames.newerIdle));
  assert.deepEqual(host.readCard(), snapshot(frames.newerIdle));
});
