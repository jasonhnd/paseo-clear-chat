const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("the popover card cap shrinks with a short window", t => {
  const h = createToolHarness("web", { width: 1280, height: 900 });
  t.after(() => { h.unmount(); h.dispose(); });
  const module = h.load("client/components/option-card.tsx");
  const cap = module.popoverCardMaxHeight;
  assert.equal(typeof cap, "function", "the card cap must be a pure function of the window height");
  assert.equal(cap(900), 408, "a tall window keeps the host popover cap");
  assert.equal(cap(440), 392, "the host clamps to screenHeight-16, then the card loses 32");
  assert.equal(cap(400), 352, "a shorter window shrinks the card further");
  assert.equal(cap(100), 52, "below 117 px the footer cannot fit, but the cap still shrinks");
  assert.equal(cap(10), 0, "a tiny window leaves no card height");
  assert.equal(cap(0), 0, "zero height leaves no card height");
  assert.equal(cap(Number.NaN), 408, "a non-finite height falls back to the normal cap");
});
