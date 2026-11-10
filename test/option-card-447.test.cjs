const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function fixture(t, reply = '0) Zero question?\nA Alpha\nB Beta\nC Gamma\n\nReply: A') {
  const h = createToolHarness('web', { width: 1280, agents: { a: { status: 'idle' } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  s.publishAssistantReply('a', { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 10, tokens: h.tokens } });
  return { h, s, draw };
}

test('447 numbering: explicit zero displays the actual question without Q0', t => {
  const { h, draw } = fixture(t);
  const tab = h.text(byId(h, draw(), 'option-question-0'));
  assert.doesNotMatch(tab, /Q0\b/);
  assert.match(tab, /Zero question/);
});

test('447 input: prompt is placeholder and empty field is one line before growth', t => {
  const { h, draw } = fixture(t);
  byId(h, draw(), 'option-row-D').props.onPress();
  let input = byId(h, draw(), 'option-custom-input');
  assert.equal(input.props.placeholder, 'Write your own answer');
  assert.equal(input.props.value, '');
  assert.equal(input.props.style[0].height, 44);
  assert.equal(input.props.style[0].lineHeight, 20);
  input.props.onChangeText('synthetic first line\nsynthetic second line');
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } });
  input = byId(h, draw(), 'option-custom-input');
  assert.equal(input.props.value, 'synthetic first line\nsynthetic second line');
  assert.equal(input.props.style[0].height, 60);
});

test('447 focus: selected custom row has one emphasis and visible keyboard focus', t => {
  const { h, draw } = fixture(t);
  byId(h, draw(), 'option-row-D').props.onPress();
  let input = byId(h, draw(), 'option-custom-input');
  input.props.onFocus({ stopPropagation() {} });
  const tree = draw();
  const row = byId(h, tree, 'option-row-D');
  input = byId(h, tree, 'option-custom-input');
  assert.equal(row.props.accessibilityState.selected, true);
  assert.notEqual(row.props.style[1].outlineStyle, 'solid');
  assert.notEqual(input.props.style[1]?.outlineStyle, 'solid');
  assert.equal(row.props.style[0].borderColor, h.tokens.accent);
  assert.equal(row.props.style[0].borderWidth, 2);
});
