const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Injected colours exercise token routing, not contrast.
const colors = {
  surface0: "#191919", foreground: "#e1e2e3", foregroundMuted: "#888888",
  accent: "#20744a", accentForeground: "#ffffff", statusDanger: "#dd3333",
};
const preferences = {
  accent: "host", customAccentEnabled: false, uiFont: "inter", codeFont: "code",
  codeFontFamily: "host", textScale: 1, frostedGlass: true,
};
const savedReplies = ["Go with the recommended", "Leave it for now", "Continue"];

function page(t, platform) {
  const h = createToolHarness(platform, { themeTokens: true, settingsPage: true });
  t.after(() => { h.unmount(); h.dispose(); });
  const screen = h.settingsScreens.get("chat-presentation");
  assert.ok(screen, "the chat-presentation settings screen is not registered");
  const tree = h.draw({ type: screen.Component, props: { theme: { colors } } });
  const input = h.nodes(tree, node => node.props.testID === "saved-replies-input")[0];
  assert.ok(input, "saved-replies-input is missing");
  const tokens = h.load("client/components/theme-tokens.ts").buildThemeTokens(colors, preferences);
  return { h, tree, input, tokens };
}

// A family list is CSS only: React Native's native `fontFamily` names one
// installed face, so a stack there is either ignored or warns.
const families = style => (Array.isArray(style) ? style.flat() : [style])
  .map(entry => entry?.fontFamily).filter(family => family !== undefined);

test("web: UI text uses the host's system sans stack", t => {
  const { input, tokens } = page(t, "web");
  assert.equal(typeof tokens.fontUi, "string");
  assert.match(tokens.fontUi, /^system-ui,/);
  assert.ok(tokens.fontUi.endsWith("sans-serif"), `web stack must end in sans-serif: ${tokens.fontUi}`);
  assert.ok(!tokens.fontUi.includes("OMP Inter"), "the removed embedded face is still referenced");
  // The page applies the stack itself: its root opts out of the host's own rule.
  assert.deepEqual(families(input.props.style), [tokens.fontUi]);
});

for (const platform of ["ios", "android"]) {
  test(`${platform}: UI text keeps the platform font instead of a CSS stack`, t => {
    const { input, tokens } = page(t, platform);
    assert.equal(tokens.fontUi, undefined);
    assert.deepEqual(families(input.props.style), []);
  });
}

test("saved replies: four lines fit before the box scrolls", t => {
  const { input } = page(t, "ios");
  const box = input.props.style[0];
  assert.equal(box.fontSize, 16);
  assert.equal(typeof box.lineHeight, "number", "an explicit line height is what makes four lines a known height");
  const outer = (box.paddingVertical ?? 0) * 2 + (box.borderWidth ?? 0) * 2;
  const four = box.lineHeight * 4 + outer;
  assert.ok(box.minHeight >= four, `minHeight ${box.minHeight} does not hold four lines (${four})`);
  assert.equal(box.height, undefined, "a fixed height would clip text instead of scrolling it");
  // Long lists scroll inside the box rather than pushing the rest of the page away.
  assert.ok(box.maxHeight >= four, `maxHeight ${box.maxHeight} is below four lines (${four})`);
  assert.ok(Number.isFinite(box.maxHeight), "a capped box is what lets longer content scroll");
  assert.equal(input.props.value, savedReplies.join("\n"));
});
