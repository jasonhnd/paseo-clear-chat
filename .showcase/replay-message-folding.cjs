"use strict";

// Offline component replay. Only fictional fixture content reaches the browser.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");

const root = resolve(__dirname, "..");
const temp = process.env.KANBAN_TMP;
if (!temp) throw new Error("Set KANBAN_TMP to the authorized task directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "message-folding-replay");
mkdirSync(work, { recursive: true });

const source = Array.from({ length: 31 }, (_, i) => `sample_line_${i + 1};`).join("\n");
const reply = `Before the code.\n\n\`\`\`text\n${source}\n\`\`\`\n\nAfter the code.`;
const fixture = require("../test/fixtures/real-hermes-reply-footer.json");
const prompt = { ...fixture[0].item, text: source };
assert.deepEqual(Object.keys(prompt).sort(), ["messageId", "text", "type"]);
const hostShim = `
  const callbacks = new Map();
  const agent = { cwd: "/workspace/demo", status: "idle", updatedAt: "2026-01-01T12:00:10Z" };
  const handle = { refresh: async () => ({ agent }), timeline: { refetch: async () => ({ entries: [], hasNewer: false }) } };
  const paseo = { agents: { ref: () => handle } };
  export async function replayRpc(contract, input) {
    const group = contract.name.includes("tool-expansion") ? "expansion" : "presentation";
    if (!contract.name.startsWith("settings.")) throw new Error("No live RPC in offline replay");
    const key = "clear-chat/offline-folding/" + group;
    const saved = JSON.parse(localStorage.getItem(key) || "null") || {
      revision: 0, values: group === "expansion" ? { entries: {} } : { preferences: {}, legacyMigrated: true }
    };
    if (contract.name.endsWith(".read")) return { status: "ready", revision: String(saved.revision), values: saved.values };
    if (input.revision !== String(saved.revision)) return { status: "conflict", error: "Changed" };
    localStorage.setItem(key, JSON.stringify({ revision: saved.revision + 1, values: input.values }));
    return { status: "saved", values: input.values };
  }
  export function useRpc(contract) {
    if (!callbacks.has(contract.name)) callbacks.set(contract.name, input => replayRpc(contract, input));
    return callbacks.get(contract.name);
  }
  export function useAgent(_id, selector) { return selector(agent); }
  export function usePaseo() { return paseo; }
`;

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const free = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("No free Chrome debugging port in the authorized range.");
}

