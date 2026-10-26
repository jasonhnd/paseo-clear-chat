"use strict";

// Offline builds, synthetic fixtures, fresh Chrome or Chromium profiles for each scale.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, copyFileSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const { resolve, join, dirname } = require("node:path");
const { readmeV2Groups, demoCapture, heroCapture } = require("./capture-plan.cjs");
const { captureDemo } = require("./capture-demo.cjs");
const { rowMetrics } = require("./capture-row-metrics.cjs");

const root = resolve(__dirname, "..");
const work = mkdtempSync(join(tmpdir(), "clear-chat-capture-"));
const selected = process.env.SHOWCASE_CAPTURE_ONLY;
const plan = readmeV2Groups.filter(group => !selected || selected.split(",").some(id => group.id === id || group.id.startsWith(`${id}-`)));
if (selected && selected !== "demo" && selected !== "settings" && !plan.length) throw new Error(`Unknown capture: ${selected}`);
process.env.TMPDIR = work;
process.env.TMP = work;
process.env.TEMP = work;
const cache = join(process.env.HOME, ".cache/ms-playwright");
const bundled = existsSync(chromium.executablePath()) ? chromium.executablePath() :
  readdirSync(cache).filter(name => name.startsWith("chromium-")).map(name => join(cache, name, "chrome-linux64/chrome")).find(existsSync);
