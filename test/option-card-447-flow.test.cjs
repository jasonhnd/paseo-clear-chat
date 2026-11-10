const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];

for (const platform of ['web', 'ios']) {
  test(`447 ${platform}: accessible custom confirmation and original choices`, t => {
    const h = createToolHarness(platform, { width: 390, agents: { a: { status: 'idle' } } });
    t.after(() => { h.unmount(); h.dispose(); });
    const s = h.load('client/option-session.ts');
    const Card = h.load('client/components/option-card.tsx').OptionCard;
    s.publishAssistantReply('a', { at: 10, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
    const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens: h.tokens } });
    for (const letter of ['A', 'B', 'C']) {
      byId(h, draw(), `option-row-${letter}`).props.onPress();
      assert.equal(s.getOptionSession('a').choices[0], letter);
    }
    byId(h, draw(), 'option-row-D').props.onPress();
    let tree = draw();
    const row = byId(h, tree, 'option-row-D');
    assert.equal(row.props.accessibilityState.selected, true);
    if (platform === 'web') assert.equal(row.props['aria-pressed'], true);
    const input = byId(h, tree, 'option-custom-input');
    const button = byId(h, tree, 'option-custom-confirm');
    assert.equal(input.props.accessibilityLabel, 'Other');
    assert.equal(button.props.accessibilityRole, 'button');
    button.props.onPress();
    tree = draw();
    assert.equal(h.text(byId(h, tree, 'option-custom-empty')), 'Write your answer first');
    assert.equal(byId(h, tree, 'option-custom-empty').props.accessibilityLiveRegion, 'polite');
    assert.equal(s.answerText('a'), null);
    byId(h, tree, 'option-custom-input').props.onChangeText('synthetic answer');
    byId(h, draw(), 'option-custom-confirm').props.onPress();
    assert.equal(s.getOptionSession('a').choices[0], 'D');
    assert.equal(s.answerText('a'), 'D\n\nD：\nsynthetic answer');
  });
}

test('447 synthetic numbering and actual sender mapping', async t => {
  const h = createToolHarness('web');
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load('client/option-session.ts');
  const sent = [];
  s.setOptionSender(async (agent, message) => { sent.push({ agent, message }); });
  for (const [agent, text, choice, expected] of [
    ['unnumbered', 'Pick?\nA Alpha\nB Beta\n\nReply: A', 'A', 'A'],
    ['zero', '0) Zero?\nA Alpha\nB Beta\n\nReply: A', 'A', '0A'],
    ['seven', '7) Seven?\nA Alpha\nB Beta\n\nReply: A', 'B', '7B'],
  ]) {
    s.publishAssistantReply(agent, { at: 1, text });
    const before = s.getOptionSession(agent);
    assert.equal(before.activeQuestion, 0);
    s.choose(agent, 0, choice);
    assert.equal(s.answerIndex(agent), expected);
    assert.equal(s.answerText(agent), expected);
    await s.sendAnswer(agent);
    assert.deepEqual(sent.at(-1), { agent, message: expected });
    console.log(JSON.stringify({ synthetic: true, agent, rawIndex: 0, parsedNumber: before.set.questions[0].number, choice, answerIndex: expected, sent: sent.at(-1).message }));
  }
  const agent = 'custom-zero';
  s.publishAssistantReply(agent, { at: 1, text: '0) Zero?\nA Alpha\nB Beta\n\nReply: A' });
  s.openCustom(agent, 0);
  s.setCustomDraft(agent, 0, 'synthetic text\nsecond line');
  assert.equal(s.confirmCustom(agent, 0), 'confirmed');
  assert.equal(s.getOptionSession(agent).choices[0], 'C');
  assert.equal(s.answerIndex(agent), '0C');
  assert.equal(s.answerText(agent), '0C\n\n0C：\nsynthetic text\nsecond line');
  await s.sendAnswer(agent);
  assert.equal(sent.at(-1).message, s.getOptionSession(agent).answeredText);
  console.log(JSON.stringify({ synthetic: true, agent, rawIndex: 0, parsedNumber: 0, choice: 'C', answerIndex: '0C', sent: sent.at(-1).message }));
});
