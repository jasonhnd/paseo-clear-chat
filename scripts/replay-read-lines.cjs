// Offline browser checks; no running host or captured conversation is accessed.
const assert = require("node:assert/strict");
const { build } = require("../.showcase/node_modules/esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { resolve, join, dirname, isAbsolute } = require("node:path");
const { createRequire } = require("node:module");
const root = resolve(__dirname, "..");
const previewRequire = createRequire(join(root, ".showcase/package.json"));
const temp = process.env.KANBAN_TMP;
if (!temp || !isAbsolute(temp)) throw new Error("Set KANBAN_TMP to the task directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "read-lines-browser");
mkdirSync(work, { recursive: true });
const offset = require("../test/fixtures/hermes-offset-read.json").item;
const plain = Array.from({ length: 10000 }, (_, index) => index === 5000 ? `sample ${index + 50} ${"wrapped ".repeat(100)}` : `sample ${index + 50}`).join("\n");
const large = { ...offset, detail: { ...offset.detail, content: `Read ${offset.detail.filePath} — 12000 total lines\n\n\x60\x60\x60\n${plain.split("\n").map((line, index) => `${index + 50}|${line}`).join("\n")}\n\x60\x60\x60` } };
async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    if (await new Promise(resolve => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    })) return port;
  }
  throw new Error("No permitted Chrome debugging port available.");
}
async function replay() {
  const bundle = await build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { StepDetailContent } from './client/components/step-detail-content';
      import { buildLiveToolCallData } from './client/tool-call-data';
      import { embedFonts } from './client/components/embed-fonts';
      embedFonts();
      import { buildThemeTokens } from './client/components/theme-tokens';
      const tokens = buildThemeTokens({ surface0:'#ffffff', surface1:'#ffffff', surface2:'#eeeeee', border:'#cccccc', foreground:'#181818', foregroundMuted:'#555555', accent:'#3355bb', accentForeground:'#ffffff', statusSuccess:'#228844', statusWarning:'#885522', statusDanger:'#bb2222' });
      const step = buildLiveToolCallData(window.sample);
      createRoot(document.getElementById('root')).render(<StepDetailContent step={step} tokens={tokens}/>);
    ` }, bundle: true, write: false, jsx: "automatic", platform: "browser", logLevel: "warning",
    define: { global: "globalThis" }, alias: {
      react: dirname(previewRequire.resolve("react/package.json")), "react-dom/client": previewRequire.resolve("react-dom/client"),
      "react-native": previewRequire.resolve("react-native-web"),
      "@getpaseo/plugin/client/ui": join(root, ".showcase/shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(root, ".showcase/shims/step-detail-client.ts"),
    }, nodePaths: [join(root, ".showcase/node_modules")],
  });
  // Build the production entry points too, with host-injected modules external.
  for (const entry of ["index.client.tsx", "index.server.ts"]) await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, platform: entry.includes("server") ? "node" : "browser", packages: "external", jsx: "automatic", logLevel: "warning" });
  const server = createServer((request, response) => {
    const sample = request.url === "/large" ? large : offset;
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? bundle.outputFiles[0].contents : `<!doctype html><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:flex;max-width:700px;margin:auto}*{box-sizing:border-box}</style><div id="root"></div><script>window.sample=${JSON.stringify(sample).replace(/</g, "\\u003c")}</script><script src="/bundle.js"></script>`);
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launchPersistentContext(join(work, "profile"), { channel: "chrome", headless: true, args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--no-first-run"] });
    await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(origin);
      await page.getByTestId("step-detail-read-line").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const selection = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="step-detail-read-line"]')];
        const range = document.createRange();
        range.selectNodeContents(rows[0].parentElement.parentElement);
        const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range);
        return selected.toString();
      });
      assert.ok(selection.includes("export const sample = 50;"));
      assert.doesNotMatch(selection, /(?:^|\n)(?:50|51|52)(?:\n|$)|50\|/);
      await page.getByTestId("step-detail-copy-output").click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "export const sample = 50;\n\nexport const ready = true;");
      await page.goto(`${origin}/large`);
      await page.getByTestId("step-detail-read-line").first().waitFor();
      const scroll = page.getByTestId("step-detail-scroll");
      const checkpoints = [];
      for (const position of ["top", "middle", "tail"]) {
        if (position !== "top") {
          await scroll.evaluate(async (node, position) => {
            for (let attempt = 0; attempt < 1800; attempt++) {
              const rows = [...node.querySelectorAll('[data-testid="step-detail-read-line"]')];
              const target = rows.find(row => Number(row.querySelector('[data-testid="step-detail-line-number"]').textContent) === (position === "middle" ? 5050 : 10049));
              if (target) {
                node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
                await new Promise(resolve => setTimeout(resolve, 100));
                return;
              }
              node.scrollTop += Math.max(80, node.clientHeight * 0.7);
              await new Promise(resolve => setTimeout(resolve, 16));
            }
            throw new Error(`Could not scroll to ${position}`);
          }, position);
        }
        const measured = await scroll.evaluate(node => {
          const viewport = node.getBoundingClientRect();
          const rows = [...node.querySelectorAll('[data-testid="step-detail-read-line"]')];
          const visible = rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom; });
          return { mounted: rows.length, horizontalOverflow: node.scrollWidth > node.clientWidth + 1, lines: visible.map(row => {
            const gutter = row.querySelector('[data-testid="step-detail-line-number"]');
            const content = row.querySelector('[data-testid="step-detail-output"]');
            const g = gutter.getBoundingClientRect(), c = content.getBoundingClientRect();
            return { number: Number(gutter.textContent), content: content.textContent, aligned: Math.abs(g.top - c.top) < 1, fits: g.left >= viewport.left && c.right <= viewport.right + 1, contentWidth: c.width };
          }) };
        });
        assert.ok(measured.mounted < 1000, "Only a bounded window mounts");
        assert.equal(measured.horizontalOverflow, false);
        assert.ok(measured.lines.length);
        for (const line of measured.lines) {
          assert.ok(line.aligned && line.fits && line.contentWidth > 250, JSON.stringify(line));
          assert.ok(line.content.startsWith(`sample ${line.number}`));
        }
        if (position === "middle") assert.ok(measured.lines[0].number > 4000 && measured.lines[0].number < 6000);
        if (position === "tail") assert.ok(measured.lines.some(line => line.number === 10049));
        await page.screenshot({ path: join(work, `read-lines-${width}-${position}.png`) });
        checkpoints.push({ position, ...measured });
      }
      report.push({ width, selection, checkpoints });
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(work, "report.json"), JSON.stringify({ productionBundles: "pass", report }, null, 2));
    console.log(JSON.stringify({ productionBundles: "pass", widths: report.map(row => row.width), checks: "selection, clipboard, bounds, alignment and virtual window at top/middle/tail" }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(join(work, "profile"), { recursive: true, force: true });
  }
}
replay().catch(error => { console.error(error); process.exitCode = 1; });
