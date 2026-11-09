const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const fence = (language, code) => `\`\`\`${language}\n${code}\n\`\`\``;
const official = props => ({ type: "OfficialMarkdown", props });

function harness(t, options = {}) {
  const h = createToolHarness("web", { markdown: true, ui: { Markdown: official }, ...options });
  t.after(() => { h.unmount(); h.dispose(); });
  return h;
}

test("fencedSource preserves language and code while choosing a safe fence", t => {
  const h = harness(t);
  const { fencedSource } = h.load("client/components/markdown/official-block.tsx");
  for (const [code, language, expected] of [
    ["const x = 1;", "ts", "```ts\nconst x = 1;\n```"],
    ["a ``` b", "js", "````js\na ``` b\n````"],
    ["````", "js", "`````js\n````\n`````"],
    ["text", "", "```\ntext\n```"],
    ["x", "TypeScript", "```TypeScript\nx\n```"],
    ["x\n", "ts", "```ts\nx\n\n```"],
    ["x\n\n\n", "ts", "```ts\nx\n\n\n\n```"],
    ["x\r\n\r\n", "ts", "```ts\nx\r\n\r\n\n```"],
    ["a ~~~ b\n~~~~", "js`extra", "~~~~~js`extra\na ~~~ b\n~~~~\n~~~~~"],
    ["``` and ~~~", "js`extra", "~~~~js`extra\n``` and ~~~\n~~~~"],
    ["first\nsecond", "ts", "```ts\nfirst\nsecond\n```"],
    ["", "", "```\n\n```"],
  ]) assert.equal(fencedSource(code, language), expected);
});

test("fencedSource produces a CommonMark fence with the specified info and body", t => {
  const MarkdownIt = require("markdown-it");
  const markdown = new MarkdownIt("commonmark");
  const h = harness(t);
  const { fencedSource } = h.load("client/components/markdown/official-block.tsx");
  for (const [code, language, expectedBody] of [
    ["x", "ts", "x\n"],
    ["x\n", "ts", "x\n\n"],
    ["x\n\n", "ts", "x\n\n\n"],
    ["x\r\n\r\n", "ts", "x\n\n\n"],
    ["```\n~~~~", "js`extra", "```\n~~~~\n"],
    ["code", "~js`extra", "code\n"],
    ["", "", "\n"],
  ]) {
    const tokens = markdown.parse(fencedSource(code, language), {});
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, "fence");
    assert.equal(tokens[0].info.trim(), language);
    assert.equal(tokens[0].content, expectedBody);
  }
});

test("a backtick in the language remains valid fence info", t => {
  const markdown = new (require("markdown-it"))("commonmark");
  const h = harness(t);
  const { fencedSource } = h.load("client/components/markdown/official-block.tsx");
  const tokens = markdown.parse(fencedSource("code", "js`extra"), {});
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "fence");
  assert.equal(tokens[0].info, "js`extra");
  assert.equal(tokens[0].content, "code\n");
});

for (const [name, Markdown, expected] of [
  ["available", official, "official"],
  ["missing", undefined, "fallback"],
  ["throws", () => { throw new Error("host render failed"); }, "fallback"],
]) {
  test(`OfficialMarkdownBlock uses ${expected} when the host component is ${name}`, t => {
    const h = harness(t, { ui: { Markdown } });
    const { OfficialMarkdownBlock } = h.load("client/components/markdown/official-block.tsx");
    const source = fence("ts", "const x = 1;");
    const tree = h.draw({ type: OfficialMarkdownBlock, props: { text: source, language: "ts", tokens: h.tokens, fallback: { type: "Fallback", props: {} } } });
    if (expected === "official") {
      assert.equal(tree[0].props.testID, "official-code-language");
      assert.equal(h.text(tree[0]), "ts");
      assert.equal(tree[1].type, "OfficialMarkdown");
      assert.deepEqual(tree[1].props, { children: source });
    } else {
      assert.equal(tree.type, "Fallback");
      assert.equal(h.nodes(tree, node => node.props.testID === "official-code-language").length, 0);
    }
  });
}