const chrome = process.env.CHROME_PATH || bundled;
assert.ok(chrome && !/edge/i.test(chrome), "Use Google Chrome or Playwright Chromium only");
assert.ok(chrome === bundled || chrome === "/usr/bin/chromium" || /(?:google\/chrome|google-chrome|chrome-for-testing)/.test(chrome), "CHROME_PATH must be Google Chrome or Chromium");
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
  const codeFamilies = await page.evaluate(frameUrl => {
    const doc = frameUrl ? [...document.querySelectorAll("iframe")].find(frame => frame.src === frameUrl).contentDocument : document;
    return [...new Set([...doc.querySelectorAll("[style]")].filter(node => !node.children.length && node.textContent.trim())
      .map(node => doc.defaultView.getComputedStyle(node).fontFamily).filter(family => family.includes("Iosevka")))];
  }, frameUrl);
  assert.ok(codeFamilies.length && codeFamilies.every(family => family === '"OMP Iosevka"'), "All README code must use literal glyphs");
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
    if (detail === "sheet") {
      // At the original half-height snap, the result continues below the fold.
      // Keep Output and its first line in view without hiding the list header.
      const heading = await page.getByTestId("step-detail-panel").getByText("Output", { exact: true }).boundingBox();
      assert.ok(heading.y >= scroll.y && heading.y + heading.height <= scroll.y + scroll.height, "Output must be visible");
      assert.ok(output.y >= scroll.y && output.y < scroll.y + scroll.height, "The success result must begin in view");
    } else {
      assert.ok(output.y >= scroll.y && output.y + output.height <= scroll.y + scroll.height, "The complete success result must be in view");
    }
  }
  if (detail === "sheet") {
    const panel = page.getByTestId("step-detail-panel");
    const scroll = page.getByTestId("step-detail-scroll");
    assert.equal(await scroll.evaluate(node => node.scrollTop), 0, "The sheet list must start at offset zero");
    const viewport = await scroll.boundingBox();
    for (const text of ["Status: completed", "Duration: 200ms"]) {
      const row = panel.getByText(text, { exact: true });
      assert.ok(await row.isVisible(), `${text} must be visible in the sheet`);
      const bounds = await row.boundingBox();
      assert.ok(bounds.y >= viewport.y && bounds.y + bounds.height <= viewport.y + viewport.height,
        `${text} must be fully inside the sheet list viewport`);
    }
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

async function verifyHero(page, device) {
  const spec = heroCapture[device];
  const displayScale = spec.displayWidth / spec.width * 800 / 2000;
  const metrics = await page.evaluate(displayScale => {
    const canvas = document.createElement("canvas").getContext("2d");
    const measure = selector => [...document.querySelectorAll(selector)].map(node => {
      const style = getComputedStyle(node);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const inkHeight = Math.max(...node.textContent.split("\n").map(line => {
        const text = canvas.measureText(line);
        return text.actualBoundingBoxAscent + text.actualBoundingBoxDescent;
      }));
      return { fontSizeAt800: parseFloat(style.fontSize) * displayScale, inkHeightAt800: inkHeight * displayScale };
    });
    const code = [...document.querySelectorAll("[style]")].filter(node =>
      !node.children.length && node.textContent.trim() && getComputedStyle(node).fontFamily.includes("Iosevka"));
    const reply = document.querySelector('[data-testid="demo-reply"]').getBoundingClientRect();
    const output = document.querySelector('[data-testid="step-detail-output"]')?.getBoundingClientRect();
    return {
      steps: measure('[data-testid="tool-summary-text"]'),
      code: measure('[data-testid="step-detail-input"], [data-testid="step-detail-output"]'),
      codeFamilies: [...new Set(code.map(node => getComputedStyle(node).fontFamily))],
      hasLigatureCharacters: code.some(node => /[≥≤≠⇒⇐]/.test(node.textContent)),
      replyBottom: reply.bottom, outputBottom: output?.bottom,
    };
  }, displayScale);
  assert.ok(metrics.steps.every(text => text.fontSizeAt800 >= 11 && text.fontSizeAt800 <= 12.1), "Hero steps must read as 11–12 px at README width");
  assert.ok(metrics.code.every(text => text.fontSizeAt800 >= 11 && text.fontSizeAt800 <= 12.1), "Hero code must read as 11–12 px at README width");
  assert.ok(metrics.codeFamilies.length && metrics.codeFamilies.every(family => family === '"OMP Iosevka"'), "Every hero code run must use the literal font cut");
  assert.equal(metrics.hasLigatureCharacters, false);
  if (device === "desktop") {
    assert.ok(Math.max(metrics.replyBottom, metrics.outputBottom) <= spec.height && spec.height - Math.max(metrics.replyBottom, metrics.outputBottom) < 16, `Crop the desktop just after the completed turn: ${JSON.stringify({ height: spec.height, reply: metrics.replyBottom, output: metrics.outputBottom })}`);
    assert.ok(spec.height - metrics.outputBottom < 128, "Trim empty space below the real success result");
  }
  const rows = await rowMetrics(page);
  assert.ok(rows.every(row => row.clippedBy.length === 0), "Hero label text must not cross a clipping ancestor");
  for (const row of rows) {
    assert.ok(row.inkTop >= row.cardTop && row.inkBottom <= row.cardBottom && row.inkLeft >= row.cardLeft && row.inkRight <= row.cardRight,
      `Every step label's ink must fit inside its row card: ${JSON.stringify(row)}`);
  }
  assert.ok(rows.every(row => row.titleToDuration * displayScale >= 4), "Hero titles must have at least 4 px before durations at README width");
  return { ...metrics, rows };
}

function heroHtml(dark) {
  const { marginX, marginY, gap, desktop, phone } = heroCapture;
  const { viewport } = readmeV2Groups.find(group => group.id === "hero");
  const displayHeight = desktop.height * desktop.displayWidth / desktop.width;
  return `<!doctype html><html lang="en"><style>
  html,body{margin:0}#frame{width:${viewport.width}px;height:${viewport.height}px;position:relative;background:${dark ? "linear-gradient(155deg,#232733,#12141b)" : "linear-gradient(155deg,#f4f7fb,#d5e0ee)"}}
  img{display:block;position:absolute;box-shadow:0 20px 46px ${dark ? "#0009" : "#18202d38"}}
  #desktop{left:${marginX}px;top:${marginY}px;width:${desktop.displayWidth}px;height:${displayHeight}px;border-radius:18px}
  #phone{left:${marginX + desktop.displayWidth + gap}px;top:${marginY}px;width:${phone.displayWidth}px;height:${displayHeight}px;object-fit:contain;object-position:top;background:${dark ? "#0f0f11" : "#f8fafc"};border-radius:28px}
  </style><div id="frame"><img id="desktop" src="/raw/desktop.png" alt=""><img id="phone" src="/raw/phone.png" alt=""></div></html>`;
}

async function capture() {
  const buildOptions = {
    absWorkingDir: root, entryPoints: [join(__dirname, "readme-capture.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")), "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/ui": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/plugin-client.tsx"),
    }, nodePaths: [join(__dirname, "node_modules")],
  };
  const bundle = await build(buildOptions);
  const settingsBundle = !selected || selected === "settings"
    ? await build({ ...buildOptions, entryPoints: [join(__dirname, "showcase.tsx")] }) : null;
  const raw = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/showcase.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); }
    else if (url.pathname === "/settings.js") { response.setHeader("Content-Type", "text/javascript"); response.end(settingsBundle.outputFiles[0].contents); }
    else if (url.pathname === "/settings") { response.setHeader("Content-Type", "text/html"); response.end(readFileSync(join(__dirname, "index.html"), "utf8").replace("./showcase.js", "./settings.js")); }
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
    const navigate = async (page, theme, textScale = 1, hero = false, desktop = false) => {
      await page.goto(`${origin}/?theme=${theme}&textScale=${textScale}${hero ? `&hero${desktop ? `&heroDesktop&detailWidth=${heroCapture.desktop.detailWidth}` : ""}` : ""}`, { waitUntil: "networkidle" });
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
    if (process.env.SHOWCASE_MEASURE_ROWS) {
      const measurements = [];
      for (const [name, viewport, textScale, hero] of [
        ["desktop-default", heroCapture.desktop, 1, false],
        ["phone-default", { width: 390, height: 900 }, 1, false],
        ["desktop-hero", heroCapture.desktop, heroCapture.desktop.textScale, true],
        ["phone-hero", heroCapture.phone, heroCapture.phone.textScale, true],
      ]) {
        for (const scale of [1, 2]) {
          const { page, errors } = await newPage(`${name}-${scale}`, viewport, scale);
          await navigate(page, "light", textScale, hero, name === "desktop-hero");
          if (name.startsWith("desktop")) await openEdit(page);
          measurements.push({ name, deviceScaleFactor: scale, rows: await rowMetrics(page) });
          await page.screenshot({ path: join(work, `${name}-${scale}.png`) });
          assert.deepEqual(errors, []);
          await browser.close(); browser = undefined;
        }
      }
      writeFileSync(join(work, "row-metrics.json"), JSON.stringify(measurements, null, 2) + "\n");
      console.log(JSON.stringify(measurements, null, 2));
      return;
    }
    if (settingsBundle) {
      const { page, errors } = await newPage("settings", { width: 1600, height: 1000 }, 1.5);
      for (const theme of ["light", "dark"]) {
        await page.goto(`${origin}/settings?theme=${theme}`, { waitUntil: "networkidle" });
        const shot = page.locator("#shot-settings");
        await shot.waitFor();
        await settle(page);
        await page.addStyleTag({ content: freeze });
        const text = await shot.innerText();
        for (const label of [
          "Accent colour", "Interface font", "Code glyphs", "Code font", "Text size",
          "Fold finished steps", "When a collapsed step is pressed", "Fold long output after",
          "Frosted glass", "Pointer glow", "Enhanced prompt bubble", "Selection actions",
          "Assistant markdown", "Markdown style", "Hermes·CC providers", "Report a problem",
        ]) {
          if (!text.includes(label)) throw new Error(`Settings capture is missing ${label}`);
        }
        const english = JSON.parse(readFileSync(join(root, "client/locales/en.json"), "utf8"));
        assert.ok(text.includes(english.settings.promptBubble.description), "The complete current prompt-bubble description must be visible");
        assert.equal(await shot.getByRole("switch", { name: english.settings.hermesCc.label, exact: true }).getAttribute("aria-checked"), "true", "Hermes·CC providers must default to on");
        assert.deepEqual(errors, []);
        const file = `docs/images/settings-${theme}.png`;
        const raw = join(work, `settings-${theme}.png`);
        const destination = join(root, file);
        await shot.screenshot({ path: raw, animations: "disabled" });
        copyFileSync(raw, destination);
        if (statSync(destination).size > 500000) {
          execFileSync("magick", [raw, "-strip", "-colors", "256", "-define", "png:compression-level=9", destination]);
        }
        const bytes = statSync(destination).size;
        if (bytes > 500000) throw new Error(`${file} exceeds 500 KB (${bytes} bytes)`);
        report.push({ file, fixture: "settings", bytes, text });
        console.log(`${file}: ${bytes} bytes`);
        rmSync(raw);
      }
      await browser.close(); browser = undefined;
    }
    for (const group of plan) {
      let { page, errors } = await newPage(group.id, group.id === "hero" ? heroCapture.desktop : group.viewport, group.id === "hero" ? heroCapture.desktop.deviceScaleFactor : group.deviceScaleFactor, group.id.startsWith("phone-"));
      for (const theme of ["light", "dark"]) {
        if (group.id === "hero") {
          await page.setViewportSize(heroCapture.desktop);
          await navigate(page, theme, 1, true, true);
          const defaultRows = await rowMetrics(page);
          assert.ok(defaultRows.every(row => row.clippedBy.length === 0), "Default product labels must not clip");
          await openEdit(page);
          const desktopFonts = await verifyCapture(page, "side");
          const desktopText = await verifyHero(page, "desktop");
          raw.set("desktop.png", await page.screenshot({ animations: "disabled" }));
          await page.setViewportSize(heroCapture.phone);
          await navigate(page, theme, heroCapture.phone.textScale, true);
          const phoneFonts = await verifyCapture(page);
          const phoneText = await verifyHero(page, "phone");
          report.push({ file: group[theme], defaultRows, desktop: { fonts: desktopFonts, text: desktopText }, phone: { fonts: phoneFonts, text: phoneText } });
          assert.equal(await page.getByTestId("step-detail-panel").count(), 0, "The hero phone must show the compact timeline without a scrim");
          const reply = await page.getByTestId("demo-reply").boundingBox();
          // Frame the compact first turn at a paragraph boundary, before the follow-up.
          raw.set("phone.png", await page.screenshot({ animations: "disabled", clip: { x: 0, y: 0, width: heroCapture.phone.width, height: Math.ceil(reply.y + reply.height + 3) } }));
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
            const { left, right, top, bottom } = image.getBoundingClientRect(); return { left, right, top, bottom };
          }));
          assert.equal(bounds[1].left - bounds[0].right, heroCapture.marginX, "Hero gap must match the outer margin");
          assert.equal(bounds[0].bottom, bounds[1].bottom, "Hero bottoms must align");
          assert.equal(bounds[0].top, bounds[1].top, "Hero tops must align");
          assert.equal(bounds[0].left, heroCapture.marginX);
          assert.equal(group.viewport.width - bounds[1].right, heroCapture.marginX);
          assert.ok(bounds.every(box => box.top >= heroCapture.marginY && box.bottom <= group.viewport.height - heroCapture.marginY), "Hero content must fit the trimmed canvas");
        } else {
          await navigate(page, theme);
          if (group.detail === "menu") await longPressRow(page);
          else if (group.detail) await openEdit(page);
          if (group.detail === "sheet") {
            // Keep the metadata header above the path, Input, and Output.
            await page.getByTestId("step-detail-scroll").evaluate(node => { node.scrollTop = 0; });
            await settle(page);
          }
          const fonts = await verifyCapture(page, group.detail);
          report.push({ file: group[theme], fonts });
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(root, group[theme]), animations: "disabled", scale: group.id === "hero" ? "css" : "device" });
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
    console.log(`Captured ${report.length} image reports with ${chrome}.`);
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
    // Keep frames locally until the contact sheets have been reviewed.
  }
}
capture().catch(error => { console.error(error); process.exitCode = 1; });
