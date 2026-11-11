const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
test('a draft from before answer blocks is first-inserted above the existing text', async t => {
  let value = '1A\nkeep', writes = 0;
  const stored = { preferences: {}, legacyMigrated: true, answerDrafts: { 'a\u00001': { schema: 1, choices: { 0: 'A' }, customDrafts: {}, customOpen: {}, activeQuestion: 0 } } };
  const host = { async rpc(contract) { assert.equal(contract.name, 'settings.presentation.read'); return { status: 'ready', revision: '0', values: structuredClone(stored) }; } };
  const composer = { get prompt() { return value; }, setPrompt(text) { value = text; writes++; }, insertText() { assert.fail('unexpected insertion'); }, async focus() {} };
  const h = createToolHarness('ios', { presentationHost: host, agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  t.after(() => { h.unmount(); h.dispose(); });
  const prefs = h.load('client/preferences.ts');
  for (let i = 0; i < 20 && !prefs.areEnhancerPreferencesReady(); i++) await tick();
  assert.equal(prefs.areEnhancerPreferencesReady(), true);
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const find = (id) => h.nodes(draw(), node => node.props.testID === id)[0];
  find('option-row-B').props.onPress();
  assert.equal(value, '1B\n1A\nkeep');
  assert.equal(writes, 1);
  assert.equal(find('option-replace-first-line'), undefined);
  assert.equal(find('option-keep-edited-first-line'), undefined);
});
