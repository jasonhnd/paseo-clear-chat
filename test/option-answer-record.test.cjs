const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolHarness } = require('./helpers/tool-harness.cjs');
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const tick = () => new Promise(resolve => setImmediate(resolve));

function host() {
  let values = { preferences: {}, legacyMigrated: true }, revision = 0, failWrites = false, writeGate;
  return {
    get values() { return structuredClone(values); },
    set failWrites(value) { failWrites = value; },
    set writeGate(value) { writeGate = value; },
    async rpc(contract, input) {
      if (contract.name === 'settings.presentation.read') return { status: 'ready', revision: String(revision), values: structuredClone(values) };
      assert.equal(contract.name, 'settings.presentation.write');
      if (failWrites) throw Error('write unavailable');
      if (writeGate) await writeGate;
      if (input.revision !== String(revision)) return { status: 'conflict' };
      values = structuredClone(input.values); revision++;
      return { status: 'saved', revision: String(revision), values: structuredClone(values) };
    },
  };
}

async function fixture(t, storage, shared) {
  const composer = {
    get prompt() { return shared.read ? shared.read() : shared.value; },
    setPrompt(value) { shared.writes++; if (shared.write) return shared.write(value); shared.value = value; },
    insertText() { assert.fail('selection-based insertion is unsafe'); },
    async focus() {},
  };
  const h = createToolHarness('ios', { presentationHost: storage, agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
  const preferences = h.load('client/preferences.ts');
  for (let i = 0; i < 20 && !preferences.areEnhancerPreferencesReady(); i++) await tick();
  assert.equal(preferences.areEnhancerPreferencesReady(), true);
  const session = h.load('client/option-session.ts');
  const Card = h.load('client/components/option-card.tsx').OptionCard;
  session.setOptionSender(async () => { shared.sent++; });
  session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\nC Gamma\n\nReply: A' });
  const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
  const press = id => { const node = byId(h, draw(), id); assert.ok(node, `missing ${id}`); node.props.onPress(); };
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, session, preferences, draw, press };
}
async function persisted(storage, block) {
  for (let i = 0; i < 100; i++) {
    if (storage.values.answerDrafts?.['a\u00001']?.block === block) return;
    await tick();
  }
  assert.fail('answer record did not persist');
}

for (const initial of ['', ' original\r\ntext\n']) {
  test(`insertion preserves original bytes: ${JSON.stringify(initial)}`, async t => {
    const shared = { value: initial, writes: 0, sent: 0 }, storage = host();
    const f = await fixture(t, storage, shared);
    f.press('option-row-A'); f.press('option-send'); await tick();
    assert.equal(shared.value, initial ? `1A\n${initial}` : '1A');
    assert.equal(shared.writes, 1); assert.equal(shared.sent, 0);
    await persisted(storage, '1A');
    assert.deepEqual(storage.values.answerDrafts, { 'a\u00001': { schema: 1, choices: { 0: 'A' }, customDrafts: {}, customOpen: { 0: false }, activeQuestion: 0, block: '1A' } });
  });
}

test('reload restores the record and reselect replaces an identical manually typed answer', async t => {
  const shared = { value: 'body\r\n', writes: 0, sent: 0 }, storage = host();
  const first = await fixture(t, storage, shared);
  first.press('option-row-A'); first.press('option-send'); await persisted(storage, '1A');
  first.h.unmount(); first.h.dispose();
  shared.value = 'other'; shared.value = '1A\nbody\r\n';
  const second = await fixture(t, storage, shared);
  second.press('option-row-B');
  assert.equal(shared.value, '1B\nbody\r\n');
  assert.equal(shared.writes, 2); assert.equal(shared.sent, 0);
  await persisted(storage, '1B');
});

test('cleared record is first-inserted on a reselect', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const first = await fixture(t, storage, shared);
  first.press('option-row-A'); first.press('option-send'); await persisted(storage, '1A');
  await first.preferences.saveOptionAnswerDraft('a', 1, null);
  first.h.unmount(); first.h.dispose();
  const second = await fixture(t, storage, shared);
  second.press('option-row-B');
  assert.equal(shared.value, '1B\n1A'); assert.equal(shared.writes, 2);
  assert.equal(byId(second.h, second.draw(), 'option-prefill-notice'), undefined);
  assert.equal(byId(second.h, second.draw(), 'option-replace-first-line'), undefined);
  assert.equal(byId(second.h, second.draw(), 'option-keep-edited-first-line'), undefined);
});

