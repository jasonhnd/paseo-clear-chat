const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Which storage?
A Server
B File (recommended)

2) Ship now?
A Yes
B No

Reply with a letter for each.`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

// Independent WCAG sRGB calculation, including alpha compositing on the card.
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

// The same accent the issue measured: rgb(32, 116, 74).
const accent = "#20744a";
const lightTheme = { surface0: "#f8fafc", foreground: "#18202d", foregroundMuted: "#586579", accent, accentForeground: "#ffffff", statusDanger: "#c93642" };
const darkTheme = { surface0: "rgb(15, 15, 17)", foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent, accentForeground: "#ffffff", statusDanger: "#f2555a" };

function nativeFixture(t) {
  const agents = { a: { status: "idle" } };
  const h = createToolHarness("ios", { width: 390, agents, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const draw = (at = 10) => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: reply } }, timestamp: new Date(at), theme: { colors: {} } } }, `reply-${at}`);
  return { h, s, draw };
}

test("the Recommended badge keeps 4.5:1 on dark and keeps the accent on light", async t => {
  const h = createToolHarness("web", { themeTokens: true, themeColors: darkTheme });
  t.after(() => { h.unmount(); h.dispose(); });
  const { buildThemeTokens } = h.load("client/components/theme-tokens.ts");
  const { recommendedBadgeColor } = h.load("client/components/option-card.tsx");
  // Only the fields buildThemeTokens reads; the harness stubs the preferences module.
  const preferences = { accent: "host", customAccent: accent, customAccentEnabled: false, uiFont: "inter", codeFont: "code", codeFontFamily: "host", textScale: 1, frostedGlass: true };

  const dark = buildThemeTokens(darkTheme, preferences);
  assert.equal(dark.isDark, true);
  const base = rgb(darkTheme.surface0);
  const card = over(dark.surface1, base);
  const backing = over(dark.accentBg, card);
  assert.ok(contrast(rgb(dark.accent), backing) < 4.5, "the plain accent is the defect this test covers");
  const badge = recommendedBadgeColor(dark);
  assert.equal(badge, dark.foreground);
  assert.ok(contrast(rgb(badge), backing) >= 4.5, `dark badge contrast ${contrast(rgb(badge), backing).toFixed(2)}:1`);

  const light = buildThemeTokens(lightTheme, preferences);
  assert.equal(light.isDark, false);
  assert.equal(recommendedBadgeColor(light), light.accent, "light themes keep the accent exactly as before");
});

test("the hint line reserves one row so the card height does not change", t => {
  const { h, draw } = nativeFixture(t);
  const row = h.tokens.fs(16);

  const empty = byId(h, draw(), "option-hint-slot");
  assert.ok(empty, "an empty hint keeps its slot");
  assert.equal(flatten(empty.props.style).minHeight, row);

  byId(h, draw(), "option-row-C").props.onPress();
  const hint = byId(h, draw(), "option-hint");
  assert.ok(hint, "the hint replaces the slot in the same row");
  assert.equal(flatten(hint.props.style).minHeight, row);
  assert.equal(flatten(hint.props.style).lineHeight, row);
  assert.equal(flatten(hint.props.style).flexShrink, 1, "a narrow phone may wrap the hint instead of clipping it");
  assert.equal(hint.props.numberOfLines, undefined);
  assert.equal(flatten(hint.props.style).maxHeight, undefined, "a second line grows once, on purpose");
});
