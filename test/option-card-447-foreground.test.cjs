const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

// These injected colors test token routing, not contrast. See the 0.15.4 pixel
// section of records/logs/cc/acceptance/447-real-page-184fbed1.md for prior samples.
function fixture(t, dark) {
  const h = createToolHarness('web', { themeTokens: true, width: 390, agents: { a: { status: 'idle' } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const colors = {
    surface0: dark ? '#191919' : '#f8f8f8', foreground: dark ? '#e1e2e3' : '#252627',
    foregroundMuted: '#888888', accent: '#20744a', accentForeground: '#ffffff', statusDanger: '#dd3333',
  };
  const tokens = h.load('client/components/theme-tokens.ts').buildThemeTokens(colors, { accent: 'host', codeFont: 'code', codeFontFamily: 'host', uiFont: 'inter', textScale: 1, frostedGlass: true });
  assert.equal(tokens.isDark, dark);
  assert.equal(tokens.foreground, colors.foreground);
  assert.equal(tokens.accent, colors.accent);
  const s = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  s.publishAssistantReply('a', { at: 10, text: 'Question?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens } });
  return { h, s, tokens, draw };
}

function checkRow(h, tree, color, width, badgeColor) {
  const row = byId(h, tree, 'option-row-D');
  assert.equal(row.props.style[0].borderColor, color);
  assert.equal(row.props.style[0].borderWidth, width);
  assert.equal(row.props.style[1].outlineStyle, 'none');
  assert.ok(!row.props.style.some(style => style && (style.boxShadow || style.shadowOpacity)));
  if (badgeColor) {
    const badge = h.nodes(row, node => node.type === 'Text' && node.props.children === 'D')[0];
    assert.equal(badge.props.style.color, badgeColor);
    assert.equal(badge.props.style.borderColor, badgeColor);
  }
  const input = byId(h, tree, 'option-custom-input');
  if (input) {
    assert.equal(input.props.style[0].borderWidth, 0);
    assert.equal(input.props.style[1].outlineStyle, 'none');
  }
}

for (const dark of [true, false]) {
  const name = dark ? 'dark' : 'light';
  test(`${name}: selected custom row and badge use the expected tokens`, t => {
    const { h, tokens, draw } = fixture(t, dark);
    byId(h, draw(), 'option-row-D').props.onPress();
    const tree = draw();
    assert.equal(byId(h, tree, 'option-row-D').props.accessibilityState.selected, true);
    checkRow(h, tree, dark ? tokens.foreground : 'rgba(32, 116, 74, 0.55)', 1, tokens.accent);
  });

  test(`${name}: keyboard focus on custom row and input uses one border`, t => {
    const { h, tokens, draw } = fixture(t, dark);
    let tree = draw();
    byId(h, tree, 'option-row-D').props.onFocus();
    tree = draw();
    checkRow(h, tree, dark ? tokens.foreground : tokens.accent, 2);
    byId(h, tree, 'option-row-D').props.onPress();
    tree = draw();
    byId(h, tree, 'option-custom-input').props.onFocus({ stopPropagation() {} });
    tree = draw();
    checkRow(h, tree, dark ? tokens.foreground : tokens.accent, 2, tokens.accent);
  });

  test(`${name}: opening animation ends at the intended border token`, t => {
    const { h, s, tokens, draw } = fixture(t, dark);
    const calls = [], never = new Promise(() => {});
    const animate = name => ({ animate(frames, options) { calls.push({ name, frames, options }); return { finished: never, cancel() {} }; } });
    const row = { style: {}, getBoundingClientRect: () => ({ height: s.getOptionSession('a').customOpen[0] ? 120 : 70 }), ...animate('row') };
    const card = { style: {}, closest: () => null, querySelector: selector => selector.includes('option-row-D') ? row : null, getBoundingClientRect: () => ({ height: s.getOptionSession('a').customOpen[0] ? 550 : 500 }), ...animate('card') };
    const tree = draw();
    byId(h, tree, 'option-card').props.ref(card);
    byId(h, tree, 'option-row-D').props.onPress();
    draw();
    const animation = calls.find(call => call.name === 'row');
    assert.ok(animation);
    assert.equal(animation.frames[0].borderColor, tokens.border);
    assert.equal(animation.frames.at(-1).borderColor, dark ? tokens.foreground : tokens.accent);
  });
}
