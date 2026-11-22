const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The 408 px popover budget leaves too little for the question body when the saved replies,
// the progress line, the keyboard hint, and Send all sit outside the scroll area: only option A
// fit. These tests pin the layout that gives the question body its height back.

const reply = `1) Which rollout should we use?
A Blue-green
B Canary
C Rolling
D Recreate

2) Which database should we choose?
A Postgres
B SQLite
C MySQL
D DuckDB

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

test("the popover keeps the saved replies inside the scrolling question body", t => {
  const { h, draw } = fixture(t);
  const tree = draw("popover");
  const scroll = byId(h, tree, "option-question-scroll");
  assert.ok(scroll, "precondition: the question body scrolls");
  const saved = byId(h, tree, "saved-replies-row");
  assert.ok(saved, "precondition: the saved replies render");
  assert.equal(inside(h, scroll, "saved-replies-row"), saved, "saved replies must scroll with the options, not take a fixed row");
});

test("the popover footer is one row with the progress line and Send, and no keyboard hint", t => {
  const { h, draw } = fixture(t);
  const tree = draw("popover");
  const footer = byId(h, tree, "option-footer");
  assert.ok(footer, "precondition: the popover has a pinned footer");
  const row = inside(h, footer, "option-footer-row");
  assert.ok(row, "the footer must be one row");
  assert.ok(inside(h, row, "option-progress"), "the progress line sits in the footer row");
  assert.ok(inside(h, row, "option-send"), "Send sits in the footer row");
  assert.equal(byId(h, tree, "option-hint"), undefined, "the desktop popover must not show the keyboard hint");
  assert.equal(byId(h, tree, "option-hint-slot"), undefined, "the desktop popover must not reserve a hint row");
});

test("the popover scroll cue is a short, faint shadow", t => {
  const { h, draw } = fixture(t);
  let tree = draw("popover");
  const scroll = byId(h, tree, "option-question-scroll");
  scroll.props.onLayout({ nativeEvent: { layout: { width: 360, height: 200 } } });
  scroll.props.onContentSizeChange(360, 600);
  tree = draw("popover");
  const cue = byId(h, tree, "option-scroll-fade-bottom");
  assert.ok(cue, "the cue appears when the body overflows");
  assert.equal(cue.props.style.height, 12, "the cue stays short so it cannot look like a grey band");
  assert.match(String(cue.props.style.backgroundImage), /^linear-gradient\(/, "the cue is a gradient, not a solid strip");
});

test("the timeline keeps the saved replies and the hint outside its card body", t => {
  const { h, draw } = fixture(t);
  const tree = draw("timeline");
  const card = byId(h, tree, "option-card");
  assert.ok(byId(h, tree, "saved-replies-row"), "the timeline still shows the saved replies");
  assert.equal(inside(h, card, "option-question-scroll"), undefined, "no inner scroll on the timeline");
  assert.ok(byId(h, tree, "option-hint"), "the timeline keeps the keyboard hint");
});
