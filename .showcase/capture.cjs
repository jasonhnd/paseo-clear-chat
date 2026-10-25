"use strict";

// Build, serve, capture and clean up in one process. Never uses a live host.
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync, realpathSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const { createCapturePlan } = require("./capture-plan.cjs");

const root = resolve(__dirname, "..");
const groups = createCapturePlan(readFileSync(join(root, "README.md"), "utf8"));
const selected = process.env.SHOWCASE_CAPTURE_ONLY;
const plan = selected ? groups.filter(group => group.id === selected) : groups;
if (!plan.length) throw new Error(`Unknown screenshot group: ${selected}`);
const output = resolve(process.env.SHOWCASE_OUTPUT_ROOT || root);
const temp = process.env.KANBAN_TMP;
if (!temp || realpathSync(temp) !== resolve(temp)) {
  throw new Error("KANBAN_TMP must be an existing, absolute task directory.");
}
// Chrome and image tools inherit this value; no system temporary directory.
process.env.TMPDIR = temp;
process.env.TMP = temp;
process.env.TEMP = temp;
process.env.MAGICK_TEMPORARY_PATH = temp;
if (tmpdir() !== temp) throw new Error("Temporary directory was not redirected.");
const work = join(temp, "capture");
mkdirSync(work, { recursive: true });
for (const group of plan) mkdirSync(dirname(join(output, group.light)), { recursive: true });

// Cover geometry. Desktop content is 1440×900. The phone view is a 390px-wide
// browser viewport, placed over the desktop's lower right. The frame is 2000px wide.
const HERO_DESKTOP = { width: 1440, height: 900 };
// Tall enough for a half sheet to show the edit diff, and short enough that the
// phone sits on the desktop's lower right without covering that diff.
const HERO_PHONE = { width: 390, height: 820 };
const HERO_PAD_X = 235;
const HERO_PAD_Y = 88;
const HERO_OVERLAP_X = 300;
const HERO_DROP_Y = 300;
const HERO_PHONE_X = HERO_PAD_X + HERO_DESKTOP.width - HERO_OVERLAP_X;
const HERO_PHONE_Y = HERO_PAD_Y + HERO_DESKTOP.height - HERO_PHONE.height + HERO_DROP_Y;
const HERO_FRAME = {
  width: HERO_PHONE_X + HERO_PHONE.width + HERO_PAD_X,
  height: HERO_PHONE_Y + HERO_PHONE.height + HERO_PAD_Y,
};

