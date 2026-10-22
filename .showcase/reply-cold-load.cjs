"use strict";

// Offline cached host replay; it never connects to a Paseo daemon.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { createServer: createSocket } = require("node:net");
const { mkdirSync, writeFileSync, rmSync, realpathSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { coldLoadSessions } = require("../test/helpers/cold-load-host.cjs");
const root = resolve(__dirname, "..");
const temp = process.env.KANBAN_TMP;
if (!temp || realpathSync(temp) !== resolve(temp)) throw new Error("KANBAN_TMP must be an existing absolute task directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "reply-cold-load");
mkdirSync(work, { recursive: true });

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const free = await new Promise(resolve => {
      const socket = createSocket();
      socket.once("error", () => resolve(false));
      socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("No permitted Chrome debugging port is available.");
}

async function replay() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "reply-cold-load.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/react-native": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/step-detail-client.ts"),
    },
    nodePaths: [join(__dirname, "node_modules")],
  });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/replay.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/replay.js" ? bundle.outputFiles[0].contents
      : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/replay.js"></script>');
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launchPersistentContext(join(work, "profile"), {
      channel: "chrome", headless: true, reducedMotion: "reduce",
      args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    browser.setDefaultTimeout(10000);
    const replies = coldLoadSessions.flatMap(session => session.items).filter(item => item.type === "assistant_message");
    for (const width of [1440, 820, 390]) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 900 });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(origin);
      const replyRows = page.locator('[data-source-type="assistant_message"]');
      await replyRows.last().waitFor();
      assert.equal(await page.evaluate(() => window.coldLoadReplay.ready()), false);
      assert.equal(await replyRows.count(), replies.length);
      assert.equal(await replyRows.locator('[data-testid="reply-footer"]').count(), 0);
      assert.ok(await page.locator('[data-source-type="tool_call"][data-projection-kind="omp-tool-call"]').count() > 0);
      const chat = page.getByTestId("host-chat");
      await chat.evaluate(node => { node.scrollTop = 600; });
      const before = await chat.evaluate(node => ({ scroll: node.scrollTop, top: node.getBoundingClientRect().top }));
      assert.equal(before.scroll, 600);
      assert.equal(before.top, 96, "the host toolbar stays above the scrolled conversation");
      await page.evaluate(() => window.coldLoadReplay.release());
      await page.waitForFunction(() => window.coldLoadReplay.ready());
      // Let React commit the registry notification, without a viewport change or refresh.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.deepEqual(await replyRows.evaluateAll(nodes => nodes.map(node => node.dataset.projectionKind)), replies.map(() => "omp-assistant"));
      assert.equal(await replyRows.getByRole("button", { name: "Copy reply", exact: true }).count(), replies.length);
      assert.equal(await chat.evaluate(node => node.scrollTop), before.scroll);
      assert.deepEqual(await page.evaluate(() => window.coldLoadReplay.widths), [width], "no resize was needed");
      assert.deepEqual(errors, []);
      report.push({ width, replies: replies.length, toolbar: before.top, scroll: before.scroll, resized: false, enhanced: true });
      console.log(`${width}px: ${replies.length} replies enhanced after preferences resolved; toolbar 96px, scroll 600px, no resize`);
      await page.close();
    }
    writeFileSync(join(temp, "reply-cold-load-report.json"), JSON.stringify({ browser: browser.browser().version(), cases: report }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}
replay().catch(error => { console.error(error); process.exitCode = 1; });
