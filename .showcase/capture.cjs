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
// iPad layouts are captured by capture-ipad.cjs at their own viewport and scale.
const groups = createCapturePlan(readFileSync(join(root, "README.md"), "utf8")).filter(group => !group.id.startsWith("ipad-"));
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
      for (const group of plan) {
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
