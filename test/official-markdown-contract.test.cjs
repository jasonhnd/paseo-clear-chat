const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

function fixture(t, Markdown) {
  const h = createToolHarness("web", { markdown: true, syntax: true, copyFeedback: true, ui: { Markdown } });
  t.after(() => { h.unmount(); h.dispose(); });
  const { MarkdownView } = h.load("client/components/markdown/markdown-view.tsx");
  return { h, draw: text => h.draw({ type: MarkdownView, props: { text, tokens: h.tokens, variant: "document" } }) };
}

// This host is a parser-backed test double, not evidence of a real host interaction.
function host({ children }) {
  const parser = new (require("markdown-it"))("commonmark");
  return parser.parse(children, {}).map(token => token.type === "fence"
    ? { type: "HostFence", props: { language: token.info.trim(), body: token.content.slice(0, -1) } }
    : { type: "HostOther", props: {} });
}

for (const [name, source, language, body] of [
  ["no trailing newline", "```js\nconst x = 1;\n```", "js", "const x = 1;"],
  ["frozen two trailing LFs", "```js\nconsole.log('line');\n\n\n```", "js", "console.log('line');\n\n"],
  ["CRLF", "```js\r\nconsole.log('line');\r\n\r\n\r\n```", "js", "console.log('line');\n\n"],
  ["backtick language", "~~~~js`odd\nconsole.log('ticks');\n~~~~", "js`odd", "console.log('ticks');"],
  ["internal fence runs", "~~~~js\na ``` b\n~~~\n~~~~", "js", "a ``` b\n~~~"],
]) {
  test(`delegate preserves host body and exact copy: ${name}`, async t => {
    const { h, draw } = fixture(t, host);
    const tree = draw(source);
    const fences = h.nodes(tree, node => node.type === "HostFence");
    assert.equal(fences.length, 1, "the host must render the code block");
    assert.equal(fences[0].props.language, language);
    assert.equal(fences[0].props.body, body);
    assert.equal(h.text(h.nodes(tree, node => node.props.testID === "official-code-language")[0]), language);
    if (body.endsWith("\n")) {
      const copy = h.nodes(tree, node => node.props.accessibilityLabel === "Copy code");
      assert.equal(copy.length, 1, "one exact-copy control");
      await copy[0].props.onPress();
      assert.equal(h.copies.at(-1), body);
    }
  });
}

for (const suffix of ["", "\n\n"]) {
  test(`mermaid is delegated with ${suffix.length} body trailing LFs`, t => {
    const { h, draw } = fixture(t, host);
    const tree = draw(`\`\`\`mermaid\ngraph TD\nA-->B${suffix}\n\`\`\``);
    const fences = h.nodes(tree, node => node.type === "HostFence");
    assert.equal(fences.length, 1);
    assert.equal(fences[0].props.language, "mermaid");
    assert.equal(fences[0].props.body, `graph TD\nA-->B${suffix}`);
  });
}

for (const [name, Markdown] of [["absent", undefined], ["throws", () => { throw new Error("host failed"); }]]) {
  test(`${name} host uses the existing fallback and its real plugin copy callback`, async t => {
    const { h, draw } = fixture(t, Markdown);
    const body = "graph TD\nA-->B\n\n";
    const tree = draw(`\`\`\`mermaid\n${body}\n\`\`\``);
    assert.ok(h.text(tree).includes("graph TD\nA-->B"));
    assert.equal(h.nodes(tree, node => node.props.testID === "exact-code-body").length, 0);
    const copy = h.nodes(tree, node => node.props.accessibilityLabel === "Copy code");
    assert.equal(copy.length, 1);
    await copy[0].props.onPress();
    assert.equal(h.copies.at(-1), body);
  });
}

// Exercise the plugin's actual copy callback separately from the host double.
test("plugin copy callback preserves the parsed trailing LFs", async t => {
  const { h, draw } = fixture(t, host);
  const tree = draw("```js\nconsole.log('line');\n\n\n```");
  const copy = h.nodes(tree, node => node.props.accessibilityLabel === "Copy code");
  assert.equal(copy.length, 1);
  await copy[0].props.onPress();
  assert.equal(h.copies.at(-1), "console.log('line');\n\n");
});
