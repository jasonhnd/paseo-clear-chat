const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The card sends the answer itself. A host that offers a composer must not
// receive the answer: the old path wrote it into the input box and left the
// button looking dead, so the product sends directly instead.
function fixture(t, { write, platform = 'ios' } = {}) {
  const calls = [];
  let value = 'already typed';
  const composer = {
    get prompt() { return value; },
    setPrompt(text) { calls.push('setPrompt'); if (write) return write(); value = text; },
    insertText(text) { calls.push('insertText'); value += text; },
    async focus() {},
  };
  const h = createToolHarness(platform, { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  t.after(() => { h.unmount(); h.dispose(); });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  const sent = [];
  session.setOptionSender(async (agentId, text) => { sent.push(text); });
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, `missing ${id}`); node.props.onPress(); };
  return { h, session, draw, press, calls, sent, get value() { return value; }, set value(next) { value = next; } };
}

test('the main button sends the answer directly while a composer is available', async t => {
  const f = fixture(t);
  f.press('option-row-A');
  f.press('option-send');
  await tick();
  assert.deepEqual(f.sent, ['1A']);
  assert.deepEqual(f.calls, [], 'the answer must not be written into the composer');
  assert.equal(f.value, 'already typed', 'the draft in the input box stays as the user left it');
});

test('choosing an answer does not write the composer', async t => {
  const f = fixture(t);
  f.press('option-row-B');
  await tick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.value, 'already typed');
  assert.equal(f.sent.length, 0);
  assert.equal(byId(f.h, f.draw(), 'option-prefill-status'), undefined);
});

test('a composer that refuses a write cannot block the send', async t => {
  const f = fixture(t, { write: () => { throw Error('locked'); } });
  f.press('option-row-C');
  f.press('option-send');
  await tick();
  assert.deepEqual(f.sent, ['1C']);
  assert.deepEqual(f.calls, []);
  assert.equal(byId(f.h, f.draw(), 'option-prefill-notice'), undefined);
  assert.equal(byId(f.h, f.draw(), 'option-replace-first-line'), undefined);
});

test('a written answer is sent as the composed text without touching the composer', async t => {
  const f = fixture(t);
  f.session.setCustomDraft('a', 0, 'first\nsecond');
  assert.equal(f.session.confirmCustom('a', 0), 'confirmed');
  f.press('option-send');
  await tick();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].startsWith('1D\n\n1D：\nfirst\nsecond'), JSON.stringify(f.sent[0]));
  assert.deepEqual(f.calls, []);
});

test('the button and its hint use the send wording', async t => {
  const f = fixture(t, { platform: 'web' });
  f.press('option-row-A');
  assert.equal(f.h.text(byId(f.h, f.draw(), 'option-send')), 'Send 1A');
  byId(f.h, f.draw(), 'option-send').props.onFocus();
  assert.equal(f.h.text(byId(f.h, f.draw(), 'option-hint')), '↵ send');
  assert.equal(f.sent.length, 0);
});
