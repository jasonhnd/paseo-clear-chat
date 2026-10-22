// Offline component replay with the installed headless Google Chrome.
const assert = require("node:assert/strict");
const { build } = require("../.showcase/node_modules/esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { createRequire } = require("node:module");

const root = resolve(__dirname, "..");
const preview = join(root, ".showcase");
const previewRequire = createRequire(join(preview, "package.json"));
const temp = process.env.KANBAN_TMP;
if (!temp || !require("node:path").isAbsolute(temp)) throw new Error("Set KANBAN_TMP to the task's temporary directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "step-detail-browser");
mkdirSync(work, { recursive: true });
const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/real-claude-session.json"), "utf8"));
const sample = fixture.items.find(item => item.type === "tool_call" && item.detail.type === "shell" && item.status === "completed");

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const free = await new Promise(resolve => {
      const probe = net.createServer();
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
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%}*{box-sizing:border-box}</style></head><body><div id="root"></div><script>window.__stepDetailSample=${JSON.stringify(sample).replace(/</g, "\\u003c")}</script><script src="/preview.js"></script></body></html>`;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/preview.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/preview.js" ? bundle.outputFiles[0].contents : html);
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = await debugPort();
    browser = await chromium.launchPersistentContext(join(work, "profile"), {
      channel: "chrome", headless: true, viewport: { width: 1440, height: 844 }, hasTouch: true,
      reducedMotion: "reduce", args: [`--remote-debugging-port=${port}`, "--disable-background-networking", "--no-first-run"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const panel = page.getByTestId("step-detail-panel");
    const row = page.getByTestId("tool-summary-row");
    const waitClosed = () => panel.waitFor({ state: "detached" });
    const waitOpen = async () => {
      await panel.waitFor();
      await page.waitForFunction(() => {
        const rect = document.querySelector('[data-testid="step-detail-panel"]')?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= innerHeight + 1;
      });
    };
    for (const [width, presentation] of [[1440, "side"], [1024, "side"], [820, "popover"], [390, "sheet"]]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
      await row.waitFor();
      await row.click();
      await waitOpen();
      assert.equal(await panel.getAttribute("data-presentation"), presentation);
      assert.equal(await row.getAttribute("aria-expanded"), "false");
      const box = await panel.boundingBox();
      console.log(JSON.stringify({ width, presentation, box }));
      assert.ok(box.width > 100 && box.height > 100);
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      assert.ok(box.y >= 0 && box.y + box.height <= 845);
      let chat = await page.getByTestId("preview-chat").boundingBox();
      if (presentation === "side") assert.ok(chat.x + chat.width <= box.x + 1, "Side details must reserve space beside chat");
      await page.screenshot({ path: join(work, `${width}.png`) });
      await page.getByTestId("step-detail-close").click();
      await waitClosed();
      if (presentation === "side") {
        await page.getByTestId("preview-host-close").click();
        chat = await page.getByTestId("preview-chat").boundingBox();
        assert.equal(chat.width, width);
      } else {
        await row.click();
        await waitOpen();
        await page.getByTestId("step-detail-backdrop").click({ position: { x: width - 30, y: 10 } });
        await waitClosed();
        await row.click();
        await waitOpen();
        await page.goBack();
        await waitClosed();
      }
      report.push({ width, presentation, panel: box, chat, openClose: "passed", backdropAndBack: presentation === "side" ? "host tab close" : "passed" });
    }

    const session = await browser.newCDPSession(page);
    async function drag(locator, dy, dx = 0) {
      const box = await locator.boundingBox();
      const x = box.x + box.width / 2, y = box.y + Math.min(14, box.height / 2);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let index = 1; index <= 12; index++) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * index / 12, y: y + dy * index / 12 }] });
        await page.waitForTimeout(40);
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await row.click();
    await waitOpen();
    await drag(page.getByTestId("step-detail-drag-handle"), -350);
    assert.equal(await panel.getAttribute("data-snap"), "full");
    const full = await panel.boundingBox();
    assert.ok(full.height >= 840);
    await drag(page.getByTestId("step-detail-drag-handle"), 350);
    assert.equal(await panel.getAttribute("data-snap"), "half");
    const half = await panel.boundingBox();
    assert.ok(half.height >= 420 && half.height <= 424);
    await drag(page.getByTestId("step-detail-drag-handle"), 300);
    await waitClosed();
    await row.click();
    await waitOpen();
    await drag(page.getByTestId("step-detail-back-edge"), 2, 120);
    await waitClosed();
    await page.getByTestId("preview-action").click();
    await row.click();
    await page.getByTestId("tool-card-body").waitFor();
    assert.equal(await row.getAttribute("aria-expanded"), "true");
    assert.equal(await panel.count(), 0);
    report.push({ width: 390, fullHeight: full.height, halfHeight: half.height, touchDragAndDismiss: "passed", leftEdgeBack: "passed", inlineSetting: "passed" });
    assert.deepEqual(errors, []);
    writeFileSync(join(temp, "step-detail-report.json"), JSON.stringify({ debugPort: port, bundleBytes: bundle.outputFiles[0].contents.length, measurements: report }, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(join(work, "profile"), { recursive: true, force: true });
  }
}
replay().catch(error => { console.error(error); process.exitCode = 1; });
