const { test } = require("node:test");
const assert = require("node:assert/strict");
const { observeAgentTime, forgetAgentTime, getObservedAgentTimes } = require("../client/observed-agent-times.ts");

const idle = { status: "idle", attentionReason: "finished" };
const running = { status: "running" };
const at = value => Date.parse(value);
const times = (state, key = "agent") => getObservedAgentTimes(state, key);
const observe = (state, status, time, key = "agent") => observeAgentTime(state, key, status, at(time));

test("records observed transitions on the same day and across midnight, including later rounds", () => {
  let state = observe(new Map(), idle, "2026-11-12T13:00:00Z");
  state = observe(state, running, "2026-11-12T13:01:00Z");
  state = observe(state, running, "2026-11-12T13:02:00Z");
  state = observe(state, idle, "2026-11-12T13:03:00Z");
  assert.deepEqual(times(state), { startedAt: at("2026-11-12T13:01:00Z"), finishedAt: at("2026-11-12T13:03:00Z") });
  state = observe(state, running, "2026-11-12T14:59:00Z");
  assert.deepEqual(times(state), { startedAt: at("2026-11-12T14:59:00Z"), finishedAt: undefined });
  state = observe(state, idle, "2026-11-12T15:01:00Z");
  assert.deepEqual(times(state), { startedAt: at("2026-11-12T14:59:00Z"), finishedAt: at("2026-11-12T15:01:00Z") });
});

test("initial snapshots and subscription gaps do not invent transitions", () => {
  let state = observe(new Map(), idle, "2026-11-12T13:00:00Z");
  assert.deepEqual(times(state), { startedAt: undefined, finishedAt: undefined });
  state = observe(state, running, "2026-11-12T13:01:00Z");
  state = forgetAgentTime(state, "agent");
  state = observe(state, idle, "2026-11-12T13:03:00Z");
  assert.deepEqual(times(state), { startedAt: undefined, finishedAt: undefined });

  state = observe(new Map(), running, "2026-11-12T13:04:00Z");
  assert.deepEqual(times(state), { startedAt: undefined, finishedAt: undefined });
  state = observe(state, idle, "2026-11-12T13:05:00Z");
  assert.deepEqual(times(state), { startedAt: undefined, finishedAt: at("2026-11-12T13:05:00Z") });

  state = observe(new Map(), running, "2026-11-12T13:06:00Z");
  state = observe(state, { status: "idle", attentionReason: null }, "2026-11-12T13:07:00Z");
  state = observe(state, idle, "2026-11-12T13:08:00Z");
  assert.deepEqual(times(state), { startedAt: undefined, finishedAt: undefined });
});

test("preserves absolute instants across timezones and daylight saving changes", () => {
  const oldTz = process.env.TZ;
  try {
    for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = zone;
      let state = observe(new Map(), idle, "2026-03-08T09:58:00Z");
      state = observe(state, running, "2026-03-08T09:59:00Z");
      state = observe(state, idle, "2026-03-08T10:01:00Z");
      assert.deepEqual(times(state), { startedAt: at("2026-03-08T09:59:00Z"), finishedAt: at("2026-03-08T10:01:00Z") });
    }
  } finally {
    if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
  }
});

test("isolates agents and does not mutate the input state", () => {
  let state = observe(new Map(), idle, "2026-11-12T13:00:00Z", "a");
  state = observe(state, idle, "2026-11-12T13:00:00Z", "b");
  const before = state;
  state = observe(state, running, "2026-11-12T13:01:00Z", "a");
  state = observe(state, running, "2026-11-12T13:02:00Z", "b");
  state = observe(state, idle, "2026-11-12T13:03:00Z", "a");
  assert.deepEqual(times(before, "a"), { startedAt: undefined, finishedAt: undefined });
  assert.deepEqual(times(state, "a"), { startedAt: at("2026-11-12T13:01:00Z"), finishedAt: at("2026-11-12T13:03:00Z") });
  assert.deepEqual(times(state, "b"), { startedAt: at("2026-11-12T13:02:00Z"), finishedAt: undefined });
  const forgotten = forgetAgentTime(state, "a");
  assert.equal(times(forgotten, "a"), undefined);
  assert.deepEqual(times(forgotten, "b"), times(state, "b"));
});

test("error and closed are never recorded as finished, nor is a later idle snapshot", () => {
  for (const status of ["error", "closed"]) {
    let state = observe(new Map(), idle, "2026-11-12T13:00:00Z");
    state = observe(state, running, "2026-11-12T13:01:00Z");
    state = observe(state, { status, attentionReason: "finished" }, "2026-11-12T13:02:00Z");
    state = observe(state, idle, "2026-11-12T13:03:00Z");
    assert.deepEqual(times(state), { startedAt: at("2026-11-12T13:01:00Z"), finishedAt: undefined });
  }
});
