const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
function load(t) {
  const h = createToolHarness('web', { agents: { a: { status: 'idle' } }, presentationHost: {} });
  t.after(() => { h.unmount(); h.dispose(); });
  return h.load('client/components/answer-style-control.tsx');
}
test('the style adds the approved instruction only to the first inserted line', t => {
  const m = load(t);
  assert.equal(m.composeAnswerText('1B\n第二行', 'none'), '1B\n第二行');
  assert.equal(m.composeAnswerText('1B\n第二行', 'concise'), '1B Answer briefly.\n第二行');
  assert.equal(m.composeAnswerText('   ', 'none'), '');
});
test('the formatter returns text without controlling the composer', t => {
  const m=load(t);assert.equal(m.composeAnswerText('1B\n2A','formal'),'1B Use a formal tone.\n2A');assert.equal(typeof m.insertAnswer,'undefined');
});
test('registration is guarded on the beta composer API', t => {
  const m=load(t);assert.equal(m.answerStyleSupported({}),false);assert.equal(m.answerStyleSupported(null),false);assert.equal(m.answerStyleSupported({addComposerItem:()=>()=>{}}),true);
});
test('choosing a style changes later insertions without sending', t => {
  const m=load(t);const calls=[];
  m.setAnswerStyle('concise');assert.equal(m.getAnswerStyle(),'concise');calls.push(m.composeAnswerText('第一行\n第二行'));
  m.setAnswerStyle('formal');calls.push(m.composeAnswerText('第一行\n第二行'));
  assert.deepEqual(calls,['第一行 Answer briefly.\n第二行','第一行 Use a formal tone.\n第二行']);
});
