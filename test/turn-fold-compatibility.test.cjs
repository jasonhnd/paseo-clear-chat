const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const nodesWithId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id);

test("completed reasoning is readable when its row mounts and its disclosure remains operable", () => {
  const h = createToolHarness("web", { reasoningTrace: true });
  const { tree, render, replaceRow } = h.mount({ type: "reasoning", text: "First thought.\n\nSecond thought." }, false);
  const header = tree => h.nodes(tree, node => node.props.accessibilityRole === "button" &&
    node.props.accessibilityLabel === "Reasoning summary")[0];
  assert.equal(header(tree).props.accessibilityState.expanded, true);
  assert.match(h.text(tree), /First thought\.[\s\S]*Second thought\./);
  header(tree).props.onPress();
  const closed = render();
  assert.equal(header(closed).props.accessibilityState.expanded, false);
  assert.doesNotMatch(h.text(closed), /First thought\./);
  header(closed).props.onPress();
  assert.match(h.text(render()), /First thought\.[\s\S]*Second thought\./);
  assert.match(h.text(replaceRow()), /First thought\.[\s\S]*Second thought\./);
  h.unmount();
});

test("reasoning keeps a reader's choice through streaming and completion", () => {
  const h = createToolHarness("web", { reasoningTrace: true });
  const Component = h.load("client/live-renderers.tsx").LiveReasoningRenderer;
  const render = phase => h.draw({ type: Component, props: { item: { data: { text: "Live thought", phase } }, theme: { colors: {} } } });
  const disclosure = tree => h.nodes(tree, node => node.props.accessibilityRole === "button" &&
    typeof node.props.accessibilityState?.expanded === "boolean")[0];
  const live = render("streaming");
  assert.equal(disclosure(live).props.accessibilityState.expanded, true);
  disclosure(live).props.onPress();
  const complete = render("complete");
  assert.equal(disclosure(complete).props.accessibilityState.expanded, false);
  disclosure(complete).props.onPress();
  assert.match(h.text(render("complete")), /Live thought/);
  h.unmount();
});

test("each source call remains a separate rendered item, including repeated content", () => {
  const h = createToolHarness("web");
  const transform = h.transformers.get("tool_call").transform;
  const call = callId => ({ type: "tool_call", callId, name: "shell", status: "completed",
    detail: { type: "shell", command: "printf sample", output: "sample" }, error: null });
  const first = transform({ item: call("one"), phase: "complete" });
  const second = transform({ item: call("two"), phase: "complete" });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(first.items[0].data.callId, "one");
  assert.equal(second.items[0].data.callId, "two");
  for (const id of ["one", "two"]) {
    const { tree } = h.mount(call(id), true);
    assert.equal(nodesWithId(h, tree, "tool-summary-row").length, 1);
    assert.match(h.text(tree), /sample/);
  }
  h.unmount();
});
