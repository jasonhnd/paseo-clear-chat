const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const h = createToolHarness('web', { agents: { a: { status: 'idle' } } });
const s = h.load('client/option-session.ts');
const Card = h.load('client/components/option-card.tsx').OptionCard;
test.after(() => { h.unmount(); h.dispose(); });
const choices = 'A Alpha\nB Beta\nC Gamma';
function textFor(headers) { return headers.map(header => `${header}\n${choices}`).join('\n\n') + '\n\nReply: A'; }
for (const [name, headers, numbers] of [
  ['consecutive', ['1) First?', '2) Second?', '3) Third?'], [1, 2, 3]],
  ['nonconsecutive', ['2) First?', '5) Second?', '7) Third?'], [2, 5, 7]],
  ['mixed', ['Z9 First?', '1) Second?', 'A3 Third?'], [1, 2, 3]],
  ['unnumbered', ['First?'], [1]],
  ['zero', ['0) First?', '5) Second?', '7) Third?'], [1, 2, 3]],
  ['duplicate', ['1) First?', '1) Second?', '3) Third?'], [1, 2, 3]],
]) test(`whole-card numbering: ${name}`, async () => {
  const agent = name;
  s.publishAssistantReply(agent, { at: 10, text: textFor(headers) });
  const session = s.getOptionSession(agent);
  assert.equal(session.set.questions.length, headers.length);
  const tree = h.draw({ type: Card, props: { agentId: agent, at: 10, tokens: h.tokens } });
  for (let i = 0; i < numbers.length; i++) {
    const tab = h.nodes(tree, n => n.props.testID === `option-question-${i}`)[0];
    assert.match(h.text(tab), new RegExp(`^Q${numbers[i]} ·`));
  }
  if (numbers.length === 1) s.choose(agent, 0, 'A');
  else for (let i = 0; i < numbers.length; i++) {
    if (i === 1) { s.openCustom(agent, i); s.setCustomDraft(agent, i, 'draft\nsecond line'); s.confirmCustom(agent, i); }
    else s.choose(agent, i, name === 'mixed' ? 'D' : 'A');
  }
  // Mixed uses identical answer letters while retaining the middle custom content.
  if (name === 'mixed') {
    for (const i of [0, 2]) { s.openCustom(agent, i); s.setCustomDraft(agent, i, `content ${i}`); s.confirmCustom(agent, i); }
  }
  const index = numbers.map((number, i) => `${number}${numbers.length === 1 ? 'A' : i === 1 || name === 'mixed' ? 'D' : 'A'}`).join(' ');
  assert.equal(s.answerIndex(agent), index);
  const sent = []; s.setOptionSender(async (_agent, message) => sent.push(message));
  await s.sendAnswer(agent);
  const blocks = numbers.length === 1 ? '' : name === 'mixed' ? `\n\n1D：\ncontent 0\n\n2D：\ndraft\nsecond line\n\n3D：\ncontent 2` : `\n\n${numbers[1]}D：\ndraft\nsecond line`;
  assert.deepEqual(sent, [index + blocks]);
  console.log(JSON.stringify({ case: name, parsed: session.set.questions.map(question => question.number), displayed: numbers, index: s.answerIndex(agent), sent: sent[0] }));
});
