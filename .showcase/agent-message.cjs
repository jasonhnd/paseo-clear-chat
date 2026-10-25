"use strict";

// Offline browser replay through the registered transformer, schema and renderer.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const { createServer } = require("node:http");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { resolve, join, dirname, relative } = require("node:path");
const entries = require("../test/fixtures/real-claude-agent-message.json");
const root = resolve(__dirname, "..");
const temp = process.env.KANBAN_TMP;
if (!temp) throw new Error("Set KANBAN_TMP to the authorized task directory.");
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
const work = join(temp, "agent-message-browser");
mkdirSync(work, { recursive: true });

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const free = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("No authorized Chrome debugging port is available.");
}

async function bundle(revision) {
  return (await build({
    absWorkingDir: root, bundle: true, write: false, jsx: "automatic", platform: "browser",
    logLevel: "warning", define: { global: "globalThis" }, nodePaths: [join(__dirname, "node_modules")],
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import contribute from "./index.client";
      import { initializeEnhancerPreferences } from "./client/preferences";
      const transformers = new Map(), renderers = new Map();
      const rpc = async () => ({ status: "ready", revision: "0", values: {
        preferences: { foldFinishedSteps: false, collapsedStepAction: "inline" }, legacyMigrated: true,
      } });
      contribute({ rpc, addSettingsScreen: () => () => {}, addAgentPanel: () => () => {},
        addTimelineTransformer: value => { transformers.set(value.query.itemType, value); return () => {}; },
        addTimelineRenderer: value => { renderers.set(value.kind, value); return () => {}; },
      });
      const colors = { surface0: "#f8fafc", surface1: "#fff", surface2: "#edf0f5", border: "#d5dbe5",
        foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#fff",
        statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642" };
      initializeEnhancerPreferences(rpc).then(() => {
        createRoot(document.getElementById("root")).render(<main style={{ padding: 12 }}>
          {${JSON.stringify(entries)}.map(({ item, timestamp }, index) => {
            const source = item.type === "tool_call" ? Object.freeze({ type: item.type,
              callId: item.callId, name: item.name, detail: item.detail, status: item.status, error: item.error }) : item;
            const transformed = transformers.get(item.type).transform({ item: source, phase: "complete" });
            return transformed.items.map((part, subindex) => {
              const renderer = renderers.get(part.kind), Component = renderer.Component;
              return <section key={index + ":" + subindex} data-index={index} style={{ marginBottom: 16 }}>
                <Component agentId="sample-agent" host={{ id: "sample-host" }} timestamp={new Date(timestamp)}
                  theme={{ colors }} layout={{ compact: innerWidth < 744, platform: "web" }}
                  item={{ ...part, data: renderer.schema.parse(part.data) }} />
              </section>;
            });
          })}
        </main>);
      });
    ` },
    alias: {
      react: dirname(require.resolve("react/package.json")),
      "react-dom/client": require.resolve("react-dom/client"),
      "react-native": require.resolve("react-native-web"),
      "@getpaseo/plugin/client/ui": join(__dirname, "shims/plugin-react-native.tsx"),
      "@getpaseo/plugin/client": join(__dirname, "shims/agent-message-client.ts"),
    },
    plugins: revision ? [{ name: "baseline", setup(builder) {
      builder.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
        if (args.path.includes("node_modules")) return;
        try {
          const contents = execFileSync("git", ["show", `${revision}:${relative(root, args.path)}`], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString();
          return { contents, loader: args.path.endsWith("tsx") ? "tsx" : "ts" };
        } catch { return; }
      });
    } }] : [],
  })).outputFiles[0].contents;
}

async function replay() {
  const baseline = process.argv[2];
  if (!baseline) throw new Error("Pass the pre-fix Git revision.");
  const bundles = { before: await bundle(baseline), after: await bundle() };
  const server = createServer((request, response) => {
    const mode = request.url.startsWith("/before") ? "before" : "after";
    response.setHeader("Content-Type", request.url.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(request.url.endsWith(".js") ? bundles[mode]
      : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="root"></div><script src="/${mode}.js"></script>`);
  });
  let browser;
  const report = [];
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const port = await debugPort();
    browser = await chromium.launchPersistentContext(join(work, "profile"), {
      channel: "chrome", headless: true, reducedMotion: "reduce",
      args: [`--remote-debugging-port=${port}`, "--disable-background-networking", "--no-first-run"],
    });
    browser.setDefaultTimeout(15000);
    for (const width of [1440, 1024, 820, 390]) {
      const results = {};
      for (const mode of ["before", "after"]) {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(`${origin}/${mode}`);
        await page.locator("section").last().waitFor();
        await page.waitForFunction(() => document.querySelector('[data-index="1"]').textContent.includes("sample-coordinator"));
        const title = await page.locator('[data-index="1"] [data-testid="tool-summary-text"]').innerText();
        const text = await page.locator("main").innerText();
        assert.equal(text.split(entries[1].item.agentMessage.text).length - 1, 1);
        assert.equal(text.split(entries[0].item.text).length - 1, 1);
        if (mode === "before") assert.equal(title, "Message received · sample-coordinator");
        else {
          assert.equal(title, "Message received");
          assert.ok(!text.includes("agent_message"));
          assert.ok(text.includes("Sender: sample-coordinator"));
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        results[mode] = { title, otherRows: await page.locator('section:not([data-index="1"])').allInnerTexts() };
        await page.screenshot({ path: join(temp, `agent-message-${mode}-${width}.png`), fullPage: true });
        await page.close();
      }
      assert.deepEqual(results.after.otherRows, results.before.otherRows, "other timeline items are unchanged");
      report.push({ width, before: results.before.title, after: results.after.title, promptCopies: 1,
        deliveryCopies: 1, otherRowsUnchanged: true, overflow: false, pageErrors: 0, debugPort: port });
    }
    writeFileSync(join(temp, "agent-message-browser-report.json"), JSON.stringify({ browser: browser.browser().version(), cases: report }, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}
replay().catch(error => { console.error(error); process.exitCode = 1; });
