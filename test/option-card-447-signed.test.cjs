const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];
const single = 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A';
const three = '1) First?\nA Alpha\nB Beta\nC Gamma\n\n2) Second?\nA Alpha\nB Beta\nC Gamma\n\n3) Third?\nA Alpha\nB Beta\nC Gamma\n\nReply: A';
function fixture(t, reply = single, locale = 'en') {
  const h = createToolHarness('web', { width: 390, locale, agents: { a: { status: 'idle' } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  s.publishAssistantReply('a', { at: 10, text: reply });
  return { h, s, draw: () => h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens: h.tokens } }) };
}
function press(f, id) { byId(f.h, f.draw(), id).props.onPress(); }
function change(f, value) { byId(f.h, f.draw(), 'option-custom-input').props.onChangeText(value); }

test('category 1 alignment and single line', t => {
  const f = fixture(t); press(f, 'option-row-D'); const tree = f.draw();
  const row = byId(f.h, tree, 'option-row-D'); const input = byId(f.h, tree, 'option-custom-input');
  assert.equal(row.props.style[0].minHeight, 44);
  assert.equal(row.props.style[0].alignItems, 'flex-start');
  assert.equal(input.props.style[0].padding, 0);
  assert.equal(input.props.placeholder, 'Write your own answer');
  assert.equal(input.props.style[0].minHeight, input.props.style[0].lineHeight);
  const hints = f.h.nodes(row, n => n.type === 'Text' && f.h.text(n) === 'Write your own answer');
  assert.equal(hints.length, 0, 'do not duplicate placeholder outside input');
});

test('category 2 blank Send disabled and filled enabled', t => {
  const f = fixture(t); press(f, 'option-row-D'); let tree = f.draw();
  let button = byId(f.h, tree, 'option-send');
  assert.equal(button.props.disabled, true); assert.equal(button.props.accessibilityState.disabled, true);
  assert.equal(f.h.text(button), 'Send');
  button.props.onPress(); assert.equal(f.s.getOptionSession('a').error, null);
  change(f, 'draft'); button = byId(f.h, f.draw(), 'option-send');
  assert.equal(button.props.disabled, false);
});

test('category 3 custom hint explains both keys', t => {
  const f = fixture(t); press(f, 'option-row-D'); const hint = byId(f.h, f.draw(), 'option-hint');
  assert.match(f.h.text(hint), /Enter.*confirm/i); assert.match(f.h.text(hint), /Shift\s*\+\s*Enter.*(?:new line|newline)/i);
  assert.equal(hint.props.style.fontFamily, f.h.tokens.fontUi);
});

test('category 4 focus replaces border', t => {
  const f = fixture(t); let tree = f.draw(); let row = byId(f.h, tree, 'option-row-D'); row.props.onFocus();
  row = byId(f.h, f.draw(), 'option-row-D');
  assert.equal(row.props.style[0].borderColor, f.h.tokens.accent);
  assert.notEqual(row.props.style[1]?.outlineStyle, 'solid');
  press(f, 'option-row-D'); tree = f.draw(); byId(f.h, tree, 'option-custom-input').props.onFocus({ stopPropagation() {} });
  row = byId(f.h, f.draw(), 'option-row-D');
  assert.equal(row.props.style[0].borderColor, f.h.tokens.accent);
  assert.notEqual(row.props.style[1]?.outlineStyle, 'solid');
});

test('category 5 Send confirms draft then navigates or sends exactly once', async t => {
  const f = fixture(t, three); const sent = []; f.s.setOptionSender(async (_agent, text) => { sent.push(text); });
  press(f, 'option-row-A'); press(f, 'option-row-D'); change(f, 'second draft');
  assert.equal(byId(f.h, f.draw(), 'option-send').props.disabled, false);
  press(f, 'option-send'); await new Promise(setImmediate);
  assert.deepEqual(sent, []); assert.equal(f.s.getOptionSession('a').customConfirmed[1], 'second draft');
  assert.equal(f.s.getOptionSession('a').activeQuestion, 2);
  press(f, 'option-row-B'); press(f, 'option-send'); await new Promise(setImmediate);
  assert.deepEqual(sent, ['1A 2D 3B\n\n2D：\nsecond draft']);
  const g = fixture(t); const one = []; g.s.setOptionSender(async (_agent, text) => one.push(text));
  press(g, 'option-row-D'); change(g, 'one draft'); press(g, 'option-send'); await new Promise(setImmediate);
  assert.deepEqual(one, ['1D\n\n1D：\none draft']);
});

test('category 6 parser session sender positive numbering', async t => {
  const f = fixture(t, three); const sent = []; f.s.setOptionSender(async (_agent, text) => sent.push(text));
  f.s.choose('a', 0, 'A'); f.s.openCustom('a', 1); f.s.setCustomDraft('a', 1, 'answer'); f.s.confirmCustom('a', 1); f.s.choose('a', 2, 'C');
  assert.equal(f.s.answerIndex('a'), '1A 2D 3C'); await f.s.sendAnswer('a');
  assert.deepEqual(sent, ['1A 2D 3C\n\n2D：\nanswer']);
  for (const text of [single, '0) Zero?\nA Alpha\nB Beta\nC Gamma\n\nReply: A']) {
    const g = fixture(t, text); g.s.choose('a', 0, 'A'); assert.equal(g.s.answerIndex('a'), '1A');
    const actual = []; g.s.setOptionSender(async (_agent, message) => actual.push(message)); await g.s.sendAnswer('a'); assert.deepEqual(actual, ['1A']);
  }
});

test('category 7 translations supply localized action and key hint', t => {
  const expected = { en: 'Send', 'zh-CN': '发送', ja: '送信' };
  for (const [locale, label] of Object.entries(expected)) {
    const f = fixture(t, single, locale); press(f, 'option-row-D');
    assert.equal(f.h.text(byId(f.h, f.draw(), 'option-send')), label);
    const hint = f.h.text(byId(f.h, f.draw(), 'option-hint'));
    assert.match(hint, /Enter/); assert.match(hint, /Shift\s*\+\s*Enter/);
    const messages = JSON.parse(readFileSync(`client/locales/${locale}.json`, 'utf8'));
    assert.ok(messages.answerCard.hintCustom);
  }
});
