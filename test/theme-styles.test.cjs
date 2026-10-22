const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInThisContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function harness() {
  let compilations = 0;
  const preferences = { accent: "host", uiFont: "inter", codeFont: "code", textScale: 1, frostedGlass: true };
  const colors = { surface0: "#101010", foreground: "#eeeeee", foregroundMuted: "#999999",
    accent: "#5577ee", accentForeground: "#ffffff", statusDanger: "#ee5555" };
  function load(file, dependencies) {
    const filename = resolve(__dirname, "..", file);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod = { exports: {} };
    runInThisContext(`(function(require,module,exports){${source}\n})`, { filename })(id => {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    }, mod, mod.exports);
    return mod.exports;
  }
  const theme = load("client/components/theme-tokens.ts", {
    "../preferences": { DEFAULT_PREFERENCES: preferences, ACCENT_PRESETS: { host: undefined, jade: "#10b981" } },
  });
  const { useToolCalloutStyles } = load("client/components/tool-callout-styles.ts", {
    // Every call models a fresh row mount, so per-component useMemo cannot hide
    // repeated compilation across rows entering the history viewport.
    react: { useMemo: build => build() },
    "react-native": { StyleSheet: { create(styles) { compilations += 1; return styles; } } },
    "./theme-tokens": theme,
    "./selection": { selectableSurface: {} },
  });
  return { colors, preferences, ...theme, useToolCalloutStyles, get compilations() { return compilations; } };
}

test("history row mounts share derived tokens and compile each status style only once", () => {
  const h = harness();
  const tokens = h.buildThemeTokens(h.colors, h.preferences);
  const styles = h.useToolCalloutStyles(tokens, tokens.successBg, tokens.success);
  for (let row = 0; row < 200; row += 1) {
    const next = h.buildThemeTokens({ ...h.colors }, { ...h.preferences });
    assert.equal(next, tokens);
    assert.equal(h.useToolCalloutStyles(next, next.successBg, next.success), styles);
  }
  assert.equal(h.compilations, 1);
  const failed = h.useToolCalloutStyles(tokens, tokens.dangerBg, tokens.danger);
  assert.equal(failed.indicatorText.color, tokens.danger);
  assert.equal(failed.statusBadge.backgroundColor, tokens.dangerBg);
  assert.equal(h.useToolCalloutStyles(tokens, tokens.dangerBg, tokens.danger), failed);
  assert.equal(h.compilations, 2);
});

test("theme and typography changes invalidate shared styles while unrelated folding changes do not", () => {
  const h = harness();
  const original = h.buildThemeTokens(h.colors, h.preferences);
  assert.equal(h.buildThemeTokens(h.colors, { ...h.preferences, foldLongOutputAfter: 30 }), original);
  for (const [field, value] of Object.entries({ accent: "jade", uiFont: "system", codeFont: "plain", textScale: 1.3, frostedGlass: false })) {
    const tokens = h.buildThemeTokens(h.colors, { ...h.preferences, [field]: value });
    assert.notEqual(tokens, original, field);
    const styles = h.useToolCalloutStyles(tokens, tokens.successBg, tokens.success);
    assert.equal(styles.titleText.fontSize, tokens.fs(12));
    assert.equal(styles.titleText.fontFamily, tokens.fontUi);
    assert.equal(styles.container.backgroundColor, tokens.surfaceGlass);
    assert.equal(h.buildThemeTokens(h.colors, h.preferences), original);
  }
  for (const field of Object.keys(h.colors)) {
    const colors = { ...h.colors, [field]: "#223344" };
    assert.notEqual(h.buildThemeTokens(colors, h.preferences), original, field);
  }
});

test("theme cache stays bounded and detects changes to reused input objects", () => {
  const h = harness();
  const first = h.buildThemeTokens(h.colors, h.preferences);
  h.colors.foreground = "#ffffff";
  assert.notEqual(h.buildThemeTokens(h.colors, h.preferences), first);
  h.preferences.textScale = 1.3;
  assert.equal(h.buildThemeTokens(h.colors, h.preferences).fs(12), 15.5);
  for (let i = 0; i < 16; i += 1) h.buildThemeTokens({ ...h.colors, accent: `rgb(${i}, 0, 0)` }, h.preferences);
  assert.notEqual(h.buildThemeTokens({ ...h.colors, foreground: "#eeeeee" }, { ...h.preferences, textScale: 1 }), first);
});
