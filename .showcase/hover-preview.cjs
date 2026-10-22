"use strict";

const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium, devices } = require("playwright-core");
const { createServer } = require("node:http");
const { createServer: createPortProbe } = require("node:net");
const { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");

const root = resolve(__dirname, "..");
const temp = process.env.KANBAN_TMP;
if (!temp || realpathSync(temp) !== resolve(temp)) throw new Error("KANBAN_TMP must be an existing, absolute task directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const profile = join(temp, "hover-chrome-profile");

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const probe = createPortProbe();
    const available = await new Promise(resolve => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("No authorized Chrome debugging port is available.");
}

async function replay() {
  const bundle = await build({
    absWorkingDir: root, entryPoints: [join(__dirname, "hover-preview.tsx")], bundle: true, write: false,
    jsx: "automatic", platform: "browser", logLevel: "warning", define: { global: "globalThis" },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/react-native": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/plugin-client.tsx"),
    },
    nodePaths: [join(__dirname, "node_modules")],
  });
  console.log(`Browser bundle passed (${bundle.outputFiles[0].contents.length} bytes).`);
  const calls = ["real-hermes-session.json", "real-hermes-hover.json"].flatMap(file =>
    JSON.parse(readFileSync(join(root, "test/fixtures", file), "utf8")).items.filter(item => item.type === "tool_call"));
  const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script id="fixtures" type="application/json">${JSON.stringify(calls).replace(/</g, "\\u003c")}</script><script src="/replay.js"></script>`;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/replay.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/replay.js" ? bundle.outputFiles[0].contents : html);
  });
  let context;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    mkdirSync(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      channel: "chrome", headless: true, viewport: { width: 1440, height: 900 },
      args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    const preview = page.getByTestId("tool-hover-preview");
    const row = page.locator("#middle [data-step='0']").getByTestId("tool-summary-row");
    const capturedRead = page.locator(`#middle [data-step='${calls.length - 1}']`).getByTestId("tool-summary-row");
    const absent = async () => assert.equal(await preview.count(), 0);
    const show = async (target = row) => {
      await page.mouse.move(0, 0);
      await target.hover();
      await preview.waitFor({ state: "visible" });
    };
    for (const theme of ["light", "dark"]) {
      for (const glass of [false, true]) {
        for (const width of [1440, 1024, 820, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${url}?theme=${theme}&glass=${glass}`);
          await row.waitFor();
          await row.hover();
          let geometry;
          if (width >= 1024) {
            await preview.waitFor({ state: "visible" });
            assert.match(await preview.innerText(), /\$ git log/);
            assert.match(await preview.innerText(), /Sample text line 1\./);
            assert.match(await preview.innerText(), /Sample text line 6\./);
            assert.doesNotMatch(await preview.innerText(), /Sample text line 7\./);
            const box = await preview.boundingBox(), anchor = await row.boundingBox();
            geometry = { row: anchor, preview: box };
            assert.ok(box.y + box.height < anchor.y);
            assert.equal(await page.locator("#middle [data-step='0']").getByTestId("tool-card-body").count(), 0);
            await page.mouse.move(0, 0);
            await absent();
            await show(capturedRead);
            const text = await preview.innerText();
            assert.match(text, /\/workspace\/sample\/src\/sample\.js/);
            assert.match(text, /1\|export function sampleTotal\(items\) \{/);
            assert.match(text, /2\|  return items\.reduce/);
            assert.match(text, /3\|\}/);
            assert.doesNotMatch(text, /total lines|```/);
            const style = await preview.evaluate(node => {
              const css = getComputedStyle(node);
              const rgba = color => color.match(/[\d.]+/g).map(Number);
              const background = rgba(css.backgroundColor);
              const alpha = background[3] ?? 1;
              const luminance = channels => channels.slice(0, 3).map(value => {
                const c = value / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
              const bg = luminance(background);
              const ratios = [node, ...node.querySelectorAll("div")].map(element => {
                const fg = luminance(rgba(getComputedStyle(element).color));
                return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
              });
              return { alpha, minContrast: Math.min(...ratios), background: css.backgroundColor,
                border: css.borderTopStyle, shadow: css.boxShadow, clipped: node.scrollHeight > node.clientHeight };
            });
            assert.equal(style.alpha, 1);
            assert.ok(style.minContrast >= 4.5, JSON.stringify(style));
            assert.equal(style.border, "solid");
            assert.notEqual(style.shadow, "none");
            assert.equal(style.clipped, false);
            geometry.readStyle = style;
            const code = await page.locator("#behind-preview pre").boundingBox();
            const readBox = await preview.boundingBox();
            assert.ok(code.y < readBox.y + readBox.height && code.y + code.height > readBox.y,
              "the screenshot must exercise code behind the preview");
            const screenshot = join(temp, `hover-${theme}-${glass ? "glass" : "solid"}-${width}.png`);
            await page.screenshot({ path: screenshot });
            await page.mouse.move(0, 0);
            await absent();
          } else {
            await page.waitForTimeout(400);
            await absent();
          }
          report.push({ theme, glass, width, mouse: true, preview: width >= 1024, delay: "300ms (component timer coverage)", leave: "cleared", geometry });
          console.log(`${theme}, glass ${glass}, width ${width}: hover ${width >= 1024 ? "opaque, multiline, readable and cleared" : "disabled"}.`);
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    for (let index = 0; index < calls.length; index++) {
      const current = page.locator(`#middle [data-step='${index}']`).getByTestId("tool-summary-row");
      await show(current);
      const text = await preview.innerText();
      assert.ok(text.includes("Sample") || text.includes("sample"));
      if (index === 1) assert.match(text, /config\.ts/);
      if (index === 2) assert.match(text, /sampleSetting/);
    }
    await show();
    await page.mouse.wheel(0, 80);
    await preview.waitFor({ state: "detached" });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(100);
    const top = page.locator("#top [data-step='0']").getByTestId("tool-summary-row");
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const x of [24, width / 2, width - 32]) {
        const anchor = await top.boundingBox();
        await page.mouse.move(0, 899);
        await page.mouse.move(x, anchor.y + anchor.height / 2);
        await preview.waitFor({ state: "visible" });
        const box = await preview.boundingBox();
        assert.ok(x < box.x || x > box.x + box.width, "the next row's pointer lane stays clear");
        assert.ok(box.x >= 8 && box.x + box.width <= width - 8);
        const next = page.locator("#top [data-step='1']").getByTestId("tool-summary-row");
        const nextBox = await next.boundingBox();
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-testid='tool-summary-row']")?.getAttribute("data-testid"), { x, y: nextBox.y + nextBox.height / 2 });
        assert.equal(hit, "tool-summary-row");
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await show();
    await row.click({ button: "right" });
    await absent();
    await page.getByTestId("tool-step-menu").waitFor({ state: "visible" });
    assert.equal(await page.locator("#middle [data-step='0']").getByTestId("tool-card-body").count(), 0);
    await page.getByTestId("step-menu-dismiss").click({ position: { x: 8, y: 8 } });
    await show();
    await row.click();
    await absent();
    assert.equal(await page.locator("#middle [data-step='0']").getByTestId("tool-card-body").count(), 1);
    await page.mouse.move(0, 0); await row.hover(); await page.waitForTimeout(400); await absent();
    await row.click();
    await show();
    await page.locator("#middle #replace").evaluate(button => button.click());
    await absent();
    await show();
    assert.match(await preview.innerText(), /config\.ts/);
    await page.locator("#unmount").evaluate(button => button.click());
    await absent();
    assert.equal(errors.length, 0, errors.join("\n"));
    report.push({ desktop: "captured data, top-edge placement, hit testing, scroll, context menu, click, expanded rows, replacement and unmount passed" });

    const browser = context.browser();
    for (const [name, device, width] of [["iOS", "iPhone 13", 390], ["iPadOS", "iPad Pro 11", 1024], ["Android", "Pixel 7", 1440]]) {
      const touch = await browser.newContext({ ...devices[device], viewport: { width, height: 900 } });
      try {
        await touch.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
        const tab = await touch.newPage();
        await tab.goto(url);
        const target = tab.locator("#middle [data-step='0']").getByTestId("tool-summary-row");
        await target.waitFor();
        await target.hover(); await tab.waitForTimeout(400);
        assert.equal(await tab.getByTestId("tool-hover-preview").count(), 0);
        await target.dispatchEvent("pointerenter", { pointerType: "touch" });
        await tab.waitForTimeout(400);
        assert.equal(await tab.getByTestId("tool-hover-preview").count(), 0);
        await target.tap();
        assert.equal(await tab.locator("#middle [data-step='0']").getByTestId("tool-card-body").count(), 1);
        report.push({ device: name, width, hover: "none", touch: "none", tap: "preserved", realDevice: "pending" });
      } finally { await touch.close(); }
    }
    writeFileSync(join(temp, "hover-preview-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
}

replay().catch(error => { console.error(error); process.exitCode = 1; });
