const assert = require('node:assert/strict');
const test = require('node:test');
const oracle = require('./fixtures/oracle-457.json');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function mount(initial) {
  let value = initial, selection = { start: 0, end: 0 }, sent = 0;
  const composer = {
    get prompt() { return value; },
    setPrompt(text) { value = text; },
    insertText(text) { value = value.slice(0, selection.start) + text + value.slice(selection.end); },
    async focus(options) { if (options?.selection) selection = options.selection; },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const prefs = h.load('client/preferences.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  const mixed = oracle.find(entry => entry.id === 'mixed');
  session.setOptionSender(async () => { sent++; });
  session.publishAssistantReply('a', { at: 1, text: mixed.reply });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, `missing control ${id}`); node.props.onPress(); };
  return { h, session, prefs, mixed, press, composer, get value() { return value; }, get sent() { return sent; } };
}

test('mixed two-question block: stored block is the whole inserted message and reselect replaces it', async () => {
  const m = mount('');
  const expected = '1A 2E\n\n2E：\n  雪：🌸\n第二行，句号。  \n';
  m.session.choose('a', 0, 'B');
  m.session.setCustomDraft('a', 1, m.mixed.answers[1].content);
  assert.equal(m.session.confirmCustom('a', 1), 'confirmed');
  m.press('option-send'); await tick();
  assert.equal(m.value, m.mixed.message);
  assert.equal(m.prefs.getOptionAnswerDraft('a', 1)?.block, m.mixed.message);
  m.press('option-question-0');
  m.press('option-row-A');
  m.press('option-send'); await tick();
  assert.equal(m.value, expected);
  assert.equal(m.sent, 0);
  m.h.unmount(); m.h.dispose();
});

test('mixed two-question block: reselect preserves an existing user suffix', async () => {
  const m = mount('my own words');
  const expected = '1A 2E\n\n2E：\n  雪：🌸\n第二行，句号。  \n\nmy own words';
  m.session.choose('a', 0, 'B');
  m.session.setCustomDraft('a', 1, m.mixed.answers[1].content);
  assert.equal(m.session.confirmCustom('a', 1), 'confirmed');
  m.press('option-send'); await tick();
  assert.equal(m.value, `${m.mixed.message}\nmy own words`);
  m.press('option-question-0');
  m.press('option-row-A');
  m.press('option-send'); await tick();
  assert.equal(m.value, expected);
  assert.equal(m.sent, 0);
  m.h.unmount(); m.h.dispose();
});

test('mixed two-question block: edited previous block is not overwritten', async () => {
  const m = mount('my own words');
  m.session.choose('a', 0, 'B');
  m.session.setCustomDraft('a', 1, m.mixed.answers[1].content);
  assert.equal(m.session.confirmCustom('a', 1), 'confirmed');
  m.press('option-send'); await tick();
  const edited = '1X 2E' + m.mixed.message.slice(5) + '\nmy own words';
  m.composer.setPrompt(edited);
  const before = m.value;
  m.press('option-question-0');
  m.press('option-row-A');
  m.press('option-send'); await tick();
  assert.equal(m.value, before);
  m.h.unmount(); m.h.dispose();
});
