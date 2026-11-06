const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const tick = () => new Promise(setImmediate);
const id = (h, tree, value) => h.nodes(tree, node => node.props.testID === value)[0];
const label = (h, tree, value) => h.nodes(tree, node => node.props.accessibilityLabel === value)[0];

async function mount(text, preferences = {}, extra = {}, options = {}) {
  const h = createToolHarness("web", { userMessage: true, copyFeedback: true, agent: { status: "idle" }, preferences, ...options });
  const mounted = h.mount({ type: "user_message", text, ...extra }, false);
  await tick();
  return { h, mounted, tree: mounted.render() };
}

for (const [rules, text, expected] of [
  ["", "[Relay] hello", false],
  ["[Relay]", "  \n[Relay] hello", true],
  ["[Relay]", "hello [Relay]", false],
  ["[Relay]", "[relay] hello", false],
  ["[Report]\n\n  \n[Relay]", "[Relay] hello", true],
  ["\n  \n", "anything", false],
]) {
  test(`prefix matching ${JSON.stringify([rules, text])}`, async t => {
    const { h, tree } = await mount(text, { foldMessagePrefixes: rules });
    t.after(() => h.unmount());
    assert.equal(!!id(h, tree, "folded-user-message"), expected);
  });
}

test("folded row opens the full original, copies and quotes it, and hides again", async t => {
  const text = `[Relay] ${"x".repeat(130)}\n${"second line\n".repeat(30)}`;
  const { h, mounted, tree } = await mount(text, { foldMessagePrefixes: "[Relay]" });
  t.after(() => h.unmount());
  const summary = id(h, tree, "folded-message-summary");
  assert.equal(Array.from(h.text(summary)).length, 120);
  assert.ok(h.text(summary).endsWith("…"));
  assert.equal(id(h, tree, "folded-message-search-text").props.children, text);
  assert.equal(label(h, tree, "Show full message").props.accessibilityState.expanded, false);
  label(h, tree, "Show full message").props.onPress();
  let open = mounted.render();
  assert.equal(id(h, open, "folded-user-message"), undefined);
  assert.ok(h.text(open).includes(text));
  await label(h, open, "Copy prompt").props.onPress();
  assert.equal(h.copies.at(-1), text);
  id(h, open, "quote-action").props.onPress();
  open = mounted.render();
  assert.equal(h.text(id(h, open, "quote-original")), text);
  label(h, open, "Hide full message").props.onPress();
  assert.ok(id(h, mounted.render(), "folded-user-message"));
  mounted.replaceRow();
  await tick();
  assert.ok(id(h, mounted.render(), "folded-user-message"));
});

test("short first lines stay whole and image attachments never fold", async t => {
  const short = await mount("[Relay] short\nbody", { foldMessagePrefixes: "[Relay]" });
  t.after(() => short.h.unmount());
  assert.equal(short.h.text(id(short.h, short.tree, "folded-message-summary")), "[Relay] short");
  for (const extra of [{ images: ["data:image/png;base64,c2FtcGxl"] }, { imageCount: 1 }]) {
    const sample = await mount("[Relay] image", { foldMessagePrefixes: "[Relay]" }, extra);
    assert.equal(id(sample.h, sample.tree, "folded-user-message"), undefined);
    sample.h.unmount();
  }
  const sample = await mount("[Relay] pasted", { foldMessagePrefixes: "[Relay]" }, {}, {
    promptImagesRpc: async () => ({ images: [{ id: "image", thumbDataUri: "data:image/png;base64,c2FtcGxl", mime: "image/png", width: 1, height: 1 }], total: 1, reason: null }),
  });
  assert.equal(id(sample.h, sample.tree, "folded-user-message"), undefined);
  assert.ok(id(sample.h, sample.tree, "prompt-pasted-thumb"));
  sample.h.unmount();
});

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: setting and disclosure controls use translated labels`, async t => {
    const strings = require(`../client/locales/${locale}.json`);
    const settings = createToolHarness("ios", { locale, settingsPage: true });
    t.after(() => settings.unmount());
    const screen = [...settings.settingsScreens.values()][0];
    const page = settings.draw({ type: screen.Component, props: { theme: { colors: {} } } });
    const input = label(settings, page, strings.settings.foldMessages.label);
    assert.ok(input);
    assert.equal(input.props.multiline, true);
    input.props.onChangeText("[Relay]\n[Report]");
    assert.equal(settings.preferences.foldMessagePrefixes, "[Relay]\n[Report]");
    const { h, mounted, tree } = await mount("[Relay] text", { foldMessagePrefixes: "[Relay]" }, {}, { locale });
    t.after(() => h.unmount());
    assert.ok(label(h, tree, strings.prompt.showMessage));
    label(h, tree, strings.prompt.showMessage).props.onPress();
    assert.ok(label(h, mounted.render(), strings.prompt.hideMessage));
  });
}

test("pending pasted-image lookup leaves a matching message open", async t => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const h = createToolHarness("ios", { userMessage: true, preferences: { foldMessagePrefixes: "[Relay]" }, promptImagesRpc: () => wait });
  t.after(() => h.unmount());
  const mounted = h.mount({ type: "user_message", text: "[Relay] image" }, false);
  assert.equal(id(h, mounted.tree, "folded-user-message"), undefined);
  finish({ images: [], total: 1, reason: null });
  await tick();
  assert.equal(id(h, mounted.render(), "folded-user-message"), undefined);
});


test("an unresolved image lookup keeps a matching message open", async t => {
  const { h, tree } = await mount("[Relay] text", { foldMessagePrefixes: "[Relay]" }, {}, {
    promptImagesRpc: async () => ({ images: [], total: 0, reason: "unknown_provider" }),
  });
  t.after(() => h.unmount());
  assert.equal(id(h, tree, "folded-user-message"), undefined);
});
