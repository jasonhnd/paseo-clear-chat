'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const ref = (kind, id, hostId = 'srv_1') => ({ kind, id, hostId, key: `${hostId}:${id}` });
const workspace = ref('workspace', 'work');
const agent = (id, metadata = {}, hostId = 'srv_1') => ({ id, ref: ref('agent', id, hostId), workspace, title: id, metadata, status: 'idle', updatedAt: '', lastActivityAt: '' });
const marker = (pending = 2, total = 5) => ({ clearChat: { pending, total, updatedAt: '2026-01-01T00:00:00Z' } });

function harness(agents, { live = false, locale = 'en', hosts = [{ serverId: 'srv_1', status: 'online' }], refresh = async () => null, composers } = {}) {
  const h = require('./helpers/tool-harness.cjs').createToolHarness('ios', { locale, composers });
  const messages = h.load('client/messages.ts').messages;
  const opened = [], calls = [], states = new Map(), effects = new Map();
  let current, index, pending = [], nodes = [];
  const react = {
    useState(initial) {
      const slot = index++, key = `${current}:${slot}`;
      if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
      return [states.get(key), value => states.set(key, typeof value === 'function' ? value(states.get(key)) : value)];
    },
    useEffect(fn, deps) {
      const key = `${current}:${index++}`, previous = effects.get(key);
      if (current.includes(':TodayBoard')) return;
      if (!previous || deps.some((v, i) => !Object.is(v, previous.deps[i]))) {
        if (previous?.cleanup) previous.cleanup();
        const entry = { deps, cleanup: null }; effects.set(key, entry);
        pending.push(() => { entry.cleanup = fn(); });
      }
    },
  };
  const hooks = { useComposers: () => [],
    useProjects: () => [],
    useTranslation: () => ({ t: (key, options) => h.translations.runtime.t(messages, key, options) }),
    useAgents: q => [{ key: typeof q.groupBy === 'function' ? q.groupBy({}) : 'waiting', items: agents.filter(q.where).sort(q.orderBy).map(a => a.ref) }],
    useAgent: (id, selector) => { const a = agents.find(a => a.id === (typeof id === 'string' ? id : id.id)); return a && selector ? selector(a) : a || null; },
    useWorkspace: () => 'Worktree Alpha',
  };
  if (live) {
    hooks.useHosts = () => hosts;
    hooks.usePaseo = () => paseo;
  }
  const paseo = { agents: { ref: r => ({ refresh: () => { calls.push(r); return refresh(r); } }) } };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const native = { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: x => x, hairlineWidth: 1 } };
  const filename = path.join(root, 'client/components/agent-board.tsx');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const req = id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === 'react-native') return native;
    if (id === '@getpaseo/plugin/client') return hooks;
    if (id === '../preferences') return { useEnhancerPreferences: () => ({ savedReplies: [] }) };
    if (id === '../answer-state-events') return h.load('client/answer-state-events.ts');
    if (id === '../messages') return { messages };
    if (id === '../agent-board-model') return require('../client/agent-board-model.ts');
    if (id === '../outline-model') return require('../client/outline-model.ts');
    throw Error(`unexpected import ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename })(req, mod, mod.exports);
  function walk(n, key = 'root') {
    if (n == null || typeof n === 'boolean') return;
    if (Array.isArray(n)) return n.forEach((child, i) => walk(child, `${key}.${i}`));
    if (typeof n !== 'object') { nodes.push({ type: 'literal', text: String(n) }); return; }
    if (typeof n.type === 'function') { current = `${key}:${n.type.name}`; index = 0; return walk(n.type(n.props), key); }
    nodes.push(n); walk(n.props.children, `${key}.children`);
  }
  function render() {
    nodes = []; current = 'root:ClearChatSidebar'; index = 0;
    walk(mod.exports.ClearChatSidebar({ theme: { colors: { border: 'border', foreground: 'fg', foregroundMuted: 'muted', accent: 'accent' } }, navigation: { openAgent: r => opened.push(r) } }));
    return nodes.filter(n => n.type === 'literal').map(n => n.text);
  }
  function start() {
    render();
    nodes.filter(n => n.type === 'Pressable' && n.props.accessibilityRole === 'tab')[1].props.onPress();
    return render();
  }
  async function flush() { const work = pending; pending = []; work.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); return render(); }
  return { start, render, flush, calls, opened, session: () => h.load('client/option-session.ts'), nodes: () => nodes };
}


const wait = () => new Promise(resolve => setImmediate(resolve));
const reply = `1) Which storage?
A Server
B File

2) Ship now?
A Yes
B No

Reply with a letter for each.`;
test('last answer refreshes after its metadata write and leaves the other agent alone', async () => {
  const a = agent('a', marker(1, 2)), b = agent('b', marker(1, 2));
  let saved = marker(1, 2), complete;
  const write = new Promise(resolve => { complete = resolve; });
  const composers = () => [{ setMetadata: async patch => { await write; saved = patch; } }];
  const h = harness([a, b], { live: true, composers, refresh: async r => ({ agent: { ...(r.id === 'a' ? a : b), metadata: r.id === 'a' ? saved : b.metadata } }) });
  h.start(); await h.flush();
  assert.ok(h.render().includes('1/2 answered'));
  const before = h.calls.length;
  const session = h.session();
  session.publishAssistantReply('a', { at: 10, text: reply });
  session.choose('a', 0, 'A');
  session.choose('a', 1, 'B');
  await wait();
  assert.equal(h.calls.length, before, 'local notify occurs before the metadata write completes');
  complete(); await wait(); await wait();
  const text = h.render();
  assert.ok(!text.includes('a'), 'last answer removes its row');
  assert.ok(text.includes('b'), 'other agent remains');
  assert.ok(h.calls.slice(before).length > 0, 'the completed write starts a refresh');
  assert.ok(h.calls.slice(before).every(r => r.id === 'a'));
});

test('a delayed older refresh cannot overwrite a newer refresh', async () => {
  const a = agent('a', marker(1, 2));
  const pending = [];
  const composers = () => [{ setMetadata: async () => {} }];
  const h = harness([a], { live: true, composers, refresh: () => new Promise(resolve => pending.push(resolve)) });
  h.start(); await h.flush();
  const session = h.session();
  session.publishAssistantReply('a', { at: 10, text: reply });
  session.choose('a', 0, 'A');
  await wait();
  assert.equal(pending.length, 2, 'completed write starts a newer refresh');
  pending[1]({ agent: { ...a, metadata: marker(0, 2) } }); await wait();
  pending[0]({ agent: { ...a, metadata: marker(1, 2) } }); await wait();
  assert.ok(!h.render().includes('a'), 'older response must not restore a finished card');
});