async function main() {
  const bundle = await build({
    absWorkingDir: root, bundle: true, write: false, jsx: "automatic", platform: "browser", logLevel: "warning",
    define: { global: "globalThis" }, nodePaths: [join(__dirname, "node_modules")],
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import contribute from "./index.client";
      import { PHONE_MAX } from "./client/breakpoints";
      import { initializeEnhancerPreferences, updateEnhancerPreferences } from "./client/preferences";
      import { replayRpc } from "@getpaseo/plugin/client";
      const colors = {
        surface0: "#f8fafc", surface1: "#ffffff", surface2: "#edf0f5", border: "#d5dbe5",
        foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff",
        statusSuccess: "#1f8a5b", statusWarning: "#a36a00", statusDanger: "#cf3340",
      };
      const transformers = new Map(), renderers = new Map();
      contribute({
        rpc: replayRpc,
        addSettingsScreen: () => () => {},
        addTimelineTransformer: value => { transformers.set(value.query.itemType, value); return () => {}; },
        addTimelineRenderer: value => { renderers.set(value.kind, value); return () => {}; },
      });
      const input = ${JSON.stringify(prompt)};
      window.__promptInput = input;
      function timelineItem(item, timestamp) {
        const result = transformers.get(item.type).transform({ item, phase: "complete" });
        if (!result) throw new Error("Captured text-only item was left untransformed");
        const plugin = result.items[0], renderer = renderers.get(plugin.kind);
        const data = renderer.schema.parse(plugin.data);
        if (item.type === "user_message") window.__promptPayload = data;
        return React.createElement(renderer.Component, {
          host: { id: "offline-host" }, agentId: "offline-agent", timestamp: new Date(timestamp),
          theme: { colors }, layout: { platform: "web", compact: window.innerWidth <= PHONE_MAX },
          item: { ...plugin, data },
        });
      }
      window.__copies = [];
      window.__setLimit = limit => updateEnhancerPreferences({ foldLongOutputAfter: limit });
      initializeEnhancerPreferences(replayRpc).then(() => {
        createRoot(document.getElementById("root")).render(
          <main style={{ width: "100%", maxWidth: 1000, margin: "0 auto", padding: 12, boxSizing: "border-box" }}>
            <section id="prompt">{timelineItem(input, ${JSON.stringify(fixture[0].timestamp)})}</section>
            <section id="reply">{timelineItem(${JSON.stringify({ ...fixture.at(-1).item, text: reply })}, ${JSON.stringify(fixture.at(-1).timestamp)})}</section>
          </main>
        );
      });
    ` },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
    },
    plugins: [{ name: "offline-host", setup(builder) {
      builder.onResolve({ filter: /^@getpaseo\/plugin\/client(?:\/react-native)?$/ }, args => ({ path: args.path, namespace: "offline" }));
      builder.onLoad({ filter: /.*/, namespace: "offline" }, args => ({
        loader: "tsx", resolveDir: __dirname,
        contents: args.path.endsWith("react-native") ? `
          export * from "./shims/plugin-react-native";
          export async function copyText(text) { window.__copies.push(text); }
        ` : hostShim,
      }));
    } }],
  });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/replay.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/replay.js" ? bundle.outputFiles[0].contents :
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}section{display:flex;flex-direction:column;margin-bottom:16px}</style></head><body><div id="root"></div><script src="/replay.js"></script></body></html>');
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = await debugPort();
    browser = await chromium.launchPersistentContext(join(work, "chrome-profile"), {
      channel: "chrome", headless: true, reducedMotion: "reduce",
      args: [`--remote-debugging-port=${port}`, "--disable-background-networking", "--no-first-run"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    const address = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(address) ? route.continue() : route.abort());
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(address);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      const measurements = {};
      await page.waitForFunction(() => window.__promptPayload);
      assert.deepEqual(await page.evaluate(() => Object.keys(window.__promptInput).sort()), ["messageId", "text", "type"]);
      assert.equal(await page.evaluate(() => "imageCount" in window.__promptPayload || "images" in window.__promptPayload), false);
      for (const [section, copyLabel] of [["prompt", "Copy prompt"], ["reply", "Copy code"]]) {
        const content = page.locator(`#${section}`);
        await content.getByRole("button", { name: "Show all 31 lines", exact: true }).waitFor();
        assert.equal((await content.innerText()).includes("sample_line_16;"), false);
        const closed = await content.boundingBox();
        const button = content.getByRole("button", { name: "Show all 31 lines", exact: true });
        const target = await button.boundingBox();
        assert.ok(target.height >= 44);
        await content.getByRole("button", { name: copyLabel, exact: true }).click();
        assert.equal(await page.evaluate(() => window.__copies.at(-1)), source);
        await button.click();
        await content.getByRole("button", { name: "Show fewer lines", exact: true }).waitFor();
        assert.ok((await content.innerText()).includes("sample_line_31;"));
        const opened = await content.boundingBox();
        assert.ok(opened.height > closed.height);
        measurements[section] = { collapsedHeight: closed.height, expandedHeight: opened.height, buttonHeight: target.height };
      }
      // Both choices must reach storage before a hard page reload.
      await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem("clear-chat/offline-folding/expansion"))?.values.entries ?? {}).filter(entry => entry.expanded).length === 2);
      await page.reload();
      for (const section of ["prompt", "reply"]) {
        const content = page.locator(`#${section}`);
        await content.getByRole("button", { name: "Show fewer lines", exact: true }).waitFor();
        assert.ok((await content.innerText()).includes("sample_line_31;"));
        await content.getByRole("button", { name: "Show fewer lines", exact: true }).click();
        assert.equal((await content.innerText()).includes("sample_line_16;"), false);
      }
      await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem("clear-chat/offline-folding/expansion"))?.values.entries ?? {}).filter(entry => entry.expanded === false).length === 2);
      await page.reload();
      for (const section of ["prompt", "reply"]) {
        await page.locator(`#${section}`).getByRole("button", { name: "Show all 31 lines", exact: true }).waitFor();
        assert.equal((await page.locator(`#${section}`).innerText()).includes("sample_line_16;"), false);
      }
      for (const limit of [10, 30, "never", 15]) {
        await page.evaluate(limit => window.__setLimit(limit), limit);
        for (const section of ["prompt", "reply"]) {
          const content = page.locator(`#${section}`);
          assert.equal((await content.innerText()).includes("sample_line_31;"), limit === "never");
          if (limit !== "never") {
            assert.ok((await content.innerText()).includes(`sample_line_${limit};`));
            assert.equal((await content.innerText()).includes(`sample_line_${limit + 1};`), false);
          }
        }
      }
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(scrollWidth <= width, `Overflow at ${width}px: ${scrollWidth}`);
      await page.screenshot({ path: join(work, `${width}.png`), fullPage: true });
      report.push({ width, scrollWidth, ...measurements, promptKeys: ["messageId", "text", "type"], pipeline: "registered transformer/schema/live renderer", copy: "full source", reload: "expansion and collapse restored", limits: [10, 15, 30, "never"], debugPort: port });
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(temp, "message-folding-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(join(work, "chrome-profile"), { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
