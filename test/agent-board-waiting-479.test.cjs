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

function harness(agents, { live = false, hosts = [{ serverId: 'srv_1', status: 'online' }], refresh = async () => null } = {}) {
  const h = require('./helpers/tool-harness.cjs').createToolHarness('ios', { locale: 'en' });
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
  const hooks = {
    useProjects: () => [],
    useTranslation: () => ({ t: (key, options) => h.translations.runtime.t(messages, key, options) }),
    useAgents: q => [{ key: 'waiting', items: agents.filter(q.where).sort(q.orderBy).map(a => a.ref) }],
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
  return { start, render, flush, calls, opened, nodes: () => nodes };
}

test('snapshot rows render synchronously without optional hooks', () => {
  const h = harness([agent('snapshot', marker())]);
  const text = h.start();
  assert.ok(text.includes('snapshot'));
  assert.ok(text.includes('3/5 answered'));
});

test('refresh discovers a row, preserves the host ref on click, and does not repeat on rerender', async () => {
  const a = agent('live');
  const h = harness([a], { live: true, refresh: async () => ({ agent: { ...a, metadata: marker() } }) });
  assert.ok(h.start().includes('Nothing waiting for your answer.'));
  const text = await h.flush();
  assert.ok(text.includes('live'));
  assert.ok(text.includes('3/5 answered'));
  assert.ok(text.includes('Worktree Alpha'));
  h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityRole === 'button').props.onPress();
  assert.deepEqual(h.opened, [a.ref]);
  h.render(); await h.flush();
  assert.deepEqual(h.calls, [a.ref]);
});

test('host mismatch skips refresh and leaves the board empty', async () => {
  const h = harness([agent('foreign', {}, 'srv_2')], { live: true });
  h.start(); const text = await h.flush();
  assert.equal(h.calls.length, 0);
  assert.ok(text.includes('Nothing waiting for your answer.'));
  assert.ok(!text.includes('foreign'));
});

test('a rejected refresh does not prevent other rows from appearing', async () => {
  const bad = agent('bad'), good = agent('good');
  const h = harness([bad, good], { live: true, refresh: async r => {
    if (r.id === 'bad') throw Error('offline');
    return { agent: { ...good, metadata: marker() } };
  } });
  h.start(); const text = await h.flush();
  assert.ok(!text.includes('bad'));
  assert.ok(text.includes('good'));
  assert.ok(text.includes('3/5 answered'));
});


test('a pending refresh does not delay a different live row', async () => {
  const slow = agent('slow'), fast = agent('fast');
  const h = harness([slow, fast], { live: true, refresh: r => r.id === 'slow'
    ? new Promise(() => {}) : Promise.resolve({ agent: { ...fast, metadata: marker() } }) });
  h.start(); const text = await h.flush();
  assert.ok(text.includes('fast'));
  assert.ok(!text.includes('slow'));
});

test('unanswered cards remain in the first group and errors appear in a separate group', () => {
  const unanswered = agent('needs-answer', marker());
  const failed = { ...agent('failed'), status: 'error' };
  const both = { ...agent('failed-with-answer', marker()), status: 'error' };
  const h = harness([unanswered, failed, both]);
  const text = h.start();
  const firstGroup = text.lastIndexOf('Answers waiting');
  const errorGroup = text.indexOf('Errors');
  assert.ok(firstGroup >= 0 && errorGroup > firstGroup);
  assert.ok(text.slice(firstGroup, errorGroup).includes('needs-answer'));
  assert.ok(text.slice(firstGroup, errorGroup).includes('failed-with-answer'));
  assert.ok(!text.slice(firstGroup, errorGroup).includes('failed'));
  assert.ok(text.slice(errorGroup).includes('failed'));
  assert.ok(text.slice(errorGroup).includes('failed-with-answer'));
  h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityRole === 'button' && n.props.children.some(child => child?.props?.children === 'failed')).props.onPress();
  assert.deepEqual(h.opened, [failed.ref]);
});

test('idle, running and unknown status are neither unread nor errors', () => {
  const timestamp = '2026-11-12T12:00:00Z';
  const agents = ['idle', 'running', 'unknown'].map(status => ({
    ...agent(`${status}-agent`, { clearChat: { pending: 0, total: 1, updatedAt: timestamp } }),
    status, updatedAt: timestamp, lastActivityAt: timestamp, attentionReason: 'finished',
  }));
  const h = harness(agents);
  let text = h.start();
  for (const a of agents) assert.ok(!text.includes(a.id));
  assert.ok(!text.some(value => /unread/i.test(value)));
  assert.ok(text.includes('Nothing waiting for your answer.'));
  agents[0].status = 'error';
  text = h.render();
  assert.ok(text.slice(text.indexOf('Errors')).includes('idle-agent'));
  agents[0].status = 'idle';
  text = h.render();
  assert.ok(!text.includes('idle-agent'));
});
