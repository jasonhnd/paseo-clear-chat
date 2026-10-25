const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const fixture = require("./fixtures/real-claude-session.json");
const codexFixture = require("./fixtures/codex-session.json");
const shell = fixture.items.find(item => item.detail?.type === "shell" && item.status === "completed");
const webSearch = codexFixture.items.find(item => item.callId === "codex-call-7");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const harness = (platform, width = 390, options = {}) => createToolHarness(platform, {
  ...options, isPad: platform === "ios" && width >= 744, dimensions: { width, height: 844 },
  preferences: { collapsedStepAction: "details", foldLongOutputAfter: 15 },
});

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: captured web search results display and copy separately from the query`, async t => {
    const h = harness(platform, platform === "web" ? 1440 : platform === "ios" ? 820 : 390);
    t.after(() => h.unmount());
    const expectedInput = JSON.stringify({ query: webSearch.detail.query }, null, 2);
    const expectedOutput = JSON.stringify({ results: webSearch.detail.results }, null, 2);
    assert.equal(webSearch.detail.results.length, 1, "Replay the captured search result");
    const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
    const data = build(webSearch);
    assert.equal(data.input, expectedInput);
    assert.equal(data.copyResult, expectedOutput);
    const { tree } = h.mount(webSearch);
    assert.equal(h.text(byId(h, tree, "step-detail-input")), expectedInput);
    assert.equal(h.text(byId(h, tree, "step-detail-output")), expectedOutput);
    await byId(h, tree, "step-detail-copy-input").props.onPress();
    await byId(h, tree, "step-detail-copy-output").props.onPress();
    assert.deepEqual(h.copies, [expectedInput, expectedOutput]);
  });

  test(`${platform}: GitHub device details display and copy the full request and only reported replies`, async t => {
    const h = harness(platform, platform === "web" ? 1440 : platform === "ios" ? 820 : 390);
    t.after(() => h.unmount());
    const content = JSON.stringify({ op: "pr_checks", repo: "example/project", pr: 12 });
    const filePath = "xd://github";
    const expectedInput = JSON.stringify({ filePath, content }, null, 2);
    const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
    for (const output of [undefined, "checks\tpass\t1s\n  "]) {
      const item = { ...shell, name: "github", detail: { type: "unknown", filePath, content, output } };
      const data = build(item);
      assert.equal(data.input, expectedInput);
      assert.equal(data.copyResult, output, "The request is not an invented reply");
      const { tree } = h.mount(item);
      assert.equal(h.text(byId(h, tree, "step-detail-input")), expectedInput);
      await byId(h, tree, "step-detail-copy-input").props.onPress();
      const copyOutput = byId(h, tree, "step-detail-copy-output");
      if (output === undefined) {
        assert.equal(copyOutput, undefined);
        assert.match(h.text(tree), /No output was reported\./);
      } else {
        assert.equal(h.text(byId(h, tree, "step-detail-output")), output);
        await copyOutput.props.onPress();
      }
      assert.deepEqual(h.copies, output === undefined ? [expectedInput] : [expectedInput, output]);
    }
  });

  for (const width of [1440, 1024, 820, 390]) {
    test(`${platform} ${width}: captured details show and copy full input and output despite timeline folding`, async () => {
      const h = harness(platform, width);
      const mounted = h.mount(shell);
      const tree = mounted.render();
      assert.ok(h.text(byId(h, tree, "step-detail-input")).includes(shell.detail.command), "Complete input is labeled separately");
      assert.ok(h.text(byId(h, tree, "step-detail-output")).includes("Sample text line 24."), "Output is not folded at 15 lines");
      assert.equal(h.nodes(tree, node => /Show all/.test(node.props.accessibilityLabel ?? "")).length, 0);
      await byId(h, tree, "step-detail-copy-input").props.onPress();
      await byId(h, tree, "step-detail-copy-output").props.onPress();
      assert.deepEqual(h.copies, [shell.detail.command, shell.detail.output]);
      assert.equal(byId(h, tree, "tool-summary-row").props.accessibilityState.expanded, false);
      h.unmount();
    });
  }

  test(`${platform}: zero duration and exit code are visible, absent and invalid metrics are omitted`, () => {
    const h = harness(platform);
    const withMetrics = h.mount({ ...shell, detail: { ...shell.detail, durationMs: 0, exitCode: 0 } });
    assert.equal(h.text(byId(h, withMetrics.tree, "step-detail-duration")), "Duration: 0ms");
    assert.equal(h.text(byId(h, withMetrics.tree, "step-detail-exit-code")), "Exit code: 0");
    for (const metrics of [{}, { durationMs: -1, exitCode: 0.5 }, { durationMs: NaN, exitCode: Infinity }]) {
      const mounted = h.mount({ ...shell, detail: { ...shell.detail, ...metrics } });
      assert.equal(byId(h, mounted.tree, "step-detail-duration"), undefined);
      assert.equal(byId(h, mounted.tree, "step-detail-exit-code"), undefined);
    }
    h.unmount();
  });
}

test("GitHub device request content follows tool identity from names, types and device paths", t => {
  const h = harness("web");
  t.after(() => h.unmount());
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const content = JSON.stringify({ op: "pr_checks", repo: "example/project", pr: 12 });
  const result = { checks: [{ name: "sample", status: "pass" }], count: 1 };
  for (const [name, type, filePath] of [
    ["github", "unknown", undefined], ["device", "github", undefined],
    ["write_file", "unknown", "xd://github"], ["write_file", "unknown", "xd://github/request"],
  ]) {
    const data = build({ name, status: "completed", detail: { type, filePath, content, result } });
    assert.equal(data.tool, "github");
    assert.deepEqual(JSON.parse(data.input), { ...(filePath ? { filePath } : {}), content });
    assert.equal(data.copyResult, JSON.stringify(result, null, 2));
  }
});

test("detail extraction retains every structured argument, result field, block and whitespace", () => {
  const h = harness("ios");
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const input = { command: "  printf 'sample'\n  ", cwd: "/workspace/demo", options: { timeout: 20 } };
  for (const output of [" first\nlast  ", { stdout: "out\n", stderr: "err\n", exitCode: 1 },
    { content: [{ type: "text", text: " first\n" }, { type: "text", text: "last  " }] },
    { content: [{ type: "text", text: "text" }, { type: "image", data: "sample", mimeType: "image/png" }], details: { count: 2 } }]) {
    const data = build({ ...shell, detail: { type: "shell", input, output } });
    assert.equal(data.input, JSON.stringify(input, null, 2));
    const expected = typeof output === "string" ? output
      : Object.keys(output).length === 1 && output.content ? output.content.map(block => block.text).join("\n")
      : JSON.stringify(output, null, 2);
    assert.equal(data.copyResult, expected);
  }
  assert.equal(build({ ...shell, detail: { type: "shell", input: "\n command  ", output: "" } }).input, "\n command  ");
  assert.equal(build({ ...shell, detail: { type: "shell", command: " command  ", cwd: "/workspace/demo", output: "" } }).input,
    JSON.stringify({ command: " command  ", cwd: "/workspace/demo" }, null, 2));
  h.unmount();
});

test("typed read results stay separate from write and edit inputs", () => {
  const h = harness("web");
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const filePath = "/workspace/demo/sample.txt";
  const read = build({ name: "read", status: "completed", detail: { type: "read", filePath, offset: 2, limit: 3, content: "full read result\n" } });
  assert.equal(read.input, JSON.stringify({ filePath, offset: 2, limit: 3 }, null, 2));
  assert.equal(read.copyResult, "full read result\n");
  for (const fields of [{ type: "write", content: "full file input\n" }, { type: "edit", oldString: "old", newString: "new", unifiedDiff: "full patch" }]) {
    const { type, ...args } = fields;
    const data = build({ name: type, status: "completed", detail: { ...fields, filePath } });
    assert.deepEqual(JSON.parse(data.input), { ...args, filePath });
    assert.equal(data.copyResult, undefined, "File and patch inputs are not invented results");
  }
  const fetch = build({ name: "fetch", status: "completed", detail: { type: "fetch", url: "https://example.org", code: 200, result: "page" } });
  assert.equal(fetch.exitCode, undefined, "An HTTP status is not a process exit code");
  h.unmount();
});

test("text result blocks with extra fields retain their complete structure", () => {
  const h = harness("web");
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const output = { content: [{ type: "text", text: "Full result text", annotations: { source: "sample", count: 0 } }] };
  const data = build({ ...shell, detail: { type: "shell", command: "sample", output } });
  assert.equal(data.copyResult, JSON.stringify(output, null, 2));
  h.unmount();
});

test("only explicit reported result metrics are extracted, with no status inference", () => {
  const h = harness("android");
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const data = build({ ...shell, detail: { type: "shell", command: "sample", output: { stdout: "out", stderr: "err", exit_code: 2, durationMs: 1250 } } });
  assert.equal(data.exitCode, 2);
  assert.equal(data.durationMs, 1250);
  for (const status of ["completed", "failed", "canceled", "running"]) {
    const absent = build({ ...shell, status });
    assert.equal(absent.exitCode, undefined);
    assert.equal(absent.durationMs, undefined);
  }
  h.unmount();
});

test("copy rejection retains the complete output in the selectable fallback", async () => {
  const h = harness("ios", 390, { copyText: async () => { throw new Error("Denied"); } });
  const mounted = h.mount(shell);
  await byId(h, mounted.tree, "step-detail-copy-output").props.onPress();
  const fallback = h.nodes(mounted.render(), node => node.props.accessibilityLabel === "Text to copy")[0];
  assert.equal(fallback.props.value, shell.detail.output);
  assert.equal(fallback.props.readOnly, true);
  h.unmount();
});

test("virtual cell measurements do not restore an obsolete reading position during scrolling", () => {
  const h = harness("web");
  const mounted = h.mount(shell);
  const scroll = byId(h, mounted.tree, "step-detail-scroll");
  const restores = [];
  scroll.props.ref.current = { scrollToOffset: value => restores.push(value) };
  scroll.props.onLayout({ nativeEvent: { layout: { width: 390, height: 340 } } });
  scroll.props.onContentSizeChange(390, 20000);
  restores.length = 0;
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 250 } } });
  scroll.props.onContentSizeChange(390, 20100);
  assert.deepEqual(restores, [], "Measuring newly mounted cells must leave the active scroll alone");
  scroll.props.onLayout({ nativeEvent: { layout: { width: 680, height: 600 } } });
  assert.deepEqual(restores, [{ offset: 250, animated: false }], "Viewport changes restore the last reading position");
  h.unmount();
});

test("a presentation handoff keeps the saved offset while its new scroll node is still laying out", () => {
  const frames = new Map();
  let serial = 0;
  const h = harness("web", 820, { globals: {
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
  } });
  const { StepDetailStateContext, createStepDetailState } = h.load("client/components/step-detail-state.ts");
  const state = createStepDetailState();
  state.scrollOffset = 1000;
  const tree = h.draw({ type: StepDetailStateContext.Provider, props: { value: state, children: {
    type: h.load("client/components/step-detail-content.tsx").StepDetailContent,
    props: { tokens: h.tokens, step: h.load("client/tool-call-data.ts").buildLiveToolCallData(shell) },
  } } });
  const scroll = byId(h, tree, "step-detail-scroll");
  const restores = [];
  scroll.props.ref.current = { scrollToOffset: value => {
    restores.push(value);
    scroll.props.onScroll({ nativeEvent: { contentOffset: { y: value.offset } } });
  } };
  scroll.props.onLayout({ nativeEvent: { layout: { width: 680, height: 600 } } });
  scroll.props.onContentSizeChange(680, 5000);
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
  assert.equal(state.scrollOffset, 1000, "Early clamping does not replace the saved reading position");
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
  assert.deepEqual(restores, [{ offset: 1000, animated: false }]);
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 1250 } } });
  scroll.props.onContentSizeChange(680, 5100);
  assert.equal(state.scrollOffset, 1250);
  assert.equal(frames.size, 0, "Virtual measurement does not schedule another restoration");
  h.unmount();
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
  assert.equal(state.scrollOffset, 1250, "A detached scroll node cannot overwrite the new viewport's reading state");
});

test("fresh details do not queue a zero-offset restoration over a new scroll", () => {
  const frames = new Map();
  let serial = 0;
  const h = harness("web", 820, { globals: {
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
  } });
  const mounted = h.mount(shell);
  const scroll = byId(h, mounted.tree, "step-detail-scroll");
  const restores = [];
  scroll.props.ref.current = { scrollToOffset: value => restores.push(value) };
  scroll.props.onLayout({ nativeEvent: { layout: { width: 680, height: 600 } } });
  scroll.props.onContentSizeChange(680, 5000);
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 1000 } } });
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 0 }, layoutMeasurement: { width: 0, height: 0 } } });
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
  assert.deepEqual(restores, [], "A new detail already starts at zero without an imperative restore");
  assert.equal(byId(h, mounted.render(), "step-detail-scroll").props.contentOffset.y, 1000);
  h.unmount();
});

test("bounded chunks preserve all characters, CRLF, tabs, blank lines and supplementary Unicode", () => {
  const h = harness("web");
  const { stepTextChunks } = h.load("client/step-detail-data.ts");
  for (const text of ["", "\r\n\t\n  ", `${"x".repeat(2047)}\u{1f680}last\r\n`, `${"x".repeat(2047)}\r\nlast`,
    Array.from({ length: 10000 }, (_, index) => `line ${index + 1}\t\u{1f680}\r\n`).join("")]) {
    const chunks = stepTextChunks(text);
    assert.equal(chunks.join(""), text);
    assert.ok(chunks.every(chunk => chunk.length <= 2050));
    assert.ok(chunks.every(chunk => !/[\ud800-\udbff]$/.test(chunk) && !/^[\udc00-\udfff]/.test(chunk)));
  }
  h.unmount();
});

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: a ten-thousand-line input and output mount a bounded window and copy every character`, async () => {
    const h = harness(platform, 820);
    const input = Array.from({ length: 10000 }, (_, index) => `argument line ${index + 1}\n`).join("");
    const output = Array.from({ length: 10000 }, (_, index) => `result line ${index + 1}\n`).join("");
    const mounted = h.mount({ ...shell, detail: { type: "shell", input, output } });
    const list = byId(h, mounted.tree, "step-detail-scroll");
    for (const [section, text] of [["input", input], ["output", output]]) {
      const chunks = list.props.data.filter(row => row.section === section && row.kind === "text");
      assert.equal(chunks.map(row => row.text).join(""), text, "The virtual document retains the full source");
      const tail = h.draw(list.props.renderItem({ item: chunks.at(-1) }), `tail-${section}`);
      assert.ok(h.text(tail).includes("line 10000"));
      const header = list.props.data.find(row => row.section === section && row.kind === "heading");
      const controls = h.draw(list.props.renderItem({ item: header }), `copy-${section}`);
      await byId(h, controls, `step-detail-copy-${section}`).props.onPress();
      assert.equal(h.copies.at(-1), text);
    }
    assert.ok(h.text(mounted.tree).length < 20000, "Mounting does not lay out the full document");
    h.unmount();
  });
}

