const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseArgs, median, analyzeFrames, summarizeRuns, renderMarkdown } = require("../scripts/perf/metrics.cjs");
const { collectRuns } = require("../scripts/perf/runner.cjs");

const args = ["--daemon", "http://localhost:7000", "--agent", "sample-agent", "--label", "current-state", "--output", "results/sample"];

test("performance arguments require an explicit daemon, agent, label and output", () => {
  for (let i = 0; i < args.length; i += 2) {
    assert.throws(() => parseArgs(args.filter((_, index) => index !== i && index !== i + 1)), /required/);
  }
  assert.equal(parseArgs(["--help"]).help, true);
});

test("performance arguments normalize daemon transports and preserve the configuration label", () => {
  const options = parseArgs(args);
  assert.equal(options.daemon, "ws://localhost:7000");
  assert.equal(options.label, "current-state");
  assert.equal(options.runs, 3);
  assert.equal(options.headless, false);
  for (const [url, expected] of [["https://example.test", "wss://example.test"], ["wss://example.test/", "wss://example.test"], ["ws://[::1]:7000", "ws://[::1]:7000"]]) {
    assert.equal(parseArgs([...args.slice(2), "--daemon", url]).daemon, expected);
  }
});

test("performance arguments accept numeric controls and selector overrides", () => {
  const options = parseArgs([...args, "--runs", "5", "--scroll-ms", "2000", "--settle-ms", "0",
    "--timeout-ms", "5000", "--fps", "120", "--width", "1280", "--height", "800",
    "--ready-selector", "[data-message-id]", "--scroll-selector", "main", "--headless"]);
  assert.deepEqual([options.runs, options.scrollMs, options.settleMs, options.timeoutMs, options.fps,
    options.width, options.height, options.readySelector, options.scrollSelector, options.headless],
  [5, 2000, 0, 5000, 120, 1280, 800, "[data-message-id]", "main", true]);
});

test("performance arguments reject ambiguous or missing values", () => {
  for (const tail of [["--unknown"], ["--runs"], ["--runs", "--headless"], ["--label", "x"], ["--runs", "2", "--runs", "3"], ["--headless", "--headless"]]) {
    assert.throws(() => parseArgs([...args, ...tail]));
  }
});

test("performance numeric controls reject zero runs, fractions, infinities and excessive values", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "1e2", "101", "9007199254740992"]) {
    assert.throws(() => parseArgs([...args, "--runs", value]), /integer/);
  }
  for (const [flag, value] of [["--scroll-ms", "0"], ["--fps", "0"], ["--settle-ms", "60001"], ["--width", "1"], ["--timeout-ms", "999"]]) {
    assert.throws(() => parseArgs([...args, flag, value]), /integer/);
  }
});

test("performance arguments reject unsafe or unsupported daemon addresses", () => {
  for (const url of ["localhost:7000", "file:///example", "ftp://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test?token=secret", "https://example.test/#fragment"]) {
    assert.throws(() => parseArgs([...args.slice(2), "--daemon", url]), /daemon/);
  }
});

test("performance labels and agent identifiers reject control characters and paths", () => {
  assert.throws(() => parseArgs([...args.slice(0, 4), "--label", "one\ntwo", ...args.slice(6)]), /single line/);
  assert.throws(() => parseArgs([...args.slice(0, 2), "--agent", "../agent", ...args.slice(4)]), /agent ID/);
});

test("median handles odd and even numeric samples without mutating input", () => {
  const values = [100, 2, 10];
  assert.equal(median(values), 10);
  assert.deepEqual(values, [100, 2, 10]);
  assert.equal(median([4, 2]), 3);
  assert.equal(median([0]), 0);
  for (const invalid of [[], [NaN], [Infinity], ["1"]]) assert.throws(() => median(invalid), /finite/);
});

test("frame analysis distinguishes 50 ms long frames from estimated missed refresh slots", () => {
  const result = analyzeFrames([16.667, 33.333, 50, 100], 60);
  assert.equal(result.frameCount, 4);
  assert.equal(result.longFrames, 2);
  assert.equal(result.delayedFrames, 3);
  assert.equal(result.droppedFrames, 8);
  assert.equal(result.droppedFrameRatio, 8 / 12);
  assert.equal(result.maxFrameMs, 100);
  assert.equal(result.scrollDurationMs, 200);
  assert.equal(analyzeFrames([8.333, 16.667], 120).droppedFrames, 1);
});

test("frame analysis rejects missing and invalid readings instead of reporting zero jank", () => {
  for (const values of [[], [0], [-1], [Infinity], [NaN]]) assert.throws(() => analyzeFrames(values, 60));
  assert.throws(() => analyzeFrames([16], 0));
});

function sample(firstScreenMs, heapUsedBytes, intervals) {
  return { firstScreenMs, heapUsedBytes, ...analyzeFrames(intervals, 60) };
}

test("run summaries take each metric's median rather than pooling frame ratios", () => {
  const runs = [sample(100, 30, [16.667]), sample(20, 10, [50]), sample(30, 20, [16.667, 100])];
  const result = summarizeRuns(runs);
  assert.equal(result.firstScreenMs, 30);
  assert.equal(result.heapUsedBytes, 20);
  assert.equal(result.longFrames, 1);
  assert.equal(result.droppedFrameRatio, 2 / 3);
  assert.equal(summarizeRuns(runs.slice(0, 2)).firstScreenMs, 60);
});

test("run summaries reject incomplete or failed runs", () => {
  assert.throws(() => summarizeRuns([]), /successful run/);
  assert.throws(() => summarizeRuns([{}]), /firstScreenMs/);
  assert.throws(() => summarizeRuns([{ ...sample(1, 1, [16]), heapUsedBytes: NaN }]), /heapUsedBytes/);
  assert.throws(() => summarizeRuns([{ ...sample(1, 1, [16]), droppedFrameRatio: 2 }]), /ratio/);
});

test("Markdown reports medians, percent and binary heap units with escaped labels", () => {
  const runs = [sample(123.456, 2 * 1024 ** 2, [50])];
  const markdown = renderMarkdown({ label: "with|plugin`<x>", runs, median: summarizeRuns(runs) });
  assert.match(markdown, /with&#124;plugin&#96;&lt;x&gt;/);
  assert.match(markdown, /\| 1 \| 123\.5 \| 1 \| 66\.67 \| 2\.00 \|/);
  assert.match(markdown, /median/);
});

test("each performance sample owns a new tab that closes before the next sample", async () => {
  const events = [];
  const pages = [];
  const context = { async newPage() {
    const id = pages.length + 1;
    const page = { id, async close() { events.push(`close ${id}`); } };
    pages.push(page);
    events.push(`open ${id}`);
    return page;
  } };
  const runs = await collectRuns(context, 3, async (page, run) => {
    assert.equal(page, pages[run - 1]);
    events.push(`measure ${run}`);
    return { firstScreenMs: run * 10 };
  });
  assert.deepEqual(events, ["open 1", "measure 1", "close 1", "open 2", "measure 2", "close 2", "open 3", "measure 3", "close 3"]);
  assert.deepEqual(runs.map(run => run.firstScreenMs), [10, 20, 30]);
});

test("failed performance samples close their tab and abort instead of silently changing the median", async () => {
  let closed = 0;
  let opened = 0;
  const context = { async newPage() { opened += 1; return { async close() { closed += 1; } }; } };
  await assert.rejects(collectRuns(context, 3, async () => { throw new Error("Conversation unavailable"); }), /Conversation unavailable/);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});
