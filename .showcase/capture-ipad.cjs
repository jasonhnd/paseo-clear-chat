"use strict";

// Capture the step-detail popover and side panel from synthetic host fixtures.
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { readFileSync, mkdirSync, rmSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");

const root = resolve(__dirname, "..");
const temp = join(__dirname, ".capture-ipad-temp");
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });
const sample = {
  name: "bash", status: "completed", callId: "demo-step-test",
  detail: {
    type: "shell", command: "npm test", durationMs: 1250, exitCode: 0,
    input: { command: "npm test", cwd: "/workspace/demo-shop" },
    output: "PASS test/cart.test.ts\n  below $50: standard shipping\n  exactly $50: free shipping\n  above $50: free shipping\n\n12 tests passed",
  },
};

async function capture() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "step-details.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/ui": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/step-detail-client.ts"),
    },
    nodePaths: [join(__dirname, "node_modules")],
  });
  const html = readFileSync(join(__dirname, "index.html"));
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/showcase.js")) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    }
  });
  let browser;
  try {
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    browser = await chromium.launchPersistentContext(join(temp, "chrome-profile"), {
      executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
      headless: process.env.INSTABOX_HEADLESS === "1",
      viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2,
      locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce",
      args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    for (const shot of [
      { id: "ipad-popover", width: 834, height: 1194 },
      { id: "ipad-side", width: 1194, height: 834 },
    ]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: shot.width, height: shot.height });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(value => { window.__stepDetailSamples = [value]; }, sample);
        await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`, { waitUntil: "networkidle" });
        const background = await page.evaluate(() => getComputedStyle(document.querySelector("#root").firstElementChild).backgroundColor);
        if (background !== (theme === "light" ? "rgb(248, 250, 252)" : "rgb(15, 15, 17)")) throw new Error(`Unexpected ${theme} theme for ${shot.id}: ${background}`);
        const row = page.getByTestId("tool-summary-row");
        await row.waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await row.click();
        if (shot.id === "ipad-side") await page.getByTestId("preview-host-panel").waitFor();
        else await page.getByTestId("step-detail-scroll").waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
        if (errors.length) throw new Error(errors.join("\n"));
        const file = join(root, "docs", "images", `${shot.id}-${theme}.png`);
        await page.screenshot({ path: file, animations: "disabled" });
        console.log(`${file} (${shot.width}x${shot.height} CSS px @2x)`);
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
    rmSync(temp, { recursive: true, force: true });
  }
}

capture().catch(error => { console.error(error); process.exitCode = 1; });
