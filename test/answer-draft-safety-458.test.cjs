const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const reply = '1) First?\nA One\nB Two\n\n2) Second?\nA Yes\nB No\n\nReply: A';
const draft = { schema: 1, choices: { 0: 'B' }, customDrafts: {}, customOpen: {}, activeQuestion: 1 };
const flush = () => new Promise(setImmediate);

function setup(t) {
  const h = createToolHarness('web');
  const s = h.load('client/option-session.ts');
  t.after(() => { s.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  return s;
}

test('resume requires an explicit stable click and remains isolated', async t => {
  const s = setup(t), data = {};
  data[s.answerDraftKey('a', 10)] = structuredClone(draft);
  data[s.answerDraftKey('a', 20)] = { ...draft, choices: { 0: 'A' } };
  data[s.answerDraftKey('b', 10)] = structuredClone(draft);
  s.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; } });
  for (const [id, at] of [['a', 10], ['b', 10]]) {
    s.publishAssistantReply(id, { at, text: reply });
    s.publishUserMessage(id, at + 1, 'Please wait until tomorrow.');
    assert.equal(s.getOptionSessionAt(id, at).readOnly, true);
  }
  const oldClick = s.resumeAnswerDraft('a', 10);
  s.publishAssistantReply('a', { at: 20, text: reply });
  s.publishUserMessage('a', 21, 'Please wait until tomorrow.');
  assert.equal(await oldClick, false);
  assert.equal(await s.resumeAnswerDraft('a', 10), false);
  assert.equal(await s.resumeAnswerDraft('b', 10), true);
  s.choose('b', 1, 'A', 10);
  assert.equal(s.getOptionSessionAt('b', 10).choices[1], 'A');
  assert.equal(s.getOptionSessionAt('a', 20).readOnly, true);
  assert.equal(s.getOptionSessionAt('a', 10).readOnly, true);
  assert.equal(s.getOptionSessionAt('a', 20).choices[0], 'A');
  assert.equal(s.getOptionSessionAt('a', 10).choices[1], undefined);
  const click = s.resumeAnswerDraft('a', 20);
  data[s.answerDraftKey('a', 20)] = { ...draft, choices: { 0: 'B' } };
  assert.equal(await click, false);
  assert.equal(s.getOptionSessionAt('a', 20).readOnly, true);
});

test('resume waits for the pending write and rejects a failed write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup(t), data = {};
  let settle;
  let reject;
  s.setAnswerDraftStore({
    read: key => data[key],
    write: (key, value) => new Promise((resolve, fail) => {
      settle = () => { data[key] = value; resolve(); };
      reject = fail;
    }),
  });
  s.publishAssistantReply('a', { at: 10, text: reply });
  s.choose('a', 0, 'B');
  s.publishUserMessage('a', 11, 'Please wait until tomorrow.');
  const click = s.resumeAnswerDraft('a', 10);
  let finished = false;
  click.then(() => { finished = true; });
  t.mock.timers.tick(400);
  await flush();
  assert.equal(finished, false);
  settle();
  assert.equal(await click, true);
  s.choose('a', 1, 'A', 10);
  s.publishUserMessage('a', 12, 'Please wait again.');
  // Reconcile the next card independently, so its write can fail while awaited.
  s.publishAssistantReply('b', { at: 20, text: reply });
  s.choose('b', 0, 'A');
  s.publishUserMessage('b', 21, 'Please wait until tomorrow.');
  const failedClick = s.resumeAnswerDraft('b', 20);
  t.mock.timers.tick(400);
  await flush();
  reject(new Error('write failed'));
  assert.equal(await failedClick, false);
  assert.equal(s.getOptionSessionAt('b', 20).readOnly, true);
});

test('host draft cache is unavailable during a write and after failure until a fresh read', async t => {
  let values = { preferences: {}, legacyMigrated: true, answerDrafts: {} }, revision = 0;
  let fail = false;
  const rpc = async (contract, input) => {
    if (contract.name.endsWith('.read')) return { status: 'ready', revision: String(revision), values: structuredClone(values) };
    if (fail) throw new Error('host failure');
    values = structuredClone(input.values);
    return { status: 'saved', revision: String(++revision), values: structuredClone(values) };
  };
  const h = createToolHarness('web', { presentationHost: true });
  t.after(() => { h.unmount(); h.dispose(); });
  const p = h.load('client/preferences.ts');
  await p.initializeEnhancerPreferences(rpc);
  await p.storeAnswerDraft('a\0x', draft);
  fail = true;
  const failed = p.storeAnswerDraft('a\0x', { ...draft, choices: { 0: 'A' } });
  assert.throws(() => p.getStoredAnswerDraft('a\0x'));
  await assert.rejects(failed);
  assert.throws(() => p.getStoredAnswerDraft('a\0x'));
  fail = false;
  await p.retryEnhancerPreferences();
  assert.deepEqual(p.getStoredAnswerDraft('a\0x'), draft);
  // This is a real fire-and-forget caller: dismiss invokes the settings queue.
  const s = h.load('client/option-session.ts');
  s.publishAssistantReply('a', { at: 10, text: reply });
  fail = true;
  s.dismiss('a', 10);
  await p.updateEnhancerPreferences({ assistantMarkdown: false });
  fail = false;
  await p.updateEnhancerPreferences({ assistantMarkdown: true });
  assert.equal(values.preferences.assistantMarkdown, true);
});
