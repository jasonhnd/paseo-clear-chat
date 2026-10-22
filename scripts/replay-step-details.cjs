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
// Preserve the sanitized real shell shape, with deterministic long output for scrolling.
const longSamples = ["A", "B"].map(label => ({
  ...sample, callId: `sample-step-${label}`,
  detail: { ...sample.detail, command: `printf 'Step ${label} start'`,
    output: [`Step ${label} start`, ...Array.from({ length: 160 }, (_, index) => `Step ${label} output line ${index + 1}`)].join("\n") },
}));

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
  const html = samples => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%}*{box-sizing:border-box}</style></head><body><div id="root"></div><script>window.__stepDetailSamples=${JSON.stringify(samples).replace(/</g, "\\u003c")}</script><script src="/preview.js"></script></body></html>`;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/preview.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/preview.js" ? bundle.outputFiles[0].contents : html(["/switching", "/keyboard"].includes(request.url) ? longSamples : [sample]));
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
    browser.setDefaultTimeout(15000);
    browser.setDefaultNavigationTimeout(15000);
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
        const element = document.querySelector('[data-testid="step-detail-panel"]');
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          if (getComputedStyle(ancestor).opacity === "0" || ancestor.getAnimations().some(animation => animation.playState === "running" || animation.pending)) return false;
        }
        const rect = element?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= innerHeight + 1;
      });
    };
    async function detailScroll(top) {
      return panel.evaluate((element, top) => {
        const scroll = Array.from(element.querySelectorAll("div")).find(node =>
          ["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.clientHeight > 0);
        if (!scroll) throw new Error("Step details must have a scrollable body");
        if (top !== undefined) scroll.scrollTop = top;
        const body = element.querySelector('[data-testid="tool-card-body"]');
        return { top: scroll.scrollTop, height: scroll.clientHeight, contentHeight: scroll.scrollHeight,
          bodyTop: body.getBoundingClientRect().top, viewportTop: scroll.getBoundingClientRect().top };
      }, top);
    }
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/switching`, { waitUntil: "networkidle" });
      const rows = page.getByTestId("tool-summary-row");
      await rows.nth(0).click();
      await waitOpen();
      assert.ok((await panel.textContent()).includes("Step A start"));
      assert.equal((await detailScroll(1000)).top, 1000, "Long step A must scroll before switching");
      await page.getByTestId("preview-update-step").click();
      await panel.getByText("Updated sample output", { exact: false }).waitFor();
      assert.equal((await detailScroll()).top, 1000, "Output updates to the same step must preserve the reader's position");
      await rows.nth(1).click();
      assert.ok((await panel.textContent()).includes("Step B start"));
      const next = await detailScroll();
      assert.equal(next.top, 0, "Switching from scrolled step A to step B must show B from the top");
      assert.ok(next.bodyTop >= next.viewportTop && next.bodyTop < next.viewportTop + next.height, "Step B's beginning must be in view");
      await detailScroll(1000);
      await rows.nth(0).click();
      assert.ok((await panel.textContent()).includes("Step A start"));
      assert.equal((await detailScroll()).top, 0, "Switching back to step A must also start at the top");
      assert.equal(await rows.nth(0).getAttribute("aria-expanded"), "false");
      assert.equal(await rows.nth(1).getAttribute("aria-expanded"), "false");
      report.push({ width, stepSwitching: "A -> B -> A starts at top", liveOutputUpdate: "keeps scrollTop 1000" });
    }
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/keyboard`, { waitUntil: "networkidle" });
      const rows = page.getByTestId("tool-summary-row");
      await rows.nth(0).waitFor();
      const scrolled = await page.getByTestId("preview-chat").evaluate(node => node.scrollTop);
      assert.ok(scrolled >= 350, "Replay must include an already-scrolled chat below a host header");
      const header = await page.getByTestId("preview-host-header").boundingBox();
      assert.equal(header.height, 64);
      const active = async index => assert.equal(await rows.nth(index).evaluate(node => node === document.activeElement), true);
      // Tab to the first row from a neutral element, giving Chrome keyboard modality.
      await page.evaluate(() => { document.activeElement?.blur(); });
      await page.keyboard.press("Tab");
      await active(0);
      await page.keyboard.press("ArrowDown"); await active(1);
      await page.keyboard.press("ArrowDown"); await active(1);
      await page.keyboard.press("ArrowUp"); await active(0);
      await page.keyboard.press("ArrowUp"); await active(0);
      const ring = await rows.nth(0).evaluate(node => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor,
          x: rect.x, y: rect.y, widthPx: rect.width, height: rect.height };
      });
      assert.equal(ring.style, "solid"); assert.ok(ring.width >= 2);
      assert.ok(ring.y >= header.height && ring.x >= 0 && ring.x + ring.widthPx <= width + 1);
      for (const inputId of ["preview-input", "preview-textarea", "preview-editable"]) {
        const input = page.getByTestId(inputId);
        await input.focus();
        await input.evaluate(node => {
          window.__keyboardEvents = [];
          node.addEventListener("keydown", event => queueMicrotask(() => window.__keyboardEvents.push({ key: event.key, prevented: event.defaultPrevented })));
        });
        for (const key of ["ArrowUp", "ArrowDown", "Enter"]) await page.keyboard.press(key);
        await page.keyboard.type(" typed");
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        const events = await page.evaluate(() => window.__keyboardEvents.filter(event => ["ArrowUp", "ArrowDown", "Enter"].includes(event.key)));
        assert.deepEqual(events, ["ArrowUp", "ArrowDown", "Enter"].map(key => ({ key, prevented: false })));
        assert.equal(await panel.count(), 0);
      }
      await rows.nth(1).focus();
      await page.keyboard.press("Enter"); await waitOpen();
      assert.ok((await panel.textContent()).includes("Step B start"));
      assert.equal(await rows.nth(1).getAttribute("aria-expanded"), "false");
      const box = await panel.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 845);
      if (width >= 1024) {
        const chat = await page.getByTestId("preview-chat").boundingBox();
        assert.ok(chat.x + chat.width <= box.x + 1);
      }
      await page.screenshot({ path: join(work, `keyboard-${width}.png`) });
      // Escape works from an interactive descendant of the panel as well as a row.
      await page.getByTestId("step-detail-close").focus();
      await page.keyboard.press("Escape"); await waitClosed();
      await active(1);
      await page.keyboard.press("ArrowUp"); await active(0);
      if (width === 390) {
        await rows.nth(0).tap(); await waitOpen();
        await page.getByTestId("step-detail-close").tap(); await waitClosed();
        assert.equal(await rows.nth(0).evaluate(node => getComputedStyle(node).outlineStyle), "none", "Touch must not draw a keyboard focus ring");
      }
      report.push({ width, keyboard: "arrows scoped to steps; Enter opens; Escape closes and restores focus", inputs: "input, textarea, contenteditable keep arrows and Enter", ring, panel: box, headerHeight: header.height, chatScrollTop: scrolled, touchRing: width === 390 ? "hidden" : "not applicable" });
    }
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
    await page.waitForFunction(() => document.querySelector('[data-testid="step-detail-panel"]')?.getAttribute("data-snap") === "full");
    assert.equal(await panel.getAttribute("data-snap"), "full");
    const full = await panel.boundingBox();
    assert.ok(full.height >= 840);
    await drag(page.getByTestId("step-detail-drag-handle"), 350);
    await page.waitForFunction(() => document.querySelector('[data-testid="step-detail-panel"]')?.getAttribute("data-snap") === "half");
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
