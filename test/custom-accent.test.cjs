const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const fixture = require("./fixtures/real-hermes-session.json");

const themes = [
  { surface0: "#f8fafc", foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff", statusDanger: "#c93642" },
  { surface0: "rgb(15, 15, 17)", foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11", statusDanger: "#f2555a" },
];
function host() {
  let values = { preferences: {}, legacyMigrated: true }, revision = 0;
  return {
    get values() { return structuredClone(values); },
    async rpc(contract, input) {
      if (contract.name.endsWith(".read")) return { status: "ready", revision: String(revision), values: structuredClone(values) };
      assert.equal(input.revision, String(revision));
      // Simulate the JSON boundary of the real settings file.
      values = JSON.parse(JSON.stringify(input.values));
      return { status: "saved", revision: String(++revision), values: structuredClone(values) };
    },
  };
}
const flatten = styles => Object.assign({}, ...[styles].flat(Infinity).filter(Boolean));
const find = (h, tree, label) => h.nodes(tree, node => node.props.accessibilityLabel === label)[0];
async function client(platform, storage, colors = themes[0]) {
  const h = createToolHarness(platform, { presentationHost: storage, settingsPage: true, themeTokens: true, themeColors: colors });
  await new Promise(setImmediate);
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  return { h, page: () => h.draw({ type: Page, props: { theme: { colors } } }) };
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: custom HEX validates, recolours a mounted real call immediately, and survives reload`, async () => {
    const storage = host();
    const { h, page } = await client(platform, storage);
    const preferences = h.load("client/preferences.ts");
    const mounted = h.mount({ ...fixture.items.find(item => item.type === "tool_call"), status: "running" }, false);
    const oldTree = mounted.render();
    await find(h, page(), "Accent: Custom").props.onPress();
    assert.equal(find(h, page(), "Accent: Custom").props.accessibilityState.selected, true);
    const apply = () => find(h, page(), "Apply custom accent").props.onPress();
    const change = text => find(h, page(), "Custom HEX colour").props.onChangeText(text);
    const previous = preferences.getEnhancerPreferences().customAccent;
    for (const invalid of ["#12", "red", "#gggggg", "#12345678", "#12zz45"]) {
      change(invalid);
      await apply();
      assert.match(h.text(h.nodes(page(), node => node.props.accessibilityRole === "alert")), /#RGB or #RRGGBB/);
      assert.equal(preferences.getEnhancerPreferences().customAccent, previous);
      assert.equal(storage.values.preferences.customAccent, previous);
    }
    change(" #0aC ");
    await apply();
    assert.equal(storage.values.preferences.customAccent, "#00aacc");
    assert.equal(storage.values.preferences.customAccentEnabled, true);
    assert.equal(h.nodes(page(), node => node.props.accessibilityRole === "alert").length, 0);
    const { buildThemeTokens } = h.load("client/components/theme-tokens.ts");
    const tokens = buildThemeTokens(themes[0], preferences.getEnhancerPreferences());
    const accentText = tree => h.nodes(tree, node => node.type === "Text" && flatten(node.props.style).color === tokens.accent);
    assert.equal(accentText(oldTree).length, 0);
    assert.ok(accentText(mounted.render()).length > 0, "existing calls receive the new theme without rerunning their transformer");
    assert.ok(flatten(find(h, page(), "Custom HEX colour").props.style).minHeight >= 44);

    await find(h, page(), "Accent: Jade").props.onPress();
    assert.equal(preferences.getEnhancerPreferences().customAccentEnabled, false);
    assert.equal(preferences.getEnhancerPreferences().customAccent, "#00aacc", "preset changes retain the custom colour");
    await find(h, page(), "Accent: Custom").props.onPress();
    h.unmount();
    const fresh = await client(platform, storage);
    assert.equal(find(fresh.h, fresh.page(), "Custom HEX colour").props.value, "#00aacc");
    assert.equal(find(fresh.h, fresh.page(), "Accent: Custom").props.accessibilityState.selected, true);
    await fresh.h.load("client/preferences.ts").resetEnhancerPreferences();
    assert.equal(find(fresh.h, fresh.page(), "Accent: Host theme").props.accessibilityState.selected, true);
    fresh.h.unmount();
  });
}

// Independent WCAG sRGB calculation, including alpha compositing on the host surface.
function rgb(value) {
  if (value.startsWith("#")) return value.slice(1).match(/../g).slice(0, 3).map(x => parseInt(x, 16));
  return value.match(/[\d.]+/g).map(Number);
}
function over(value, background) {
  const [r, g, b, alpha = 1] = rgb(value);
  return [r, g, b].map((x, i) => x * alpha + background[i] * (1 - alpha));
}
function luminance(channels) {
  return channels.reduce((sum, x, i) => {
    const v = x / 255;
    return sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("custom accent text, tinted labels and filled buttons meet 4.5:1 on light and dark surfaces", async () => {
  const { h } = await client("web", host());
  const { buildThemeTokens } = h.load("client/components/theme-tokens.ts");
  const defaults = h.load("client/preferences.ts").DEFAULT_PREFERENCES;
  const samples = ["#ffffff", "#000000", "#777777", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#00aacc"];
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    samples.push(`#${[r, g, b].map(x => x.toString(16).padStart(2, "0")).join("")}`);
  }
  for (const colors of themes) for (const customAccent of samples) {
    const tokens = buildThemeTokens(colors, { ...defaults, customAccent, customAccentEnabled: true });
    const base = rgb(colors.surface0);
    const surfaces = [base, ...[tokens.surface1, tokens.surface2, tokens.surfaceCode, tokens.surfaceGlass, tokens.surfaceCodeGlass].map(value => over(value, base))];
    surfaces.push(...surfaces.map(background => over(tokens.accentBg, background)));
    for (const background of surfaces) {
      assert.ok(contrast(rgb(tokens.accent), background) >= 4.5, `${customAccent} on ${colors.surface0}: accent text contrast`);
    }
    assert.ok(contrast(rgb(tokens.accentForeground), rgb(tokens.accent)) >= 4.5, "filled action text contrast");
  }
  const a = buildThemeTokens(themes[0], { ...defaults, customAccent: "#004488", customAccentEnabled: true });
  assert.equal(a.accent, "#004488", "already accessible colours stay exact");
  assert.notEqual(buildThemeTokens(themes[0], { ...defaults, customAccent: "#884400", customAccentEnabled: true }), a, "cache includes the custom colour");
  assert.equal(buildThemeTokens(themes[0], defaults).accent, themes[0].accent, "host accent remains the default");
  h.unmount();
});

test("new accent settings stay optional at version 2 and reject invalid persisted HEX", async () => {
  const { h } = await client("web", host());
  const { presentationSettings, preferenceOverridesSchema } = h.load("shared/settings.ts");
  assert.equal(presentationSettings.version, 2);
  assert.deepEqual(preferenceOverridesSchema.parse({}), {});
  assert.deepEqual(preferenceOverridesSchema.parse({ customAccent: " #aBc ", customAccentEnabled: true }), { customAccent: "#aabbcc", customAccentEnabled: true });
  assert.equal(preferenceOverridesSchema.safeParse({ customAccent: "#xyzxyz" }).success, false);
  h.unmount();
});
