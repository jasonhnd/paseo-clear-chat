"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const frames = require("./fixtures/late-idle/frames.json");
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
