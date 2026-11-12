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
  { id: 'b', ref: ref('b'), title: 'Winter Notes', metadata: { clearChatOutline: {
    version: 1, replyId: 'reply', at: 'now', updatedAt: 'now',
    headings: [{ text: 'Hidden Snapshot Text', level: 1, offset: 0 }],
  } } },
  { id: 'c', ref: { kind: 'agent', id: 'c', hostId: 'host-two', key: 'host-two:c' }, title: 'Other host', metadata: { clearChatOutline: {
    version: 1, replyId: 'reply', at: 'now', updatedAt: 'now',
    headings: [{ text: 'Hidden Snapshot Text', level: 1, offset: 0 }],
  } } },
];

function harness(locale = 'en', missingKeyReturnsKey = false) {
  const h = require('./helpers/tool-harness.cjs').createToolHarness('ios', { locale });
  const messages = h.load('client/messages.ts').messages;
  const states = new Map(), effects = new Map(), opened = [], requests = [];
  const pages = {
    a: { entries: [{ item: { type: 'user_message', text: 'Loaded Needle Text' } }], hasOlder: true },
    b: { entries: [{ item: { type: 'assistant_message', text: 'Current page' } }], hasOlder: true },
    c: { entries: [{ item: { type: 'assistant_message', text: 'Loaded Needle Text' } }], hasOlder: false },
  };
  const olderPage = { entries: [{ item: { type: 'user_message', text: 'Unloaded older text' } }], hasOlder: false };
  const paseo = { agents: { ref: ref => ({ timeline: { refetch: async options => {
    requests.push({ ref, options }); return options.direction === 'before' ? olderPage : pages[ref.id];
  } } }) } };
  let current, index, nodes = [], active = { agent: agents[0].ref }, hosts = [{ serverId: 'host-one' }, { serverId: 'host-two' }];
  const react = {
    useState(initial) {
      const key = `${current}:${index++}`;
      if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
      return [states.get(key), value => states.set(key, typeof value === 'function' ? value(states.get(key)) : value)];
    },
    useEffect(effect, deps) {
      if (!current.endsWith(':SearchBoard')) return;
      const key = `${current}:${index++}`;
      const previous = effects.get(key);
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        previous?.cleanup?.();
        effects.set(key, { deps, cleanup: effect() });
      }
    },
  };
  const hooks = {
    useProjects: () => [],
    usePaseo: () => paseo,
    useHosts: () => hosts,
    useAgents: query => agents.filter(query.where).map(agent => agent.ref),
    useAgent: agentRef => agents.find(agent => agent.ref.key === agentRef.key) ?? null,
    useTranslation: () => ({ t: key => missingKeyReturnsKey && key === 'sidebar.searchLimitOlder' ? key : h.translations.runtime.t(messages, key) }),
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
    if (id === '../preferences') return { useEnhancerPreferences: () => ({ savedReplies: [] }) };
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
  return { render, search, opened, requests, messages, nodes: () => nodes, setActive: value => { active = value; }, setHosts: value => { hosts = value; } };
}

test('searches titles and fetched timeline text on the active host and opens a hit', async () => {
  const h = harness();
  h.render();
  h.nodes().filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'tab')[3].props.onPress();
  let text = h.render();
  await new Promise(resolve => setImmediate(resolve));
  text = h.render();
  assert.ok(!text.includes('Summer Planning'));
  assert.ok(!text.includes('No matching conversations.'));
  assert.ok(text.includes('Only loaded titles and fetched timeline text on the current host are searched. Older pages were not fetched, so their text was not searched. Unloaded history, archived conversations, and other providers are not included.'));
  text = h.search('sUMMer');
  assert.ok(text.includes('Summer Planning'));
  assert.ok(!text.includes('Winter Notes'));
  h.nodes().find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'button').props.onPress();
  assert.deepEqual(h.opened, [agents[0].ref]);
  text = h.search('sNaPsHoT');
  assert.ok(text.includes('No matching conversations.'));
  text = h.search('nEeDlE');
  assert.ok(text.includes('Summer Planning'));
  assert.ok(!text.includes('Other host'));
  h.nodes().find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'button').props.onPress();
  assert.deepEqual(h.opened, [agents[0].ref, agents[0].ref]);
  text = h.search('unloaded older text');
  assert.ok(text.includes('No matching conversations.'));
  assert.deepEqual(h.requests.map(request => request.ref.id).sort(), ['a', 'b']);
  assert.ok(h.requests.every(request => JSON.stringify(request.options) === JSON.stringify({ direction: 'tail', limit: 100, projection: 'canonical' })));
  text = h.search('missing');
  assert.ok(text.includes('No matching conversations.'));
  h.search('summer');
  h.setActive({ agent: { hostId: 'host-two' } });
  text = h.render();
  assert.ok(!text.includes('Summer Planning'));
  assert.ok(text.includes('No matching conversations.'));
});

test('shows the shorter limitation when the fetched page has no older pages', async () => {
  const h = harness();
  h.setActive({ agent: agents[2].ref });
  h.render();
  h.nodes().filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'tab')[3].props.onPress();
  h.render();
  await new Promise(resolve => setImmediate(resolve));
  const text = h.render();
  assert.ok(text.includes('Only loaded titles and timeline text on the current host are searched. Unloaded history, archived conversations, and other providers are not included.'));
  assert.deepEqual(h.requests.map(request => request.ref.id), ['c']);
});

for (const missingKeyReturnsKey of [false, true]) test(`renders the English older-page limitation in Japanese (missing key returned: ${missingKeyReturnsKey})`, async () => {
  const h = harness('ja', missingKeyReturnsKey);
  assert.equal(Object.hasOwn(h.messages.resources.ja.sidebar, 'searchLimitOlder'), false);
  h.render();
  h.nodes().filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'tab')[3].props.onPress();
  h.render();
  await new Promise(resolve => setImmediate(resolve));
  const text = h.render().join(' ');
  assert.ok(text.includes('Older pages were not fetched, so their text was not searched.'));
  assert.ok(!text.includes('sidebar.searchLimitOlder'));
  assert.deepEqual(h.requests.map(request => request.ref.id).sort(), ['a', 'b']);
  assert.ok(h.requests.every(request => request.options.direction === 'tail'));
});

test('uses a single host as fallback and handles no hosts', () => {
  const h = harness();
  h.setActive(undefined);
  h.setHosts([]);
  h.render();
  h.nodes().filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'tab')[3].props.onPress();
  h.render();
  let text = h.search('summer');
  assert.ok(text.includes('No matching conversations.'));
  h.setHosts([{ serverId: 'host-one' }]);
  text = h.render();
  assert.ok(text.includes('Summer Planning'));
  h.setHosts([{ serverId: 'host-one' }, { serverId: 'host-two' }]);
  text = h.render();
  assert.ok(text.includes('No matching conversations.'));
});
