const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const address = "https://example.org/Path?q=Value#part";
const fence = body => `\`\`\`text\n${body}\n\`\`\``;
const openButtons = (h, tree) => h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityLabel?.startsWith("Open https://"));

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: eligible reply fences show an accessible Open button only when enabled`, async t => {
    const h = createToolHarness(platform, { markdown: true, syntax: true, copyFeedback: true, preferences: { codeBlockOpen: false } });
    t.after(() => h.dispose());
    let mounted = h.mount({ type: "assistant_message", text: fence(address) });
    assert.equal(openButtons(h, mounted.tree).length, 0);
    h.preferences.codeBlockOpen = true;
    const tree = mounted.render();
    const button = openButtons(h, tree)[0];
    assert.equal(button.props.accessibilityLabel, `Open ${address}`);
    assert.equal(button.props.accessibilityRole, "button");
    assert.ok(Object.assign({}, ...[button.props.style].flat()).minHeight >= 44);
    const copy = h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityLabel === "Copy code")[0];
    await copy.props.onPress();
    assert.equal(h.copies.at(-1), address);
    if (platform !== "web") {
      await button.props.onPress();
      assert.deepEqual(h.links, [address]);
    }
  });
}

test("only one closed fence containing an eligible address gets Open", t => {
  const h = createToolHarness("ios", { markdown: true, syntax: true, copyFeedback: true, preferences: { codeBlockOpen: true } });
  t.after(() => h.dispose());
  const cases = [
    [address, true], [`  ${address}  `, true], [` ${address} \n`, true],
    ["http://example.org", false], ["https://localhost", false],
    ["https://127.0.0.1", false], ["https://[::1]", false],
    ["https://device.local", false], ["https://DEVICE.LOCAL.", false],
    ["mailto:hello@example.org", false], ["javascript:alert(1)", false],
    [`${address} https://example.net`, false], [`${address} text`, false],
    [`${address}\nhttps://example.net`, false], [`${address}\n\n`, false],
    ["", false], ["https://", false], ["https://exa mple.org", false],
  ];
  for (const [body, expected] of cases) {
    const { tree } = h.mount({ type: "assistant_message", text: fence(body) });
    assert.equal(openButtons(h, tree).length, Number(expected), JSON.stringify(body));
  }
  for (const text of [`\`\`\`\n${address}`, `Inline \`${address}\``, address]) {
    assert.equal(openButtons(h, h.mount({ type: "assistant_message", text }).tree).length, 0);
  }
});

test("opening preserves the address rather than surrounding whitespace", async t => {
  const h = createToolHarness("ios", { markdown: true, syntax: true, copyFeedback: true, preferences: { codeBlockOpen: true } });
  t.after(() => h.dispose());
  const { tree } = h.mount({ type: "assistant_message", text: fence(`  ${address}  \n`) });
  await openButtons(h, tree)[0].props.onPress();
  assert.deepEqual(h.links, [address]);
});

test("Open appears when a streamed fence closes", t => {
  const h = createToolHarness("ios", { markdown: true, syntax: true, preferences: { codeBlockOpen: true } });
  t.after(() => h.dispose());
  const mounted = h.mount({ type: "assistant_message", text: `\`\`\`\n${address}` });
  assert.equal(openButtons(h, mounted.tree).length, 0);
  assert.equal(openButtons(h, mounted.render({ ...mounted.data, text: fence(address) })).length, 1);
});

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: settings and Open button have translations`, () => {
    const resource = require(`../client/locales/${locale}.json`);
    for (const value of [resource.settings.codeBlockOpen.label, resource.settings.codeBlockOpen.description, resource.code.open, resource.code.openA11y]) assert.equal(typeof value, "string");
    assert.match(resource.code.openA11y, /{{address}}/);
  });
}
