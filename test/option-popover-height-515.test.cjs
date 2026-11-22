const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("the popover card cap shrinks with a short window", t => {
  const h = createToolHarness("web", { width: 1280, height: 900 });
  t.after(() => { h.unmount(); h.dispose(); });
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  assert.equal(typeof Card.popoverCardMaxHeight, "function", "the card cap must be a pure function of the window height");
  assert.equal(Card.popoverCardMaxHeight(900), 408, "a tall window keeps the host popover cap");
  assert.equal(Card.popoverCardMaxHeight(440), 392, "the host clamps to screenHeight-16, then the card loses 32");
  assert.equal(Card.popoverCardMaxHeight(400), 352, "a shorter window shrinks the card further");
});
