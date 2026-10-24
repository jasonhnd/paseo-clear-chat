"use strict";

const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const probe = net.createServer();
    const free = await new Promise(resolve => probe.once("error", () => resolve(false)).listen(port, "127.0.0.1", () => probe.close(() => resolve(true))));
    if (free) return port;
  }
  throw new Error("No free Chrome debugging port in 9444–9499.");
}

async function replay() {
  const temp = process.env.KANBAN_TMP;
  assert.ok(temp && temp === resolve(temp), "KANBAN_TMP must be an absolute task directory");
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
  const work = join(temp, "accent-replay");
  mkdirSync(work, { recursive: true });
  const bundle = await build({
    absWorkingDir: resolve(__dirname, ".."), entryPoints: [join(__dirname, "custom-accent.tsx")],
    bundle: true, write: false, jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
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
    response.end(request.url === "/replay.js" ? bundle.outputFiles[0].contents : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div><script src="/replay.js"></script>');
  });
  let browser;
  const results = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
      channel: "chrome", headless: true, reducedMotion: "reduce",
      args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--no-first-run"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === `http://127.0.0.1:${server.address().port}` ? route.continue() : route.abort());
    for (const theme of ["light", "dark"]) for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
      await page.getByLabel("Accent: Host theme", { exact: true }).waitFor();
      await page.getByLabel("Accent: Host theme", { exact: true }).click();
      const original = await page.locator("#accent-preview").getAttribute("data-accent");
      await page.getByLabel("Accent: Custom", { exact: true }).click();
      const input = page.getByLabel("Custom HEX colour", { exact: true });
      await input.fill("#zzzzzz");
      await page.getByLabel("Apply custom accent", { exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "#RGB or #RRGGBB" }).waitFor();
      await input.fill("#0aC");
      await input.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("accent-replay")).preferences.customAccent === "#00aacc");
      const changed = await page.locator("#accent-preview").getAttribute("data-accent");
      assert.notEqual(changed, original, "mounted Markdown receives the custom accent immediately");
      const linkColour = await page.getByRole("link", { name: "Sample link", exact: true }).evaluate(element => getComputedStyle(element).color);
      assert.equal(linkColour, `rgb(${changed.slice(1).match(/../g).map(channel => parseInt(channel, 16)).join(", ")})`, "the mounted Markdown link paints the derived accent");
      assert.equal(await input.inputValue(), "#00aacc");
      assert.equal(await page.getByRole("alert").count(), 0);
      const metrics = await page.evaluate(() => {
        const picker = document.querySelector('[data-testid="custom-accent-picker"]');
        const controls = [...picker.querySelectorAll('input,[role="button"]')].map(element => {
          const rect = element.getBoundingClientRect();
          return { label: element.getAttribute("aria-label"), left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        });
        return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, controls };
      });
      assert.ok(metrics.scrollWidth <= width, `${theme}/${width}: page overflow`);
      for (const control of metrics.controls) {
        assert.ok(control.left >= 0 && control.right <= width, `${control.label}: horizontal overflow`);
        assert.ok(control.height >= 44 && control.width >= 44, `${control.label}: touch target`);
      }
      await page.reload();
      await page.getByLabel("Custom HEX colour", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("Custom HEX colour", { exact: true }).inputValue(), "#00aacc");
      assert.equal(await page.locator("#accent-preview").getAttribute("data-accent"), changed);
      await page.getByLabel("Accent: Jade", { exact: true }).click();
      await page.getByLabel("Accent: Custom", { exact: true }).click();
      assert.equal(await page.getByLabel("Custom HEX colour", { exact: true }).inputValue(), "#00aacc");
      await page.getByLabel("Use accent #e63946", { exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("accent-replay")).preferences.customAccent === "#e63946");
      assert.equal(await page.getByLabel("Custom HEX colour", { exact: true }).inputValue(), "#e63946");
      results.push({ theme, width, accent: changed, ...metrics, invalidHex: "rejected", reload: "retained", swatch: "applied", presetRoundTrip: "retained" });
      console.log(`PASS ${theme} ${width}px: no overflow, 44px targets, invalid HEX, immediate colour, reload, preset round trip, swatch`);
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(temp, "accent-replay-report.json"), JSON.stringify({ bundleBytes: bundle.outputFiles[0].contents.length, results }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}

replay().catch(error => { console.error(error); process.exitCode = 1; });
