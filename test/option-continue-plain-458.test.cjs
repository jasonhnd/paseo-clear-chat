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
  return { h, s, data, draw: () => h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens: h.tokens } }) };
}
function replay(f) {
  f.s.publishAssistantReply('a', { at: 10, text: questions });
  f.s.publishUserMessage('a', 11, 'Please wait until tomorrow.');
  f.s.publishAssistantReply('a', { at: 12, text: 'I will wait.' });
}
function node(f, id) {
  return f.h.nodes(f.draw(), n => n.props?.testID === id)[0];
}
async function pressContinue(f) {
  const control = node(f, 'option-resume');
  assert.ok(control, 'waiting card offers Continue');
  control.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.s.getOptionSessionAt('a', 10).readOnly, false);
}
function assertEditable(f) {
  const row = node(f, 'option-row-A');
  assert.equal(typeof row?.props.onPress, 'function', 'answer row is interactive');
  row.props.onPress();
  assert.equal(f.s.getOptionSessionAt('a', 10).choices[1], 'A');
}
function dataWithDraft() { return { ['a\0' + 10]: structuredClone(draft) }; }

test('a plain reply preserves both resume and the Continue control', async t => {
  const f = fixture(t, dataWithDraft());
  replay(f);
  assert.equal(f.s.getOptionSessionAt('a', 10).followupStatus, 'waiting');
  assert.ok(node(f, 'option-resume'), 'Continue remains visible after a plain reply');
  assert.equal(await f.s.resumeAnswerDraft('a', 10), true);
});

test('after Continue, another plain reply leaves the card editable', async t => {
  const f = fixture(t, dataWithDraft());
  replay(f);
  await pressContinue(f);
  f.s.publishAssistantReply('a', { at: 13, text: 'Still waiting.' });
  assertEditable(f);
});

test('replaying the same draft and history after reload permits editing', async t => {
  const data = dataWithDraft();
  const first = fixture(t, data);
  replay(first);
  await pressContinue(first);
  const reloaded = fixture(t, data);
  replay(reloaded);
  assert.equal(reloaded.s.getOptionSessionAt('a', 10).choices[0], 'B');
  await pressContinue(reloaded);
  assertEditable(reloaded);
});

test('a newer answer card ends the older card and blocks resume', async t => {
  const f = fixture(t, dataWithDraft());
  replay(f);
  f.s.publishAssistantReply('a', { at: 13, text: questions });
  assert.equal(f.s.getOptionSessionAt('a', 10).followupStatus, 'ended');
  assert.equal(f.s.getOptionSessionAt('a', 10).readOnly, true);
  assert.equal(node(f, 'option-resume'), undefined);
  assert.equal(await f.s.resumeAnswerDraft('a', 10), false);
});
