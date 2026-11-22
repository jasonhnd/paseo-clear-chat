const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// On a desktop window the host opens a composer pill in a popover capped at 440 px.
// A two-question card is about 630 px tall, so the whole-card scroll hid Send.
// The popover card pins the progress line and Send below a scrollable question body.

const reply = `1) Which storage?
A Server
B File (recommended)

2) Ship now?
A Yes
B No

Reply with a letter for each.`;

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const inside = (h, root, id) => h.nodes(root, node => node.props.testID === id)[0];

function fixture(t) {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = (surface = "popover") => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface } });
  return { h, s, draw };
}

test("a popover card pins Send and the progress line outside the scrolling question area", t => {
  const { h, draw } = fixture(t);
  const tree = draw("popover");
  const card = byId(h, tree, "option-card");
  assert.ok(card, "precondition: the card renders");
  const scroll = byId(h, tree, "option-question-scroll");
  assert.ok(scroll, "the popover card must keep the question body in its own scroll area");
  assert.equal(scroll.type, "ScrollView", "the question body scrolls in a ScrollView");
  assert.ok(inside(h, scroll, "option-question-content"), "the question body must be inside the scroll area");
  assert.equal(inside(h, scroll, "option-send"), undefined, "Send must stay outside the scrolling question area");
  assert.equal(inside(h, scroll, "option-progress"), undefined, "the progress line must stay outside the scrolling question area");
  const footer = byId(h, tree, "option-footer");
  assert.ok(footer, "the popover card needs a pinned footer");
  assert.ok(inside(h, footer, "option-send"), "Send must sit in the pinned footer");
  assert.ok(inside(h, footer, "option-progress"), "the progress line must sit in the pinned footer");
  assert.ok(card.props.style.maxHeight <= 440, "the card must fit inside the host popover, which is capped at 440 px");
});

test("a timeline card keeps its single-column layout", t => {
  const { h, draw } = fixture(t);
  const tree = draw("timeline");
  assert.equal(byId(h, tree, "option-question-scroll"), undefined, "the timeline card keeps no inner scroll area");
  assert.equal(byId(h, tree, "option-footer"), undefined, "the timeline card keeps no pinned footer");
  assert.ok(byId(h, tree, "option-progress"), "the timeline card still shows the progress line");
  assert.ok(byId(h, tree, "option-send"), "the timeline card still shows Send");
});

test("the scroll cue appears only while the question body overflows", t => {
  const { h, draw } = fixture(t);
  let tree = draw("popover");
  const scroll = byId(h, tree, "option-question-scroll");
  assert.ok(scroll, "precondition: the scroll area exists");
  assert.equal(byId(h, tree, "option-scroll-fade-bottom"), undefined, "no cue before the body is measured");
  scroll.props.onLayout({ nativeEvent: { layout: { width: 360, height: 240 } } });
  scroll.props.onContentSizeChange(360, 600);
  tree = draw("popover");
  const cue = byId(h, tree, "option-scroll-fade-bottom");
  assert.ok(cue, "a cue must show that the question body continues below");
  assert.equal(cue.props.pointerEvents, "none", "the cue must not take clicks from the options");
});
