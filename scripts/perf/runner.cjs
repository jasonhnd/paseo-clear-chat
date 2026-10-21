"use strict";

const { analyzeFrames } = require("./metrics.cjs");
const { observeFirstScreen, prepareScroll, sampleScroll } = require("./probes.cjs");

const APP_ORIGIN = "https://app.paseo.sh";

async function connectDaemon(context, options) {
  const page = await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  try {
    // Grant access after opening the dialog, so the app's localhost discovery
    // cannot replace the welcome screen before the supplied daemon is entered.
    await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.getByTestId("welcome-direct-connection").click();
    const daemon = new URL(options.daemon);
    await page.getByTestId("direct-host-input").fill(daemon.hostname);
    await page.getByTestId("direct-port-input").fill(daemon.port || (daemon.protocol === "wss:" ? "443" : "80"));
    if (daemon.protocol === "wss:") await page.getByTestId("direct-ssl-toggle").click();
    await context.grantPermissions(["local-network-access"], { origin: APP_ORIGIN });
    await page.getByTestId("direct-host-submit").click();
    await page.getByTestId("add-host-modal").waitFor({ state: "hidden" });
    const state = await context.storageState();
    const origin = state.origins.find(item => item.origin === APP_ORIGIN);
    const registry = origin?.localStorage.find(item => item.name === "@paseo:daemon-registry");
    const profiles = JSON.parse(registry?.value || "[]");
    const matches = profiles.flatMap(profile => profile.connections.filter(connection => {
      if (connection.type !== "directTcp") return false;
      const url = new URL(`${connection.useTls ? "wss" : "ws"}://${connection.endpoint}`);
      return url.origin === options.daemon;
    }).map(connection => ({ profile, connection })));
    if (matches.length !== 1) throw new Error("Could not identify the supplied daemon in Paseo's browser registry");
    const { profile, connection } = matches[0];
    // Only the requested host and transport enter the measurement context.
    registry.value = JSON.stringify([{ ...profile, connections: [connection], preferredConnectionId: connection.id }]);
    return { storageState: state, serverId: profile.serverId };
  } finally {
    await page.close();
  }
}

async function withTimeout(operation, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collectRuns(context, count, measure) {
  const runs = [];
  for (let index = 0; index < count; index += 1) {
    const page = await context.newPage();
    try {
      runs.push({ run: index + 1, ...await measure(page, index + 1) });
    } finally {
      await page.close();
    }
  }
  return runs;
}

async function measurePage(page, url, options) {
  page.setDefaultTimeout(options.timeoutMs);
  await page.bringToFront();
  await page.addInitScript(observeFirstScreen, { readySelector: options.readySelector });
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.waitForFunction(() => Number.isFinite(window.__clearChatPerf?.firstScreenMs) || window.__clearChatPerf?.error,
      null, { timeout: options.timeoutMs });
    const firstScreen = await page.evaluate(() => ({
      firstScreenMs: window.__clearChatPerf.firstScreenMs,
      error: window.__clearChatPerf.error,
    }));
    if (firstScreen.error) throw new Error(firstScreen.error);
    if (!Number.isFinite(firstScreen.firstScreenMs)) throw new Error("No conversation first-screen reading");
    await page.waitForTimeout(options.settleMs);
    const geometry = await page.evaluate(prepareScroll, options);
    await page.waitForTimeout(options.settleMs);
    const scroll = await withTimeout(() => page.evaluate(sampleScroll, options), options.scrollMs + options.timeoutMs, "Scroll sampling");
    // GC is deliberately outside the first-screen and scroll timing windows.
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    if (!Number.isFinite(heap.usedSize) || heap.usedSize <= 0) throw new Error("No JS heap reading");
    return {
      firstScreenMs: firstScreen.firstScreenMs,
      heapUsedBytes: heap.usedSize,
      ...analyzeFrames(scroll.intervals, options.fps),
      movedPixels: scroll.movedPixels,
      ...geometry,
      finalScrollHeight: scroll.finalScrollHeight,
    };
  } finally {
    await cdp.detach();
  }
}

module.exports = { APP_ORIGIN, connectDaemon, collectRuns, measurePage, withTimeout };
