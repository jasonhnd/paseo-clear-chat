'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const ref = (kind, id) => ({ kind, key: `host:${id}`, hostId: 'host', id });
const workspace = ref('workspace', 'work');
const agent = (id, marker, title = id) => ({ ref: ref('agent', id), id, title, workspace, metadata: marker, status: 'idle', lastActivityAt: '', updatedAt: '' });
const marker = (pending, total, updatedAt) => ({ clearChat: { pending, total, updatedAt } });

function render(agents = [], { locale = 'en', projectCount = 1, workspaceName = 'Worktree Alpha' } = {}) {
  const loadMessages = require('./helpers/tool-harness.cjs').createToolHarness;
  // Load the real message definition through the existing harness and SDK translation runtime.
  const h = loadMessages('ios', { locale });
  h.setLocale(locale);
  const translations = h.translations;
  const messages = h.load('client/messages.ts').messages;
  const opened = [];
  const hooks = {
    useTranslation: () => ({ locale, t: (key, options) => translations.runtime.t(messages, key, options) }),
    useProjects: () => projectCount ? [ref('project', 'p')] : [],
    useAgents: q => {
      const groups = new Map();
      for (const a of agents.filter(q.where).sort(q.orderBy)) {
        const key = q.groupBy(a);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a.ref);
      }
      return [...groups].map(([key, items]) => ({ key, title: null, color: null, items }));
    },
    useAgent: (ref, selector) => { const found = typeof ref === "object" && ref && typeof ref.key === "string" ? (agents.find(a => a.ref.key === ref.key) ?? null) : null; return found && selector ? selector(found) : found; },
    // waitA showed wks_... instead of ws-n1 when the workspace was looked up by id.
    useWorkspace: (ref, selector) => { const found = typeof ref === "object" && ref && typeof ref.key === "string" ? (ref.key === workspace.key ? { ref: workspace, id: workspace.id, name: workspaceName, displayName: workspaceName } : null) : null; return found && selector ? selector(found) : found; },
    useProject: () => null, useWorkspaces: () => [],
  };
  const react = { useState: () => ['waiting', () => {}], useEffect: () => {} };
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
    if (id === '../answers-waiting-model') return require('../client/answers-waiting-model.ts');
    throw Error(`unexpected import ${id}`);
  };
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename })(req, mod, mod.exports);
  const nodes = [];
  function walk(n) {
    if (n == null || typeof n === 'boolean') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== 'object') { nodes.push({ type: 'literal', text: String(n) }); return; }
    if (typeof n.type === 'function') return walk(n.type(n.props));
    nodes.push(n); walk(n.props?.children);
  }
  walk(mod.exports.ClearChatSidebar({ theme: { colors: { border: 'border', foreground: 'fg', foregroundMuted: 'muted', accent: 'accent' } }, navigation: { openAgent: r => opened.push(r) } }));
  return { nodes, text: nodes.filter(n => n.type === 'literal').map(n => n.text), opened, messages, translations, h };
}

test('filters positive finite pending markers, handles malformed metadata and clamps answered', () => {
  const inputs = [agent('good', marker(2, 5, '2026-01-01T00:00:00Z')), agent('clamp', marker(7, 2, '2026-01-01T00:00:00Z')), ...[null, {}, 'x', [], { clearChat: null }, { clearChat: [] }, marker(0, 2, ''), marker(-1, 2, ''), marker(NaN, 2, ''), marker(Infinity, 2, ''), marker('2', 2, '')].map((m, i) => agent(`bad${i}`, m))];
  const { text } = render(inputs);
  assert.ok(text.includes('good')); assert.ok(text.includes('clamp'));
  assert.ok(text.includes('3/5 answered')); assert.ok(text.includes('0/2 answered'));
  for (let i = 0; i < 11; i++) assert.ok(!text.includes(`bad${i}`));
});

test('orders all agents by marker time descending, invalid last, ties by title then id', () => {
  const inputs = [agent('bad', marker(1, 2, 'bad'), 'Unknown'), agent('old', marker(1, 2, '2020-01-01T00:00:00Z'), 'Old'), agent('b', marker(1, 2, '2026-01-01T00:00:00Z'), 'Same'), agent('a', marker(1, 2, '2026-01-01T00:00:00Z'), 'Same'), agent('z', marker(1, 2, '2026-01-01T00:00:00Z'), 'Alpha')];
  const { nodes, text } = render(inputs);
  const buttons = nodes.filter(n => n.type === 'Pressable' && n.props.accessibilityRole === 'button');
  const ids = buttons.map(n => { const opened = []; n.props.onPress(); return n; });
  assert.equal(ids.length, 5);
  assert.ok(text.indexOf('Alpha') < text.indexOf('Same'));
  assert.ok(text.lastIndexOf('Same') < text.indexOf('Old'));
  assert.ok(text.indexOf('Old') < text.indexOf('Unknown'));
  assert.ok(text.includes('Time unknown'));
  const rendered = render(inputs); rendered.nodes.filter(n => n.type === 'Pressable' && n.props.accessibilityRole === 'button').forEach(n => n.props.onPress());
  assert.deepEqual(rendered.opened.map(r => r.id), ['z', 'a', 'b', 'old', 'bad']);
});

test('row displays workspace, title, progress and local time; press opens its ref once', () => {
  const date = '2026-04-02T13:04:00Z'; const a = agent('long-agent-id', marker(1, 4, date), 'Agent title');
  const { nodes, text, opened } = render([a], { projectCount: 0 });
  assert.ok(text.includes('Worktree Alpha')); assert.ok(text.includes('Agent title')); assert.ok(text.includes('3/4 answered'));
  assert.ok(text.includes(new Date(date).toLocaleString()));
  const row = nodes.find(n => n.type === 'Pressable' && n.props.accessibilityRole === 'button'); assert.ok(row); row.props.onPress(); assert.deepEqual(opened, [a.ref]);
  assert.ok(render([agent('abcdefghijk', marker(1, 1, date), null)]).text.includes('abcdefgh'));
});

test('empty and malformed metadata are safe even with no projects', () => {
  for (const agents of [[], [agent('bad', null)], [agent('bad', { clearChat: 5 })]]) assert.ok(render(agents, { projectCount: 0 }).text.includes('Nothing waiting for your answer.'));
});

test('approved strings exist in all effective locale resources with complete parity', () => {
  const { messages, translations, h } = render();
  const expected = { en: '{{answered}}/{{total}} answered', 'zh-CN': '已答 {{answered}}/{{total}}', ja: '{{answered}}/{{total}} 回答済み' };
  const keys = value => Object.entries(value).flatMap(([key, child]) => typeof child === 'string' ? [key] : keys(child).map(k => `${key}.${k}`)).sort();
  for (const locale of Object.keys(expected)) {
    assert.equal(messages.resources[locale].sidebar.answeredOf, expected[locale]);
    assert.deepEqual(keys(messages.resources[locale]), keys(messages.resources.en));
    h.setLocale(locale);
    assert.equal(translations.runtime.t(messages, 'sidebar.answeredOf', { answered: 3, total: 5 }), expected[locale].replace('{{answered}}', '3').replace('{{total}}', '5'));
  }
});
