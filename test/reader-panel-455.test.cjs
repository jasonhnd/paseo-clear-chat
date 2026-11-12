const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `# First\n\n${"body ".repeat(700)}\n\n## Second\n\n${"tail ".repeat(200)}`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props?.testID === id)[0];

function fixture(t, platform = "web") {
  const h = createToolHarness(platform, { markdown: true, preferences: { showJumpChips: true }, width: 390 });
  t.after(() => { h.unmount(); h.dispose(); });
  const transformer = h.transformers.get("assistant_message");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const draw = (text = reply, phase = "complete") => {
    const result = transformer.transform({ item: { type: "assistant_message", text }, phase });
    const item = result.items[0];
    assert.equal(item.data.phase, phase);
    return h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item, timestamp: new Date(10), theme: { colors: {} } } });
  };
  return { h, draw };
}

function webScroll() {
  const conversation = {
    scrollTop: 400, scrollLeft: 3, scrollHeight: 900, clientHeight: 200, scrollWidth: 0, clientWidth: 0, parentElement: null,
  };
  const page = {
    scrollTop: 80, scrollLeft: 1, scrollHeight: 1000, clientHeight: 100, scrollWidth: 0, clientWidth: 0,
  };
  global.document = { scrollingElement: page };
  global.requestAnimationFrame = fn => fn();
  return { conversation, page };
}

function bindReply(h, tree, conversation) {
  const root = h.nodes(tree, node => typeof node.props?.ref === "function")[0];
  assert.equal(typeof root?.props.ref, "function");
  root.props.ref({ parentElement: conversation });
}

function requireButton(h, tree, id) {
  const node = byId(h, tree, id);
  assert.ok(node, `${id} is missing`);
  assert.equal(typeof node.props.onPress, "function", id);
  return node;
}

for (const platform of ["ios", "android"]) {
  test(`${platform}: reader behaviour is NOT_RUN`, t => {
    const { h, draw } = fixture(t, platform);
    const tree = draw();
    assert.equal(byId(h, tree, "reader-open"), undefined);
    t.diagnostic("NOT_RUN: open, close, independent reader scroll, and reopen restore were not executed");
  });
}

test("web: open shows the full reply in the reader", t => {
  const { h, draw } = fixture(t);
  webScroll();
  requireButton(h, draw(), "reader-open").props.onPress();
  const tree = draw();
  const reader = byId(h, tree, "reader-scroll");
  assert.ok(reader);
  assert.ok(h.text(reader).includes("First"));
  assert.ok(h.text(reader).includes("Second"));
  assert.ok(h.text(reader).includes("body ".repeat(20).trim()));
});

test("web: close removes the reader", t => {
  const { h, draw } = fixture(t);
  webScroll();
  let tree = draw();
  bindReply(h, tree, webScroll().conversation);
  requireButton(h, tree, "reader-open").props.onPress();
  tree = draw();
  requireButton(h, tree, "reader-close").props.onPress();
  tree = draw();
  assert.equal(byId(h, tree, "reader-scroll"), undefined);
  assert.equal(byId(h, tree, "reader-close"), undefined);
});

test("web: scrolling the reader does not move the conversation", t => {
  const { h, draw } = fixture(t);
  const { conversation, page } = webScroll();
  let tree = draw();
  bindReply(h, tree, conversation);
  requireButton(h, tree, "reader-open").props.onPress();
  tree = draw();
  const reader = byId(h, tree, "reader-scroll");
  assert.ok(reader, "reader-scroll is missing");
  assert.equal(typeof reader.props.onScroll, "function");
  reader.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 240 } } });
  assert.equal(conversation.scrollTop, 400);
  assert.equal(page.scrollTop, 80);
});

test("web: closing and reopening restores the reader position", t => {
  const { h, draw } = fixture(t);
  const { conversation } = webScroll();
  let tree = draw();
  bindReply(h, tree, conversation);
  requireButton(h, tree, "reader-open").props.onPress();
  tree = draw();
  const reader = byId(h, tree, "reader-scroll");
  assert.ok(reader, "reader-scroll is missing");
  assert.equal(typeof reader.props.onScroll, "function");
  reader.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 240 } } });
  requireButton(h, tree, "reader-close").props.onPress();
  tree = draw();
  assert.equal(conversation.scrollTop, 400);
  requireButton(h, tree, "reader-open").props.onPress();
  tree = draw();
  const reopened = byId(h, tree, "reader-scroll");
  assert.ok(reopened, "reader-scroll is missing");
  assert.equal(reopened.props.contentOffset?.y, 240);
});

test("web: reopening restores actual DOM scroll when the last scroll event was not delivered", t => {
  const { h, draw } = fixture(t);
  const { conversation } = webScroll();
  let tree = draw();
  bindReply(h, tree, conversation);
  requireButton(h, tree, "reader-open").props.onPress();
  tree = draw();
  const oldScroller = { scrollTop: 0 };
  const readerRoot = h.nodes(tree, n => typeof n.props?.ref === "function")[1];
  assert.ok(readerRoot, "reader root exists");
  readerRoot.props.ref({ querySelector: selector => selector === '[data-testid="reader-scroll"]' ? oldScroller : null });
  oldScroller.scrollTop = 300;
  requireButton(h, tree, "reader-close").props.onPress();
  tree = draw();
  requireButton(h, tree, "reader-open").props.onPress();
  tree = draw();
  const newScroller = { scrollTop: 0 };
  const newRoot = h.nodes(tree, n => typeof n.props?.ref === "function")[1];
  assert.ok(newRoot, "reopened reader root exists");
  newRoot.props.ref({ querySelector: selector => selector === '[data-testid="reader-scroll"]' ? newScroller : null });
  assert.equal(newScroller.scrollTop, 300, "DOM scroll position must be restored after remount");
  assert.equal(conversation.scrollTop, 400);
});
