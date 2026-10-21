#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs, summarizeRuns, renderMarkdown } = require("./metrics.cjs");
const { APP_ORIGIN, connectDaemon, collectRuns, measurePage } = require("./runner.cjs");

const HELP = `Usage: node scripts/perf/measure.cjs --daemon <origin> --agent <id> --label <text> --output <prefix>

Required:
  --daemon <origin>       Explicit HTTP(S) or WS(S) daemon address
  --agent <id>            Existing long conversation's agent ID
  --label <text>          Human-supplied plugin state; no plugin changes are made
  --output <prefix>       Write <prefix>.json and <prefix>.md (keep outside tracked files)

Options:
  --runs <N>             Repetitions, each in a new tab (default: 3)
  --scroll-ms <ms>       Scroll sampling duration (default: 5000)
  --settle-ms <ms>       Wait before scroll setup and again before sampling (default: 1000)
  --timeout-ms <ms>      Navigation and readiness timeout (default: 60000)
  --fps <N>              Display refresh budget for dropped-frame estimates (default: 60)
  --width <px>           Viewport width (default: 1440)
  --height <px>          Viewport height (default: 900)
  --ready-selector <css> Override the conversation content marker
  --scroll-selector <css> Override automatic timeline scroller selection
  --headless             Run installed Google Chrome without a window
  --help                 Show this help

See scripts/perf/README.md for metric definitions and controlled comparisons.
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  // Loading this dependency is intentionally deferred: help and unit tests need no browser.
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: options.headless });
  try {
    const contextOptions = { viewport: { width: options.width, height: options.height }, serviceWorkers: "block" };
    const setup = await browser.newContext(contextOptions);
    let connection;
    try {
      process.stderr.write("Connecting the supplied daemon in a temporary setup tab...\n");
      connection = await connectDaemon(setup, options);
    } finally {
      await setup.close();
    }
    const context = await browser.newContext({ ...contextOptions, storageState: connection.storageState });
    try {
      await context.grantPermissions(["local-network-access"], { origin: APP_ORIGIN });
      const url = `${APP_ORIGIN}/h/${encodeURIComponent(connection.serverId)}/agent/${encodeURIComponent(options.agent)}`;
      const runs = await collectRuns(context, options.runs, async (page, run) => {
        process.stderr.write(`Measuring sample ${run}/${options.runs} in a new tab...\n`);
        return measurePage(page, url, options);
      });
      const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        label: options.label,
        daemon: options.daemon,
        agent: options.agent,
        browser: { name: "Google Chrome", version: browser.version(), headless: options.headless },
        environment: { platform: process.platform, arch: process.arch, node: process.version },
        settings: Object.fromEntries(["runs", "width", "height", "fps", "scrollMs", "settleMs", "timeoutMs", "readySelector", "scrollSelector"]
          .map(key => [key, options[key] ?? null])),
        runs,
        median: summarizeRuns(runs),
      };
      const markdown = renderMarkdown(report);
      const prefix = path.resolve(options.output);
      await fs.mkdir(path.dirname(prefix), { recursive: true });
      await fs.writeFile(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await fs.writeFile(`${prefix}.md`, markdown);
      process.stdout.write(markdown);
      process.stderr.write("JSON and Markdown reports written. No conversation text was recorded.\n");
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Performance measurement failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
