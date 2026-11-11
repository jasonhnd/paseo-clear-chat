const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(t, initial = '') {
  let value = initial, onFocus = () => {}, writes = [];
  const composer = {
    get prompt() { return value; },
    setPrompt(text) { writes.push(text); value = text; },
    async focus() { onFocus(); },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const node = id => h.nodes(draw(), n => n.props.testID === id)[0];
  const press = id => { const n = node(id); assert.ok(n, id); n.props.onPress(); };
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, node, press, writes, get value() { return value; }, set value(v) { value = v; }, set onFocus(fn) { onFocus = fn; } };
}

test('explicit replacement preserves the remainder and keep leaves the edit in place', async t => {
  const f = fixture(t, 'body\r\n\n雪  ');
  f.press('option-row-A'); f.press('option-send'); await tick();
  f.value = 'my edit\nbody\r\n\n雪  ';
  f.press('option-row-C'); await tick();
  assert.match(f.h.text(f.node('option-prefill-status')), /Selected 1C.*edited/);
  f.press('option-replace-first-line'); await tick();
  assert.equal(f.value, '1C\nbody\r\n\n雪  ');
  f.value = 'another edit\nbody\r\n\n雪  ';
  f.press('option-row-B'); await tick();
  f.press('option-keep-edited-first-line');
  assert.equal(f.value, 'another edit\nbody\r\n\n雪  ');
  assert.equal(f.node('option-replace-first-line'), undefined);
});

test('a change during focus or before explicit replacement is never overwritten', async t => {
  const f = fixture(t, 'original');
  f.onFocus = () => { f.value = 'changed during focus'; };
  f.press('option-row-A'); f.press('option-send'); await tick();
  assert.equal(f.value, 'changed during focus');
  assert.equal(f.writes.length, 0);
  assert.match(f.h.text(f.node('option-prefill-notice')), /just changed/);
  f.onFocus = () => {};
  f.press('option-send'); await tick();
  assert.equal(f.value, '1A\nchanged during focus');
  f.value = 'edited\nchanged during focus';
  f.press('option-row-C'); await tick();
  f.value = 'edited again\nchanged during focus';
  f.press('option-replace-first-line'); await tick();
  assert.equal(f.value, 'edited again\nchanged during focus');
  assert.equal(f.writes.length, 1);
  assert.match(f.h.text(f.node('option-prefill-notice')), /just changed/);
});

test('confirming a custom choice updates the first line with the complete formatted answer', async t => {
  const f = fixture(t, 'user text\r\n');
  f.press('option-row-A'); f.press('option-send'); await tick();
  f.press('option-row-D');
  f.node('option-custom-input').props.onChangeText('  雪\r\nsecond line  ');
  f.press('option-custom-confirm'); await tick();
  assert.equal(f.value, '1D\n\n1D：\n  雪\r\nsecond line  \nuser text\r\n');
});
