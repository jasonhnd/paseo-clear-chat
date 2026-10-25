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
const fieldSamples = JSON.parse(readFileSync(join(root, "test/fixtures/real-shell-details.json"), "utf8")).entries.map(entry => entry.item);
fieldSamples.push(JSON.parse(readFileSync(join(root, "test/fixtures/codex-session.json"), "utf8")).items.find(item => item.detail?.type === "shell"));
fieldSamples.push({ ...sample, callId: "sample-explicit-streams", detail: { type: "shell", command: "sample", durationMs: 1250,
  output: { stdout: " sample stdout\n  ", stderr: " sample stderr\n  ", exitCode: 0 } } });
fieldSamples.push(JSON.parse(readFileSync(join(root, "test/fixtures/real-hermes-step-menu.json"), "utf8")).items[0]);
const fieldsOnly = process.argv.includes("--fields-only");
const inputsOnly = process.argv.includes("--inputs-only");
// Preserve the sanitized real shell shape, with deterministic long output for scrolling.
const longSamples = ["A", "B"].map(label => ({
  ...sample, callId: `sample-step-${label}`,
  detail: { ...sample.detail, command: `printf 'Step ${label} start'`,
    output: [`Step ${label} start`, ...Array.from({ length: 160 }, (_, index) => `Step ${label} output line ${index + 1}`)].join("\n") },
}));
const readSample = JSON.parse(readFileSync(join(root, "test/fixtures/real-hermes-session.json"), "utf8"))
  .items.find(item => item.type === "tool_call" && item.detail.type === "read");