test('edited block stays unchanged until explicit replacement', async t => {
  const shared = { value: 'tail\n', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.press('option-row-A'); f.press('option-send'); await tick();
  shared.value = 'my edit\ntail\n';
  f.press('option-row-B');
  assert.equal(shared.value, 'my edit\ntail\n'); assert.equal(shared.writes, 1);
  assert.ok(byId(f.h, f.draw(), 'option-replace-first-line'));
  assert.ok(byId(f.h, f.draw(), 'option-keep-edited-first-line'));
  f.press('option-replace-first-line');
  assert.equal(shared.value, '1B\ntail\n'); assert.equal(shared.writes, 2); assert.equal(shared.sent, 0);
  await persisted(storage, '1B');
});

test('multiline custom block is replaced wholly and the suffix is preserved', async t => {
  const shared = { value: 'keep\r\nthis', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.session.setCustomDraft('a', 0, 'first\nsecond\r\n');
  assert.equal(f.session.confirmCustom('a', 0), 'confirmed');
  f.press('option-send'); await tick();
  const block = '1D\n\n1D：\nfirst\nsecond\r\n';
  assert.equal(shared.value, `${block}\nkeep\r\nthis`);
  await persisted(storage, block);
  f.press('option-row-C');
  assert.equal(shared.value, '1C\nkeep\r\nthis'); assert.equal(shared.writes, 2); assert.equal(shared.sent, 0);
});

test('prompt changed after click is never written, including explicit replacement', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.press('option-row-A'); f.press('option-send'); await tick();
  let reads = 0;
  shared.read = () => ++reads === 1 ? '1A' : 'someone changed this';
  f.press('option-row-B');
  assert.equal(shared.writes, 1);
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /changed meanwhile/i);
  delete shared.read;
  shared.value = 'edited'; f.press('option-row-C');
  reads = 0; shared.read = () => ++reads === 1 ? 'edited' : 'changed again';
  f.press('option-replace-first-line');
  assert.equal(shared.writes, 1);
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /changed meanwhile/i);
});

test('a missing block in a retained draft is first-inserted on reselect', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.press('option-row-A'); f.press('option-send'); await tick();
  await persisted(storage, '1A');
  f.h.unmount(); f.h.dispose();
  // Simulate an older or partially cleared persisted draft with its identity retained.
  const saved = storage.values;
  delete saved.answerDrafts['a\u00001'].block;
  const oldRpc = storage.rpc;
  let first = true;
  storage.rpc = async (contract, input) => {
    if (first && contract.name === 'settings.presentation.read') {
      first = false;
      const result = await oldRpc(contract, input);
      return { ...result, values: saved };
    }
    return oldRpc(contract, input);
  };
  const reloaded = await fixture(t, storage, shared);
  reloaded.press('option-row-B');
  assert.equal(shared.value, '1B\n1A'); assert.equal(shared.writes, 2);
  assert.equal(byId(reloaded.h, reloaded.draw(), 'option-replace-first-line'), undefined);
  assert.equal(byId(reloaded.h, reloaded.draw(), 'option-keep-edited-first-line'), undefined);
});

test('ordinary answers insert their index even when a note exists', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.session.choose('a', 0, 'A'); f.session.setNote('a', 0, 'a note');
  f.press('option-send'); await tick();
  assert.equal(shared.value, '1A'); assert.equal(shared.writes, 1);
});


test('confirming a custom reselect replaces the previous answer block', async t => {
  const shared = { value: 'tail', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.press('option-row-A'); f.press('option-send'); await tick();
  f.press('option-row-D');
  byId(f.h, f.draw(), 'option-custom-input').props.onChangeText('first\nsecond');
  f.press('option-custom-confirm');
  assert.equal(shared.value, '1D\n\n1D：\nfirst\nsecond\ntail');
  assert.equal(shared.writes, 2); assert.equal(shared.sent, 0);
});


test('an empty cleared record is first-inserted into an empty composer', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.press('option-row-A'); f.press('option-send'); await tick();
  await f.preferences.saveOptionAnswerDraft('a', 1, '');
  shared.value = '';
  f.press('option-row-B');
  assert.equal(shared.value, '1B'); assert.equal(shared.writes, 2);
  assert.equal(byId(f.h, f.draw(), 'option-replace-first-line'), undefined);
  assert.equal(byId(f.h, f.draw(), 'option-keep-edited-first-line'), undefined);
});


test('a custom record ending in a newline preserves text typed immediately after it', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.session.setCustomDraft('a', 0, 'first\n');
  assert.equal(f.session.confirmCustom('a', 0), 'confirmed');
  f.press('option-send'); await tick();
  assert.equal(shared.value, '1D\n\n1D：\nfirst\n');
  shared.value += 'user suffix';
  f.press('option-row-B');
  assert.equal(shared.value, '1Buser suffix');
  assert.equal(shared.writes, 2);
});

