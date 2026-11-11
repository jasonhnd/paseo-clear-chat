const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const oracle = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'oracle-457.json'), 'utf8'));

test('changing the choice replaces the whole recorded answer block, including a multi-line custom answer', async t => {
  let value = '', selection = { start: 0, end: 0 }, sent = 0;
  const composer = {
    get prompt() { return value; },
    setPrompt(text) { value = text; },
    insertText(text) { value = value.slice(0, selection.start) + text + value.slice(selection.end); },
    async focus(options) { if (options?.selection) selection = options.selection; },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { sent++; });
  const mixed = oracle.find(entry => entry.id === 'mixed');
  session.publishAssistantReply('a', { at: 1, text: mixed.reply });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, 'missing control ' + id); node.props.onPress(); };
  t.after(() => { h.unmount(); h.dispose(); });

  session.choose('a', 0, 'B');
  session.setCustomDraft('a', 1, mixed.answers[1].content);
  assert.equal(session.confirmCustom('a', 1), 'confirmed');
  press('option-send');
  await tick();
  assert.equal(value, mixed.message, 'the complete formatter message is the recorded block');

  press('option-row-A');
  press('option-send');
  await tick();
  assert.equal(value, '1A', 'replacing the recorded block must not leave any line of the previous multi-line answer behind');
  assert.equal(sent, 0);
});
