const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The popover is a sheet on compact layouts, where there is no hardware keyboard to hint at.
// The host hands the pill content `layout.compact`; the card must pass that through.
const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function pill(t, compact) {
  const h = createToolHarness("web", { locale: "en" });
  const session = h.load("client/option-session.ts");
  session.publishAssistantReply("a", { at: 10, text: questions });
  const Content = h.load("client/components/answer-pill-content.tsx").AnswerPillContent;
  const props = { context: "agent", agentId: "a", workspaceId: "w1", theme: { colors: {} }, close: () => {}, layout: { compact, platform: "web" }, host: { id: "h", label: "host" } };
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, draw: () => h.draw({ type: Content, props }) };
}

test("the compact sheet hides the keyboard hint and keeps the slot", async t => {
  const f = pill(t, true);
  const tree = f.draw();
  assert.equal(f.h.nodes(tree, node => node.props.testID === "option-card").length, 1, "the sheet still draws the card");
  assert.equal(byId(f.h, tree, "option-hint"), undefined, "a touch sheet shows no keyboard hint");
  assert.equal(f.h.nodes(tree, node => node.props.testID === "option-hint-slot").length, 1, "the footer keeps the slot so the send control does not move");
});

test("the wide popover keeps the keyboard hint", async t => {
  const f = pill(t, false);
  const hint = byId(f.h, f.draw(), "option-hint");
  assert.ok(hint, "a wide popover still shows the keyboard hint");
  assert.equal(f.h.text(hint), "↑↓ move · ↵ choose");
});
