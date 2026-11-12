'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(phrases, composers) {
  const selectors = [];
  const hooks = {
    useTranslation: () => ({ t: key => key }),
    useComposers: selector => { selectors.push(selector.agentId); return composers[selector.agentId] ? [composers[selector.agentId]] : []; },
  };
  const react = { useState: () => ['today', () => {}], useEffect: () => {} };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const native = { Platform: { OS: 'web' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: x => x, hairlineWidth: 1 } };
  const filename = path.join(__dirname, '../client/components/agent-board.tsx');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const req = id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (id === 'react-native') return native;
    if (id === '@getpaseo/plugin/client') return hooks;
    if (id === '../preferences') return { useEnhancerPreferences: () => ({ savedReplies: phrases }) };
    if (id === '../messages') return { messages: {} };
    if (id === '../agent-board-model') return require('../client/agent-board-model.ts');
    if (id === '../outline-model') return require('../client/outline-model.ts');
    throw Error(`unexpected import ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename })(req, mod, mod.exports);
  function render(agentId) {
    const tree = mod.exports.ClearChatSidebar({ theme: { colors: {} }, active: agentId === null ? undefined : { agent: { id: agentId } }, navigation: { openAgent() {} } });
    const nodes = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      nodes.push(node);
      walk(node.props?.children);
    }
    walk(tree);
    return nodes.filter(node => node.props?.testID?.startsWith('sidebar-saved-reply-'));
  }
  return { render, selectors };
}

function composer(initial, start = initial.length, end = start) {
  let prompt = initial, sent = 0, setCalls = 0, insertCalls = 0;
  return {
    get prompt() { return prompt; }, get sent() { return sent; }, get setCalls() { return setCalls; }, get insertCalls() { return insertCalls; },
    insertText(text) { insertCalls++; prompt = prompt.slice(0, start) + text + prompt.slice(end); start += text.length; end = start; },
    setPrompt(text) { setCalls++; prompt = text; }, send() { sent++; }, submit() { sent++; },
  };
}

test('inserts into the selected agent draft at the cursor without replacing or sending', () => {
  const first = composer('DRAFT keep', 5), second = composer('other');
  const h = harness([' hi'], { first, second });
  const [button] = h.render('first');
  let prevented = false;
  button.props.onMouseDown({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  button.props.onPress();
  assert.equal(first.prompt, 'DRAFT hi keep');
  assert.notEqual(first.prompt, ' hi');
  assert.equal(first.setCalls, 0); assert.equal(first.sent, 0);
  h.render('second')[0].props.onPress();
  assert.equal(second.prompt, 'other hi');
  assert.equal(first.prompt, 'DRAFT hi keep');
  assert.deepEqual(h.selectors, ['first', 'second']);
  assert.equal(second.setCalls, 0); assert.equal(second.sent, 0);
});

test('replaces only the selection and repeated clicks insert repeatedly', () => {
  const target = composer('DRAFT replace keep', 6, 13);
  const h = harness([' hi'], { a: target });
  const [button] = h.render('a');
  button.props.onPress(); button.props.onPress();
  assert.equal(target.prompt, 'DRAFT  hi hi keep');
  assert.equal(target.insertCalls, 2); assert.equal(target.setCalls, 0); assert.equal(target.sent, 0);
});

test('empty phrase, missing agent and missing composer do nothing', () => {
  const target = composer('DRAFT');
  const fallback = composer('fallback');
  const h = harness(['', ' hi'], { a: target, 'no-agent': fallback });
  const empty = h.render('a')[0];
  assert.equal(empty.props.disabled, true); empty.props.onPress();
  const missingAgent = h.render(null)[1];
  assert.equal(missingAgent.props.disabled, true); missingAgent.props.onPress();
  const missingComposer = h.render('absent')[1];
  assert.equal(missingComposer.props.disabled, true); missingComposer.props.onPress();
  assert.deepEqual(h.selectors, ['a', 'no-agent', 'absent']);
  assert.equal(target.prompt, 'DRAFT'); assert.equal(target.insertCalls, 0);
  assert.equal(fallback.prompt, 'fallback'); assert.equal(fallback.insertCalls, 0);
  assert.equal(target.setCalls + fallback.setCalls, 0); assert.equal(target.sent + fallback.sent, 0);
});