function pngSize(file) {
  const bytes = Buffer.isBuffer(file) ? file : readFileSync(file);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("Capture is not a PNG.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function heroComposeHtml(dark) {
  const backdrop = dark
    ? "linear-gradient(155deg, #232733 0%, #12141b 100%)"
    : "linear-gradient(155deg, #f4f7fb 0%, #d5e0ee 100%)";
  const shadow = dark
    ? "0 0 0 1px rgba(255,255,255,0.08), 0 22px 50px rgba(0,0,0,0.55)"
    : "0 0 0 1px rgba(24,32,45,0.12), 0 20px 46px rgba(24,32,45,0.22)";
  const phoneShadow = dark
    ? "0 0 0 1px rgba(255,255,255,0.12), 0 28px 60px rgba(0,0,0,0.62)"
    : "0 0 0 1px rgba(24,32,45,0.16), 0 26px 54px rgba(24,32,45,0.30)";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Clear Chat</title>
<style>
  html, body { margin: 0; background: ${dark ? "#12141b" : "#d5e0ee"}; }
  #frame { width: ${HERO_FRAME.width}px; height: ${HERO_FRAME.height}px; position: relative; background: ${backdrop}; }
  .win { position: absolute; overflow: hidden; line-height: 0; }
  .win img { display: block; width: 100%; height: 100%; }
  #desk { left: ${HERO_PAD_X}px; top: ${HERO_PAD_Y}px; width: ${HERO_DESKTOP.width}px; height: ${HERO_DESKTOP.height}px; border-radius: 18px; box-shadow: ${shadow}; }
  #phone { left: ${HERO_PHONE_X}px; top: ${HERO_PHONE_Y}px; width: ${HERO_PHONE.width}px; height: ${HERO_PHONE.height}px; border-radius: 28px; box-shadow: ${phoneShadow}; }
</style></head>
<body><div id="frame">
  <div class="win" id="desk"><img alt="" src="/raw/desktop.png"></div>
  <div class="win" id="phone"><img alt="" src="/raw/phone.png"></div>
</div></body></html>`;
}

if (HERO_FRAME.width !== 2000) throw new Error(`Hero frame is ${HERO_FRAME.width}px wide, expected 2000.`);

function launchOptions(viewport) {
  return {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true, viewport, deviceScaleFactor: 1, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
    args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
  };
}

async function captureHero(port, rawShots, report) {
  const group = plan.find(item => item.id === "hero");
  const context = await chromium.launchPersistentContext(join(work, "hero-profile"), launchOptions(HERO_DESKTOP));
  const freeze = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } html, body { overflow: hidden !important; }";
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize(HERO_DESKTOP);
      await page.goto(`http://127.0.0.1:${port}/?theme=${theme}&shot=hero-desktop`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("#shot-hero-desktop") || window.__err?.length);
      if (errors.length) throw new Error(errors.join("\n"));
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.addStyleTag({ content: freeze });
      const desk = page.locator("#shot-hero-desktop");
      const deskText = await desk.innerText();
      for (const label of ["cart.ts", "Free shipping", "npm test", "shippingLabel"]) {
        if (!deskText.includes(label)) throw new Error(`Hero desktop is missing ${label}`);
      }
      const deskPath = join(work, `hero-desktop-${theme}.png`);
      await desk.screenshot({ path: deskPath, animations: "disabled" });
      const deskSize = pngSize(deskPath);
      if (deskSize.width !== HERO_DESKTOP.width || deskSize.height !== HERO_DESKTOP.height) {
        throw new Error(`Hero desktop is ${deskSize.width}x${deskSize.height}`);
      }

      await page.setViewportSize(HERO_PHONE);
      await page.goto(`http://127.0.0.1:${port}/?theme=${theme}&shot=hero-phone`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector('[data-presentation="sheet"]') || window.__err?.length);
      if (errors.length) throw new Error(errors.join("\n"));
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.addStyleTag({ content: freeze });
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-presentation="sheet"]');
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return rect.height > 300 && rect.top > 100 && rect.bottom <= window.innerHeight + 1;
      });
      const phoneText = await page.locator('[data-presentation="sheet"]').innerText();
      for (const label of ["cart.ts", "Free shipping", "Updated src/cart.ts."]) {
        if (!phoneText.includes(label)) throw new Error(`Hero phone sheet is missing ${label}`);
      }
      const conversation = await page.locator("#shot-hero-phone").innerText();
      if (!conversation.includes("npm test")) throw new Error("Hero phone conversation is missing folded steps");
      const phonePath = join(work, `hero-phone-${theme}.png`);
      await page.screenshot({ path: phonePath, animations: "disabled" });
      const phoneSize = pngSize(phonePath);
      if (phoneSize.width !== HERO_PHONE.width || phoneSize.height !== HERO_PHONE.height) {
        throw new Error(`Hero phone is ${phoneSize.width}x${phoneSize.height}`);
      }
      rawShots.set("desktop.png", readFileSync(deskPath));
      rawShots.set("phone.png", readFileSync(phonePath));

      await page.setViewportSize(HERO_FRAME);
      await page.goto(`http://127.0.0.1:${port}/compose?theme=${theme}`, { waitUntil: "networkidle" });
      await page.locator("#frame img").nth(1).waitFor();
      await page.evaluate(async () => {
        await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
      });
      const composedPath = join(work, `hero-${theme}.png`);
      await page.locator("#frame").screenshot({ path: composedPath, animations: "disabled" });
      const composed = pngSize(composedPath);
      if (composed.width !== 2000) throw new Error(`Hero export is ${composed.width}px wide`);
      const destination = join(output, group[theme]);
      copyFileSync(composedPath, destination);
      if (statSync(destination).size > 500000) {
        execFileSync("magick", [composedPath, "-strip", "-colors", "256", "-define", "png:compression-level=9", destination]);
      }
      const bytes = statSync(destination).size;
      if (bytes > 500000) throw new Error(`hero-${theme}.png exceeds 500 KB (${bytes} bytes)`);
      report.push({ file: group[theme], fixture: "hero", bytes, text: deskText });
      console.log(`${group[theme]}: ${bytes} bytes (${composed.width}x${composed.height})`);
    }
  } finally {
    await context.close();
  }
}

