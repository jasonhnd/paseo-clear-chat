const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("a long written answer is capped in the pinned footer", t => {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: "Pick?\nA One\nB Two\n\nReply: A" });
  s.openCustom("a", 0);
  s.setCustomDraft("a", 0, "x".repeat(320));
  assert.equal(s.confirmCustom("a", 0), "confirmed", "precondition: the written answer is confirmed");
  const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface: "popover" } });
  const byId = (id) => h.nodes(tree, node => node.props.testID === id)[0];
  const preview = byId("option-send-preview");
  assert.ok(preview, "the written answer is previewed");
  assert.equal(preview.props.numberOfLines, 2, "the preview may take at most two lines");
  assert.ok(byId("option-send"), "Send stays in the footer");
});
