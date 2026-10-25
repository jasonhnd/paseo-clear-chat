"use strict";

// Capture the step-detail popover and side panel from synthetic host fixtures.
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const { readFileSync, mkdirSync, rmSync, existsSync, readdirSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");

const root = resolve(__dirname, "..");
const temp = join(__dirname, ".capture-ipad-temp");
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });
function playwrightChrome() {
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const cache = join(process.env.HOME || "", ".cache", "ms-playwright");
  if (!existsSync(cache)) return expected;
  const found = readdirSync(cache)
    .filter(name => name.startsWith("chromium-"))
    .map(name => join(cache, name, "chrome-linux64", "chrome"))
    .find(path => existsSync(path));
  return found || expected;
}
const chromePath = process.env.CHROME_PATH || playwrightChrome();
if (/msedge|edge/i.test(chromePath)) throw new Error("Refusing to launch Microsoft Edge.");
if (!existsSync(chromePath)) throw new Error(`Chromium not found at ${chromePath}`);

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
      executablePath: chromePath,
      headless: process.env.INSTABOX_HEADLESS === "1",
      viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2,
      locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce",
      args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    const lines = ["Check the shipping rule", "Search: shippingLabel", "cart.ts:1-5", "cart.ts", "$ npm test", "$ git diff --stat", "Ready to review", "Free shipping"];
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
        await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
        await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}&capture=ipad`, { waitUntil: "networkidle" });
        const background = await page.evaluate(() => getComputedStyle(document.querySelector("#root").firstElementChild).backgroundColor);
        if (background !== (theme === "light" ? "rgb(248, 250, 252)" : "rgb(15, 15, 17)")) throw new Error(`Unexpected ${theme} theme for ${shot.id}: ${background}`);
        const row = page.getByRole("button", { name: "View details: cart.ts · +3 −1" });
        await row.waitFor();
        const fonts = await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([
            document.fonts.load('600 12px "OMP Inter"'),
            document.fonts.load('400 12px "OMP Iosevka"'),
            document.fonts.load('400 12px "OMP Iosevka Code"'),
          ]);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const family = selector => {
            const node = document.querySelector(selector);
            return node ? getComputedStyle(node).fontFamily : "";
          };
          return {
            ui: document.fonts.check('600 12px "OMP Inter"'),
            mono: document.fonts.check('400 12px "OMP Iosevka"'),
            code: document.fonts.check('400 12px "OMP Iosevka Code"'),
            row: family('[data-testid="tool-summary-text"]'),
          };
        });
        if (!fonts.ui || !fonts.mono || !fonts.code) throw new Error(`Bundled fonts did not load for ${shot.id} ${theme}: ${JSON.stringify(fonts)}`);
        if (!fonts.row.includes("OMP Inter")) throw new Error(`Tool row is not using Inter for ${shot.id} ${theme}: ${fonts.row}`);
        await row.click();
        await page.mouse.move(4, 4);
        if (shot.id === "ipad-side") await page.getByTestId("preview-host-panel").waitFor();
        await page.getByTestId("step-detail-scroll").waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.addStyleTag({ content: '[data-testid="preview-host-close"]{display:none!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
        const text = await page.locator("body").innerText();
        for (const line of lines) if (!text.includes(line)) throw new Error(`${shot.id} ${theme} is missing “${line}”`);
        if (text.includes("Close host panel") || await page.getByTestId("preview-host-close").count()) throw new Error(`${shot.id} ${theme} shows the harness close button`);
        const codeFont = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="step-detail-input"]')).fontFamily);
        if (!codeFont.includes("Iosevka")) throw new Error(`Detail code is not Iosevka for ${shot.id} ${theme}: ${codeFont}`);
        const top = await page.evaluate(() => document.querySelector('[data-testid="preview-chat"]').getBoundingClientRect().top);
        if (top > 1) throw new Error(`${shot.id} ${theme} leaves a ${top}px harness gap above the conversation`);
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
