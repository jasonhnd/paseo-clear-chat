const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const questions = '1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A';
const draft = { schema: 1, choices: { 0: 'B' }, customDrafts: {}, customOpen: {}, activeQuestion: 1 };

function fixture(t, data = {}) {
  const h = createToolHarness('web', { agents: { a: { status: 'idle' } } });
  const s = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  s.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
  t.after(() => { s.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens: h.tokens } });
  const control = id => h.nodes(draw(), node => node.props?.testID === id);
  return { h, s, data, draw, control };
}
function replay(f) {
  f.s.publishAssistantReply('a', { at: 10, text: questions });
  f.s.publishUserMessage('a', 11, 'Please wait until tomorrow.');
  f.s.publishAssistantReply('a', { at: 12, text: 'I will wait.' });
}
async function pressContinue(f) {
  const buttons = f.control('option-resume');
  assert.equal(buttons.length, 1, 'waiting card has Continue after a non-card reply');
  buttons[0].props.onPress();
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('waiting card keeps Continue and can resume after a non-card reply', async t => {
  const f = fixture(t);
  f.data[f.s.answerDraftKey('a', 10)] = structuredClone(draft);
  replay(f);
  assert.equal(f.s.getOptionSessionAt('a', 10).followupStatus, 'waiting');
  assert.equal(f.control('option-resume').length, 1);
  assert.equal(await f.s.resumeAnswerDraft('a', 10), true);
  assert.equal(f.s.getOptionSessionAt('a', 10).readOnly, false);
});

test('Continue keeps the card editable when another non-card reply arrives', async t => {
  const f = fixture(t);
  f.data[f.s.answerDraftKey('a', 10)] = structuredClone(draft);
  replay(f);
  await pressContinue(f);
  f.s.publishAssistantReply('a', { at: 13, text: 'Still waiting.' });
  assert.equal(f.s.getOptionSessionAt('a', 10).readOnly, false);
  assert.equal(f.control('option-row-A').length, 1);
  f.control('option-row-A')[0].props.onPress();
  assert.equal(f.s.getOptionSessionAt('a', 10).choices[1], 'A');
});

test('replaying the same draft after reload allows Continue and editing', async t => {
  const data = {};
  const first = fixture(t, data);
  data[first.s.answerDraftKey('a', 10)] = structuredClone(draft);
  replay(first);
  await pressContinue(first);
  const reloaded = fixture(t, data);
  replay(reloaded);
  await pressContinue(reloaded);
  assert.equal(reloaded.s.getOptionSessionAt('a', 10).readOnly, false);
  assert.equal(reloaded.s.getOptionSessionAt('a', 10).choices[0], 'B');
  assert.equal(reloaded.control('option-row-A').length, 1);
});

test('a newer answer card ends the older waiting card and refuses resume', async t => {
  const f = fixture(t);
  f.data[f.s.answerDraftKey('a', 10)] = structuredClone(draft);
  replay(f);
  f.s.publishAssistantReply('a', { at: 14, text: questions });
  assert.equal(f.s.getOptionSessionAt('a', 10).followupStatus, 'ended');
  assert.equal(f.s.getOptionSessionAt('a', 10).readOnly, true);
  assert.equal(f.control('option-resume').length, 0);
  assert.equal(await f.s.resumeAnswerDraft('a', 10), false);
});
