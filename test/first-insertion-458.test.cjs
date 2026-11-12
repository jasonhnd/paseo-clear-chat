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
  return {
    get values() { return structuredClone(values); },
    async rpc(contract, input) {
      if (contract.name.endsWith('.read')) return { status: 'ready', revision: String(revision), values: structuredClone(values) };
      assert.equal(contract.name, 'settings.presentation.write');
      if (input.revision !== String(revision)) return { status: 'conflict' };
      values = structuredClone(input.values);
      return { status: 'saved', revision: String(++revision), values: structuredClone(values) };
    },
  };
}
async function setup(t, initial, prompt) {
  const host = storage(initial), shared = { prompt, writes: 0, sent: 0 };
  const composer = { get prompt() { return shared.prompt; }, setPrompt(v) { shared.prompt = v; shared.writes++; }, insertText() { assert.fail('unexpected insertText'); }, async focus() {} };
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
  return { h, host, prefs, shared, draw, press };
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

test('reconstructed host fixture has three observed entries and no blocks', () => {
  assert.equal(original.document.version, 2);
  assert.equal(typeof original.document.values.preferences.showAnswerCard, 'boolean');
  assert.equal(original.document.values.legacyMigrated, true);
  assert.equal(otherKeys.length, 2);
  for (const [k, entry] of Object.entries(original.document.values.answerDrafts)) {
    assert.match(k, /^[0-9a-f-]{36}\0\d+$/);
    assert.deepEqual(Object.keys(entry), ['schema', 'choices', 'customDrafts', 'customOpen', 'activeQuestion']);
    assert.equal(entry.schema, 1); assert.equal(typeof entry.activeQuestion, 'number');
    assert.equal(typeof entry.choices['0'], 'string'); assert.equal(typeof entry.customDrafts['0'], 'string');
    assert.equal(typeof entry.customOpen['0'], 'boolean'); assert.equal(Object.hasOwn(entry, 'block'), false);
  }
});

for (const prompt of ['', '  user\r\n\ntext\n']) test(`absent record inserts while preserving prompt ${JSON.stringify(prompt)}`, async t => {
  const data = values(); delete data.answerDrafts[key];
  const f = await setup(t, data, prompt); f.press('option-row-A'); f.press('option-send');
  await waitBlock(f, '1A');
  assert.equal(f.shared.prompt, prompt ? `1A\n${prompt}` : '1A');
  assert.equal(f.shared.writes, 1); assert.equal(f.shared.sent, 0);
});

test('matching multiline block is wholly replaced and suffix kept', async t => {
  const data = values(); data.answerDrafts[key].block = 'old\nblock';
  const f = await setup(t, data, 'old\nblock\r\nnot a boundary');
  // A block ending before CR is not a full line; use an exact newline boundary.
  f.shared.prompt = 'old\nblock\nuser\r\ntext\n'; f.press('option-row-B'); await waitBlock(f, '1B');
  assert.equal(f.shared.prompt, '1B\nuser\r\ntext\n'); assert.equal(f.shared.writes, 1); assert.equal(f.shared.sent, 0);
});
test('different recorded block offers controls without writing', async t => {
  const data = values(); data.answerDrafts[key].block = 'old\nblock';
  const f = await setup(t, data, 'edited\nuser'); f.press('option-row-B');
  assert.equal(f.shared.prompt, 'edited\nuser'); assert.equal(f.shared.writes, 0); controls(f); assert.equal(f.shared.sent, 0);
});
for (const prompt of ['', 'user\r\ntext\n']) test(`host record without block with prompt ${JSON.stringify(prompt)}`, async t => {
  const data = values(); const f = await setup(t, data, prompt); f.press('option-row-B');
  if (prompt) { await waitBlock(f, '1B'); assert.equal(f.shared.prompt, `1B\n${prompt}`); assert.equal(f.shared.writes, 1); assert.equal(byId(f.h, f.draw(), 'option-replace-first-line'), undefined); assert.equal(byId(f.h, f.draw(), 'option-keep-edited-first-line'), undefined); }
  else { await waitBlock(f, '1B'); assert.equal(f.shared.prompt, '1B'); assert.equal(f.shared.writes, 1); }
  for (const k of otherKeys) assert.deepEqual(f.host.values.answerDrafts[k], data.answerDrafts[k]);
  assert.equal(f.shared.sent, 0);
});

for (const [name, change] of [
  ['array-shaped entry', d => { d.answerDrafts[key] = []; }],
  ['missing schema field', d => { delete d.answerDrafts[key].schema; }],
]) test(`invalid upgrade state: ${name} fails closed`, async t => {
  const data = values(); change(data); const f = await setup(t, data, '');
  assert.equal(f.prefs.areEnhancerPreferencesReady(), false); assert.ok(f.prefs.getEnhancerPreferencesError());
  f.press('option-row-B'); f.press('option-send'); await tick();
  assert.equal(f.shared.prompt, ''); assert.equal(f.shared.writes, 0); assert.equal(f.shared.sent, 0);
});
test('unknown extra key in an old entry does not prevent empty insertion', async t => {
  const data = values(); data.answerDrafts[key].future = 'extra';
  const f = await setup(t, data, ''); f.press('option-row-B'); await waitBlock(f, '1B');
  assert.equal(f.shared.prompt, '1B'); assert.equal(f.shared.writes, 1); assert.equal(f.shared.sent, 0);
});
