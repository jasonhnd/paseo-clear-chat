const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

function restore(t, headers, message) {
  const h = createToolHarness('web');
  const s = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  t.after(() => { h.unmount(); h.dispose(); });
  const text = headers.map(header => `${header}\nA Alpha\nB Beta`).join('\n\n') + '\n\nReply: A';
  s.publishUserMessage('a', 20, message);
  s.publishAssistantReply('a', { at: 10, text });
  return { h, session: s.getOptionSession('a', 10), Card };
}

for (const [name, headers, message] of [
  ['legacy zero-based', ['0. First?', '1. Second?'], '0B 1A'],
  ['current numbering', ['1. First?', '2. Second?'], '1B 2A'],
]) test(`restores ${name} ordinary answers and renders the selected row`, t => {
  const { h, session, Card } = restore(t, headers, message);
  assert.deepEqual(session.set.questions.map(q => q.number), headers.map(h => Number(h[0])));
  assert.equal(session.readOnly, true);
  assert.equal(session.answeredText, message);
  assert.deepEqual(session.choices, { 0: 'B', 1: 'A' });
  const tree = h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens: h.tokens } });
  const row = h.nodes(tree, node => node.props.testID === 'option-row-B')[0];
  assert.equal(row.props.accessibilityState.selected, true);
  assert.match(h.text(row), /✓/);
});

test('unmatched and ambiguous identifiers remain unanswered', t => {
  for (const [headers, message] of [
    [['0. First?', '1. Second?'], '8B 9A'],
    [['0. First?', '0. Second?'], '0B'],
    [['0. First?', '1. Second?'], '0B 0A'],
  ]) {
    const { session } = restore(t, headers, message);
    assert.equal(session.answeredText, message);
    assert.deepEqual(session.choices, {});
  }
});

test('current identifiers take precedence over legacy identifiers', t => {
  const { session } = restore(t, ['0. First?', '1. Second?'], '1B');
  assert.equal(session.answeredText, '1B');
  assert.deepEqual(session.choices, { 0: 'B' });
});
