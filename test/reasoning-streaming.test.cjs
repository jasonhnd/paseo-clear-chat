const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("reasoning keeps its paragraph cards and delegates active text pacing to StreamedText", () => {
  const calls = [];
  const h = createToolHarness("web", { reasoningTrace: true, onStreamedText: props => calls.push(props) });
  const Component = h.load("client/live-renderers.tsx").LiveReasoningRenderer;
  const text = "Check the inputs.\n\nCompare the results.";
  const render = phase => h.draw({ type: Component, props: {
    item: { data: { text, phase } }, theme: { colors: {} },
  } });
  const streaming = render("streaming");
  assert.deepEqual(calls.map(({ text, phase }) => [text, phase]), [
    ["Check the inputs.", "complete"], ["Compare the results.", "streaming"],
  ]);
  assert.ok(calls.every(props => props.selectable && props.style));
  assert.match(h.text(streaming), /Step 1/);
  assert.match(h.text(streaming), /Step 2/);
  assert.match(h.text(streaming), /Thinking in progress/);
  calls.length = 0;
  const complete = render("complete");
  assert.ok(calls.every(props => props.phase === "complete"));
  assert.match(h.text(complete), /Reasoning summary/);
  assert.ok(h.text(complete).includes("Compare the results."));
  h.unmount();
});