test('explicit replacement of an edited multiline block preserves the remaining text', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.session.setCustomDraft('a', 0, 'first\nsecond');
  assert.equal(f.session.confirmCustom('a', 0), 'confirmed');
  f.press('option-send'); await tick();
  shared.value = 'edited\nuser suffix\n';
  f.press('option-row-B');
  assert.equal(shared.value, 'edited\nuser suffix\n');
  f.press('option-replace-first-line');
  assert.equal(shared.value, '1B\nuser suffix\n');
  assert.equal(shared.writes, 2);
});

test('an asynchronous rejected write keeps the previous record and blocks overlapping writes', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  f.press('option-row-A'); f.press('option-send'); await tick(); await persisted(storage, '1A');
  let rejectWrite;
  shared.write = () => new Promise((resolve, reject) => { rejectWrite = reject; });
  f.press('option-row-B');
  assert.equal(shared.writes, 2);
  f.press('option-row-C');
  assert.equal(shared.writes, 2);
  assert.equal(f.preferences.getOptionAnswerDraft('a', 1).block, '1A');
  rejectWrite(Error('write failed')); await tick(); await tick();
  assert.equal(shared.value, '1A');
  assert.equal(f.preferences.getOptionAnswerDraft('a', 1).block, '1A');
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /Could not update/);
  delete shared.write;
  f.press('option-row-C');
  assert.equal(shared.value, '1C');
  await persisted(storage, '1C');
});

test('an asynchronous successful write records the block only after it resolves', async t => {
  const shared = { value: 'tail', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  let finishWrite;
  shared.write = value => new Promise(resolve => { finishWrite = () => { shared.value = value; resolve(); }; });
  f.press('option-row-A'); f.press('option-send'); await tick();
  assert.equal(shared.value, 'tail');
  assert.equal(f.preferences.getOptionAnswerDraft('a', 1).block, undefined);
  finishWrite(); await tick(); await tick();
  assert.equal(shared.value, '1A\ntail');
  assert.equal(f.preferences.getOptionAnswerDraft('a', 1).block, '1A');
  await persisted(storage, '1A');
});


test('a failed record save is retried by the next settings write and survives reload', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  shared.write = value => { shared.value = value; storage.failWrites = true; };
  f.press('option-row-A'); f.press('option-send'); await tick();
  for (let i = 0; i < 100 && !f.preferences.getEnhancerPreferencesError(); i++) await tick();
  assert.ok(f.preferences.getEnhancerPreferencesError());
  assert.equal(f.preferences.getOptionAnswerDraft('a', 1).block, '1A');
  storage.failWrites = false;
  await f.preferences.updateEnhancerPreferences({ textScale: 1.15 });
  assert.equal(f.preferences.getOptionAnswerDraft('a', 1).block, '1A');
  await persisted(storage, '1A');
  f.h.unmount(); f.h.dispose();
  const reloaded = await fixture(t, storage, shared);
  reloaded.press('option-row-B');
  assert.equal(shared.value, '1B'); assert.equal(shared.writes, 2);
});


test('failed persistence before the first insertion does not write the composer', async t => {
  const shared = { value: 'original', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  storage.failWrites = true;
  f.press('option-row-A'); f.press('option-send'); await tick(); await tick();
  assert.equal(shared.value, 'original'); assert.equal(shared.writes, 0);
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /Could not update/);
});

test('a saved card marker without a block is first-inserted after reload', async t => {
  const shared = { value: '', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  shared.write = value => { shared.value = value; storage.failWrites = true; };
  f.press('option-row-A'); f.press('option-send'); await tick();
  for (let i = 0; i < 100 && !f.preferences.getEnhancerPreferencesError(); i++) await tick();
  assert.ok(f.preferences.getEnhancerPreferencesError());
  assert.equal(storage.values.answerDrafts['a\u00001'].block, undefined);
  f.h.unmount(); f.h.dispose();
  delete shared.write; storage.failWrites = false;
  const reloaded = await fixture(t, storage, shared);
  reloaded.press('option-row-B');
  assert.equal(shared.value, '1B\n1A'); assert.equal(shared.writes, 2);
  assert.equal(byId(reloaded.h, reloaded.draw(), 'option-replace-first-line'), undefined);
  assert.equal(byId(reloaded.h, reloaded.draw(), 'option-keep-edited-first-line'), undefined);
});


test('a changed prompt while saving the first marker is not overwritten', async t => {
  const shared = { value: 'original', writes: 0, sent: 0 }, storage = host();
  const f = await fixture(t, storage, shared);
  let release;
  storage.writeGate = new Promise(resolve => { release = resolve; });
  f.press('option-row-A'); f.press('option-send');
  shared.value = 'changed while waiting';
  release(); await tick(); await tick();
  assert.equal(shared.value, 'changed while waiting'); assert.equal(shared.writes, 0);
  assert.match(f.h.text(byId(f.h, f.draw(), 'option-prefill-notice')), /changed meanwhile/i);
});
