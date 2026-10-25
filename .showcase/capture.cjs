"use strict";

// Build, serve, capture and clean up in one process. Never uses a live host.
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, statSync, realpathSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const { createCapturePlan, withPhoneGroups } = require("./capture-plan.cjs");

const root = resolve(__dirname, "..");
const groups = withPhoneGroups(createCapturePlan(readFileSync(join(root, "README.md"), "utf8")));
const selected = process.env.SHOWCASE_CAPTURE_ONLY;
const plan = selected ? groups.filter(group => group.id === selected) : groups;
if (!plan.length) throw new Error(`Unknown screenshot group: ${selected}`);
const standardPlan = plan.filter(group => group.deviceScaleFactor !== 3);
const phonePlan = plan.filter(group => group.deviceScaleFactor === 3);
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
  const server = createServer((request, response) => {
    if (request.url === "/showcase.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else if (request.url?.startsWith("/?")) {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    } else { response.writeHead(404); response.end(); }
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    if (standardPlan.length) {
      browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
        ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }), headless: true, viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1.5, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
        args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
      });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      // Rasterize the authored SVG fixture in Chrome, entirely in memory.
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
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`, { waitUntil: "networkidle" });
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
        for (const group of standardPlan) {
          const { id } = group;
          const shot = page.locator(`#shot-${id}`);
          await shot.waitFor();
          const text = await shot.innerText();
          if (id === "settings") {
            for (const label of ["Fold finished steps", "Fold long output after", "Report a problem"]) {
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
      await browser.close();
      browser = undefined;
    }
    if (phonePlan.length) await capturePhone(server, report);
    writeFileSync(join(temp, "capture-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`Captured ${report.length} images with Chromium.`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}

function launchOptions(viewport, deviceScaleFactor) {
  return {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true, viewport, deviceScaleFactor, hasTouch: true,
    reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
    args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
  };
}

async function longPressRow(page) {
  const row = page.locator('[data-testid="tool-summary-row"]').filter({ hasText: "$ npm test" });
  await row.waitFor();
  const box = await row.boundingBox();
  if (!box) throw new Error("The phone menu row is not visible.");
  const x = Math.round(box.x + 32);
  const y = Math.round(box.y + box.height / 2);
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }],
  });
  await page.waitForTimeout(800);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

function expectText(id, text) {
  const required = {
    "phone-timeline": ["Search: shippingLabel", "cart.ts:1-5", "cart.ts", "$ npm test", "Ready to review"],
    "phone-details": ["cart.ts", "Free shipping", 'return "Shipping calculated at checkout"'],
    "phone-menu": ["Copy command", "Copy path", "Copy result"],
  };
  for (const label of required[id] ?? []) {
    if (!text.includes(label)) throw new Error(`${id} capture is missing ${label}`);
  }
  if (id === "phone-menu" && text.includes("Open in file manager")) {
    throw new Error("Phone menu includes Open in file manager.");
  }
}

async function capturePhone(server, report) {
  const browser = await chromium.launchPersistentContext(join(work, "chrome-profile-phone"), launchOptions(phonePlan[0].viewport, 3));
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    const port = server.address().port;
    for (const theme of ["light", "dark"]) {
      for (const group of phonePlan) {
        await page.setViewportSize(group.viewport);
        await page.goto(`http://127.0.0.1:${port}/?theme=${theme}&shot=${group.id}`, { waitUntil: "networkidle" });
        const shot = page.locator(`#shot-${group.id}`);
        await shot.waitFor();
        if (errors.length) throw new Error(errors.join("\n"));
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.addStyleTag({ content: "html, body { margin: 0; overflow: hidden; } *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: Iosevka, monospace; font-size: 12px; line-height: 20px; }" });
        if (group.fit === "content") {
          const height = await shot.evaluate(node => Math.ceil(node.getBoundingClientRect().height));
          await page.setViewportSize({ width: group.viewport.width, height });
        }
        if (group.id === "phone-menu") {
          await longPressRow(page);
          await page.waitForFunction(() => {
            const menu = document.querySelector('[data-testid="tool-step-menu"]');
            return Boolean(menu && getComputedStyle(menu).opacity !== "0" && menu.textContent?.includes("Copy result"));
          });
        }
        if (group.id === "phone-details") {
          await page.waitForFunction(() => document.body.innerText.includes("Free shipping"));
        }
        const box = await shot.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        if (Math.round(box.width) !== 390 || Math.round(box.x) !== 0 || Math.round(box.y) !== 0) {
          throw new Error(`${group.id} shot is ${box.width}px at ${box.x},${box.y}`);
        }
        const text = await page.locator("body").innerText();
        expectText(group.id, text);
        const name = `${group.id}-${theme}.png`;
        const raw = join(work, name);
        await page.screenshot({ path: raw, animations: "disabled" });
        const destination = join(output, group[theme]);
        copyFileSync(raw, destination);
        if (statSync(destination).size > 500000) {
          execFileSync("magick", [raw, "-strip", "-colors", "256", "-define", "png:compression-level=9", destination]);
        }
        const bytes = statSync(destination).size;
        if (bytes > 500000) throw new Error(`${name} exceeds 500 KB (${bytes} bytes)`);
        const png = readFileSync(destination);
        const pixelsWide = png.readUInt32BE(16);
        if (pixelsWide !== group.viewport.width * 3) throw new Error(`${name} is ${pixelsWide}px wide`);
        report.push({ file: group[theme], fixture: group.id, bytes, text });
        console.log(`${group[theme]}: ${bytes} bytes, ${pixelsWide}x${png.readUInt32BE(20)}`);
        rmSync(raw);
      }
    }
  } finally {
    await browser.close();
  }
}

capture().catch(error => { console.error(error); process.exitCode = 1; });
