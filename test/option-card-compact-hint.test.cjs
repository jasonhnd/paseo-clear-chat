const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The popover is a sheet on compact layouts, where there is no hardware keyboard to hint at.
// On the wide popover the hint and its slot would take a row from the question body, so the
// desktop card drops both; the sheet keeps the empty slot so Send does not move.
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

test("the wide popover hides the keyboard hint to give the question body its height", async t => {
  const f = pill(t, false);
  const tree = f.draw();
  assert.equal(byId(f.h, tree, "option-hint"), undefined, "a wide popover no longer shows the keyboard hint");
  assert.equal(byId(f.h, tree, "option-hint-slot"), undefined, "a wide popover no longer reserves a hint row");
  assert.ok(byId(f.h, tree, "option-progress"), "the footer still shows the progress line");
  assert.ok(byId(f.h, tree, "option-send"), "the footer still shows Send");
});
