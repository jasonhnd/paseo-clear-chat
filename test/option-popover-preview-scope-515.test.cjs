const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const content = "A written answer that is long enough to need shortening in the preview but must read in full on a narrow sheet.";

test("only the pinned popover caps the written-answer preview at two lines", t => {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: "Pick?\nA One\nB Two\n\nReply: A" });
  s.openCustom("a", 0);
  s.setCustomDraft("a", 0, content);
  assert.equal(s.confirmCustom("a", 0), "confirmed");
  const draw = surface => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface } });
  const previewOf = tree => h.nodes(tree, node => node.props.testID === "option-send-preview")[0];
  const popover = previewOf(draw("popover"));
  const timeline = previewOf(draw("timeline"));
  assert.equal(popover.props.numberOfLines, 2, "the popover caps the preview");
  assert.equal(timeline.props.numberOfLines, undefined, "the timeline keeps the full preview");
});
