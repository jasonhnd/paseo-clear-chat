const assert = require('node:assert/strict');
const test = require('node:test');
const original = require('./fixtures/qa-458-reconstructed-host.json');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const [key, ...otherKeys] = Object.keys(original.document.values.answerDrafts);
const [agentId, atText] = key.split('\0');
const at = Number(atText);
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];

function storage(initial) {
  let values = structuredClone(initial), revision = 0;
  const history = [];
  return {
    get values() { return structuredClone(values); },
    history,
    async rpc(contract, input) {
      if (contract.name.endsWith('.read')) return { status: 'ready', revision: String(revision), values: structuredClone(values) };
      assert.equal(contract.name, 'settings.presentation.write');
      if (input.revision !== String(revision)) return { status: 'conflict' };
      values = structuredClone(input.values); history.push(structuredClone(values));
      return { status: 'saved', revision: String(++revision), values: structuredClone(values) };
    },
  };
}
async function setup(t, initial, prompt) {
  const host = storage(initial), shared = { prompt, writes: 0, sent: 0 };
  const composer = { selection: { start: 0, end: 0 }, get prompt() { return shared.prompt; }, setPrompt(v) { shared.beforeWrite = host.values.answerDrafts?.[key]; shared.prompt = v; shared.writes++; }, insertText() { assert.fail('unexpected insertText'); }, async focus() {} };
  const h = createToolHarness('ios', { presentationHost: host, agents: { [agentId]: { status: 'idle' } }, useComposers: () => [composer] });
  t.after(() => { h.unmount(); h.dispose(); });
  const prefs = h.load('client/preferences.ts');
  for (let i = 0; i < 50 && !prefs.areEnhancerPreferencesReady() && !prefs.getEnhancerPreferencesError(); i++) await tick();
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { shared.sent++; });
  session.publishAssistantReply(agentId, { at, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId, at, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, `missing ${id}`); node.props.onPress(); };
  return { h, host, prefs, shared, composer, draw, press };
}
async function waitBlock(f, block) {
  for (let i = 0; i < 100 && f.host.values.answerDrafts?.[key]?.block !== block; i++) await tick();
  assert.equal(f.host.values.answerDrafts?.[key]?.block, block);
}
function controls(f) {
  assert.ok(byId(f.h, f.draw(), 'option-replace-first-line'));
  assert.ok(byId(f.h, f.draw(), 'option-keep-edited-first-line'));
}
const values = () => structuredClone(original.document.values);


function noControls(f) {
  const tree = f.draw();
  assert.equal(byId(f.h, tree, 'option-replace-first-line'), undefined);
  assert.equal(byId(f.h, tree, 'option-keep-edited-first-line'), undefined);
  const notice = byId(f.h, tree, 'option-prefill-notice');
  if (notice) assert.doesNotMatch(f.h.text(notice), /The answer block was edited or its record is missing/);
}
function absent() { const data = values(); delete data.answerDrafts[key]; return data; }
async function first(f, letter) { f.press(`option-row-${letter}`); f.press('option-send'); }

test('a: empty composer with existing block is first insertion', async t => {
  const data = values(); data.answerDrafts[key].block = '1A';
  const f = await setup(t, data, ''); f.press('option-row-C');
  assert.equal(f.shared.prompt, '1C'); noControls(f); await waitBlock(f, '1C'); assert.equal(f.shared.sent, 0);
});

test('b: record without block preserves the non-empty prompt', async t => {
  const f = await setup(t, values(), 'hello world'); f.press('option-row-A');
  assert.equal(f.shared.prompt, '1A\nhello world'); noControls(f); await waitBlock(f, '1A'); assert.equal(f.shared.sent, 0);
});

test('c: record without block does not treat a block-looking prompt as an answer', async t => {
  const f = await setup(t, values(), '1A\nUser text'); await first(f, 'C'); await waitBlock(f, '1C');
  assert.equal(f.shared.prompt, '1C\n1A\nUser text'); assert.equal(f.shared.sent, 0);
});

test('d: whitespace-only prompt is preserved byte-for-byte', async t => {
  const f = await setup(t, values(), ' \n '); await first(f, 'A'); await waitBlock(f, '1A');
  assert.equal(f.shared.prompt, '1A\n \n '); assert.equal(f.shared.sent, 0);
});

test('e: custom multiline answer preserves the original prompt', async t => {
  const f = await setup(t, values(), 'User text');
  const custom = 'first line\nsecond line\r\n';
  f.press('option-row-D'); byId(f.h, f.draw(), 'option-custom-input').props.onChangeText(custom); f.press('option-custom-confirm');
  const answer = `1D\n\n1D：\n${custom}`;
  f.press('option-send'); await waitBlock(f, answer);
  assert.equal(f.shared.prompt, `${answer}\nUser text`); assert.equal(f.shared.sent, 0);
});

test('f: identity record has no block before the first write', async t => {
  const f = await setup(t, absent(), 'hello world'); await first(f, 'A'); await waitBlock(f, '1A');
  const identity = f.host.history.find(v => v.answerDrafts?.[key]?.block === undefined && v.answerDrafts?.[key]);
  assert.ok(identity, 'identity record was persisted');
  assert.deepEqual(f.shared.beforeWrite, identity.answerDrafts[key]);
  assert.equal(f.shared.beforeWrite.block, undefined);
  assert.equal(f.shared.prompt, '1A\nhello world'); assert.equal(f.shared.sent, 0);
});

test('g: selection does not discard any original prompt', async t => {
  const f = await setup(t, values(), 'hello world'); f.composer.selection = { start: 0, end: 6 };
  await first(f, 'A'); await waitBlock(f, '1A');
  assert.equal(f.shared.prompt, '1A\nhello world'); assert.equal(f.shared.sent, 0);
});

test('h: matching existing block is replaced with suffix preserved', async t => {
  const data = values(); data.answerDrafts[key].block = '1A';
  const f = await setup(t, data, '1A\nUser text'); f.press('option-row-C'); await waitBlock(f, '1C');
  assert.equal(f.shared.prompt, '1C\nUser text'); assert.equal(f.shared.sent, 0);
});

test('h: edited existing block remains untouched and offers controls', async t => {
  const data = values(); data.answerDrafts[key].block = '1A';
  const f = await setup(t, data, 'edited\nUser text'); f.press('option-row-C');
  assert.equal(f.shared.prompt, 'edited\nUser text'); assert.equal(f.shared.writes, 0); controls(f); assert.equal(f.shared.sent, 0);
});
