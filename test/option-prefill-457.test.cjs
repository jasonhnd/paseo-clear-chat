const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture({ locked = false } = {}) {
  let value = '', selection = { start: 0, end: 0 }, sent = 0;
  const composer = {
    get prompt() { return value; },
    setPrompt(text) { if (locked) throw Error('locked'); value = text; },
    insertText(text) { if (locked) throw Error('locked'); value = value.slice(0, selection.start) + text + value.slice(selection.end); },
    async focus(options) { if (options?.selection) selection = options.selection; },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { sent++; });
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => byId(h, draw(), id).props.onPress();
  return { h, session, draw, press, set value(text) { value = text; }, get value() { return value; }, get sent() { return sent; } };
}

test('composer prefill handles an unavailable or locked composer visibly and never sends', async t => {
  const f = fixture({ locked: true }); t.after(() => { f.h.unmount(); f.h.dispose(); });
  f.press('option-row-A'); f.press('option-send'); await tick();
  assert.equal(f.value, ''); assert.equal(f.sent, 0);
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /Could not update the composer/);
});

// The answer lives on the first line and any user text stays below it, byte for byte
// (approved design: answers on the first line, original prompt preserved underneath).
test('insertion puts the answer on the first line and keeps existing user text below', async t => {
  const f = fixture(); t.after(() => { f.h.unmount(); f.h.dispose(); });
  f.value = 'my own words';
  f.press('option-row-A'); f.press('option-send'); await tick();
  assert.equal(f.value, '1A\nmy own words');
  assert.equal(f.sent, 0);
});

// Migrated: a first line the user edited is never rewritten; explicit controls replace it.
test('prefill replaces only its own first line, refuses an edited first line and offers both choices', async t => {
  const f = fixture(); t.after(() => { f.h.unmount(); f.h.dispose(); });
  f.press('option-row-A'); f.press('option-send'); await tick(); assert.equal(f.value, '1A');
  f.value = '1A\nUser text'; f.press('option-row-C'); await tick(); assert.equal(f.value, '1C\nUser text');
  f.value = 'Edited\nUser text'; f.press('option-row-B'); await tick(); assert.equal(f.value, 'Edited\nUser text');
  const board = f.draw();
  assert.ok(byId(f.h, board, 'option-replace-first-line'), 'expected the replace-first-line control');
  assert.ok(byId(f.h, board, 'option-keep-edited-first-line'), 'expected the keep-edited-first-line control');
  assert.equal(f.sent, 0);
});
