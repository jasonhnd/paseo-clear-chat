"use strict";

// Compare actual components against a Git revision without checking it out or
// connecting to a daemon. Both bundles replay the same sanitized tool sequence.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const { createServer: createSocketServer } = require("node:net");
const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { resolve, join, dirname, relative } = require("node:path");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");

const root = resolve(__dirname, "..");
const baseline = process.argv[2] || "v1.0.1";
const temp = process.env.KANBAN_TMP;
if (!temp || !require("node:path").isAbsolute(temp)) throw new Error("Set KANBAN_TMP to the task temporary directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "tool-rows");
mkdirSync(work, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

async function bundle(revision) {
  return (await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "tool-rows.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/react-native": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/plugin-client.tsx"),
    },
    nodePaths: [join(__dirname, "node_modules")],
    plugins: revision ? [{ name: "baseline-source", setup(builder) {
      builder.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
        const file = relative(root, args.path);
        if (!/^(client|shared)\//.test(file)) return;
        return { contents: git("show", `${revision}:${file}`), loader: file.endsWith("tsx") ? "tsx" : "ts" };
      });
    } }] : [],
  })).outputFiles[0].contents;
}

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const socket = createSocketServer();
    const free = await new Promise(resolve => {
      socket.once("error", () => resolve(false));
      socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("No free Chrome debugging port in the permitted range.");
}

async function measure() {
  const bundles = { baseline: await bundle(baseline), current: await bundle() };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.endsWith(".js")) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundles[url.pathname.slice(1, -3)]);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><style>html,body{margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/${url.searchParams.get("bundle")}.js"></script>`);
    }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
      channel: "chrome", headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC",
      args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--no-first-run"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const report = { baseline: git("rev-parse", baseline).trim(), chrome: browser.browser().version(), fixture: "real-claude-session.json", segment: "28 tool calls, folded, 64px top inset, 16px host gap", measurements: [], edgeClicks: 0 };
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 1024, 820, 744, 743, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const shots = {};
        const readings = {};
        for (const label of ["baseline", "current"]) {
          await page.goto(`http://127.0.0.1:${server.address().port}/?bundle=${label}&theme=${theme}`, { waitUntil: "networkidle" });
          await page.locator('[data-testid="tool-summary-row"]').nth(27).waitFor();
          await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
          await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
          readings[label] = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('[data-testid="tool-summary-row"]')];
            const markers = [...document.querySelectorAll("[data-clearchattool]")];
            const cards = buttons.map(button => button.closest('[data-testid^="tool-card-"]'));
            const rects = cards.map(card => card.getBoundingClientRect());
            return {
              visibleRows: rects.filter(rect => rect.top >= 0 && rect.bottom <= innerHeight).length,
              cardHeight: rects[0].height, footprint: markers[0].getBoundingClientRect().height,
              buttonHeight: buttons[0].getBoundingClientRect().height,
              pitch: rects[1].top - rects[0].top,
              fontSize: parseFloat(getComputedStyle(document.querySelector('[data-testid="tool-summary-text"]')).fontSize),
              hostGaps: [...new Set([...document.querySelectorAll("[data-host-frame]")].map(frame => getComputedStyle(frame).marginBottom))],
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          shots[label] = await page.screenshot({ path: join(work, `${label}-${width}-${theme}.png`) });
          if (label === "current" && width < 744) {
            for (const index of [1, 5, 20]) {
              for (const edge of [1, 27]) {
                const button = page.locator('[data-testid="tool-summary-row"]').nth(index);
                const rect = await button.boundingBox();
                const before = await page.evaluate(() => window.toolRowClicks.length);
                await page.mouse.click(rect.x + rect.width / 2, rect.y + edge);
                await page.waitForFunction(({ before, index }) => window.toolRowClicks.length === before + 1 && window.toolRowClicks.at(-1) === index,
                  { before, index }, { timeout: 5000 }).catch(async error => {
                    throw new Error(`${width}px ${theme}, row ${index}, edge ${edge}: ${error.message}; clicks=${JSON.stringify(await page.evaluate(() => window.toolRowClicks))}`);
                  });
                await button.click();
                await page.waitForFunction(() => !document.querySelector('[data-testid="tool-card-body"]'));
                report.edgeClicks++;
              }
            }
          }
        }
        assert.equal(errors.length, 0, errors.join("\n"));
        const identical = shots.baseline.equals(shots.current);
        if (width >= 744) assert.ok(identical, `${width}px ${theme}: pixels must match`);
        else {
          assert.ok(readings.current.visibleRows > readings.baseline.visibleRows, "phone shows more steps");
          assert.ok(readings.current.buttonHeight >= 28);
          assert.ok(readings.current.fontSize >= 11);
          assert.ok(readings.current.pitch >= readings.current.buttonHeight, "adjacent touch targets do not overlap");
        }
        assert.deepEqual(readings.current.hostGaps, ["16px"]);
        assert.equal(readings.current.overflow, false);
        report.measurements.push({ width, theme, ...readings, identical });
        console.log(JSON.stringify(report.measurements.at(-1)));
      }
    }
    writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`Passed with ${report.edgeClicks} button-edge clicks.`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(join(work, "chrome-profile"), { recursive: true, force: true });
  }
}

measure().catch(error => { console.error(error); process.exitCode = 1; });