test("captured Hermes reads display and copy file content without the read envelope", async () => {
  const item = require("./fixtures/real-hermes-hover.json").items.find(item => item.detail?.type === "read");
  const expected = "export function sampleTotal(items) {\n  return items.reduce((sum, item) => sum + item.cost, 0);\n}";
  for (const platform of ["web", "ios", "android"]) {
    const h = harness(platform, 820);
    const { tree } = h.mount(item);
    const rows = byId(h, tree, "step-detail-scroll").props.data;
    assert.equal(rows.filter(row => row.section === "output" && row.kind === "text").map(row => row.text).join(""), expected);
    await byId(h, tree, "step-detail-copy-output").props.onPress();
    assert.equal(h.copies.at(-1), expected);
    h.unmount();
  }
});

for (const platform of ["web", "ios", "android"]) {
  for (const targetWidth of [820, 1440]) {
    test(`${platform}: sheet reflow to ${targetWidth} preserves the first visible output line`, () => {
      const h = harness(platform);
      const { StepDetailStateContext, createStepDetailState } = h.load("client/components/step-detail-state.ts");
      const state = createStepDetailState();
      const Content = h.load("client/components/step-detail-content.tsx").StepDetailContent;
      const step = h.load("client/tool-call-data.ts").buildLiveToolCallData(shell);
      const render = () => h.draw({ type: StepDetailStateContext.Provider, props: { value: state,
        children: { type: Content, props: { step, tokens: h.tokens } } } });
      const measure = (tree, width, outputTop, restores) => {
        const scroll = byId(h, tree, "step-detail-scroll");
        scroll.props.ref.current = { scrollToOffset: value => restores.push(value.offset) };
        scroll.props.onLayout({ nativeEvent: { layout: { width, height: 340 } } });
        // The input loses two wrapped lines when the phone sheet widens.
        for (const cell of h.nodes(tree, node => node.props.testID?.startsWith("step-detail-cell-"))) {
          const y = cell.props.testID === "step-detail-cell-output-0" ? outputTop : 8;
          cell.props.onLayout?.({ nativeEvent: { layout: { x: 0, y, width, height: 2000 } } });
        }
        scroll.props.onContentSizeChange(width, 5000);
        return scroll;
      };
      const scroll = measure(render(), 390, 280, []);
      scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 400 } } });
      h.unmount();
      const restores = [];
      const returned = measure(render(), targetWidth, 244, restores);
      const firstLine = (offset, outputTop) => Math.ceil((offset - outputTop) / 18);
      assert.equal(firstLine(restores.at(-1), 244), firstLine(400, 280));
      assert.equal(restores.at(-1), 364);
      returned.props.onScroll({ nativeEvent: { contentOffset: { y: 364 } } });
      returned.props.onScroll({ nativeEvent: { contentOffset: { y: 500 } } });
      assert.equal(state.scrollOffset, 500, "Ordinary scrolling updates the anchor after restoration");
      h.unmount();
    });
  }
}

