'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const ref = id => ({ kind: 'agent', id, hostId: 'host-one', key: `host-one:${id}` });
const agents = [
  { id: 'a', ref: ref('a'), title: 'Summer Planning' },
  { id: 'b', ref: ref('b'), title: 'Winter Notes' },
];

function harness() {
  const h = require('./helpers/tool-harness.cjs').createToolHarness('ios', { locale: 'en' });
  const messages = h.load('client/messages.ts').messages;
  const states = new Map(), opened = [];
  let current, index, nodes = [], active = { agent: agents[0].ref };
  const react = {
    useState(initial) {
      const key = `${current}:${index++}`;
      if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
      return [states.get(key), value => states.set(key, value)];
    },
    useEffect() {},
  };
  const hooks = {
    useProjects: () => [],
    useHosts: () => [{ serverId: 'host-one' }, { serverId: 'host-two' }],
    useAgents: query => agents.filter(query.where).map(agent => agent.ref),
    useAgent: agentRef => agents.find(agent => agent.ref.key === agentRef.key) ?? null,
    useTranslation: () => ({ t: key => h.translations.runtime.t(messages, key) }),
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const native = { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: x => x, hairlineWidth: 1 } };
  const filename = path.join(root, 'client/components/agent-board.tsx');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const req = id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (id === 'react-native') return native;
    if (id === '@getpaseo/plugin/client') return hooks;
    if (id === '../messages') return { messages };
    if (id === '../agent-board-model') return require('../client/agent-board-model.ts');
    if (id === '../outline-model') return require('../client/outline-model.ts');
    throw Error(`unexpected import ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename })(req, mod, mod.exports);
  function walk(node, key = 'root') {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${key}.${i}`));
    if (typeof node !== 'object') { nodes.push({ type: 'literal', text: String(node) }); return; }
    if (typeof node.type === 'function') { current = `${key}:${node.type.name}`; index = 0; return walk(node.type(node.props), key); }
    nodes.push(node); walk(node.props.children, `${key}.children`);
  }
  function render() {
    nodes = []; current = 'root:ClearChatSidebar'; index = 0;
    walk(mod.exports.ClearChatSidebar({ theme: { colors: { border: 'border', foreground: 'fg', foregroundMuted: 'muted', accent: 'accent' } }, active, navigation: { openAgent: agentRef => opened.push(agentRef) } }));
    return nodes.filter(node => node.type === 'literal').map(node => node.text);
  }
  function search(query) { nodes.find(node => node.type === 'TextInput').props.onChangeText(query); return render(); }
  return { render, search, opened, nodes: () => nodes, setActive: value => { active = value; } };
}

test('searches loaded titles on the active host and opens a matching agent', () => {
  const h = harness();
  h.render();
  h.nodes().filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'tab')[3].props.onPress();
  let text = h.render();
  assert.ok(!text.includes('Summer Planning'));
  assert.ok(!text.includes('No matching conversations.'));
  assert.ok(text.includes('Only loaded titles on the current host are searched. Archived conversations and other providers are not included.'));
  text = h.search('sUMMer');
  assert.ok(text.includes('Summer Planning'));
  assert.ok(!text.includes('Winter Notes'));
  h.nodes().find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'button').props.onPress();
  assert.deepEqual(h.opened, [agents[0].ref]);
  text = h.search('missing');
  assert.ok(text.includes('No matching conversations.'));
  h.search('summer');
  h.setActive({ agent: { hostId: 'host-two' } });
  text = h.render();
  assert.ok(!text.includes('Summer Planning'));
  assert.ok(text.includes('No matching conversations.'));
});
