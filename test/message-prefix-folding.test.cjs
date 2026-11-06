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

test("a matching message folds while the image lookup is pending and opens when images arrive", async t => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const h = createToolHarness("ios", { userMessage: true, preferences: { foldMessagePrefixes: "[Relay]" }, promptImagesRpc: () => wait });
  t.after(() => h.unmount());
  const identity = { host: { id: "first-host" } };
  const mounted = h.mount({ type: "user_message", text: "[Relay] image", messageId: "one" }, false, identity);
  assert.ok(id(h, mounted.tree, "folded-user-message"));
  finish({ images: [{ id: "image", thumbDataUri: "data:image/png;base64,c2FtcGxl", mime: "image/png", width: 1, height: 1 }], total: 1, reason: null });
  await tick();
  const open = mounted.render();
  assert.equal(id(h, open, "folded-user-message"), undefined);
  assert.ok(id(h, open, "prompt-pasted-thumb"));
  assert.equal(label(h, open, "Hide full message"), undefined);
  identity.host = { id: "second-host" };
  assert.equal(id(h, mounted.render(), "folded-user-message"), undefined, "the same message stays open when its lookup key changes");
});

for (const reason of [null, "unknown_provider", "no_match", "agent_not_found", "provider_mismatch", "timeout", "lookup_failed", "ambiguous"]) {
  test(`a matching message folds when the image lookup returns ${reason}`, async t => {
    const { h, tree } = await mount("[Relay] text", { foldMessagePrefixes: "[Relay]" }, {}, {
      promptImagesRpc: async () => ({ images: [], total: 0, reason }),
    });
    t.after(() => h.unmount());
    assert.ok(id(h, tree, "folded-user-message"));
  });
}

test("a rejected image lookup leaves a matching message folded", async t => {
  const { h, tree } = await mount("[Relay] text", { foldMessagePrefixes: "[Relay]" }, {}, {
    promptImagesRpc: async () => { throw new Error("lookup failed"); },
  });
  t.after(() => h.unmount());
  assert.ok(id(h, tree, "folded-user-message"));
});

test("image counts or thumbnails independently prevent folding", async t => {
  for (const result of [
    { images: [], total: 1, reason: null },
    { images: [{ id: "image", thumbDataUri: "data:image/png;base64,c2FtcGxl" }], total: 0, reason: null },
  ]) {
    const { h, tree } = await mount("[Relay] text", { foldMessagePrefixes: "[Relay]" }, {}, { promptImagesRpc: async () => result });
    t.after(() => h.unmount());
    assert.equal(id(h, tree, "folded-user-message"), undefined);
  }
});

test("opening survives renders and resets when message text or either id changes", async t => {
  const { h, mounted, tree } = await mount("[Relay] text", { foldMessagePrefixes: "[Relay]" });
  t.after(() => h.unmount());
  label(h, tree, "Show full message").props.onPress();
  assert.ok(label(h, mounted.render(), "Hide full message"));
  for (const data of [
    { ...mounted.data, text: "[Relay] changed" },
    { ...mounted.data, text: "[Relay] changed", messageId: "message-one" },
    { ...mounted.data, text: "[Relay] changed", messageId: "message-one", clientMessageId: "client-one" },
  ]) {
    mounted.render(data);
    const folded = mounted.render(data);
    assert.ok(id(h, folded, "folded-user-message"));
    label(h, folded, "Show full message").props.onPress();
    assert.ok(label(h, mounted.render(data), "Hide full message"));
  }
});