// A browser can anchor the old sheet before RN Web delivers its new onLayout;
// the host then replaces the compact timeline row on its next commit.
test("sheet reflow scroll before layout does not corrupt the anchor handed to the popover", () => {
  const h = harness("web");
  const { StepDetailStateContext, createStepDetailState } = h.load("client/components/step-detail-state.ts");
  const state = createStepDetailState();
  const Content = h.load("client/components/step-detail-content.tsx").StepDetailContent;
  const step = h.load("client/tool-call-data.ts").buildLiveToolCallData(shell);
  const render = () => h.draw({ type: StepDetailStateContext.Provider, props: { value: state,
    children: { type: Content, props: { step, tokens: h.tokens } } } });
  const measure = (width, outputTop, restores) => {
    const tree = render();
    const scroll = byId(h, tree, "step-detail-scroll");
    scroll.props.ref.current = { scrollToOffset: value => restores.push(value.offset) };
    scroll.props.onLayout({ nativeEvent: { layout: { width, height: 340 } } });
    for (const cell of h.nodes(tree, node => node.props.testID === "step-detail-cell-output-0")) {
      cell.props.onLayout({ nativeEvent: { layout: { x: 0, y: outputTop, width: width - 24, height: 2000 } } });
    }
    scroll.props.onContentSizeChange(width, 5000);
    return scroll;
  };
  const sheet = measure(388, 280, []);
  sheet.props.onScroll({ nativeEvent: { contentOffset: { y: 400 }, layoutMeasurement: { width: 388, height: 340 } } });
  // Chrome already compensated for the 36px reflow, but cells still have sheet coordinates.
  sheet.props.onScroll({ nativeEvent: { contentOffset: { y: 364 }, layoutMeasurement: { width: 678, height: 627 } } });
  h.unmount();
  const restores = [];
  measure(678, 244, restores);
  assert.equal(restores.at(-1), 364, "Apply the 36px reflow once, preserving output line 7 (not line 5 at 328px)");
  assert.deepEqual(state.scrollAnchor, { key: "output-0", offset: 120 });
  h.unmount();
});
