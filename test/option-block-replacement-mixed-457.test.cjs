// Regression for #476: the recorded block is the whole composed message, so a
// reselect on a mixed card must replace every byte of it and keep the reader's
// own suffix. Test-only: no product code is changed by this file.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const oracle = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'oracle-457.json'), 'utf8'));
const mixed = oracle.find(entry => entry.id === 'mixed');
const customContent = mixed.answers[1].content;
const firstBlock = mixed.message; // '1B 2E\n\n2E：\n' + customContent
const reselectedBlock = `1A 2E\n\n2E：\n${customContent}`;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];

function fixture(t) {
  let value = '';
  let sent = 0;
  let selection = { start: 0, end: 0 };
  const composer = {
    get prompt() { return value; },
    setPrompt(text) { value = text; },
    insertText(text) { value = value.slice(0, selection.start) + text + value.slice(selection.end); },
    async focus(options) { if (options?.selection) selection = options.selection; },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { sent++; });
  session.publishAssistantReply('a', { at: 1, text: mixed.reply });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => {
    const node = byId(h, draw(), id);
    assert.ok(node, `missing control ${id}`);
    node.props.onPress();
  };
  const answerMixed = () => {
    session.choose('a', 0, 'B');
    session.setCustomDraft('a', 1, customContent);
    assert.equal(session.confirmCustom('a', 1), 'confirmed');
  };
  t.after(() => { h.unmount(); h.dispose(); });
  return {
    h, session, press, answerMixed,
    get value() { return value; },
    set value(next) { value = next; },
    get sent() { return sent; },
  };
}

test('the recorded block is the whole mixed message, not only its index line', async t => {
  const f = fixture(t);
  f.answerMixed();
  f.press('option-send');
  await tick();
  assert.equal(f.value, firstBlock);
  assert.ok(f.value.startsWith('1B 2E'), 'the block starts with the composed index');
  assert.ok(f.value.includes(customContent), 'the block carries the multi-line custom answer');
  assert.equal(f.sent, 0);
});

test('reselecting Q1 replaces the whole recorded block and leaves no old line behind', async t => {
  const f = fixture(t);
  f.answerMixed();
  f.press('option-send');
  await tick();
  assert.equal(f.value, firstBlock);

  f.press('option-question-0'); // switching the answer moves the card to Q2
  await tick();
  f.press('option-row-A');
  await tick();
  assert.equal(f.value, reselectedBlock, 'the whole previous block is replaced by the new composed message');
  assert.equal(f.value.includes('1B'), false, 'no line of the previous answer survives');
  assert.equal(f.value.split('2E：').length - 1, 1, 'the custom answer section appears exactly once');
  assert.equal(f.sent, 0);
});

test('a reader suffix after the recorded block is preserved byte for byte', async t => {
  const f = fixture(t);
  f.answerMixed();
  f.press('option-send');
  await tick();
  f.value = `${firstBlock}\nmy own words`;
  assert.equal(f.value.slice(firstBlock.length), '\nmy own words');

  f.press('option-question-0'); // switching the answer moves the card to Q2
  await tick();
  f.press('option-row-A');
  await tick();
  assert.equal(f.value, `${reselectedBlock}\nmy own words`);
  assert.equal(f.sent, 0);
});

test('an edited recorded block is not overwritten', async t => {
  const f = fixture(t);
  f.answerMixed();
  f.press('option-send');
  await tick();
  const edited = `${firstBlock.replace('1B 2E', '1B 2E edited')}`;
  f.value = edited;

  f.press('option-question-0'); // switching the answer moves the card to Q2
  await tick();
  f.press('option-row-A');
  await tick();
  // Known limitation from #476: this asserts the value only, not that the
  // composer setter was never called.
  assert.equal(f.value, edited);
  assert.equal(f.sent, 0);
});
