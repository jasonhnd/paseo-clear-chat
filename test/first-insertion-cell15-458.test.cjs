const assert = require('node:assert/strict');
const test = require('node:test');
const original = require('./fixtures/qa-458-reconstructed-host.json');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const [key] = Object.keys(original.document.values.answerDrafts);
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
  const composer = {
    selection: { start: 0, end: 0 },
    get prompt() { return shared.prompt; },
    setPrompt(v) { shared.prompt = v; shared.writes++; },
    insertText(text) { assert.fail('unexpected insertText'); },
    async focus() {},
  };
  const h = createToolHarness('ios', {
    presentationHost: host,
    agents: { [agentId]: { status: 'idle' } },
    useComposers: () => [composer],
  });
  t.after(() => { h.unmount(); h.dispose(); });
  const prefs = h.load('client/preferences.ts');
  for (let i = 0; i < 50 && !prefs.areEnhancerPreferencesReady() && !prefs.getEnhancerPreferencesError(); i++) await tick();
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { shared.sent++; });
  session.publishAssistantReply(agentId, { at, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\nD Delta\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId, at, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, `missing ${id}`); node.props.onPress(); };
  return { h, host, prefs, shared, composer, draw, press };
}
async function waitBlock(f, block) {
  for (let i = 0; i < 100 && f.host.values.answerDrafts?.[key]?.block !== block; i++) await tick();
  assert.equal(f.host.values.answerDrafts?.[key]?.block, block);
}

// Origin: qa matrix v5b cell 15 driver (~/AgenticCoder/_cc/qa-457/matrix-v5b.mjs, SHA fd7b4617..., line 109):
//   input().fill('X') -> custom('E','line1\n') -> click(send) -> expect '1E\n\n1E：\nline1\n\nX'
// Oracle: qa-466-457-answer-first-oracle.md Edge rules "preserve P bytes" + §6 (custom) + §2.
test('cell 15: legacy no-block record, P="X", custom E "line1\\n" -> A + "\\n" + P', async t => {
  const data = structuredClone(original.document.values); // the captured host shape: a record with no block
  delete data.answerDrafts[key].block;
  const f = await setup(t, data, 'X');
  f.press('option-row-E');
  byId(f.h, f.draw(), 'option-custom-input').props.onChangeText('line1\n');
  f.press('option-custom-confirm');
  f.press('option-send');
  const A = '1E\n\n1E：\nline1\n';
  await waitBlock(f, A);
  assert.equal(f.shared.prompt, `${A}\nX`);
  assert.equal(f.shared.prompt, '1E\n\n1E：\nline1\n\nX');
  assert.equal(f.shared.sent, 0);
});
