'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const two = `1) Which storage?
A Server
B File

2) Ship now?
A Yes
B No

Reply with a letter for each.`;
const one = `1) Which schedule?
A Morning
B Evening

Reply with a letter.`;

function open(t, reply = two) {
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } } });
  const s = h.load('client/option-session.ts');
  const data = {};
  s.setAnswerDraftStore({
    read: key => data[key],
    write: (key, value) => { data[key] = value; },
    clear: key => { delete data[key]; },
  });
  t.after(() => { s.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  data[s.answerDraftKey('a', 10)] = { schema: 1, choices: { 0: 'A' }, customDrafts: {}, customOpen: {}, activeQuestion: 0 };
  s.publishAssistantReply('a', { at: 10, text: reply });
  return { s, data, card: () => s.getOptionSessionAt('a', 10) };
}

function say(opened, text) {
  opened.s.publishUserMessage('a', 11, text);
  return opened.card();
}

test('a saved draft survives an ordinary sentence that contains a bare letter', t => {
  const opened = open(t);
  const card = say(opened, 'wait a moment');
  assert.equal(card.followupStatus, 'waiting');
  assert.equal(card.choices[0], 'A');
  assert.equal(card.readOnly && !card.followupStatus, false);
  assert.equal(opened.data[opened.s.answerDraftKey('a', 10)].choices['0'], 'A');
});

test('I pick a please is an ordinary message', t => {
  const card = say(open(t), 'I pick a please');
  assert.equal(card.followupStatus, 'waiting');
  assert.equal(card.choices[0], 'A');
  assert.equal(card.readOnly && !card.followupStatus, false);
});

test('Option A is an ordinary message', t => {
  const card = say(open(t), 'Option A');
  assert.equal(card.followupStatus, 'waiting');
  assert.equal(card.choices[0], 'A');
  assert.equal(card.readOnly && !card.followupStatus, false);
});

test('a whole message of numbered choices is answered', t => {
  const card = say(open(t), '1A 2B');
  assert.equal(card.readOnly, true);
  assert.equal(card.followupStatus, undefined);
  assert.equal(card.choices[0], 'A');
  assert.equal(card.choices[1], 'B');
});

test('a numbered token inside a sentence is still an answer shape', t => {
  const card = say(open(t), 'use 1A for now');
  assert.equal(card.readOnly, true);
  assert.equal(card.followupStatus, undefined);
});

test('a numbered token keeps its answer shape after trailing punctuation', t => {
  const card = say(open(t), '1A.');
  assert.equal(card.readOnly, true);
  assert.equal(card.followupStatus, undefined);
});

test('a single-question card answered with only b is answered', t => {
  const card = say(open(t, one), 'b');
  assert.equal(card.readOnly, true);
  assert.equal(card.followupStatus, undefined);
  assert.equal(card.choices[0], 'B');
});

test('a Chinese ordinary message keeps the saved draft', t => {
  const opened = open(t);
  const card = say(opened, '等一下');
  assert.equal(card.followupStatus, 'waiting');
  assert.equal(card.choices[0], 'A');
  assert.equal(card.readOnly && !card.followupStatus, false);
  assert.equal(opened.data[opened.s.answerDraftKey('a', 10)].choices['0'], 'A');
});
