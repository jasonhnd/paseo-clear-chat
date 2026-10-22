const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const captures = require("./fixtures/real-shell-details.json").entries;
const hermesFailure = require("./fixtures/real-hermes-errors.json").items[1];
const codex = require("./fixtures/codex-session.json").items.find(item => item.detail?.type === "shell");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

for (const platform of ["web", "ios", "android"]) {
  for (const width of [1440, 1024, 820, 390]) {
    test(`${platform} ${width}: captured shell fields and failure text remain visible and copyable`, async t => {
      const h = createToolHarness(platform, { dimensions: { width, height: 844 },
        preferences: { collapsedStepAction: "details" } });
      t.after(() => h.unmount());
      const before = structuredClone(captures);
      for (const item of [...captures.map(entry => entry.item), hermesFailure, codex]) {
        const mounted = h.mount(item, false);
        let tree = mounted.tree;
        const row = () => byId(h, tree, "tool-summary-row");
        if (row().props.accessibilityState.expanded) {
          row().props.onPress();
          tree = mounted.render();
        }
        row().props.onPress();
        tree = mounted.render();
        const expectedCode = item === codex ? item.detail.exitCode : item === hermesFailure ? 1 : item.status === "failed" ? 1 : 0;
        assert.equal(h.text(byId(h, tree, "step-detail-exit-code")), `Exit code: ${expectedCode}`);
        assert.equal(byId(h, tree, "step-detail-duration"), undefined, "No tool duration was reported");
        assert.equal(byId(h, tree, "step-detail-stderr"), undefined, "Merged output is not an independent stderr stream");
        if (item === captures[0].item) {
          assert.equal(h.text(byId(h, tree, "step-detail-error")), item.error.content);
          await byId(h, tree, "step-detail-copy-error").props.onPress();
          assert.deepEqual(h.copies, [item.error.content]);
        }
      }
      assert.deepEqual(captures, before, "Adapters leave the captured timeline untouched");
    });
  }

  test(`${platform}: explicit streams display separately and copy their complete whitespace`, async t => {
    const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
    t.after(() => h.unmount());
    for (const nested of [false, true]) {
      const streams = { stdout: " first\nlast  \n", stderr: " warning\n  ", exitCode: 0, durationMs: 1250 };
      const item = { ...codex, detail: { type: "shell", command: "sample", ...(nested ? { output: streams } : streams) } };
      const { tree } = h.mount(item);
      const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
      assert.equal(h.text(byId(h, tree, "step-detail-duration")), "Duration: 1.25s");
      assert.equal(build(item).input, "sample", "Result streams and metrics are not invocation arguments");
      assert.equal(h.text(byId(h, tree, "step-detail-stdout")), streams.stdout.replace(/\n$/, ""));
      assert.equal(h.text(byId(h, tree, "step-detail-stderr")), streams.stderr);
      for (const stream of ["stdout", "stderr"]) await byId(h, tree, `step-detail-copy-${stream}`).props.onPress();
      assert.deepEqual(h.copies, [streams.stdout, streams.stderr]);
    }
  });

  test(`${platform}: reported search and fetch durations display without inventing process exit codes`, t => {
    const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
    t.after(() => h.unmount());
    for (const detail of [
      { type: "search", query: "sample", content: "sample.ts", durationMs: 0 },
      { type: "search", query: "sample", webResults: [], durationSeconds: 1.25 },
      { type: "fetch", url: "https://example.org", result: "sample", durationMs: 1250, code: 200 },
    ]) {
      const { tree } = h.mount({ ...codex, detail });
      assert.equal(h.text(byId(h, tree, "step-detail-duration")), detail.durationMs === 0 ? "Duration: 0ms" : "Duration: 1.25s");
      assert.equal(byId(h, tree, "step-detail-exit-code"), undefined);
    }
  });

  test(`${platform}: empty streams remain copyable and stderr copy rejection preserves the full text`, async t => {
    const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" }, copyText: async () => { throw new Error("Denied"); } });
    t.after(() => h.unmount());
    const mounted = h.mount({ ...codex, detail: { type: "shell", command: "sample", stdout: "", stderr: " error\n  " } });
    assert.ok(byId(h, mounted.tree, "step-detail-copy-stdout"));
    assert.match(h.text(mounted.tree), /Empty stdout\./);
    assert.doesNotMatch(h.text(mounted.tree), /No output was reported/);
    await byId(h, mounted.tree, "step-detail-copy-stderr").props.onPress();
    const fallback = h.nodes(mounted.render(), node => node.props.accessibilityLabel === "Text to copy")[0];
    assert.equal(fallback.props.value, " error\n  ");
  });
}

test("exit codes require recognized result envelopes and never come from commands, status or timestamps", t => {
  const h = createToolHarness("web");
  t.after(() => h.unmount());
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const claude = captures[0].item;
  for (const error of [null, { content: "Exit code 9\ntext" }, { ...claude.error, is_error: false },
    { ...claude.error, content: "Quoted text\nExit code 9" }, { ...claude.error, content: "Exit code 1.5\ntext" }]) {
    assert.equal(build({ ...claude, error }).exitCode, undefined);
  }
  const hermes = captures[1].item;
  for (const output of ["- exit_code: 9", "terminal result\n- output: sample\n- exit_code: 1.5",
    "terminal result\n- output: sample\n- exit_code: 9\nextra", "Exit code 9\ncommand output"]) {
    assert.equal(build({ ...hermes, detail: { ...hermes.detail, output } }).exitCode, undefined);
  }
  const body = "terminal result\n- output: literal\n- exit_code: 99\n- exit_code: 0";
  assert.equal(build({ ...hermes, detail: { ...hermes.detail, output: body } }).exitCode, 0);
  assert.equal(build({ ...hermes, detail: { ...hermes.detail, exitCode: 7 } }).exitCode, 7, "Typed exit codes take precedence");
  assert.equal(build({ ...claude, name: "read", detail: { type: "read", filePath: "sample" } }).exitCode, undefined);
  assert.equal(build({ ...claude, timestamp: 100, startedAt: 0, endedAt: 100 }).durationMs, undefined);
  assert.equal(build({ ...claude, error: { ...claude.error, content: [{ type: "text", text: "Exit code 2\r\nSample error" }] } }).exitCode, 2);
  assert.equal(build({ ...hermes, detail: { ...hermes.detail, output: "terminal result\r\n- output: sample\r\n- exit_code: 0\r\n" } }).exitCode, 0);
});
