"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const wait = () => new Promise(resolve => setImmediate(resolve));
async function scenario(mode, newer) {
  const events = createToolHarness("ios").load("client/answer-state-events.ts");
  const notices = [], warnings = [], calls = [];
  let stored, settle;
  const unsubscribe = events.subscribeAnswerMetadata(id => notices.push({ id, stored }));
  const oldSet = global.setTimeout, oldClear = global.clearTimeout, oldWarn = console.warn;
  const timers = new Map(); let next = 0;
  global.setTimeout = fn => { const id = ++next; timers.set(id, fn); return id; };
  global.clearTimeout = id => timers.delete(id);
  console.warn = (...args) => warnings.push(args);
  try {
    const first = events.publishAnswerMetadata("agent", () => { calls.push(1); return new Promise((resolve, reject) => { settle = () => { if (mode === "reject") reject(Error("late failure")); else { stored = 1; resolve(); } }; }); });
    await wait();
    const second = newer ? events.publishAnswerMetadata("agent", async () => { calls.push(2); stored = 0; }) : null;
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    await first; if (second) await second;
    const before = notices.length;
    settle(); await wait(); await wait(); await wait();
    if (newer) {
      assert.equal(stored, 0, "newest metadata must remain stored after late settlement");
      assert.deepEqual(calls, [1, 2, 2]);
      assert.ok(notices.length > before, "listener must fire after late settlement");
    } else {
      assert.deepEqual(calls, [1]);
      assert.equal(notices.length, before);
    }
    if (mode === "reject") assert.ok(warnings.length >= 2, "late rejection must be logged");
  } finally { global.setTimeout = oldSet; global.clearTimeout = oldClear; console.warn = oldWarn; unsubscribe(); }
}
test("late timed-out write is followed by latest state and notification", () => scenario("resolve", true));
test("late rejection is logged and latest state is reapplied", () => scenario("reject", true));
test("late write with no newer generation causes no extra write", () => scenario("resolve", false));
