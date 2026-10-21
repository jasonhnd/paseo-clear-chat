"use strict";

const DEFAULTS = Object.freeze({
  runs: 3,
  scrollMs: 5000,
  settleMs: 1000,
  timeoutMs: 60000,
  fps: 60,
  width: 1440,
  height: 900,
  headless: false,
});

const NUMBERS = {
  runs: [1, 100],
  scrollMs: [250, 120000],
  settleMs: [0, 60000],
  timeoutMs: [1000, 300000],
  fps: [1, 240],
  width: [320, 7680],
  height: [240, 4320],
};

const OPTIONS = {
  "--daemon": "daemon",
  "--agent": "agent",
  "--label": "label",
  "--output": "output",
  "--runs": "runs",
  "--scroll-ms": "scrollMs",
  "--settle-ms": "settleMs",
  "--timeout-ms": "timeoutMs",
  "--fps": "fps",
  "--width": "width",
  "--height": "height",
  "--ready-selector": "readySelector",
  "--scroll-selector": "scrollSelector",
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--help") { options.help = true; continue; }
    if (flag === "--headless") { options.headless = true; continue; }
    const key = OPTIONS[flag];
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--") || !value.trim()) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (NUMBERS[key]) {
      const [min, max] = NUMBERS[key];
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
        throw new Error(`${flag} must be an integer from ${min} to ${max}`);
      }
      options[key] = number;
    } else {
      options[key] = value.trim();
    }
  }
  if (options.help) return options;
  for (const key of ["daemon", "agent", "label", "output"]) {
    if (!options[key]) throw new Error(`--${key} is required`);
  }
  let daemon;
  try { daemon = new URL(options.daemon); } catch { throw new Error("--daemon must be an absolute HTTP(S) or WS(S) address"); }
  if (!["http:", "https:", "ws:", "wss:"].includes(daemon.protocol) || !daemon.hostname ||
      daemon.username || daemon.password || daemon.search || daemon.hash || daemon.pathname !== "/") {
    throw new Error("--daemon must be an HTTP(S) or WS(S) origin without credentials, path, query or fragment");
  }
  daemon.protocol = daemon.protocol === "https:" || daemon.protocol === "wss:" ? "wss:" : "ws:";
  options.daemon = daemon.origin;
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(options.agent)) throw new Error("--agent must be an agent ID");
  if (options.label.length > 200 || /[\r\n\x00-\x1f]/.test(options.label)) {
    throw new Error("--label must be a single line of at most 200 characters");
  }
  return options;
}

function median(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) {
    throw new Error("Median requires nonempty finite numeric samples");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function analyzeFrames(intervals, fps) {
  if (!intervals.length || intervals.some(value => !Number.isFinite(value) || value <= 0) ||
      !Number.isFinite(fps) || fps <= 0) throw new Error("Invalid frame samples or target FPS");
  const budget = 1000 / fps;
  const droppedFrames = intervals.reduce((sum, value) => sum + Math.max(0, Math.round(value / budget) - 1), 0);
  return {
    frameCount: intervals.length,
    longFrames: intervals.filter(value => value >= 50).length,
    delayedFrames: intervals.filter(value => value > budget * 1.5).length,
    droppedFrames,
    droppedFrameRatio: droppedFrames / (intervals.length + droppedFrames),
    maxFrameMs: Math.max(...intervals),
    scrollDurationMs: intervals.reduce((sum, value) => sum + value, 0),
  };
}

const METRICS = ["firstScreenMs", "heapUsedBytes", "frameCount", "longFrames", "delayedFrames",
  "droppedFrames", "droppedFrameRatio", "maxFrameMs", "scrollDurationMs"];

function summarizeRuns(runs) {
  if (!runs.length) throw new Error("At least one successful run is required");
  const summary = {};
  for (const key of METRICS) {
    const values = runs.map(run => run[key]);
    if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`Invalid run metric: ${key}`);
    if (key === "droppedFrameRatio" && values.some(value => value > 1)) throw new Error("Invalid dropped frame ratio");
    summary[key] = median(values);
  }
  return summary;
}

function renderMarkdown(report) {
  const s = report.median;
  const label = report.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/`/g, "&#96;").replace(/[\r\n]/g, " ");
  return [
    "| Label | Runs | First screen (ms) | Long frames (>=50 ms) | Estimated dropped frames (%) | Post-GC JS heap (MiB) |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    `| ${label} | ${report.runs.length} | ${s.firstScreenMs.toFixed(1)} | ${s.longFrames} | ${(s.droppedFrameRatio * 100).toFixed(2)} | ${(s.heapUsedBytes / 1024 ** 2).toFixed(2)} |`,
    "",
    "Each column is the median of the per-run readings. Dropped frames are estimated from requestAnimationFrame gaps.",
    "",
  ].join("\n");
}

module.exports = { DEFAULTS, parseArgs, median, analyzeFrames, summarizeRuns, renderMarkdown };
