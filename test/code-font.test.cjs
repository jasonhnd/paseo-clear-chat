const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const realShell = require("./fixtures/real-hermes-errors.json").items.find(item => item.detail?.type === "shell");
const realPatch = require("./fixtures/real-hermes-patch.json").items[0];

const colors = { surface0: "#111111", foreground: "#eeeeee", foregroundMuted: "#aaaaaa", accent: "#00ff00", statusDanger: "#ff0000" };
function host(preferences = {}) {
  let values = { preferences, legacyMigrated: true };
  return {
    get values() { return structuredClone(values); },
    async rpc(contract, input) {
      if (contract.name.endsWith(".write")) values = structuredClone(input.values);
      return { status: contract.name.endsWith(".write") ? "saved" : "ready", revision: "0", values: structuredClone(values) };
    },
  };
}
async function client(platform, presentationHost = host()) {
  const h = createToolHarness(platform, { presentationHost, settingsPage: true, themeTokens: true, markdown: true, syntax: true, themeColors: colors });
  await new Promise(setImmediate);
  return h;
}
const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
function fontsFor(h, tree, text) {
  return h.nodes(tree, node => node.type === "Text" && h.text(node).replace(/\n/g, "").includes(text.replace(/\n/g, "")))
    .map(node => flatten(node.props.style).fontFamily).filter(Boolean);
}

test("code font defaults to Default (Iosevka) without changing the settings version or legacy glyphs", async () => {
  const h = await client("web", host({ codeFont: "plain" }));
  assert.equal(h.preferences.codeFontFamily, "host");
  const theme = h.load("client/components/theme-tokens.ts");
  let tokens = theme.buildThemeTokens(colors, h.preferences);
  assert.equal(tokens.fontCode, theme.fontMono);
  assert.equal(tokens.fontMono, theme.fontMono);
  await h.load("client/preferences.ts").updateEnhancerPreferences({ codeFont: "code" });
  tokens = theme.buildThemeTokens(colors, h.preferences);
  assert.equal(tokens.fontCode, theme.fontCode);
  const { presentationSettings } = h.load("shared/settings.ts");
  assert.equal(presentationSettings.version, 2);
  assert.deepEqual(presentationSettings.schema.parse({}), { preferences: {}, legacyMigrated: false });
});

test("font choices persist across clients, reject invalid families and reset to Default (Iosevka)", async () => {
  const storage = host({ accent: "jade", codeFont: "plain" });
  const h = await client("web", storage);
  const p = h.load("client/preferences.ts");
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  const page = () => h.draw({ type: Page, props: { theme: { colors } } });
  assert.match(h.text(page()), /not exposed.*SDK/i);
  assert.match(h.text(page()), /Default \(Iosevka\) uses Iosevka and your Code glyphs choice/);
  for (const [value, label] of [["host", "Default (Iosevka)"], ["iosevka", "Iosevka"], ["menlo", "Menlo"], ["consolas", "Consolas"], ["fira-code", "Fira Code"], ["cascadia-code", "Cascadia Code"]]) {
    const button = h.nodes(page(), node => node.type === "Pressable" && h.text(node) === label)[0];
    assert.ok(button, `${label} is selectable`);
    await button.props.onPress();
    assert.equal(storage.values.preferences.codeFontFamily, value);
    assert.equal((await client("android", storage)).preferences.codeFontFamily, value);
    const selected = h.nodes(page(), node => node.type === "Pressable" && h.text(node) === label)[0];
    assert.equal(selected.props.accessibilityState.selected, true);
  }
  assert.throws(() => p.updateEnhancerPreferences({ codeFontFamily: "invalid" }));
  assert.equal(h.preferences.codeFont, "plain");
  await p.resetEnhancerPreferences();
  assert.equal(h.preferences.codeFontFamily, "host");
  assert.deepEqual(storage.values.preferences, {});
});

test("installed font aliases prefer local faces and retain bundled monospace fallbacks", () => {
  const h = createToolHarness("web", { fonts: true, themeTokens: true, presentationHost: host() });
  const previous = global.document;
  let sheet;
  try {
    global.document = {
      getElementById: () => null,
      createElement: () => ({ remove() {} }),
      head: { appendChild(value) { sheet = value.textContent; } },
    };
    h.load("client/components/embed-fonts.ts").embedFonts();
    for (const [id, name] of [["menlo", "Menlo"], ["consolas", "Consolas"], ["fira-code", "Fira Code"], ["cascadia-code", "Cascadia Code"]]) {
      const rules = [...sheet.matchAll(/@font-face \{([^}]+)\}/g)].map(match => match[1]).filter(rule => rule.includes(`"Clear Chat ${id}"`));
      assert.equal(rules.length, 2, "regular and semibold aliases are registered");
      for (const rule of rules) assert.match(rule, new RegExp(`src: local\\("${name}"\\),\\s+url\\(data:font/woff2;base64,`));
    }
  } finally {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  }
});

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: selected font reaches fenced code, inline code, captured terminal output and diffs`, async () => {
    const h = await client(platform);
    const theme = h.load("client/components/theme-tokens.ts");
    for (const family of ["host", "iosevka", "menlo", "consolas", "fira-code", "cascadia-code"]) {
      await h.load("client/preferences.ts").updateEnhancerPreferences({ codeFontFamily: family });
      const tokens = theme.buildThemeTokens(colors, h.preferences);
      const expected = platform === "ios" ? "Menlo" : platform === "android" ? "monospace" :
        family === "host" || family === "iosevka" ? theme.fontMono : `Clear Chat ${family}`;
      assert.equal(tokens.fontMono, expected);
      if (platform !== "web" || !["host", "iosevka"].includes(family)) assert.equal(tokens.fontCode, expected);

      const reply = h.mount({ type: "assistant_message", messageId: "font-reply", text: "Use `inline_sample` here.\n\n```js\nconst fenced_sample = 1;\n```" }).tree;
      assert.ok(fontsFor(h, reply, "inline_sample").includes(tokens.fontMono));
      assert.ok(fontsFor(h, reply, "fenced_sample").includes(tokens.fontCode));
      const shell = h.mount(realShell).tree;
      assert.ok(h.nodes(shell, node => node.type === "Text" && flatten(node.props.style).fontFamily === tokens.fontMono && h.text(node).length > 20).length, "captured terminal output uses the selected family");
      const patch = h.mount(realPatch).tree;
      assert.ok(fontsFor(h, patch, realPatch.detail.unifiedDiff.split("\n")[0]).includes(tokens.fontCode));
      const diff = h.mount({ type: "tool_call", name: "Edit", callId: "font-diff", status: "completed", detail: { type: "edit", filePath: "sample.ts", input: { old_string: "before_sample", new_string: "after_sample" } } }).tree;
      assert.ok(fontsFor(h, diff, "before_sample").includes(tokens.fontCode));
      assert.ok(fontsFor(h, diff, "after_sample").includes(tokens.fontCode));
    }
  });
}
