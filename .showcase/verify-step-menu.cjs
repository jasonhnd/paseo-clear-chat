"use strict";

// Real components and React Native Web, with only host SDK services supplied.
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { createServer: createSocket } = require("node:net");
const { readFileSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const root = resolve(__dirname, "..");
const temp = process.env.KANBAN_TMP;
if (!temp) throw new Error("KANBAN_TMP must name the task's temporary directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "step-menu-browser");
mkdirSync(work, { recursive: true });
const items = JSON.parse(readFileSync(join(root, "test/fixtures/real-hermes-step-menu.json"))).items;
const shell = items.find(item => item.detail?.type === "shell");
const read = items.find(item => item.detail?.type === "read");
const combined = { ...shell, detail: { ...shell.detail, filePath: read.detail.filePath } };

async function freeDebugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const socket = createSocket();
    const available = await new Promise(resolve => {
      socket.once("error", () => resolve(false));
      socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("No permitted Chrome debugging port is free.");
}
async function main() {
  const bundle = await build({
    absWorkingDir: root, bundle: true, write: false, jsx: "automatic", platform: "browser",
    define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { ToolCallout } from "./client/components/tool-callouts";
      import { buildLiveToolCallData } from "./client/tool-call-data";
      import { buildThemeTokens } from "./client/components/theme-tokens";
      const tokens = buildThemeTokens({ surface0: "#15151a", surface1: "#202027", surface2: "#303038", border: "#444450", foreground: "#eeeeee", foregroundMuted: "#aaaaaa", accent: "#8aadff", accentForeground: "#101010", statusSuccess: "#00bb88", statusWarning: "#ffaa00", statusDanger: "#ff4455" });
      const samples = ${JSON.stringify([combined, shell])};
      function App() {
        const [expanded, setExpanded] = useState(false);
        const [index, setIndex] = useState(0);
        window.__mount = i => { setExpanded(false); setIndex(i); };
        return <ToolCallout data={buildLiveToolCallData(samples[index])} tokens={tokens} expanded={expanded}
          onExpandedChange={value => { window.__presses++; setExpanded(value); }} onRevealPath={path => window.__reveals.push(path)} />;
      }
      window.__copies = []; window.__reveals = []; window.__presses = 0;
      createRoot(document.getElementById("root")).render(<App />);
    ` },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client": join(__dirname, "shims/plugin-client.tsx"),
    },
    nodePaths: [join(__dirname, "node_modules")],
    plugins: [{ name: "host-sdk", setup(builder) {
      builder.onResolve({ filter: /^@getpaseo\/plugin\/client\/ui$/ }, () => ({ path: "sdk", namespace: "step-menu" }));
      builder.onLoad({ filter: /.*/, namespace: "step-menu" }, () => ({ loader: "tsx", resolveDir: root, contents: `
        export { Icon, Modal, TextInput, ScrollView, StreamedText } from ${JSON.stringify(join(__dirname, "shims/plugin-react-native.tsx"))};
        export async function copyText(text) { window.__copies.push(text); }
        export function useToast() { return { show() {}, error() {} }; }
      ` }));
    } }],
  });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle.outputFiles[0].contents : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0;background:#15151a}#page-offset{height:37px}#host{transform:translateZ(0)}
      header{height:96px;color:white}#chat{height:704px;overflow:auto;margin-left:clamp(16px,6vw,96px)}
      #lead{height:640px}#root{margin:16px 8px;overflow:hidden}#tail{height:1200px}</style>
      <div id="page-offset"></div><div id="host"><header>Host toolbar</header><main id="chat">
      <div id="lead"></div><div id="root"></div><div id="tail"></div></main></div><script src="/bundle.js"></script>`);
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
      channel: "chrome", headless: true, viewport: { width: 1440, height: 800 }, hasTouch: true,
      args: [`--remote-debugging-port=${await freeDebugPort()}`, "--disable-background-networking", "--no-first-run"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const row = page.getByTestId("tool-summary-row");
    const menu = page.getByTestId("tool-step-menu");
    await row.waitFor();
    const touch = await browser.newCDPSession(page);
    async function position(gesture, point, width, flipped = false) {
      await menu.waitFor();
      // React Native Web delivers onLayout through ResizeObserver.
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="tool-step-menu"]');
        return element && getComputedStyle(element).opacity === "1";
      });
      const box = await menu.boundingBox();
      const dx = Math.abs((flipped ? box.x + box.width : box.x) - point.x);
      const dy = Math.abs((flipped ? box.y + box.height : box.y) - point.y);
      const inside = box.x >= 8 && box.y >= 8 && box.x + box.width <= width - 8 && box.y + box.height <= 792;
      assert.ok(dx <= 8 && dy <= 8 && inside, JSON.stringify({ width, gesture, point, box, dx, dy, inside }));
      return { point, box, dx, dy, inside };
    }
    async function hold(point) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await page.waitForTimeout(650);
      assert.equal(await menu.count(), 1, "touch timer opens the menu before release");
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    async function dismiss() {
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    }
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => { window.scrollTo(0, 37); document.getElementById("chat").scrollTop = 600; });
      const bounds = await row.boundingBox();
      const point = { x: bounds.x + 48, y: bounds.y + bounds.height / 2 };
      const offsets = await page.evaluate(() => ({ page: window.scrollY, chat: document.getElementById("chat").scrollTop, header: document.querySelector("header").getBoundingClientRect().height }));
      assert.deepEqual(offsets, { page: 37, chat: 600, header: 96 });
      await page.mouse.click(point.x, point.y, { button: "right" });
      const rightClick = await position("right-click", point, width);
      assert.equal(await page.getByTestId("step-open-path").count(), width >= 1024 ? 1 : 0);
      for (const [id, expected] of [["step-copy-command", shell.detail.command], ["step-copy-path", read.detail.filePath], ["step-copy-result", shell.detail.output]]) {
        if (!(await menu.count())) await row.click({ button: "right" });
        await page.getByTestId(id).click();
        await menu.waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => window.__copies.at(-1)), expected);
      }
      // Exercise Pressable's actual touch timer and the following normal tap.
      await page.evaluate(() => { window.scrollTo(0, 37); document.getElementById("chat").scrollTop = 600; });
      assert.ok(await row.evaluate((element, p) => element.contains(document.elementFromPoint(p.x, p.y)), point), "touch starts on the summary");
      await hold(point);
      const longPress = await position("touch-long-press", point, width);
      assert.equal(await page.getByTestId("tool-card-body").count(), 0);
      assert.equal(await page.evaluate(() => window.getSelection().toString()), "");
      await dismiss();
      await row.click();
      await page.getByTestId("tool-card-body").waitFor();
      await row.click();
      // Scroll the same row to the bottom and click near its right edge.
      await page.evaluate(() => { document.getElementById("chat").scrollTop = 4; });
      const edgeBounds = await row.boundingBox();
      const edge = { x: edgeBounds.x + edgeBounds.width - 12, y: edgeBounds.y + edgeBounds.height / 2 };
      await page.mouse.click(edge.x, edge.y, { button: "right" });
      const rightEdge = await position("right-click-edge", edge, width, true);
      await dismiss();
      await page.evaluate(() => { window.scrollTo(0, 37); document.getElementById("chat").scrollTop = 4; });
      await hold(edge);
      const touchEdge = await position("touch-long-press-edge", edge, width, true);
      await dismiss();
      report.push({ width, height: 800, offsets, rightClick, longPress, rightEdge, touchEdge, copies: "verbatim", selection: "empty", ordinaryClick: "passed" });
    }
    await page.evaluate(() => window.__mount(1));
    await row.click({ button: "right" });
    assert.equal(await page.getByTestId("step-copy-path").count(), 0);
    assert.equal(await page.getByTestId("step-open-path").count(), 0);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    writeFileSync(join(temp, "step-menu-browser-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