async function capture() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "showcase.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/ui": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/plugin-client.tsx"),
    },
    nodePaths: [join(__dirname, "node_modules")],
  });
  const html = readFileSync(join(__dirname, "index.html"));
  const rawShots = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/showcase.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    } else if (url.pathname === "/compose") {
      response.setHeader("Content-Type", "text/html");
      response.end(heroComposeHtml(url.searchParams.get("theme") === "dark"));
    } else if (url.pathname.startsWith("/raw/")) {
      const file = rawShots.get(url.pathname.slice("/raw/".length));
      if (!file) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", "image/png");
      response.end(file);
    } else { response.writeHead(404); response.end(); }
  });
  let browser;
  const report = [];
  try {
    let port = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
      if (port !== 9333) break;
      await new Promise(resolve => server.close(resolve));
      port = 0;
    }
    if (!port || port === 9333) throw new Error("Could not bind a capture port other than 9333.");
    const elementPlan = plan.filter(group => group.id !== "hero");
    if (elementPlan.length) browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }), headless: true, viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1.5, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
      args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    const page = browser ? await browser.newPage() : null;
    const errors = [];
    page?.on("pageerror", error => errors.push(error.message));
    // Rasterize the authored SVG fixture in Chrome, entirely in memory.
    if (page) {
      const image = await page.evaluate(async svg => {
        const bitmap = new Image();
        bitmap.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await bitmap.decode();
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        return canvas.toDataURL("image/png");
      }, readFileSync(join(__dirname, "sample-image.svg"), "utf8"));
      await page.addInitScript(image => { window.__showcaseImage = image; }, image);
      // Refuse all external traffic, including accidental URLs in demo content.
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
      });
      for (const theme of ["light", "dark"]) {
        await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`, { waitUntil: "networkidle" });
        await page.waitForFunction(() => document.querySelector("#shot-settings") || window.__err?.length);
        if (errors.length) throw new Error(errors.join("\n"));
        await page.locator("#shot-settings").waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
        });
        // Freeze decorative animations after component effects and fonts settle.
        await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: Iosevka, monospace; font-size: 12px; line-height: 20px; }" });
        if (errors.length) throw new Error(errors.join("\n"));
        for (const group of elementPlan) {
          const { id } = group;
          const shot = page.locator(`#shot-${id}`);
          await shot.waitFor();
          const text = await shot.innerText();
          if (id === "settings") {
            for (const label of [
            "Accent colour", "Interface font", "Code glyphs", "Code font", "Text size",
            "Fold finished steps", "When a collapsed step is pressed", "Fold long output after",
            "Frosted glass", "Pointer glow", "Enhanced prompt bubble", "Selection actions",
            "Assistant markdown", "Markdown style", "Report a problem",
          ]) {
              if (!text.includes(label)) throw new Error(`Settings capture is missing ${label}`);
            }
          }
          const name = `${id}-${theme}.png`;
          const raw = join(work, name);
          await shot.screenshot({ path: raw, animations: "disabled" });
          const destination = join(output, group[theme]);
          copyFileSync(raw, destination);
          // Palette compression keeps large comparison/whole-turn images readable.
          if (statSync(destination).size > 500000) {
            execFileSync("magick", [raw, "-strip", "-colors", "256", "-define", "png:compression-level=9", destination]);
          }
          const bytes = statSync(destination).size;
          if (bytes > 500000) throw new Error(`${name} exceeds 500 KB (${bytes} bytes)`);
          report.push({ file: group[theme], fixture: id, bytes, text });
          console.log(`${group[theme]}: ${bytes} bytes`);
          rmSync(raw);
        }
      }
    }
    if (plan.some(group => group.id === "hero")) await captureHero(port, rawShots, report);
    writeFileSync(join(temp, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
    const browserName = process.env.CHROME_PATH ? process.env.CHROME_PATH : "Chrome channel";
    console.log(`Captured ${report.length} images with ${browserName}.`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}
capture().catch(error => { console.error(error); process.exitCode = 1; });
