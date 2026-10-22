const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

const compiled = ts.transpileModule(readFileSync(resolve(__dirname, "../client/step-detail-back.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function load(platform, window) {
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, window, require: () => ({ Platform: { OS: platform } }) });
  return module.exports.installStepDetailBack;
}
function browser() {
  const entries = [{ hostRoute: "chat", selectedAgent: "demo-agent" }];
  const listeners = new Set(), pending = [];
  let index = 0, backs = 0;
  return {
    get backs() { return backs; },
    history: {
      get state() { return entries[index]; },
      pushState(state) { entries.splice(++index); entries[index] = state; },
      back() {
        backs++;
        const next = index - 1;
        pending.push(() => { index = next; for (const listener of [...listeners]) listener(); });
      },
    },
    addEventListener(type, listener) { assert.equal(type, "popstate"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "popstate"); listeners.delete(listener); },
    flush() { while (pending.length) pending.shift()(); },
  };
}

test("browser Back dismisses details once and leaves the host route intact", () => {
  const window = browser();
  const install = load("web", window);
  let closed = 0;
  const remove = install(() => closed++);
  assert.equal(window.history.state.hostRoute, "chat");
  assert.equal(window.history.state.selectedAgent, "demo-agent");
  window.history.back(); window.flush();
  assert.equal(closed, 1);
  remove();
  assert.equal(window.backs, 1);
  assert.equal(window.history.state.clearChatStepDetail, undefined);
});

test("closing with a button removes the extra history entry without dismissing again", () => {
  const window = browser();
  const install = load("web", window);
  let closed = 0;
  const remove = install(() => closed++);
  remove(); window.flush();
  assert.equal(closed, 0);
  assert.equal(window.backs, 1);
  assert.deepEqual(window.history.state, { hostRoute: "chat", selectedAgent: "demo-agent" });
});

test("quickly reopening before the old history traversal completes keeps the new detail open", async () => {
  const window = browser();
  const install = load("web", window);
  const removeFirst = install(() => assert.fail("The old detail was already closed"));
  removeFirst();
  let closed = 0;
  const removeNext = install(() => closed++);
  window.flush();
  await new Promise(setImmediate);
  assert.equal(closed, 0);
  assert.ok(window.history.state.clearChatStepDetail);
  window.history.back(); window.flush();
  assert.equal(closed, 1);
  removeNext();
  assert.equal(window.backs, 2);
});

test("native modals and restricted browser history do not mutate navigation", () => {
  for (const platform of ["ios", "android"]) {
    const window = browser();
    load(platform, window)(() => assert.fail("Native Back is owned by Modal"))();
    assert.equal(window.backs, 0);
    assert.equal(window.history.state.clearChatStepDetail, undefined);
  }
  const window = browser();
  window.history.pushState = () => { throw new Error("History unavailable"); };
  load("web", window)(() => assert.fail("No entry was installed"))();
  assert.equal(window.backs, 0);
});
