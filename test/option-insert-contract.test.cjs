const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('/data/home/w/test/helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(t, initial = '', selection = { start: 0, end: 0 }) {
  let value = initial;
  let sel = { ...selection };
  const writes = [];
  const composer = {
    get prompt() { return value; },
    setPrompt(v) { writes.push(v); value = v; },
    insertText(text) { value = value.slice(0, sel.start) + text + value.slice(sel.end); },
    async focus(options) { if (options?.selection) sel = { ...options.selection }; },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => {});
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, 'missing control ' + id); node.props.onPress(); };
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, session, draw, press, writes, get value() { return value; }, setValue(v) { value = v; } };
}

test('selection changing after focus never loses user text: answer goes on the first line', async t => {
  let value = 'hello world';
  let selection = { start: 0, end: 5 };
  let sends = 0;
  const composer = {
    get prompt() { return value; },
    setPrompt(v) { value = v; },
    async focus(options) { if (options?.selection) selection = { ...options.selection }; queueMicrotask(() => { selection = { start: 0, end: 5 }; }); },
    insertText(text) { value = value.slice(0, selection.start) + text + value.slice(selection.end); },
  };
  const h = createToolHarness('ios', { agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { sends++; });
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  t.after(() => { h.unmount(); h.dispose(); });
  byId(h, draw(), 'option-row-A').props.onPress();
  byId(h, draw(), 'option-send').props.onPress();
  await tick();
  assert.equal(value, '1A\nhello world', `expected the answer on the first line with the original text kept below, got ${JSON.stringify(value)}`);
  assert.equal(sends, 0);
});

test('a user-edited first line is never overwritten, and both explicit choices are offered', async t => {
  const f = setup(t);
  f.press('option-row-A');
  f.press('option-send');
  await tick();
  assert.equal(f.value, '1A');
  f.setValue('MY OWN LINE');
  f.press('option-row-C');
  f.press('option-send');
  await tick();
  assert.equal(f.value, 'MY OWN LINE', 'a first line the user changed must not be rewritten');
  const board = f.draw();
  assert.ok(byId(f.h, board, 'option-replace-first-line'), 'expected the replace-first-line control');
  assert.ok(byId(f.h, board, 'option-keep-edited-first-line'), 'expected the keep-edited-first-line control');
});

test('replacing an untouched first line after changing the choice rewrites only that line', async t => {
  const f = setup(t);
  f.setValue('existing text');
  f.press('option-row-A');
  f.press('option-send');
  await tick();
  assert.equal(f.value, '1A\nexisting text');
  f.press('option-row-C');
  f.press('option-send');
  await tick();
  assert.equal(f.value, '1C\nexisting text', 'an untouched first line follows the new choice while the rest stays byte-identical');
});
