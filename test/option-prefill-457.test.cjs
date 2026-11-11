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

test('prefill replaces only its first line and refuses an edited first line', async t => {
  const f = fixture(); t.after(() => { f.h.unmount(); f.h.dispose(); });
  f.press('option-row-A'); f.press('option-send'); await tick(); assert.equal(f.value, '1A');
  f.value = '1A\nUser text'; f.press('option-row-C'); await tick(); assert.equal(f.value, '1C\nUser text');
  f.value = 'Edited\nUser text'; f.press('option-row-B'); await tick(); assert.equal(f.value, 'Edited\nUser text');
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /first line was edited/); assert.equal(f.sent, 0);
});
