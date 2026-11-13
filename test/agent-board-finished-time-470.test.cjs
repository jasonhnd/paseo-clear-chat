'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { finishedClock, localDayBounds } = require('../client/agent-board-model.ts');

function harness(locale) {
  const h = require('./helpers/tool-harness.cjs').createToolHarness('ios', { locale });
  const messages = h.load('client/messages.ts').messages;
  const project = { id: 'project', key: 'project' };
  const workspace = { id: 'workspace', key: 'workspace', project };
  const agentRef = { id: 'agent', key: 'agent', hostId: 'host' };
  const agent = { id: 'agent', ref: agentRef, workspace, title: 'Conversation', status: 'running', attentionReason: null, lastActivityAt: new Date().toISOString() };
  const states = new Map(), effects = new Map(), opened = [];
  let current, index, pending = [], nodes = [];
  const react = {
    useState(initial) {
      const key = `${current}:${index++}`;
      if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
      return [states.get(key), value => states.set(key, typeof value === 'function' ? value(states.get(key)) : value)];
    },
    useEffect(fn, deps) {
      const key = `${current}:${index++}`;
      if (current.endsWith(':TodayBoard')) return;
      const previous = effects.get(key);
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        effects.set(key, deps);
        pending.push(fn);
      }
    },
  };
  const hooks = {
    useComposers: () => [], useProjects: () => [project], useProject: () => ({ displayName: 'Project' }),
    useWorkspaces: () => [workspace], useAgent: () => agent,
    useTranslation: () => ({ t: (key, options) => h.translations.runtime.t(messages, key, options) }),
    useAgents: query => {
      if (!query.where(agent)) return [];
      return [{ key: query.groupBy(agent), items: [agentRef] }];
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const native = { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: x => x, hairlineWidth: 1 } };
  const filename = path.join(__dirname, '../client/components/agent-board.tsx');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const req = id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === 'react-native') return native;
    if (id === '@getpaseo/plugin/client') return hooks;
    if (id === '../preferences') return { useEnhancerPreferences: () => ({ savedReplies: [] }) };
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
    walk(mod.exports.ClearChatSidebar({ theme: { colors: { border: 'border', foreground: 'fg', foregroundMuted: 'muted', accent: 'accent' } }, navigation: { openAgent: ref => opened.push(ref) } }));
    return nodes.filter(node => node.type === 'literal').map(node => node.text);
  }
  function flushAt(now) {
    const original = Date.now;
    try { Date.now = () => now; const work = pending; pending = []; work.forEach(fn => fn()); }
    finally { Date.now = original; }
    return render();
  }
  return { agent, agentRef, opened, render, flushAt, nodes: () => nodes };
}

const today = localDayBounds(Date.now());
const clockTime = new Date(today.start); clockTime.setHours(14, 32, 0, 0);
const yesterday = today.start - 60_000;

function finish(h, observedAt) {
  h.render(); h.flushAt(observedAt - 1000);
  h.agent.status = 'idle'; h.agent.attentionReason = 'finished';
  h.render();
  return h.flushAt(observedAt);
}

test('observed completion renders local time in Chinese and English on the clickable row', () => {
  assert.equal(finishedClock(clockTime.getTime(), today), '14:32');
  for (const [locale, expected] of [['zh-CN', '14:32 完成'], ['en', 'Finished 14:32']]) {
    const h = harness(locale);
    const text = finish(h, clockTime.getTime());
    assert.ok(text.includes(expected));
    assert.ok(!text.some(value => value.includes('sidebar.finishedAt')));
    const row = h.nodes().find(node => node.type === 'Pressable' && node.props.accessibilityRole === 'button');
    row.props.onPress();
    assert.deepEqual(h.opened, [h.agentRef]);
  }
});

test('an initial finished snapshot does not render a time or placeholder', () => {
  assert.equal(finishedClock(undefined, today), null);
  assert.equal(finishedClock(NaN, today), null);
  const h = harness('zh-CN');
  h.agent.status = 'idle'; h.agent.attentionReason = 'finished';
  h.render();
  const text = h.flushAt(clockTime.getTime()).join(' ');
  assert.ok(text.includes('Conversation'));
  assert.ok(!/finishedAt|undefined|0 完成|14:32 完成/.test(text));
});

test('a completion observed before local midnight is not displayed on today’s row', () => {
  assert.equal(finishedClock(yesterday, today), null);
  assert.equal(finishedClock(today.end, today), null);
  const h = harness('zh-CN');
  const text = finish(h, yesterday).join(' ');
  assert.ok(text.includes('Conversation'));
  assert.ok(!text.includes(`${new Date(yesterday).getHours().toString().padStart(2, '0')}:${new Date(yesterday).getMinutes().toString().padStart(2, '0')} 完成`));
  assert.ok(!/finishedAt|undefined|0 完成/.test(text));
});
