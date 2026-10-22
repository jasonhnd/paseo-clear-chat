"use strict";

// Offline component replay: no live Paseo host or conversation is accessed.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { createServer } = require("node:http");
const net = require("node:net");
const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");
const { chromium } = require("playwright-core");
const { install } = require("./install.cjs");
const root = resolve(__dirname, "..");
const showcaseRequire = createRequire(join(root, ".showcase/package.json"));
const { build } = showcaseRequire("esbuild");

async function debugPort() {
  for (let port = 9444; port <= 9499; port++) {
    const probe = net.createServer();
    if (await new Promise(resolve => probe.once("error", () => resolve(false)).listen(port, "127.0.0.1", () => resolve(true)))) {
      await new Promise(resolve => probe.close(resolve));
      return port;
    }
  }
  throw new Error("No free Chrome debugging port in the permitted range.");
}

async function replay() {
  assert.ok(process.env.KANBAN_TMP, "Set KANBAN_TMP to the task temporary directory.");
  const work = resolve(process.env.KANBAN_TMP);
  mkdirSync(work, { recursive: true });
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = work;

  await Promise.all([
    build({ absWorkingDir: root, entryPoints: ["index.server.ts"], platform: "node", bundle: true, write: false, external: ["@getpaseo/plugin", "@getpaseo/plugin/*", "zod"] }),
    build({ absWorkingDir: root, entryPoints: ["index.client.tsx"], platform: "browser", bundle: true, write: false, jsx: "automatic", external: ["react", "react/jsx-runtime", "react-native", "@tanstack/react-query", "zod", "@getpaseo/plugin", "@getpaseo/plugin/*"] }),
  ]);

  const installMessages = [];
  install({ run: () => ({ status: 1 }), report: text => installMessages.push(text) });
  install({ run: () => ({ status: 0 }), resolveDependency: () => { throw new Error(); }, report: text => installMessages.push(text) });
  const bundle = await build({
    absWorkingDir: root, bundle: true, write: false, platform: "browser", jsx: "automatic",
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { View } from "react-native";
      import { SettingsFailureNotice } from "./client/components/settings-failure-notice";
      import { STARTUP_MESSAGES } from "./shared/startup-diagnostics";
      const tokens = { foreground: "#eeeeee", borderSubtle: "#555555", fontUi: "sans-serif" };
      createRoot(document.getElementById("root")).render(
        <View style={{ padding: 16, gap: 12, width: "100%" }}>
          {[...Object.values(STARTUP_MESSAGES), ...${JSON.stringify(installMessages)}].map((message, index) =>
            <SettingsFailureNotice key={index} message={message} tokens={tokens} onRetry={() => { window.retries = (window.retries || 0) + 1; }} />)}
        </View>);
    ` },
    alias: {
      react: dirname(showcaseRequire.resolve("react/package.json")),
      "react-dom/client": showcaseRequire.resolve("react-dom/client"),
      "react-native": showcaseRequire.resolve("react-native-web"),
    },
  });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/replay.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/replay.js" ? bundle.outputFiles[0].contents : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#111}</style><div id="root"></div><script src="/replay.js"></script>');
  });
  const profile = join(work, "chrome-profile");
  const report = [];
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launchPersistentContext(profile, {
      channel: "chrome", headless: true,
      args: [`--remote-debugging-port=${await debugPort()}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    for (const platform of ["web", "ios", "ipados", "android"]) {
      const page = await browser.newPage();
      const emulation = await browser.newCDPSession(page);
      await emulation.send("Emulation.setTouchEmulationEnabled", { enabled: platform !== "web" });
      await emulation.send("Emulation.setUserAgentOverride", {
        userAgent: platform === "web" ? "ClearChatComponentReplay" : platform === "android"
          ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"
          : `Mozilla/5.0 (${platform === "ipados" ? "iPad" : "iPhone"}; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1`,
      });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      for (const width of [1440, 1024, 820, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await emulation.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: platform !== "web" });
        await page.goto(origin);
        await page.getByRole("alert").first().waitFor();
        const bounds = await page.getByRole("alert").evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height, clipped: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight, parentLeft: parent.left, parentRight: parent.right };
        }));
        assert.equal(bounds.length, 9);
        assert.ok(bounds.every(box => box.left >= 0 && box.right <= width && box.parentLeft >= 0 && box.parentRight <= width && box.height > 0 && !box.clipped), JSON.stringify({ platform, width, bounds }));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.getByRole("button", { name: "Retry", exact: true }).first().click();
        assert.equal(await page.evaluate(() => window.retries), 1);
        assert.deepEqual(errors, []);
        report.push({ platform, width, renderer: "React Native Web component replay in Google Chrome", messages: bounds.length, overflow: false, clipped: false, retry: "passed", nativeDevice: platform === "web" ? "not applicable" : "pending" });
      }
      await page.close();
    }
    writeFileSync(join(work, "install-failure-replay.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ builds: ["server", "client"], cases: report.length, messagesPerCase: 9, overflow: false, clipped: false, nativeDevices: "pending" }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
}

replay().catch(error => { console.error(error); process.exitCode = 1; });
