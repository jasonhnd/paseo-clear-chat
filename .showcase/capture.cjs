"use strict";

// One offline build, one synthetic conversation, fresh Chromium profiles for each scale.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { readmeV2Groups, demoCapture } = require("./capture-plan.cjs");
const { captureDemo } = require("./capture-demo.cjs");

const root = resolve(__dirname, "..");
const work = join(__dirname, ".capture-temp");
const selected = process.env.SHOWCASE_CAPTURE_ONLY;
const plan = readmeV2Groups.filter(group => !selected || group.id === selected || group.id.startsWith(`${selected}-`));
if (selected && selected !== "demo" && !plan.length) throw new Error(`Unknown capture: ${selected}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
process.env.TMPDIR = work;
process.env.TMP = work;
process.env.TEMP = work;
const cache = join(process.env.HOME, ".cache/ms-playwright");
const bundled = existsSync(chromium.executablePath()) ? chromium.executablePath() :
  readdirSync(cache).filter(name => name.startsWith("chromium-")).map(name => join(cache, name, "chrome-linux64/chrome")).find(existsSync);
const chrome = process.env.CHROME_PATH || bundled;
assert.ok(chrome && !/edge/i.test(chrome), "Use Google Chrome or Playwright Chromium only");
assert.ok(chrome === bundled || /(?:google\/chrome|google-chrome|chrome-for-testing)/.test(chrome), "CHROME_PATH must be Google Chrome");
const freeze = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

async function settle(page) {
  await page.evaluate(async () => {
    await Promise.all(['400 12px "OMP Inter"', '600 12px "OMP Inter"', '400 12px "OMP Iosevka"', '400 12px "OMP Iosevka Code"'].map(face => document.fonts.load(face)));
    await document.fonts.ready;
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function verifyFonts(page, frameUrl) {
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const findFrame = node => node.documentURL === frameUrl ? node :
    [node.contentDocument, ...(node.children || [])].filter(Boolean).map(findFrame).find(Boolean);
  const document = frameUrl ? findFrame(root) : root;
  assert.ok(document, "The capture document must be available for font inspection");
  const report = [];
  for (const [selector, expected] of [
    ['[data-testid="tool-summary-text"]', /Inter/],
    ['[data-testid="step-detail-input"], [data-testid="step-detail-output"], [data-testid="step-detail-stdout"]', /Iosevka/],
  ]) {
    const { nodeIds } = await session.send("DOM.querySelectorAll", { nodeId: document.nodeId, selector });
    for (const nodeId of nodeIds) {
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const font of fonts.filter(font => font.glyphCount)) {
        assert.ok(expected.test(font.familyName) && font.isCustomFont, `Unexpected rendered font: ${JSON.stringify(font)}`);
        report.push({ family: font.familyName, glyphs: font.glyphCount });
      }
    }
  }
  assert.ok(report.length, "Rendered embedded font evidence is required");
  await session.detach();
  return report;
}

async function verifyCapture(page, detail) {
  const text = await page.locator("body").innerText();
  for (const label of ["Check the shipping rule", "Search: shippingLabel", "cart.ts:1-5", "cart.ts · +3 −1", "$ npm test", "$ git diff --stat", "Ready to review"]) assert.ok(text.includes(label), `Missing ${label}`);
  assert.ok(!/Close host panel|Use inline expansion|Hydrate workspace|Update first step/.test(text), "Harness controls must never appear");
  if (detail && detail !== "menu") {
    assert.equal(await page.getByTestId("step-detail-panel").getAttribute("data-presentation"), detail);
    assert.ok((await page.getByTestId("step-detail-panel").innerText()).includes("Free shipping"));
    assert.ok((await page.getByTestId("step-detail-input").innerText()).startsWith("*** Begin Patch\n*** Update File: src/cart.ts"));
    assert.equal(await page.getByTestId("step-detail-output").innerText(), "Success. Updated the following files:\nM src/cart.ts");
    const output = await page.getByTestId("step-detail-output").boundingBox();
    const scroll = await page.getByTestId("step-detail-scroll").boundingBox();
    assert.ok(output.y >= scroll.y && output.y + output.height <= scroll.y + scroll.height, "The complete success result must be in view");
  }
  if (detail === "sheet") {
    // Inspect actual text line rectangles, rather than just element bounding boxes.
    const cut = await page.evaluate(() => {
      const edge = document.querySelector('[data-testid="step-detail-panel"]').getBoundingClientRect().top;
      const walker = document.createTreeWalker(document.querySelector('[data-testid="demo-transcript"]'), NodeFilter.SHOW_TEXT);
      const cut = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) if (rect.top < edge && rect.bottom > edge) cut.push({ text: walker.currentNode.textContent, top: rect.top, bottom: rect.bottom, edge });
      }
      return cut;
    });
    assert.deepEqual(cut, [], "The sheet edge must fall between text lines");
  }
  return verifyFonts(page);
}

async function longPressRow(page) {
  const box = await page.getByRole("button", { name: "View details: $ npm test" }).boundingBox();
  assert.ok(box, "The test step must be visible");
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 32, y: box.y + box.height / 2, radiusX: 1, radiusY: 1, force: 1, id: 1 }] });
  await page.waitForTimeout(800);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  await page.getByTestId("tool-step-menu").waitFor();
  const menuText = await page.getByTestId("tool-step-menu").innerText();
  assert.ok(menuText.includes("Copy command") && menuText.includes("Copy result"));
}

function heroHtml(dark) {
  return `<!doctype html><html lang="en"><style>
  html,body{margin:0}#frame{width:2000px;height:1376px;position:relative;background:${dark ? "linear-gradient(155deg,#232733,#12141b)" : "linear-gradient(155deg,#f4f7fb,#d5e0ee)"}}
  img{display:block;position:absolute;box-shadow:0 20px 46px ${dark ? "#0009" : "#18202d38"}}
  #desktop{left:32px;top:96px;width:1480px;height:1184px;border-radius:18px}
  #phone{left:1544px;bottom:96px;width:432px;height:auto;border-radius:28px}
  </style><div id="frame"><img id="desktop" src="/raw/desktop.png" alt=""><img id="phone" src="/raw/phone.png" alt=""></div></html>`;
}

async function capture() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "readme-capture.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")), "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/ui": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/plugin-client.tsx"),
    }, nodePaths: [join(__dirname, "node_modules")],
  });
  const raw = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/showcase.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); }
    else if (url.pathname === "/compose") { response.setHeader("Content-Type", "text/html"); response.end(heroHtml(url.searchParams.get("theme") === "dark")); }
    else if (url.pathname.startsWith("/raw/")) { response.setHeader("Content-Type", "image/png"); response.end(raw.get(url.pathname.slice(5))); }
    else { response.setHeader("Content-Type", "text/html"); response.end(readFileSync(join(__dirname, "index.html"))); }
  });
  let browser;
  const report = [];
  try {
    // A fixed allowed port avoids ever using the owner's prohibited debugger port.
    await new Promise((done, reject) => { server.once("error", reject); server.listen(4318, "127.0.0.1", done); });
    const origin = "http://127.0.0.1:4318";
    const newPage = async (name, viewport, scale = 1, hasTouch = false) => {
      browser = await chromium.launchPersistentContext(join(work, `${name}-profile`), {
        executablePath: chrome, headless: process.env.INSTABOX_HEADLESS === "1", viewport, deviceScaleFactor: scale, hasTouch,
        reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
        args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
      });
      const page = browser.pages()[0] || await browser.newPage();
      // Freeze only Date, leaving animation and the responsive handoff clock live.
      await page.clock.setFixedTime(new Date("2026-10-22T14:09:37Z"));
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      return { page, errors };
    };
    const navigate = async (page, theme, textScale = 1) => {
      await page.goto(`${origin}/?theme=${theme}&textScale=${textScale}`, { waitUntil: "networkidle" });
      await page.getByTestId("demo-step-5").waitFor();
      await page.addStyleTag({ content: freeze });
      await settle(page);
      const background = await page.getByTestId("demo").evaluate(node => getComputedStyle(node).backgroundColor);
      assert.equal(background, theme === "dark" ? "rgb(15, 15, 17)" : "rgb(248, 250, 252)");
    };
    const openEdit = async page => {
      await page.getByRole("button", { name: "View details: cart.ts · +3 −1" }).click();
      await page.mouse.move(2, 2);
      await settle(page);
    };
    for (const group of plan) {
      let { page, errors } = await newPage(group.id, group.id === "hero" ? { width: 1480, height: 1184 } : group.viewport, group.deviceScaleFactor, group.id.startsWith("phone-"));
      for (const theme of ["light", "dark"]) {
        if (group.id === "hero") {
          await page.setViewportSize({ width: 1480, height: 1184 });
          await navigate(page, theme, 2); await openEdit(page);
          await verifyCapture(page, "side");
          raw.set("desktop.png", await page.screenshot({ animations: "disabled" }));
          await page.setViewportSize({ width: 390, height: 936 });
          await navigate(page, theme, 1.7);
          await verifyCapture(page);
          assert.equal(await page.getByTestId("step-detail-panel").count(), 0, "The hero phone must show the compact timeline without a scrim");
          const reply = await page.getByTestId("demo-reply").boundingBox();
          // Frame the compact first turn at a paragraph boundary, before the follow-up.
          raw.set("phone.png", await page.screenshot({ animations: "disabled", clip: { x: 0, y: 0, width: 390, height: Math.ceil(reply.y + reply.height + 3) } }));
          // The modal's history restoration must never navigate the composition page.
          await page.close();
          page = await browser.newPage();
          await page.clock.setFixedTime(new Date("2026-10-22T14:09:37Z"));
          page.on("pageerror", error => errors.push(error.message));
          await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await page.setViewportSize(group.viewport);
          await page.goto(`${origin}/compose?theme=${theme}`, { waitUntil: "networkidle" });
          await page.locator("#frame").waitFor();
          assert.equal(await page.locator("#frame img").count(), 2);
          await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
          const bounds = await page.locator("#frame img").evaluateAll(images => images.map(image => {
            const { left, right, bottom } = image.getBoundingClientRect(); return { left, right, bottom };
          }));
          assert.ok(bounds[1].left >= bounds[0].right, "Hero devices must sit side by side");
          assert.ok(Math.abs(bounds[0].bottom - bounds[1].bottom) < 1, "Hero device bottoms must align");
        } else {
          await navigate(page, theme);
          if (group.detail === "menu") await longPressRow(page);
          else if (group.detail) await openEdit(page);
          if (group.detail === "sheet") {
            // Include the success result; use the panel's own scroll surface.
            await page.getByTestId("step-detail-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
            await settle(page);
          }
          const fonts = await verifyCapture(page, group.detail);
          report.push({ file: group[theme], fonts });
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(root, group[theme]), animations: "disabled" });
        console.log(`Captured ${group[theme]}`);
      }
      await browser.close(); browser = undefined;
    }
    if (!selected || selected === "demo") {
      const { page, errors } = await newPage("demo", { width: 1200, height: 800 });
      await captureDemo({ page, origin, work, root, errors, plan: demoCapture, settle, verifyFonts });
      await browser.close(); browser = undefined;
    }
    writeFileSync(join(work, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
    // Keep frames locally until the contact sheets have been reviewed.
  }
}
capture().catch(error => { console.error(error); process.exitCode = 1; });
