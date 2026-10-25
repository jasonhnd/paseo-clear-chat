"use strict";

// Offline browser replay: real Markdown, images and footer, with recorded openers.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { createServer: createSocket } = require("node:net");
const { mkdirSync, writeFileSync, rmSync, realpathSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { replyLinkCases } = require("../test/helpers/reply-link-cases.cjs");

const root = resolve(__dirname, "..");
const temp = process.env.KANBAN_TMP;
if (!temp || realpathSync(temp) !== resolve(temp)) throw new Error("KANBAN_TMP must be an existing absolute task directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "reply-links");
mkdirSync(work, { recursive: true });

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const available = await new Promise(resolve => {
      const socket = createSocket();
      socket.once("error", () => resolve(false));
      socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("No permitted Chrome debugging port is available.");
}

async function replay() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "reply-links.tsx")], bundle: true, write: false,
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
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/replay.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/replay.js" ? bundle.outputFiles[0].contents
      : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/replay.js"></script>');
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
      channel: "chrome", headless: true, hasTouch: true, reducedMotion: "reduce",
      args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__opens = [];
      window.open = (...args) => { window.__opens.push(args); return null; };
    });
    // Raster sample in place of remote images; no external URL is fetched.
    await page.route("**/*", route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin) return route.continue();
      if (request.resourceType() === "image") return route.fulfill({
        contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=", "base64"),
      });
      return route.abort();
    });
    const targets = replyLinkCases.flatMap(sample => sample.targets);
    for (const width of [1440, 1024, 820, 390]) {
      for (const theme of ["light", "dark"]) {
        for (const variant of ["document", "compact", "terminal"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${origin}/?theme=${theme}&variant=${variant}`, { waitUntil: "networkidle" });
          const links = page.getByRole("link");
          await links.nth(targets.length - 1).waitFor();
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map(image => image.decode()));
          });
          assert.equal(await links.count(), targets.length);
          const measured = [];
          for (let index = 0; index < targets.length; index++) {
            const link = links.nth(index);
            await link.scrollIntoViewIfNeeded();
            const rects = await link.evaluate(node => [...node.getClientRects()]
              .filter(rect => rect.width > 0 && rect.height > 0)
              .map(rect => {
                const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
                const insetX = Math.min(2, rect.width / 4), insetY = Math.min(2, rect.height / 4);
                const points = [rect.left + insetX, x, rect.right - insetX]
                  .flatMap(px => [rect.top + insetY, y, rect.bottom - insetY].map(py => [px, py]));
                return { x, y, width: rect.width, height: rect.height,
                  visible: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
                  unobstructed: points.every(([px, py]) => {
                    const hit = document.elementFromPoint(px, py);
                    return hit === node || node.contains(hit);
                  }) };
              }));
            assert.ok(rects.length > 0, "link has a measurable line box");
            assert.ok(rects.every(rect => rect.visible && rect.unobstructed), `${width}/${theme}/${variant}: link ${index} is clipped or covered`);
            const { x, y } = rects[0];
            if (width < 1024) await page.touchscreen.tap(x, y);
            else await page.mouse.click(x, y);
            assert.deepEqual(await page.evaluate(() => window.__opens),
              targets.slice(0, index + 1).map(url => [url, "_blank", "noopener,noreferrer"]), "one press calls the exact browser opener once");
            measured.push({ target: targets[index], rects });
          }
          assert.deepEqual(errors, []);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
          report.push({ width, theme, variant, input: width < 1024 ? "touch" : "mouse", links: measured });
          console.log(`${width}px ${theme} ${variant}: ${targets.length} links opened; all line boxes visible and unobstructed`);
        }
      }
    }
    writeFileSync(join(temp, "reply-links-report.json"), JSON.stringify({ browser: browser.browser().version(), cases: report }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}

replay().catch(error => { console.error(error); process.exitCode = 1; });
