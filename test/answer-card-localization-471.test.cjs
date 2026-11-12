const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createToolHarness } = require('./helpers/tool-harness.cjs');

const expected = {
  en: {
    replaceFirstLine: 'Replace first line with {{answer}}',
    keepEdited: 'Keep my edit',
    limitEdited: 'If you edited the answer and then choose Replace first line, only the first line is replaced; the rest of a multi-line answer stays for you to remove.',
  },
  'zh-CN': {
    replaceFirstLine: '用 {{answer}} 替换第一行',
    keepEdited: '保留我改的',
    limitEdited: '你改过答案后再点「替换第一行」，只换第一行；多行答案的其余部分会留着，请自己删。',
  },
  ja: {
    replaceFirstLine: '1行目を{{answer}}に置き換える',
    keepEdited: '自分の編集を残す',
    limitEdited: '回答を編集したあとで「置き換える」ボタンを押しても、置き換わるのは1行目だけです。複数行の回答の2行目以降はそのまま残るので、自分で消してください。',
  },
};
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

test('conflict copy is defined in every locale and referenced by the card', () => {
  for (const [locale, values] of Object.entries(expected)) {
    const card = JSON.parse(fs.readFileSync(path.join(root, 'client/locales', `${locale}.json`), 'utf8')).answerCard;
    for (const [key, value] of Object.entries(values)) assert.equal(card[key], value, `${locale}: ${key}`);
  }
  const source = fs.readFileSync(path.join(root, 'client/components/option-card.tsx'), 'utf8');
  assert.doesNotMatch(source, /Replace first line|Keep edited text/);
  for (const key of Object.keys(expected.en)) assert.ok(source.includes(`answerCard.${key}`), key);
  assert.match(source, /testID="option-prefill-limitation"[^>]*>\{t\("answerCard\.limitEdited"\)\}/);
});

for (const [locale, values] of Object.entries(expected)) {
  test(`${locale}: edited answer conflict uses localized controls`, async t => {
    let value = '', sent = 0;
    const composer = {
      get prompt() { return value; },
      setPrompt(text) { value = text; },
      insertText(text) { value += text; },
      async focus() {},
    };
    const h = createToolHarness('ios', { locale, agents: { a: { status: 'idle' } }, useComposers: () => [composer] });
    t.after(() => { h.unmount(); h.dispose(); });
    const session = h.load('client/option-session.ts');
    const Card = h.load('client/components/option-card.tsx').OptionCard;
    session.setOptionSender(async () => { sent++; });
    session.publishAssistantReply('a', { at: 1, text: 'Pick?\nA Alpha\nB Beta\n\nReply: A' });
    const draw = () => h.draw({ type: Card, props: { agentId: 'a', at: 1, tokens: h.tokens } });
    const press = id => { const node = byId(h, draw(), id); assert.ok(node, id); node.props.onPress(); };
    press('option-row-B'); press('option-send'); await tick();
    assert.equal(value, '1B');
    value = 'Edited\nKeep these bytes\n';
    press('option-row-A'); await tick();
    const tree = draw();
    assert.equal(h.text(byId(h, tree, 'option-prefill-limitation')), values.limitEdited);
    assert.equal(h.text(byId(h, tree, 'option-keep-edited-first-line')), values.keepEdited);
    assert.equal(h.text(byId(h, tree, 'option-replace-first-line')), values.replaceFirstLine.replace('{{answer}}', '1A'));
    press('option-replace-first-line'); await tick();
    assert.equal(value, '1A\nKeep these bytes\n');
    assert.equal(sent, 0);
  });
}
