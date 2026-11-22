const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = "1) Pick?\nA One\nB Two\n\nReply: A";
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

test("the focus outline is inset so both side edges stay visible", t => {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface: "popover" } });
  let tree = draw();
  byId(h, tree, "option-row-B").props.onFocus();
  tree = draw();
  const focus = byId(h, tree, "option-row-B").props.style[1];
  assert.ok(focus.outlineOffset < 0, `the focus ring must be inset, outlineOffset=${focus.outlineOffset}`);
});
