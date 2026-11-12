const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

async function fixture(t, savedReplies, platform = 'ios', exposeSelection = true) {
  let prompt = '', cursor = 0, sent = 0, setCalls = 0, focusCalls = 0, selectionAvailable = exposeSelection;
  const composer = {
    get prompt() { return prompt; },
    get selection() { return selectionAvailable ? { start: cursor, end: cursor } : undefined; },
    setPrompt(text) { setCalls++; prompt = text; },
    insertText(text) { prompt = prompt.slice(0, cursor) + text + prompt.slice(cursor); cursor += text.length; },
    async focus() { focusCalls++; },
  };
  let values = { preferences: savedReplies === undefined ? {} : { savedReplies }, legacyMigrated: true };
  const presentationHost = { rpc: async (contract, input) => {
    if (contract.name.endsWith('.write')) values = structuredClone(input.values);
    return { status: contract.name.endsWith('.write') ? 'saved' : 'ready', revision: '0', values: structuredClone(values) };
  } };
  const h = createToolHarness(platform, { agents: { a: { status: 'idle' } }, presentationHost, useComposers: () => [composer] });
  t.after(() => { h.unmount(); h.dispose(); });
  await new Promise(setImmediate);
  assert.equal(h.load('client/preferences.ts').areEnhancerPreferencesReady(), true);
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { sent++; });
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const get = id => byId(h, draw(), id);
  const press = id => { const node = get(id); assert.ok(node, `missing ${id}`); node.props.onPress(); };
  return { h, session, draw, get, press, loseSelection() { selectionAvailable = false; }, setPrompt(text, at = text.length) { prompt = text; cursor = at; },
    get prompt() { return prompt; }, get sent() { return sent; }, get setCalls() { return setCalls; }, get focusCalls() { return focusCalls; } };
}

test('default saved replies render in order with accessible labels', async t => {
  const f = await fixture(t);
  const row = f.get('saved-replies-row');
  assert.ok(row, 'missing saved-replies-row');
  assert.equal(row.props.accessibilityLabel, 'Saved replies');
  const chips = f.h.nodes(row, node => /^saved-reply-\d+$/.test(node.props.testID ?? ''));
  assert.deepEqual(chips.map(node => f.h.text(node)), ['Go with the recommended', 'Leave it for now', 'Continue']);
  assert.deepEqual(chips.map(node => node.props.testID), ['saved-reply-0', 'saved-reply-1', 'saved-reply-2']);
  for (const chip of chips) assert.equal(chip.props.accessibilityRole, 'button');
});

test('a saved reply inserts into an empty composer without sending', async t => {
  const f = await fixture(t);
  f.press('saved-reply-2');
  assert.equal(f.prompt, 'Continue');
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

test('a saved reply separates from existing text at the end', async t => {
  const f = await fixture(t);
  f.setPrompt('my own words'); f.press('saved-reply-2');
  assert.equal(f.prompt, 'my own words Continue');
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

test('a saved reply inserts after whitespace in the middle without an extra space', async t => {
  const f = await fixture(t);
  f.setPrompt('my own words', 7); f.press('saved-reply-2');
  assert.equal(f.prompt, 'my own Continuewords');
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

test('a saved reply separates from a non-space in the middle', async t => {
  const f = await fixture(t);
  f.setPrompt('my own words', 6); f.press('saved-reply-2');
  assert.equal(f.prompt, 'my own Continue words');
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

test('a saved reply respects whitespace and the start of the prompt', async t => {
  const f = await fixture(t);
  for (const [prompt, cursor, expected] of [
    [' words', 1, ' Continuewords'],
    ['\nwords', 1, '\nContinuewords'],
    ['\twords', 1, '\tContinuewords'],
    ['words', 0, 'Continuewords'],
  ]) {
    f.setPrompt(prompt, cursor); f.press('saved-reply-2');
    assert.equal(f.prompt, expected);
  }
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

for (const [name, prompt, cursor, exposeSelection, expected] of [
  ['at the start with a selection', 'hello world', 0, true, 'Continuehello world'],
  ['at the start after selection is unavailable', 'hello world', 0, false, ' Continuehello world'],
  ['after an existing space', 'hello world', 6, true, 'hello Continueworld'],
  ['after an existing space without a selection', 'hello world', 6, false, 'hello  Continueworld'],
  ['after a non-space', 'hello world', 5, true, 'hello Continue world'],
  ['in an empty prompt', '', 0, true, 'Continue'],
  ['at the end of a prompt', 'my own words', 12, true, 'my own words Continue'],
  ['at the end without a selection', 'my own words', 12, false, 'my own words Continue'],
  ['in an empty prompt without a selection', '', 0, false, 'Continue'],
  ['at the end of a space without a selection', 'my own words ', 13, false, 'my own words Continue'],
  ['at the end of a newline without a selection', 'my own words\n', 13, false, 'my own words\nContinue'],
  ['at the end of a tab without a selection', 'my own words\t', 13, false, 'my own words\tContinue'],
]) {
  test(`saved reply ${name}`, async t => {
    const f = await fixture(t, undefined, 'ios', exposeSelection);
    f.setPrompt(prompt, cursor); f.press('saved-reply-2');
    assert.equal(f.prompt, expected);
    assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
  });
}

test('a saved reply at the start after blur loses selection assumes the end', async t => {
  const f = await fixture(t);
  f.setPrompt('hello world', 0);
  f.draw();
  f.loseSelection();
  f.press('saved-reply-2');
  assert.equal(f.prompt, ' Continuehello world');
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

test('custom saved replies render in order and insert their text', async t => {
  const f = await fixture(t, ['Try later', 'Proceed']);
  const row = f.get('saved-replies-row'); assert.ok(row, 'missing saved-replies-row');
  const chips = f.h.nodes(row, node => /^saved-reply-\d+$/.test(node.props.testID ?? ''));
  assert.deepEqual(chips.map(node => f.h.text(node)), ['Try later', 'Proceed']);
  f.press('saved-reply-1'); assert.equal(f.prompt, 'Proceed'); assert.equal(f.sent, 0);
});

test('empty preferences and read-only cards hide the row', async t => {
  const empty = await fixture(t, []);
  assert.equal(empty.get('saved-replies-row'), undefined);
  const readOnly = await fixture(t);
  readOnly.session.publishUserMessage('a', 2, 'A');
  assert.equal(readOnly.session.getOptionSessionAt('a', 1).readOnly, true);
  assert.ok(readOnly.get('option-card'));
  assert.equal(readOnly.get('saved-replies-row'), undefined);
});

test('saved reply leaves the selected answer unchanged and does not send', async t => {
  const f = await fixture(t);
  f.press('option-row-B');
  assert.equal(f.session.getOptionSessionAt('a', 1).choices[0], 'B');
  f.press('saved-reply-0');
  assert.equal(f.session.getOptionSessionAt('a', 1).choices[0], 'B');
  assert.equal(f.sent, 0); assert.equal(f.setCalls, 0); assert.equal(f.focusCalls, 0);
});

test('mouse activation preserves composer focus on web', async t => {
  const f = await fixture(t, undefined, 'web');
  const chip = f.get('saved-reply-0'); assert.ok(chip, 'missing saved-reply-0');
  let prevented = false;
  chip.props.onMouseDown({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  chip.props.onPress();
  assert.equal(f.sent, 0); assert.equal(f.focusCalls, 0);
});