// Stress the captured read shape without including any additional conversation text.
const longPath = `/workspace/sample/${"nested-directory/".repeat(12)}configuration`;
const layoutSamples = [longSamples[0],
  { ...readSample, callId: "sample-code", detail: { ...readSample.detail, filePath: `${longPath}.ts`,
    content: Array.from({ length: 48 }, (_, index) => `export const sample${index} = "${"sample".repeat(40)}";`).join("\n") } },
  { ...readSample, callId: "sample-image", detail: { ...readSample.detail, filePath: `${longPath}.png`, content: "Image file" } },
];
const largeOutput = Array.from({ length: 10000 }, (_, index) => `Output line ${index + 1}: sample text${index === 4999 ? ` ${"unbroken".repeat(512)}\u{1f680}` : ""}`).join("\n") + "\n";
const largeInput = { command: "printf 'sample output'", cwd: "/workspace/demo", options: { mode: "complete" } };
const largeSample = { ...sample, callId: "sample-large-output", detail: { type: "shell", input: largeInput, output: largeOutput, durationMs: 1250, exitCode: 0 } };

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
    response.setHeader("Content-Type", request.url === "/preview.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    const fieldIndex = /^\/fields\/(\d+)$/.exec(request.url)?.[1];
    response.end(request.url === "/preview.js" ? bundle.outputFiles[0].contents : html(fieldIndex !== undefined ? [fieldSamples[Number(fieldIndex)]] : request.url === "/layout" ? layoutSamples : ["/switching", "/keyboard", "/rotation"].includes(request.url) ? longSamples : request.url === "/host-remount" ? [longSamples[0]] : request.url === "/large-output" ? [largeSample] : [sample]));
  });
  let browser;
  const report = [];
  const performanceFailures = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const port = await debugPort();
    browser = await chromium.launchPersistentContext(join(work, "profile"), {
      channel: "chrome", executablePath: process.env.CHROME_PATH, headless: true, viewport: { width: 1440, height: 844 }, hasTouch: !inputsOnly,
      reducedMotion: "reduce", args: [`--remote-debugging-port=${port}`, "--disable-background-networking", "--no-first-run"],
    });
    browser.setDefaultTimeout(15000);
    browser.setDefaultNavigationTimeout(15000);
    await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const panel = page.getByTestId("step-detail-panel");
    const row = page.getByTestId("tool-summary-row");
    const waitClosed = async () => {
      await panel.waitFor({ state: "detached" });
      await page.waitForFunction(() => !history.state?.clearChatStepDetail);
    };
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
      if (top !== undefined) {
        await page.waitForFunction(() => document.fonts.status === "loaded");
        await panel.getByTestId("step-detail-scroll").evaluate((scroll, top) => {
          scroll.dataset.replayScrollComplete = String(scroll.scrollTop === top);
          if (scroll.scrollTop === top) return;
          // Observe completion of the browser's scroll, including scroll anchoring.
          // Two animation frames can still leave a pending final scroll event.
          scroll.addEventListener("scrollend", () => { scroll.dataset.replayScrollComplete = "true"; }, { once: true });
          scroll.scrollTop = top;
        }, top);
        await page.waitForFunction(() => document.querySelector('[data-testid="step-detail-scroll"]')?.dataset.replayScrollComplete === "true");
      }
      return panel.evaluate(element => {
        const scroll = element.querySelector('[data-testid="step-detail-scroll"]');
        if (!scroll?.clientHeight) throw new Error("Step details must have a scrollable body");
        const body = element.querySelector('[data-testid="tool-card-body"]');
        const viewportTop = scroll.getBoundingClientRect().top;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let visibleCodeLine, node;
        while (!visibleCodeLine && (node = walker.nextNode())) {
          for (const match of node.textContent.matchAll(/export const sample\d+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const rect = range.getBoundingClientRect();
            if (rect.top >= viewportTop && rect.top < viewportTop + scroll.clientHeight) { visibleCodeLine = match[0]; break; }
          }
        }
        return { top: scroll.scrollTop, height: scroll.clientHeight, contentHeight: scroll.scrollHeight,
          bodyTop: body.getBoundingClientRect().top, viewportTop,
          visibleCodeLine };
      });
    }
    async function startReading(top = 1000) {
      const position = await detailScroll(top);
      // Chrome can anchor a virtual list by one pixel after the requested scroll.
      // All subsequent checks compare the measured starting offset exactly.
      assert.ok(Math.abs(position.top - top) <= 1, `Reading setup must reach ${top}px: ${JSON.stringify(position)}`);
      return position;
    }
    async function waitReading(top) {
      try {
        await page.waitForFunction(expected => {
          const scroll = document.querySelector('[data-testid="step-detail-scroll"]');
          return scroll?.clientHeight > 0 && scroll.scrollTop === expected;
        }, top);
      } catch (error) {
        console.error(JSON.stringify({ checkpoint: "detail reading position", viewport: page.viewportSize(),
          expectedScrollTop: top, actual: await detailScroll() }));
        throw error;
      }
      return detailScroll();
    }
    if (process.argv.includes("--resize-only")) {
      for (const widths of [[1440, 820, 390], [1440, 390], [1180, 820, 390], [820, 390], [390]]) {
        await page.setViewportSize({ width: widths[0], height: 900 });
        await page.goto(`${origin}/host-remount`, { waitUntil: "networkidle" });
        await row.click();
        await waitOpen();
        const reading = await startReading(200);
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForFunction(expected => document.querySelector('[data-testid="step-detail-panel"]')?.getAttribute("data-presentation") === expected,
            width < 744 ? "sheet" : width < 1024 ? "popover" : "side");
          await waitOpen();
          const visible = panel.filter({ visible: true });
          assert.equal(await visible.count(), 1, `${widths.join(" -> ")} at ${width}: one visible panel`);
          assert.equal(await panel.count(), 1, "No hidden detail owner may retain a modal");
          await waitReading(reading.top);
          report.push({ widths, width, panel: await panel.boundingBox(), scrollTop: (await detailScroll()).top });
        }
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (inputsOnly) {
      // Keep metrics, navigation and real inputs on one session. Disconnecting
      // the metrics owner restores Chrome's original viewport.
      const input = await browser.newCDPSession(page);
      await input.send("Page.enable");
      await input.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await input.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await input.send("Page.navigate", { url: `${origin}/keyboard` });
      await row.first().waitFor();
      const key = async (key, code) => {
        for (const type of ["rawKeyDown", "keyUp"]) await input.send("Input.dispatchKeyEvent", {
          type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        });
      };
      const mouse = (type, x, y, button = "none") => input.send("Input.dispatchMouseEvent", {
        type, x, y, button, clickCount: button === "none" ? 0 : 1,
      });
      const click = async (x, y, button = "left") => {
        await mouse("mouseMoved", x, y);
        await mouse("mousePressed", x, y, button);
        await mouse("mouseReleased", x, y, button);
      };
      for (let trial = 1; trial <= 5; trial++) {
        await row.first().evaluate(node => {
          const chat = document.querySelector('[data-testid="preview-chat"]');
          chat.scrollTop += node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2 - 420;
        });
        await page.waitForFunction(() => {
          const rect = document.querySelector('[data-testid="tool-summary-row"]').getBoundingClientRect();
          return Math.abs(rect.top + rect.height / 2 - 420) < 1;
        });
        assert.equal(await page.evaluate(() => innerWidth), 1440);
        assert.equal((await page.getByTestId("preview-host-header").boundingBox()).height, 64);
        assert.ok(await page.getByTestId("preview-chat").evaluate(node => node.scrollTop) > 0);
        await click(720, 420, "right");
        const menu = page.getByTestId("tool-step-menu");
        await menu.waitFor();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="tool-step-menu"]')).opacity === "1");
        const box = await menu.boundingBox();
        assert.ok(Math.abs(box.x - 720) <= 8 && Math.abs(box.y - 420) <= 8, JSON.stringify(box));
        await key("Escape", 27);
        await menu.waitFor({ state: "detached" });
        await mouse("mouseMoved", 5, 5);
        await mouse("mouseMoved", 720, 420);
        const preview = page.getByTestId("tool-hover-preview");
        await preview.waitFor({ timeout: 1500 });
        const hover = await preview.evaluate(node => ({ opacity: getComputedStyle(node).opacity,
          background: getComputedStyle(node).backgroundColor, pointerEvents: getComputedStyle(node).pointerEvents }));
        assert.equal(hover.opacity, "1");
        assert.ok(!["transparent", "rgba(0, 0, 0, 0)"].includes(hover.background));
        assert.equal(hover.pointerEvents, "none");
        await mouse("mouseMoved", 5, 5);
        await preview.waitFor({ state: "detached" });
        await click(720, 420);
        await waitOpen();
        await key("Escape", 27);
        await waitClosed();
        await key("ArrowDown", 40);
        assert.equal(await row.nth(1).evaluate(node => node === document.activeElement), true);
        await key("ArrowUp", 38);
        assert.equal(await row.first().evaluate(node => node === document.activeElement), true);
        await key("Enter", 13);
        await waitOpen();
        await key("Escape", 27);
        await waitClosed();
        report.push({ trial, menu: { dx: box.x - 720, dy: box.y - 420 }, hover, keyboard: "pass" });
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify(report, null, 2));
      writeFileSync(join(temp, "step-input-report.json"), JSON.stringify(report, null, 2) + "\n");
      return;
    }
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [index, item] of fieldSamples.entries()) {
        await page.goto(`${origin}/fields/${index}`, { waitUntil: "networkidle" });
        await row.first().focus();
        await page.keyboard.press("Enter");
        await waitOpen();
        assert.equal(await page.getByTestId("step-detail-exit-code").textContent(), `Exit code: ${index === 0 ? 1 : 0}`);
        assert.equal(await page.getByTestId("step-detail-duration").count(), index === 3 ? 1 : 0);
        assert.equal(await page.getByTestId("step-detail-stderr").count(), index === 3 ? 1 : 0);
        if (index === 0) {
          assert.equal(await page.getByTestId("step-detail-error").textContent(), item.error.content);
          await page.getByTestId("step-detail-copy-error").click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), item.error.content);
        }
        if (index === 3) {
          assert.equal(await page.getByTestId("step-detail-duration").textContent(), "Duration: 1.25s");
          for (const stream of ["stdout", "stderr"]) {
            await page.getByTestId(`step-detail-copy-${stream}`).click();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), item.detail.output[stream]);
          }
        }
        if (index === 4) {
          assert.equal(await page.getByTestId("step-detail-output").textContent(), item.detail.output);
          await page.getByTestId("step-detail-copy-output").click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), item.detail.output);
        }
        const bounds = await panel.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 845);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: join(work, `fields-${index}-${width}.png`) });
        report.push({ width, source: ["claude", "hermes", "codex", "explicit-streams", "hermes-multiline"][index], exitCode: index === 0 ? 1 : 0,
          duration: index === 3 ? "1.25s" : "omitted", stderr: index === 3 ? "separate, copy verified" : "omitted", bounds });
        await page.getByTestId("step-detail-close").click();
        await waitClosed();
      }
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(temp, "step-detail-fields-report.json"), JSON.stringify({ debugPort: port, bundleBytes: bundle.outputFiles[0].contents.length, measurements: report }, null, 2) + "\n");
    if (fieldsOnly) { console.log(JSON.stringify(report, null, 2)); return; }
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/switching`, { waitUntil: "networkidle" });
      const rows = page.getByTestId("tool-summary-row");
      await rows.nth(0).click();
      await waitOpen();
      assert.ok((await panel.textContent()).includes("Step A start"));
      const reading = await startReading();
      await page.getByTestId("preview-update-step").click();
      await panel.getByText("Updated sample output", { exact: false }).waitFor();
      const updated = await detailScroll();
      assert.equal(updated.top, reading.top, "Output updates to the same step must preserve the reader's position");
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
      report.push({ width, stepSwitching: "A -> B -> A starts at top", liveOutputUpdate: { before: reading.top, after: updated.top } });
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
      await rows.nth(0).tap(); await waitOpen();
      assert.equal(await rows.nth(0).evaluate(node => getComputedStyle(node).outlineStyle), "none", "Touch must not draw a keyboard focus ring");
      await page.getByTestId("step-detail-close").tap(); await waitClosed();
      assert.equal(await rows.nth(0).evaluate(node => getComputedStyle(node).outlineStyle), "none", "Closing touch details must not leave a keyboard focus ring");

      report.push({ width, keyboard: "arrows scoped to steps; Enter opens; Escape closes and restores focus", inputs: "input, textarea, contenteditable keep arrows and Enter", ring, panel: box, headerHeight: header.height, chatScrollTop: scrolled, touchRing: "hidden" });
    }
    for (const widths of [[1180, 820, 1180], [820, 600, 820], [1024, 1023, 1024, 744, 743, 744]]) {
      await page.setViewportSize({ width: widths[0], height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/rotation`, { waitUntil: "networkidle" });
      assert.ok(await page.getByTestId("preview-chat").evaluate(element => element.scrollTop > 0), "Chat must already be scrolled beneath the host header");
      await row.first().click();
      await waitOpen();
      // Include an exact 999px baseline so a hard-coded 1000px wait fails deterministically.
      const reading = await startReading(widths[0] === 820 ? 999 : 1000);
      report.push({ rotation: widths, width: widths[0], scrollTop: reading.top, phase: "before resize" });
      for (const width of widths.slice(1)) {
        await page.setViewportSize({ width, height: width === 820 ? 1180 : 844 });
        const presentation = width < 744 ? "sheet" : width < 1024 ? "popover" : "side";
        await page.waitForFunction(expected => {
          const panels = document.querySelectorAll('[data-testid="step-detail-panel"]');
          return panels.length === 1 && panels[0].getAttribute("data-presentation") === expected;
        }, presentation);
        await waitOpen();
        assert.ok((await panel.textContent()).includes("Step A start"), "Rotation must keep the selected step");
        const position = await waitReading(reading.top);
        assert.equal(position.top, reading.top, `Rotation to ${width}px must preserve the reader's detail scroll position`);
        assert.equal(await page.getByTestId("step-detail-backdrop").count(), presentation === "side" ? 0 : 1, "Only modal presentations have a backdrop");
        const box = await panel.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        assert.ok(box.y >= 0 && box.y + box.height <= (width === 820 ? 1180 : 844) + 1);
        const chat = await page.getByTestId("preview-chat").boundingBox();
        if (presentation === "side") assert.ok(chat.x + chat.width <= box.x + 1);
        report.push({ rotation: widths, width, presentation, panel: box, scrollTop: position.top });
      }
      await page.getByTestId("step-detail-close").click();
      await waitClosed();
      await page.getByTestId("step-detail-backdrop").waitFor({ state: "detached" });
      await page.getByTestId("preview-action").click();
    }
    for (const [width, presentation] of [[1440, "side"], [1180, "side"], [1024, "side"], [820, "popover"], [390, "sheet"]]) {
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
      assert.equal(await page.getByTestId("preview-host-header").evaluate(element => element.getBoundingClientRect().height), 64);
      assert.equal(await page.getByTestId("preview-chat").evaluate(element => element.scrollTop), 360);
      assert.ok(chat.y >= 64, "Replay chat is a scrolled container below the host toolbar");
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

    for (const width of [1440, 1180, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}/layout`, { waitUntil: "networkidle" });
      const rows = page.getByTestId("tool-summary-row");
      for (let index = 0; index < layoutSamples.length; index++) {
        const chat = await page.getByTestId("preview-chat").boundingBox();
        const bounds = await rows.evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom };
        }));
        for (let current = 0; current < bounds.length; current++) {
          const box = bounds[current];
          assert.ok(box.x >= chat.x && box.right <= chat.x + chat.width + 1, `${width}px step rows must stay inside chat`);
          assert.ok(!current || box.y >= bounds[current - 1].bottom, `${width}px step rows must not overlap`);
        }
        await rows.nth(index).click();
        await waitOpen();
        if (index < 2) {
          await panel.getByTestId("step-detail-output").first().waitFor();
          assert.equal(await panel.getByRole("button", { name: /^Show all / }).count(), 0, "Step details always expose the full output");
        } else {
          await panel.getByRole("button", { name: "Hide the image" }).waitFor();
          await panel.locator("img").waitFor({ state: "attached" });
        }
        await detailScroll(0);
        const layout = await panel.evaluate(element => {
          const panel = element.getBoundingClientRect();
          const controls = Array.from(element.querySelectorAll('[role="button"],[role="link"],[role="img"]'));
          return { viewport: document.documentElement.scrollWidth <= innerWidth,
            controls: controls.map(control => {
              const rect = control.getBoundingClientRect();
              let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
              let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
              for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
                if (style.overflowX !== "visible") { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
                if (style.overflowY !== "visible") { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
              }
              const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
              return { label: control.getAttribute("aria-label") ?? control.getAttribute("role"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hit: hit?.getAttribute("aria-label") ?? hit?.tagName,
                inside: rect.left >= panel.left - 1 && rect.right <= panel.right + 1,
                reachable: right <= left || bottom <= top || control.contains(hit),
              };
            }) };
        });
        await page.screenshot({ path: join(work, `content-${width}-${index}.png`) });
        assert.ok(layout.viewport, "The document must not overflow horizontally");
        for (const control of layout.controls) {
          assert.ok(control.inside, `${width}px ${control.label} must fit inside details`);
          assert.ok(control.reachable, `${width}px ${control.label} must remain reachable without overlap: ${JSON.stringify(control)}`);
        }
        report.push({ width, content: ["shell", "code", "image"][index], layout });
        if (width === 820) {
          let expandedSheet = false;
          let codeAnchor;
          let reading;
          if (index === 2) await panel.getByRole("button", { name: "Hide the image" }).click();
          else { reading = await startReading(); codeAnchor = reading.visibleCodeLine; }
          if (index === 1) assert.ok(codeAnchor, "The expanded code must expose a visible source line");
          for (const resized of [600, 1180, 820, 600, 820]) {
            await page.setViewportSize({ width: resized, height: 844 });
            await page.waitForFunction(expected => {
              const panels = document.querySelectorAll('[data-testid="step-detail-panel"]');
              return panels.length === 1 && panels[0].getAttribute("data-presentation") === expected;
            }, resized < 744 ? "sheet" : resized < 1024 ? "popover" : "side");
            await waitOpen();
            assert.equal(await panel.count(), 1);
            assert.equal(await panel.getAttribute("data-presentation"), resized < 744 ? "sheet" : resized < 1024 ? "popover" : "side");
            if (index === 2) {
              await panel.getByRole("button", { name: "Show the image" }).waitFor();
              assert.equal(await panel.locator("img").count(), 0, "Hidden images must stay hidden through resize");
            } else {
              await panel.getByTestId("step-detail-output").first().waitFor();
              const position = await waitReading(reading.top);
              // Reflow of this long file header can shift the first visible code line by up to three lines.
              if (index === 1) {
                assert.ok(position.top > 0 && position.visibleCodeLine, "Expanded code must retain a scrolled reading region");
                assert.ok(Math.abs(Number(position.visibleCodeLine.match(/\d+$/)[0]) - Number(codeAnchor.match(/\d+$/)[0])) <= 3,
                  "Resize must keep the same code reading region after header wrapping");
              }
              else assert.equal(position.top, reading.top, "Expanded output must keep its reading position");
            }
            if (resized === 600 && index === 0) {
              if (!expandedSheet) {
                await panel.getByRole("button", { name: "Expand step details" }).click();
                expandedSheet = true;
              } else assert.equal(await panel.getAttribute("data-snap"), "full", "Returning to split view must retain full-screen sheet size");
              await page.waitForFunction(() => document.querySelector('[data-testid="step-detail-panel"]')?.getAttribute("data-snap") === "full");
            }
          }
          report.push({ width, content: ["shell", "code", "image"][index], stateAcrossResize: "passed" });
        }
        await page.getByTestId("step-detail-close").click();
        await waitClosed();
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
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

    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${origin}/large-output`, { waitUntil: "networkidle" });
      await row.waitFor();
      await page.evaluate(() => {
        const frames = [], tasks = [], animations = [], longFrameDetails = [];
        let phaseStarted = performance.now(), previous = phaseStarted, raf;
        const tick = now => {
          if (previous !== undefined) {
            const duration = now - previous;
            frames.push(duration);
            if (duration > 50) longFrameDetails.push({ duration, scrollTop: document.querySelector('[data-testid="step-detail-scroll"]')?.scrollTop });
          }
          previous = now;
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        const observe = (type, target) => {
          if (!PerformanceObserver.supportedEntryTypes.includes(type)) return null;
          const record = entry => ({ start: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration,
            renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: entry.scripts?.map(script => ({ duration: script.duration, sourceFunctionName: script.sourceFunctionName,
              invoker: script.invoker, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) });
          const observer = new PerformanceObserver(list => target.push(...list.getEntries().map(record)));
          observer.observe({ type });
          return observer;
        };
        const taskObserver = observe("longtask", tasks), animationObserver = observe("long-animation-frame", animations);
        window.__detailPerformance = {
          snapshot() {
            taskObserver?.takeRecords().forEach(entry => tasks.push({ start: entry.startTime, duration: entry.duration }));
            animationObserver?.takeRecords().forEach(entry => animations.push({ start: entry.startTime, duration: entry.duration }));
            const result = { frames: frames.length, maxFrameMs: Math.max(0, ...frames), longFrames: frames.filter(value => value > 50).length,
              longTasks: tasks.filter(entry => entry.start + entry.duration > phaseStarted && entry.duration > 50).length,
              longAnimationFrames: animations.filter(entry => entry.start + entry.duration > phaseStarted && entry.duration > 50).length,
              supportsLongAnimationFrames: Boolean(animationObserver), longFrameDetails: [...longFrameDetails], animationDetails: [...animations] };
            frames.length = tasks.length = animations.length = longFrameDetails.length = 0;
            phaseStarted = previous = performance.now();
            return result;
          },
          stop() { cancelAnimationFrame(raf); taskObserver?.disconnect(); animationObserver?.disconnect(); },
        };
      });
      const openMs = await page.evaluate(async () => {
        const start = performance.now();
        document.querySelector('[data-testid="tool-summary-row"]').click();
        for (let frame = 0; frame < 120; frame++) {
          await new Promise(requestAnimationFrame);
          const element = document.querySelector('[data-testid="step-detail-panel"]');
          const rect = element?.getBoundingClientRect();
          let visible = rect?.height > 100 && rect.top >= 0 && rect.bottom <= innerHeight + 1;
          for (let ancestor = element; visible && ancestor; ancestor = ancestor.parentElement) {
            if (getComputedStyle(ancestor).opacity === "0" || ancestor.getAnimations().some(animation => animation.playState === "running" || animation.pending)) visible = false;
          }
          if (visible && element.querySelector('[data-testid="step-detail-output"]')) {
            await new Promise(requestAnimationFrame);
            return performance.now() - start;
          }
        }
        throw new Error("Large output did not open within 120 frames");
      });
      const opening = await page.evaluate(() => window.__detailPerformance.snapshot());
      await page.getByTestId("step-detail-copy-input").click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), JSON.stringify(largeInput, null, 2));
      await page.getByTestId("step-detail-copy-output").click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), largeOutput);
      assert.equal(await page.getByTestId("step-detail-duration").textContent(), "Duration: 1.25s");
      assert.equal(await page.getByTestId("step-detail-exit-code").textContent(), "Exit code: 0");
      await page.evaluate(() => window.__detailPerformance.snapshot());
      const scroll = await page.evaluate(async () => {
        const panel = document.querySelector('[data-testid="step-detail-panel"]');
        const viewport = panel.querySelector('[data-testid="step-detail-scroll"]');
        let peakTextCharacters = 0, peakTextChunks = 0, settled = 0, lastHeight = 0, steps = 0;
        let overflow = false, sawMiddle = false, reachedEnd = false;
        const start = performance.now();
        for (; steps < 1800; steps++) {
          await new Promise(requestAnimationFrame);
          const chunks = Array.from(panel.querySelectorAll('[data-testid="step-detail-output"], [data-testid="step-detail-input"]'));
          peakTextCharacters = Math.max(peakTextCharacters, chunks.reduce((count, chunk) => count + chunk.textContent.length, 0));
          peakTextChunks = Math.max(peakTextChunks, chunks.length);
          overflow ||= chunks.some(chunk => chunk.scrollWidth > chunk.clientWidth + 1) || document.documentElement.scrollWidth > innerWidth;
          sawMiddle ||= chunks.some(chunk => chunk.textContent.includes("Output line 5000:"));
          reachedEnd = chunks.some(chunk => chunk.textContent.includes("Output line 10000:"));
          const atEnd = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
          settled = atEnd && reachedEnd && lastHeight === viewport.scrollHeight ? settled + 1 : 0;
          if (settled >= 8) break;
          lastHeight = viewport.scrollHeight;
          // Scroll at a readable rate, allowing each asynchronous render batch to paint.
          viewport.scrollTop += Math.max(80, viewport.clientHeight * 0.7);
        }
        return { durationMs: performance.now() - start, steps, peakTextCharacters, peakTextChunks, overflow, sawMiddle, reachedEnd,
          scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, height: viewport.clientHeight };
      });
      const scrolling = await page.evaluate(() => { const result = window.__detailPerformance.snapshot(); window.__detailPerformance.stop(); return result; });
      const measurement = { width, lines: 10000, outputCharacters: largeOutput.length, openMs, opening, scrolling, ...scroll };
      report.push(measurement);
      console.log(JSON.stringify(measurement));
      writeFileSync(join(temp, "step-detail-report.json"), JSON.stringify({ debugPort: port, measurements: report }, null, 2) + "\n");
      assert.equal(scroll.reachedEnd, true, "The final output line is reachable");
      assert.equal(scroll.sawMiddle, true, "The middle of the output is rendered while scrolling");
      assert.equal(scroll.overflow, false, "Long unbroken output stays inside the panel");
      assert.ok(scroll.peakTextCharacters < largeOutput.length / 4, "Only a bounded window of the output is mounted");
      for (const [phase, metrics] of [["opening", opening], ["scrolling", scrolling]]) {
        if (metrics.longFrames || metrics.longAnimationFrames || metrics.longTasks) performanceFailures.push({ width, phase, metrics });
      }
    }
    assert.deepEqual(performanceFailures, [], "Opening and scrolling must have no frame, animation frame or task over 50ms");
    assert.deepEqual(errors, []);
    writeFileSync(join(temp, "step-detail-report.json"), JSON.stringify({ debugPort: port, browserVersion: (await session.send("Browser.getVersion")).product,
      bundleBytes: bundle.outputFiles[0].contents.length, measurements: report }, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(join(work, "profile"), { recursive: true, force: true });
  }
}
replay().catch(error => { console.error(error); process.exitCode = 1; });
