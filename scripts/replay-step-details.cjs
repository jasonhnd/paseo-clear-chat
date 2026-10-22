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
const readSample = JSON.parse(readFileSync(join(root, "test/fixtures/real-hermes-session.json"), "utf8"))
  .items.find(item => item.type === "tool_call" && item.detail.type === "read");
// Stress the captured read shape without including any additional conversation text.
const longPath = `/workspace/sample/${"nested-directory/".repeat(12)}configuration`;
const layoutSamples = [longSamples[0],
  { ...readSample, callId: "sample-code", detail: { ...readSample.detail, filePath: `${longPath}.ts`,
    content: Array.from({ length: 48 }, (_, index) => `export const sample${index} = "${"sample".repeat(40)}";`).join("\n") } },
  { ...readSample, callId: "sample-image", detail: { ...readSample.detail, filePath: `${longPath}.png`, content: "Image file" } },
];

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
    response.end(request.url === "/preview.js" ? bundle.outputFiles[0].contents : html(request.url === "/layout" ? layoutSamples : ["/switching", "/keyboard", "/rotation"].includes(request.url) ? longSamples : [sample]));
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
      return panel.evaluate(async (element, top) => {
        const scroll = Array.from(element.querySelectorAll("div")).find(node =>
          ["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.clientHeight > 0);
        if (!scroll) throw new Error("Step details must have a scrollable body");
        if (top !== undefined) {
          scroll.scrollTop = top;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        const body = element.querySelector('[data-testid="tool-card-body"]');
        const viewportTop = scroll.getBoundingClientRect().top;
        const visibleCodeLine = Array.from(body.querySelectorAll("div")).find(node =>
          /^\d+\s*export const sample\d+\s*=/.test(node.textContent) && node.getBoundingClientRect().top >= viewportTop);
        return { top: scroll.scrollTop, height: scroll.clientHeight, contentHeight: scroll.scrollHeight,
          bodyTop: body.getBoundingClientRect().top, viewportTop,
          visibleCodeLine: visibleCodeLine?.textContent.match(/export const sample\d+/)?.[0] };
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
      await detailScroll(1000);
      for (const width of widths.slice(1)) {
        await page.setViewportSize({ width, height: width === 820 ? 1180 : 844 });
        const presentation = width < 744 ? "sheet" : width < 1024 ? "popover" : "side";
        await page.waitForFunction(expected => {
          const panels = document.querySelectorAll('[data-testid="step-detail-panel"]');
          return panels.length === 1 && panels[0].getAttribute("data-presentation") === expected;
        }, presentation);
        await waitOpen();
        assert.ok((await panel.textContent()).includes("Step A start"), "Rotation must keep the selected step");
        const position = await detailScroll();
        assert.equal(position.top, 1000, `Rotation to ${width}px must preserve the reader's detail scroll position`);
        assert.equal(await page.getByTestId("step-detail-backdrop").count(), presentation === "side" ? 0 : 1, "Only modal presentations have a backdrop");
        const box = await panel.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        assert.ok(box.y >= 0 && box.y + box.height <= (width === 820 ? 1180 : 844) + 1);
        const chat = await page.getByTestId("preview-chat").boundingBox();
        if (presentation === "side") assert.ok(chat.x + chat.width <= box.x + 1);
        report.push({ rotation: widths, width, presentation, panel: box, scrollTop: 1000 });
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
          await panel.getByRole("button", { name: /^Show all / }).first().click();
          await panel.getByRole("button", { name: "Show fewer lines" }).first().waitFor();
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
          if (index === 2) await panel.getByRole("button", { name: "Hide the image" }).click();
          else codeAnchor = (await detailScroll(1000)).visibleCodeLine;
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
              await panel.getByRole("button", { name: "Show fewer lines" }).first().waitFor();
              const position = await detailScroll();
              // Reflow of this long file header can shift the first visible code line by up to three lines.
              if (index === 1) {
                assert.ok(position.top > 0 && position.visibleCodeLine, "Expanded code must retain a scrolled reading region");
                assert.ok(Math.abs(Number(position.visibleCodeLine.match(/\d+$/)[0]) - Number(codeAnchor.match(/\d+$/)[0])) <= 3,
                  "Resize must keep the same code reading region after header wrapping");
              }
              else assert.equal(position.top, 1000, "Expanded output must keep its reading position");
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
