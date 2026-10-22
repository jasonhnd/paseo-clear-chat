const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

for (const platform of ["web", "ios", "android"]) {
  for (const variant of ["document", "compact", "terminal"]) {
    test(`highlight runs render across Markdown blocks on ${platform} in ${variant}`, () => {
      const h = createToolHarness(platform, { markdown: true, preferences: { markdownVariant: variant } });
      const text = "# ==Heading==\n\n==**Important** and `a == b`==\n\n- ==List==\n\n> ==Quote==\n\n| Label | Value |\n| --- | --- |\n| ==Cell== | Plain |\n\n`==inline==`\n\n```text\n==fenced==\n```\n\n\\==escaped== and ==unfinished";
      const { tree } = h.mount({ type: "assistant_message", text });
      const marks = h.nodes(tree, node => node.props.testID === "markdown-highlight");
      assert.equal(marks.length, 5);
      for (const mark of marks) assert.ok(mark.props.style.backgroundColor);
      const rendered = h.text(tree);
      for (const literal of ["a == b", "==inline==", "==fenced==", "==escaped==", "==unfinished"]) assert.ok(rendered.includes(literal), literal);
    });
  }
}

test("highlight delimiters skip code, escapes, empty markers and equality operators", () => {
  const h = createToolHarness("web", { markdown: true });
  const parse = h.load("client/components/markdown/parse.ts").parseMarkdown;
  const blocks = parse("==one \\== two== ===  ====  a === b ==  ==");
  const marks = blocks[0].spans.filter(span => span.kind === "highlight");
  assert.equal(marks.length, 1);
  assert.equal(h.load("client/components/markdown/parse.ts").inlineToText(marks[0].spans), "one == two");
});
