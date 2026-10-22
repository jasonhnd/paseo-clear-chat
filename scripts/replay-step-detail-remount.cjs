// Replay the host recreating its timeline across the compact boundary.
const assert = require("node:assert/strict");
const { build } = require("../.showcase/node_modules/esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { createRequire } = require("node:module");

const root = resolve(__dirname, "..");
const viaHost = process.argv.includes("--via-host");
const preview = join(root, ".showcase");
const previewRequire = createRequire(join(preview, "package.json"));
const temp = process.env.KANBAN_TMP;
assert.ok(temp && require("node:path").isAbsolute(temp), "Set KANBAN_TMP to the task temporary directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "step-detail-remount");
mkdirSync(work, { recursive: true });
const sample = JSON.parse(readFileSync(join(root, "test/fixtures/real-claude-session.json"), "utf8"))
  .items.find(item => item.type === "tool_call" && item.detail.type === "shell" && item.status === "completed");
const step = { ...sample, callId: "sample-handoff", detail: { ...sample.detail,
  output: Array.from({ length: 200 }, (_, index) => `Sample output line ${index + 1}`).join("\n") } };

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const probe = net.createServer();
    const free = await new Promise(resolve => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("No free Chrome debugging port in the permitted range.");
}

async function replay() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(preview, "step-details.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(previewRequire.resolve("react/package.json")),
      "react-dom/client": previewRequire.resolve("react-dom/client"),
      "react-native": previewRequire.resolve("react-native-web"),
      "@getpaseo/plugin/client/react-native": join(preview, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(preview, "shims/step-detail-client.ts"),
    },
    nodePaths: [join(preview, "node_modules")],
  });
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%}*{box-sizing:border-box}</style><div id="root"></div><script>window.__stepDetailSamples=${JSON.stringify([step]).replace(/</g, "\\u003c")}</script><script src="/preview.js"></script>`;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/preview.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/preview.js" ? bundle.outputFiles[0].contents : html);
  });
  let browser;
  const trials = [], errors = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = await debugPort();
    browser = await chromium.launchPersistentContext(join(work, "profile"), {
      channel: "chrome", headless: true, viewport: { width: 820, height: 844 }, reducedMotion: "reduce",
      args: [`--remote-debugging-port=${port}`, "--disable-background-networking", "--no-first-run"],
    });
    browser.setDefaultTimeout(15000);
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    for (let trial = 1; trial <= 10; trial++) {
      await page.setViewportSize({ width: 820, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/host-remount`, { waitUntil: "networkidle" });
      const panel = page.getByTestId("step-detail-panel");
      await page.getByTestId("tool-summary-row").click();
      await page.waitForFunction(() => document.fonts.status === "loaded" && document.querySelector('[data-testid="step-detail-panel"]')?.dataset.presentation === "popover");
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-testid="step-detail-panel"]');
        for (let node = panel; node; node = node.parentElement) {
          if (getComputedStyle(node).opacity === "0" || node.getAnimations().some(animation => animation.pending || animation.playState === "running")) return false;
        }
        return panel.querySelector('[data-testid="step-detail-scroll"]')?.clientHeight > 0;
      });
      await page.getByTestId("step-detail-scroll").evaluate(node => {
        node.dataset.replayScrollComplete = "false";
        node.addEventListener("scrollend", () => { node.dataset.replayScrollComplete = "true"; }, { once: true });
        node.scrollTop = 400;
      });
      await page.waitForFunction(() => {
        const scroll = document.querySelector('[data-testid="step-detail-scroll"]');
        return scroll?.scrollTop === 400 && scroll.dataset.replayScrollComplete === "true";
      });
      if (viaHost) for (const width of [1180, 820]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForFunction(presentation => {
          const node = document.querySelector('[data-testid="step-detail-panel"]');
          return node?.dataset.presentation === presentation && node.querySelector('[data-testid="step-detail-scroll"]')?.scrollTop === 400;
        }, width === 1180 ? "side" : "popover");
      }
      const originalRow = await page.getByTestId("tool-summary-row").elementHandle();
      await page.setViewportSize({ width: 600, height: 844 });
      try {
        await page.waitForFunction(node => !node.isConnected, originalRow);
      } catch (error) {
        console.error(JSON.stringify(await page.evaluate(() => ({ checkpoint: "host timeline replacement",
          route: location.pathname, width: innerWidth, visualWidth: visualViewport?.width,
          presentations: [...document.querySelectorAll('[data-testid="step-detail-panel"]')].map(node => node.dataset.presentation) }))));
        throw error;
      }
      let passed = true;
      try {
        await page.waitForFunction(() => {
          const panel = document.querySelector('[data-testid="step-detail-panel"]');
          const bounds = panel?.getBoundingClientRect();
          return bounds && bounds.top >= 0 && bounds.bottom <= innerHeight + 1 && panel.dataset.presentation === "sheet" && panel.querySelector('[data-testid="step-detail-scroll"]')?.scrollTop === 400;
        }, undefined, { timeout: 2000 });
      } catch { passed = false; }
      assert.equal(await originalRow.evaluate(node => node.isConnected), false, "The host must recreate its timeline at the compact boundary");
      const measurement = await page.evaluate(() => {
        const node = document.querySelector('[data-testid="step-detail-panel"]');
        return { presentation: node?.dataset.presentation ?? "absent",
          scrollTop: node?.querySelector('[data-testid="step-detail-scroll"]').scrollTop ?? null };
      });
      await page.setViewportSize({ width: 820, height: 844 });
      if (passed) {
        await page.waitForFunction(() => {
          const panel = document.querySelector('[data-testid="step-detail-panel"]');
          const bounds = panel?.getBoundingClientRect();
          return bounds && bounds.top >= 0 && bounds.bottom <= innerHeight + 1 && panel.dataset.presentation === "popover" && panel.querySelector('[data-testid="step-detail-scroll"]')?.scrollTop === 400;
        });
        measurement.returnScrollTop = await page.getByTestId("step-detail-scroll").evaluate(node => node.scrollTop);
      }
      const attempts = await page.evaluate(() => window.__stepDetailPanelAttempts);
      trials.push({ trial, viaHost, passed, ...measurement, attempts });
      console.log(JSON.stringify(trials.at(-1)));
      if (await page.getByTestId("step-detail-close").count()) await page.getByTestId("step-detail-close").click();
      await panel.waitFor({ state: "detached" });
      await page.waitForFunction(() => !history.state?.clearChatStepDetail);
    }
    writeFileSync(join(temp, viaHost ? "step-detail-remount-hosted-report.json" : "step-detail-remount-report.json"), JSON.stringify({ debugPort: port, trials, errors }, null, 2) + "\n");
    assert.deepEqual(errors, []);
    assert.equal(trials.filter(trial => trial.passed).length, 10, "Every host timeline remount must retain the selected step and its reading position");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(join(work, "profile"), { recursive: true, force: true });
  }
}
replay().catch(error => { console.error(error); process.exitCode = 1; });