test("reply fences delegate only when existing behavior is preserved", t => {
  const h = harness(t);
  const { MarkdownView } = h.load("client/components/markdown/markdown-view.tsx");
  const draw = (text, variant = "document") => h.draw({ type: MarkdownView, props: { text, tokens: h.tokens, variant } });
  const delegated = tree => h.nodes(tree, node => node.type === "OfficialMarkdown");
  const own = tree => h.nodes(tree, node => node.props.testID === "syntax-block");
  const bars = tree => h.nodes(tree, node => node.props.testID === "official-code-language");
  let tree = draw(fence("ts", "const x = 1;"));
  assert.equal(delegated(tree).length, 1);
  assert.equal(delegated(tree)[0].props.children, fence("ts", "const x = 1;"));
  assert.equal(own(tree).length, 0);
  assert.equal(bars(tree).length, 1);
  assert.equal(h.text(bars(tree)[0]), "ts");
  tree = draw(fence("TypeScript", "x"));
  assert.equal(h.text(bars(tree)[0]), "TypeScript");
  tree = draw(fence("", "x"));
  assert.equal(delegated(tree).length, 1);
  assert.equal(bars(tree).length, 0);
  for (const language of ["mermaid", "Mermaid", "MeRmAiD"]) {
    tree = draw(fence(language, "graph TD\nA-->B"));
    assert.equal(delegated(tree).length, 1);
    assert.equal(delegated(tree)[0].props.children, fence("mermaid", "graph TD\nA-->B"));
    assert.equal(own(tree).length, 0);
    assert.equal(bars(tree).length, 0);
  }
  h.preferences.codeBlockOpen = true;
  tree = draw(fence("text", "https://example.org/path"));
  assert.equal(delegated(tree).length, 0);
  assert.equal(own(tree).length, 1);
  assert.equal(bars(tree).length, 0);
  tree = draw(fence("mermaid", "https://example.org/path"));
  assert.equal(delegated(tree).length, 0);
  assert.equal(own(tree).length, 1);
  tree = draw(fence("mermaid", "graph TD"), "terminal");
  assert.equal(delegated(tree).length, 0);
  assert.equal(own(tree).length, 1);
  assert.equal(bars(tree).length, 0);
  tree = draw(fence("ts", "x"), "terminal");
  assert.equal(delegated(tree).length, 0);
  assert.equal(own(tree).length, 1);
  assert.equal(bars(tree).length, 0);
  tree = draw("```mermaid\ngraph TD");
  assert.equal(delegated(tree).length, 0);
  assert.equal(own(tree).length, 0);
  assert.ok(h.text(tree).includes("```mermaid\ngraph TD"));
});

test("reply fences keep trailing blank lines in delegated source and fallback copy", async t => {
  const input = "```ts\nx\n\n\n```";
  const h = harness(t, { syntax: true, copyFeedback: true });
  const { MarkdownView } = h.load("client/components/markdown/markdown-view.tsx");
  const tree = h.draw({ type: MarkdownView, props: { text: input, tokens: h.tokens, variant: "document" } });
  assert.equal(h.nodes(tree, node => node.type === "OfficialMarkdown")[0].props.children, input);

  const fallback = harness(t, { syntax: true, copyFeedback: true, ui: { Markdown: undefined } });
  const fallbackView = fallback.load("client/components/markdown/markdown-view.tsx").MarkdownView;
  const fallbackTree = fallback.draw({ type: fallbackView, props: { text: input, tokens: fallback.tokens, variant: "document" } });
  await fallback.nodes(fallbackTree, node => node.props.accessibilityLabel === "Copy code")[0].props.onPress();
  assert.deepEqual(fallback.copies, ["x\n\n"]);
});

for (const [name, Markdown] of [
  ["missing", undefined],
  ["throws", () => { throw new Error("host render failed"); }],
]) {
  test(`mermaid source and copy control survive when the host component is ${name}`, async t => {
    const h = harness(t, { syntax: true, copyFeedback: true, ui: { Markdown } });
    const { MarkdownView } = h.load("client/components/markdown/markdown-view.tsx");
    const code = "graph TD\nA-->B";
    const tree = h.draw({ type: MarkdownView, props: { text: fence("mermaid", code), tokens: h.tokens, variant: "document" } });
    assert.ok(h.text(tree).includes(code));
    const copy = h.nodes(tree, node => node.props.accessibilityLabel === "Copy code");
    assert.equal(copy.length, 1);
    await copy[0].props.onPress();
    assert.deepEqual(h.copies, [code]);
    const codeTree = h.draw({ type: MarkdownView, props: { text: fence("ts", code), tokens: h.tokens, variant: "document" } });
    assert.ok(h.text(codeTree).includes(code));
    assert.equal(h.nodes(codeTree, node => node.props.testID === "official-code-language").length, 0);
  });
}

test("foldable fences retain the folding control at the limit and when expanded", t => {
  const h = harness(t, { preferences: { foldLongOutputAfter: 10 } });
  const { MarkdownView } = h.load("client/components/markdown/markdown-view.tsx");
  const draw = text => h.draw({ type: MarkdownView, props: { text, tokens: h.tokens, variant: "document" } });
  const code = n => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  const officialNodes = tree => h.nodes(tree, node => node.type === "OfficialMarkdown");
  assert.equal(officialNodes(draw(fence("ts", code(10)))).length, 1);
  let tree = draw(fence("ts", code(11)));
  assert.equal(officialNodes(tree).length, 0);
  assert.equal(h.nodes(tree, node => node.props.testID === "official-code-language").length, 0);
  const showAll = h.nodes(tree, node => node.props.accessibilityLabel === "Show all 11 lines")[0];
  assert.ok(showAll);
  showAll.props.onPress();
  tree = draw(fence("ts", code(11)));
  assert.equal(officialNodes(tree).length, 0);
  assert.equal(h.nodes(tree, node => node.props.testID === "official-code-language").length, 0);
  assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Show fewer lines").length, 1);
  h.preferences.foldLongOutputAfter = "never";
  assert.equal(officialNodes(draw(fence("ts", code(11)))).length, 1);
  h.preferences.foldLongOutputAfter = 10;
  assert.equal(officialNodes(draw(fence("mermaid", code(11)))).length, 0);
});
