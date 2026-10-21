const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("upstream #3: image nodes retain alt text and HTTP(S), relative and data sources", () => {
  const { parseMarkdown, inlineToText } = createToolHarness().load("client/components/markdown/parse.ts");
  for (const src of ["http://example.org/chart.png", "https://example.org/chart.png", "./chart.png", "data:image/png;base64,aGVsbG8="]) {
    const [block] = parseMarkdown(`Before ![Chart](${src}) after`);
    assert.deepEqual(block.spans, [
      { kind: "text", text: "Before " },
      { kind: "image", alt: "Chart", src },
      { kind: "text", text: " after" },
    ]);
    assert.equal(inlineToText(block.spans), "Before Chart after");
  }
});

test("upstream #3: image escapes, empty alt and titles parse without changing links or code", () => {
  const { parseMarkdown } = createToolHarness().load("client/components/markdown/parse.ts");
  assert.deepEqual(parseMarkdown(String.raw`![A\] *chart*](https://example.org/a\(b\).png "Chart title")`)[0].spans,
    [{ kind: "image", alt: "A] *chart*", src: "https://example.org/a(b).png" }]);
  assert.deepEqual(parseMarkdown("![](<https://example.org/chart.png>)")[0].spans,
    [{ kind: "image", alt: "", src: "https://example.org/chart.png" }]);
  assert.deepEqual(parseMarkdown("[Guide](https://example.org/guide)")[0].spans,
    [{ kind: "link", href: "https://example.org/guide", spans: [{ kind: "text", text: "Guide" }] }]);
  assert.deepEqual(parseMarkdown("`![Chart](chart.png)`")[0].spans,
    [{ kind: "codeSpan", text: "![Chart](chart.png)" }]);
  for (const source of ["![Chart](chart.png", "![Chart", "!"]) {
    assert.equal(parseMarkdown(source)[0].spans.map(span => span.text).join(""), source);
  }
});
