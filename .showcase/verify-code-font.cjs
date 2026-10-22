const { createRequire } = require('node:module');
const { resolve, join, dirname } = require('node:path');
const { createServer } = require('node:http');
const { createServer: createTcpServer } = require('node:net');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
const assert = require('node:assert/strict');
// Replay actual components with synthetic replies and sanitized tool fixtures.
const root = resolve(__dirname, '..');
const req = createRequire(join(root, '.showcase/package.json'));
const { build } = req('esbuild');
const { chromium } = req('playwright-core');
const temp = process.env.KANBAN_TMP;
if (!temp) throw new Error('KANBAN_TMP must name the task temporary directory.');
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, 'code-font-browser');
mkdirSync(work, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClearChatSettingsPage } from './client/settings-page';
import { MarkdownView } from './client/components/markdown/markdown-view';
import { ToolCallout } from './client/components/tool-callouts';
import { buildLiveToolCallData } from './client/tool-call-data';
import { buildThemeTokens } from './client/components/theme-tokens';
import { embedFonts } from './client/components/embed-fonts';
import { initializeEnhancerPreferences, useEnhancerPreferences } from './client/preferences';
import errors from './test/fixtures/real-hermes-errors.json';
const dark = new URLSearchParams(location.search).get('theme') !== 'light';
const colors = { surface0: dark ? '#111111' : '#ffffff', foreground: dark ? '#eeeeee' : '#222222', foregroundMuted: '#777777', accent: '#4488cc', accentForeground: '#ffffff', statusDanger: '#ee3333' };
let values = { preferences: {}, legacyMigrated: true };
await initializeEnhancerPreferences(async (contract, input) => {
  if (contract.name.endsWith('.write')) values = input.values;
  return { status: contract.name.endsWith('.write') ? 'saved' : 'ready', revision: '0', values };
});
embedFonts();
const shell = errors.items.find(item => item.detail?.type === 'shell');
const diff = { type: 'tool_call', name: 'Edit', callId: 'sample-diff', status: 'completed', detail: { type: 'edit', filePath: 'sample.ts', input: { old_string: 'before_sample', new_string: 'after_sample' } } };
function App() {
  const preferences = useEnhancerPreferences();
  const tokens = buildThemeTokens(colors, preferences);
  return <main data-pmono style={{ padding: 12, boxSizing: 'border-box', width: '100%', background: colors.surface0 }}>
    <ClearChatSettingsPage theme={{colors}} />
    <div data-surface='reply'><MarkdownView variant="document" text={'Use \u0060inline_sample\u0060 here.\\n\\n\u0060\u0060\u0060js\\nconst fenced_sample = 1;\\n\u0060\u0060\u0060'} tokens={tokens} /></div>
    <div data-surface='terminal'><ToolCallout data={buildLiveToolCallData(shell)} tokens={tokens} expanded onExpandedChange={() => {}} /></div>
    <div data-surface='diff'><ToolCallout data={buildLiveToolCallData(diff)} tokens={tokens} expanded onExpandedChange={() => {}} /></div>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
`;
async function portAvailable(port) {
  return new Promise(resolve => {
    const server = createTcpServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
(async () => {
  let browser, server;
  try {
    const bundle = await build({
      absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
      bundle: true, write: false, format: 'esm', jsx: 'automatic', platform: 'browser', define: { global: 'globalThis' },
      alias: {
        react: dirname(req.resolve('react/package.json')),
        'react-dom/client': req.resolve('react-dom/client'),
        'react-native': req.resolve('react-native-web'),
        '@getpaseo/plugin/client/react-native': join(root, '.showcase/shims/plugin-react-native.tsx'),
        '@getpaseo/plugin/client': join(root, '.showcase/shims/plugin-client.tsx'),
      },
      nodePaths: [join(root, '.showcase/node_modules')],
    });
    writeFileSync(join(work, 'font-preview.js'), bundle.outputFiles[0].contents);
    server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/bundle.js' ? bundle.outputFiles[0].contents : '<html><head><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let port;
    for (let candidate = 9444; candidate <= 9499; candidate++) if (await portAvailable(candidate)) { port = candidate; break; }
    assert.ok(port, 'a permitted Chrome debug port is available');
    const profile = join(work, 'chrome-profile');
    mkdirSync(profile, { recursive: true });
    browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true,
      args: [`--remote-debugging-port=${port}`, '--disable-background-networking', '--no-first-run'],
      reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error('PAGE ERROR:', error.stack); });
    await page.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`) ? route.continue() : route.abort());
    const report = [];
    const options = [['Follow Paseo', 'host'], ['Iosevka', 'iosevka'], ['Menlo', 'menlo'], ['Consolas', 'consolas'], ['Fira Code', 'fira-code'], ['Cascadia Code', 'cascadia-code']];
    for (const width of [1440, 1024, 820, 390]) for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
      await page.getByRole('button', { name: 'Follow Paseo', exact: true }).waitFor();
      for (const [label, id] of options) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        const result = await page.evaluate(({ label, id, width, theme }) => {
          function family(surface, needle) {
            const target = [...document.querySelectorAll(`[data-surface="${surface}"] *`)]
              .filter(node => node.matches('[dir=auto], span') && node.textContent.includes(needle)).sort((a, b) => a.textContent.length - b.textContent.length)[0];
            if (!target) throw new Error(`Missing ${surface}: ${needle}`);
            return getComputedStyle(target).fontFamily.replaceAll('"', '');
          }
          const faces = { inline: family('reply', 'inline_sample'), code: family('reply', 'fenced_sample'), terminal: family('terminal', 'No such'), diff: family('diff', 'before_sample') };
          const codeFont = faces.code;
          const canvas = document.createElement('canvas').getContext('2d');
          canvas.font = `12px "${codeFont}"`;
          const widths = [...'iWM1l.@#'].map(letter => canvas.measureText(letter).width);
          const controls = [...document.querySelectorAll('[role="button"]')].filter(node => ['Follow Paseo','Iosevka','Menlo','Consolas','Fira Code','Cascadia Code'].includes(node.textContent));
          return { width, theme, id, faces, uniform: Math.max(...widths) - Math.min(...widths) < 0.01,
            scrollWidth: document.documentElement.scrollWidth,
            controlsFit: controls.length === 6 && controls.every(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= width; }) };
        }, { label, id, width, theme });
        const mono = ['host','iosevka'].includes(id) ? 'OMP Iosevka' : `Clear Chat ${id}`;
        const code = ['host','iosevka'].includes(id) ? 'OMP Iosevka Code' : mono;
        assert.deepEqual(result.faces, { inline: mono, code, terminal: mono, diff: code });
        assert.ok(result.uniform && result.controlsFit && result.scrollWidth === width, JSON.stringify(result));
        report.push(result);
        console.log(`${width}px ${theme} ${label}: fonts, monospace and layout passed`);
      }
      await page.screenshot({ path: join(work, `font-${width}-${theme}.png`), fullPage: true });
    }
    assert.deepEqual(pageErrors, []);
    writeFileSync(join(work, 'font-browser-report.json'), JSON.stringify({ debugPort: port, bundleBytes: bundle.outputFiles[0].contents.length, cases: report }, null, 2));
    console.log(JSON.stringify({ cases: report.length, widths: [1440,1024,820,390], themes: ['dark','light'], debugPort: port, bundleBytes: bundle.outputFiles[0].contents.length, allUniform: true, allControlsFit: true, noOverflow: true, pageErrors }));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(join(work, 'chrome-profile'), { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
