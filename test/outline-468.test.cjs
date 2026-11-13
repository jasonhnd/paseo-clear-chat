'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const modelPath = path.join(root, 'client/outline-model.ts');
// The empty implementation allows the assertions to run against the base checkout.
const model = fs.existsSync(modelPath) ? require(modelPath) : { extractHeadings: () => [], outlineFromEntries: () => null, parseOutline: () => null };

test('ATX headings preserve offsets and order, excluding fences and empty headings', () => {
  const text = '# First ###\n## Same\n~~~js\n# hidden\n~~~\n```\n### hidden\n```\n### Same\n# ###\n#### deep\n';
  assert.deepEqual(model.extractHeadings(text), [
    { text: 'First', level: 1, offset: 0 },
    { text: 'Same', level: 2, offset: text.indexOf('## Same') },
    { text: 'Same', level: 3, offset: text.indexOf('### Same') },
  ]);
});

test('last long assistant reply produces bounded metadata without bodies', () => {
  const text = '# ' + 'x'.repeat(200) + '\n' + Array.from({ length: 70 }, (_, i) => `## H${i}`).join('\n') + '\n' + '😀'.repeat(1200);
  const entries = [
    { item: { type: 'assistant_message', text: '# old\n' + 'a'.repeat(1200), id: 'old' }, at: 'old-at' },
    { item: { type: 'assistant_message', text, id: 'new' }, at: 'new-at' },
    { item: { type: 'assistant_message', text: '# short', id: 'short' }, at: 'short-at' },
  ];
  const marker = model.outlineFromEntries(entries, 'updated');
  assert.ok(marker);
  assert.equal(marker.replyId, 'new'); assert.equal(marker.at, 'new-at'); assert.equal(marker.updatedAt, 'updated');
  assert.equal(marker.headings.length, 64); assert.equal(Array.from(marker.headings[0].text).length, 160);
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'headings', 'replyId', 'updatedAt', 'version']);
  assert.ok(JSON.stringify(marker).length < 20000); assert.ok(!JSON.stringify(marker).includes('😀'));
  assert.equal(model.outlineFromEntries([{ item: { type: 'assistant_message', id: 'x', text: '😀'.repeat(1199) }, at: 'a' }], 'u'), null);
});

test('metadata validation rejects malformed, wrong-version and oversized markers', () => {
  const good = { version: 1, replyId: 'r', at: 'a', updatedAt: 'u', headings: [{ text: 'Title', level: 1, offset: 0 }] };
  assert.deepEqual(model.parseOutline(good), good);
  for (const bad of [null, [], 'bad', { ...good, version: 2 }, { ...good, replyId: 'x'.repeat(20000) }, { ...good, headings: Array(65).fill(good.headings[0]) }, { ...good, headings: [{ text: 'x'.repeat(161), level: 1, offset: 0 }] }, { ...good, headings: [{ text: 'Title', level: 4, offset: 0 }] }]) assert.equal(model.parseOutline(bad), null);
});

function render(marker, active = { kind: 'agent', hostId: 'host', id: 'a', key: 'host:a' }) {
  const messages = require('./helpers/tool-harness.cjs').createToolHarness('ios').load('client/messages.ts').messages;
  const hooks = { useTranslation: () => ({ t: k => ({ 'sidebar.directoryEmpty': 'EMPTY' }[k] || k) }), useHosts: () => [{ serverId: 'host', label: 'Host', status: 'online' }], useAgent: () => ({ metadata: { clearChatOutline: marker } }) };
  const react = { useState: () => ['directory', () => {}], useEffect: () => {} };
  const jsx = (type, props) => ({ type, props: props || {} });
  const native = { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: x => x, hairlineWidth: 1 } };
  const filename = path.join(root, 'client/components/agent-board.tsx');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const req = id => id === 'react' ? react : id === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : id === 'react-native' ? native : id === '@getpaseo/plugin/client' ? hooks : id === '../messages' ? { messages } : id === '../agent-board-model' ? require('../client/agent-board-model.ts') : id === '../outline-model' ? model : require(id);
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename })(req, mod, mod.exports);
  const nodes = [];
  function walk(n) { if (n == null || typeof n === 'boolean') return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n !== 'object') { nodes.push({ type: 'literal', text: String(n) }); return; } if (typeof n.type === 'function') return walk(n.type(n.props)); nodes.push(n); walk(n.props.children); }
  walk(mod.exports.ClearChatSidebar({ theme: { colors: { border: 'b', foreground: 'f', foregroundMuted: 'm', accent: 'a' } }, active: { agent: active }, navigation: { openAgent() {} } }));
  return nodes;
}

test('outline tab renders heading text read-only and empty for invalid metadata or absent agent', () => {
  const marker = { version: 1, replyId: 'r', at: 'a', updatedAt: 'u', headings: [{ text: 'Section', level: 2, offset: 9 }] };
  const nodes = render(marker); assert.ok(nodes.some(n => n.text === 'Section'));
  assert.equal(nodes.filter(n => n.type === 'Pressable' && n.props.accessibilityRole !== 'tab').length, 0);
  assert.ok(render({ ...marker, version: 2 }).some(n => n.text === 'EMPTY'));
  assert.ok(render(marker, null).some(n => n.text === 'EMPTY'));
});

test('outline labels and translation parity cover en, zh-CN and ja', () => {
  const h = require('./helpers/tool-harness.cjs').createToolHarness('ios');
  const messages = h.load('client/messages.ts').messages;
  const keys = value => Object.entries(value).flatMap(([k, v]) => typeof v === 'string' ? [k] : keys(v).map(child => `${k}.${child}`)).sort();
  for (const locale of ['en', 'zh-CN', 'ja']) {
    assert.ok(messages.resources[locale].sidebar.directory); assert.ok(messages.resources[locale].sidebar.directoryEmpty);
    // English fallback copy that intentionally has no Japanese translation yet.
    const optionalJa = new Set(locale === 'ja' ? ['prompt.imagesDidNotLoad', 'prompt.retryImages'] : []);
    assert.deepEqual(keys(messages.resources[locale]).filter(key => !optionalJa.has(key)), keys(messages.resources.en).filter(key => !optionalJa.has(key)));
  }
});
