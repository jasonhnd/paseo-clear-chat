const assert = require("node:assert/strict");
const test = require("node:test");
const MarkdownIt = require("markdown-it");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const fence = (language, code) => `\`\`\`${language}\n${code}\n\`\`\``;

// Model the host's web fence parsing and copy behavior; this is not real-host QA.
function host(clipboard) {
  const parser = new MarkdownIt("commonmark");
  return ({ children }) => parser.parse(children, {}).map(token => token.type === "fence"
    ? { type: token.info.trim().toLowerCase() === "mermaid" ? "HostDiagram" : "HostHighlightedCode", props: {
      language: token.info.trim(), code: token.content,
      children: { type: "Pressable", props: { accessibilityLabel: "Host copy code", onPress: () => { clipboard.value = token.content.replace(/\n+$/, ""); } } },
    } }
    : { type: "HostOther", props: { children: token.content } });
}

function setup(t, Markdown) {
  const h = createToolHarness("web", { markdown: true, syntax: true, copyFeedback: true, ui: { Markdown } });
  t.after(() => { h.unmount(); h.dispose(); });
  const { MarkdownView } = h.load("client/components/markdown/markdown-view.tsx");
  return { h, draw: text => h.draw({ type: MarkdownView, props: { text, tokens: h.tokens, variant: "document" } }) };
}

for (const [language, code, type] of [
  ["mermaid", "graph TD\nA-->B\n\n", "HostDiagram"],
  ["js", "const x = 1;\n\n", "HostHighlightedCode"],
]) {
  test(`${language} with trailing blank lines delegates display and the sole copy control to the host`, t => {
    const clipboard = { value: "sentinel" };
    const { h, draw } = setup(t, host(clipboard));
    const tree = draw(fence(language, code));
    const blocks = h.nodes(tree, node => node.type === type);
    assert.equal(blocks.length, 1, "the host must receive the fenced block");
    assert.equal(blocks[0].props.language, language);
    assert.equal(blocks[0].props.code, `${code}\n`);
    assert.equal(h.nodes(tree, node => node.props.testID === "exact-code-body").length, 0);
    const buttons = h.nodes(tree, node => node.type === "Pressable" && /copy code/i.test(node.props.accessibilityLabel || ""));
    assert.equal(buttons.length, 1);
    buttons[0].props.onPress();
    assert.equal(clipboard.value, code.replace(/\n+$/, ""));
  });
}

for (const [name, Markdown] of [["missing", undefined], ["throwing", () => { throw new Error("host failed"); }]]) {
  test(`${name} host falls back for a fence with trailing blank lines`, async t => {
    const { h, draw } = setup(t, Markdown);
    const code = "graph TD\nA-->B\n\n";
    const tree = draw(fence("mermaid", code));
    assert.equal(h.nodes(tree, node => node.props.testID === "exact-code-body").length, 0);
    assert.ok(h.text(tree).includes(code.trimEnd()));
    const buttons = h.nodes(tree, node => node.props.accessibilityLabel === "Copy code");
    assert.equal(buttons.length, 1);
    await buttons[0].props.onPress();
    assert.deepEqual(h.copies, [code]);
  });
}

test("backtick in info uses a valid host fence and preserves the language label", t => {
  const clipboard = { value: "sentinel" };
  const { h, draw } = setup(t, host(clipboard));
  const tree = draw("~~~~js`odd\nconsole.log('ticks');\n\n~~~~");
  const blocks = h.nodes(tree, node => node.type === "HostHighlightedCode");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].props.language, "js`odd");
  assert.equal(blocks[0].props.code, "console.log('ticks');\n\n");
  assert.equal(h.text(h.nodes(tree, node => node.props.testID === "official-code-language")[0]), "js`odd");
});
