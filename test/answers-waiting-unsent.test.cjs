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
const marker = (pending, total, updatedAt, extra = {}) => ({ clearChat: { pending, total, updatedAt, ...extra } });

function render(agents = [], { locale = 'en' } = {}) {
  const loadMessages = require('./helpers/tool-harness.cjs').createToolHarness;
  const h = loadMessages('ios', { locale });
  h.setLocale(locale);
  const translations = h.translations;
  const messages = h.load('client/messages.ts').messages;
  const hooks = { useComposers: () => [],
    useTranslation: () => ({ locale, t: (key, options) => translations.runtime.t(messages, key, options) }),
    useProjects: () => [ref('project', 'p')],
    useAgents: q => {
      const groups = new Map();
      for (const a of agents.filter(q.where).sort(q.orderBy)) {
        const key = q.groupBy(a);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a.ref);
      }
      return [...groups].map(([key, items]) => ({ key, title: null, color: null, items }));
    },
    useAgent: (agentRef, selector) => { const found = typeof agentRef === 'object' && agentRef && typeof agentRef.key === 'string' ? (agents.find(a => a.ref.key === agentRef.key) ?? null) : null; return found && selector ? selector(found) : found; },
    useWorkspace: (agentRef, selector) => { const found = typeof agentRef === 'object' && agentRef && agentRef.kind === 'workspace' && agentRef.key === workspace.key ? { ref: workspace, id: workspace.id, name: 'Worktree Alpha' } : null; return found && selector ? selector(found) : found; },
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
    if (id === '../preferences') return { useEnhancerPreferences: () => ({ savedReplies: [] }) };
    if (id === '../messages') return { messages };
    if (id === '../agent-board-model') return require('../client/agent-board-model.ts');
    if (id === '../answer-state-events') return { subscribeAnswerMetadata: () => () => {} };
    if (id === '../outline-model') return require('../client/outline-model.ts');
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
  walk(mod.exports.ClearChatSidebar({ theme: { colors: { border: 'border', foreground: 'fg', foregroundMuted: 'muted', accent: 'accent' } }, navigation: { openAgent() {} } }));
  h.unmount();
  return nodes.filter(n => n.type === 'literal').map(n => n.text);
}

const date = '2026-01-01T00:00:00Z';
const copy = { en: 'All chosen · not sent yet', 'zh-CN': '已选好，还没发送', ja: '選択済み・未送信' };

test('a partly answered card still shows its progress', () => {
  const text = render([agent('partial', marker(1, 2, date)), agent('other', marker(1, 2, date), 'other-agent')]);
  assert.ok(text.includes('partial'));
  assert.ok(text.includes('1/2 answered'));
  assert.ok(text.includes('other-agent'));
});

test('all chosen but not sent stays in Answers waiting', () => {
  const text = render([
    agent('ready', marker(0, 2, date, { sent: false })),
    agent('other', marker(1, 2, date), 'other-agent'),
  ]);
  assert.ok(text.includes('ready'));
  assert.ok(text.includes(copy.en));
  assert.ok(!text.includes('0/2 answered'));
  assert.ok(text.includes('other-agent'));
  assert.ok(text.includes('1/2 answered'));
});

test('a sent card leaves Answers waiting and does not affect another agent', () => {
  const text = render([
    agent('sent-hidden', marker(2, 2, date, { sent: true })),
    agent('other', marker(1, 2, date), 'other-agent'),
  ]);
  assert.ok(!text.includes('sent-hidden'));
  assert.ok(text.includes('other-agent'));
  assert.ok(text.includes('1/2 answered'));
});

test('old metadata without a sent field does not throw and shows chosen-not-sent when nothing is pending', () => {
  const text = render([
    agent('legacy', marker(0, 2, date)),
    agent('broken', { clearChat: { pending: '0', total: 2 } }),
    agent('empty', null),
  ]);
  assert.ok(text.includes('legacy'));
  assert.ok(text.includes(copy.en));
  assert.ok(!text.includes('broken'));
  assert.ok(!text.includes('empty'));
});

test('chosen-not-sent copy exists in every locale file and on the row', () => {
  for (const locale of Object.keys(copy)) {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'client/locales', `${locale}.json`), 'utf8'));
    assert.equal(json.answerCard.chosenNotSent, copy[locale]);
    const text = render([agent('ready', marker(0, 2, date))], { locale });
    assert.ok(text.includes(copy[locale]), locale);
    assert.ok(!text.some(value => String(value).includes('answerCard.chosenNotSent')), locale);
  }
});
