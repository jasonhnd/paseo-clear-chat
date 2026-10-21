const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const fallback = "Failed (no error message reported)";
const longError = Array.from({ length: 20 }, (_, i) => `Failure detail ${i + 1}`).join("\n");
const find = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const call = (detail, error) => ({ type: "tool_call", name: "inspect", callId: "failed-call", status: "failed", error, detail });

const failures = [
  ["error field takes precedence", { output: "Secondary failure" }, "Provider unavailable\nTry again later", "Provider unavailable\nTry again later"],
  ["detail error", { error: "Permission denied", output: "Attempting request" }, null, "Permission denied"],
  ["detail message", { message: "Request rejected" }, null, "Request rejected"],
  ["plain-text detail", { type: "plain_text", text: "Connection closed" }, null, "Connection closed"],
  ["output text", { type: "read", filePath: "missing.txt", output: "File does not exist" }, "", "File does not exist"],
  ["structured output error", { output: { error: { message: "Invalid argument" } } }, null, "Invalid argument"],
  ["stderr alongside stdout", { type: "shell", command: "sample-check", output: { stdout: "Starting check", stderr: "Check failed" } }, null, "Check failed"],
  ["result content blocks", { result: { content: [{ type: "text", text: "Request failed" }, { type: "text", text: "Service unavailable" }] } }, null, "Request failed\nService unavailable"],
  ["content text", { type: "read", filePath: "missing.txt", content: "Read failed" }, null, "Read failed"],
  ["output content array", { output: [{ type: "text", text: "Resource unavailable" }] }, null, "Resource unavailable"],
  ["write output with input content", { type: "write", content: "Draft file body", output: "Write permission denied" }, null, "Write permission denied"],
  ["write result content blocks", { type: "write", content: "Draft file body", result: { content: [{ type: "text", text: "Write failed" }] } }, null, "Write failed"],
  ["error beyond the output fold", { output: longError }, null, longError],
];

for (const [label, detail, error, expected] of failures) {
  test(`upstream #19: ${label} is visible by default and after reopening`, () => {
    const h = createToolHarness();
    const item = call({ type: "unknown", ...detail }, error);
    const mounted = h.mount(item, false);
    assert.equal(h.load("client/tool-call-data.ts").buildLiveToolCallData(mounted.data).error, expected);
    assert.equal(find(h, mounted.tree, "tool-summary-row").props.accessibilityState.expanded, true);
    assert.ok(h.text(find(h, mounted.tree, "tool-card-body")).includes(expected));
    assert.equal(h.text(mounted.tree).includes(fallback), false);

    find(h, mounted.tree, "tool-summary-row").props.onPress();
    const collapsed = mounted.render();
    assert.equal(find(h, collapsed, "tool-card-body"), undefined);
    assert.equal(find(h, collapsed, "tool-summary-text").props.numberOfLines, 1);
    find(h, collapsed, "tool-summary-row").props.onPress();
    assert.ok(h.text(find(h, mounted.render(), "tool-card-body")).includes(expected));
  });
}

for (const error of [undefined, null, "", " \n\t "]) {
  test(`upstream #19: empty error ${JSON.stringify(error)} has an explicit fallback`, () => {
    const h = createToolHarness();
    const mounted = h.mount(call({ type: "unknown", input: { query: "sample" }, output: {} }, error), false);
    assert.equal(h.load("client/tool-call-data.ts").buildLiveToolCallData(mounted.data).error, fallback);
    assert.equal(find(h, mounted.tree, "tool-summary-row").props.accessibilityState.expanded, true);
    assert.ok(h.text(find(h, mounted.tree, "tool-card-body")).includes(fallback));
  });
}

test("upstream #19: empty text envelopes do not hide the failure fallback", () => {
  const h = createToolHarness();
  for (const output of [undefined, null, "", " \n ", [], { error: "", message: " " }, { content: [{ type: "text", text: "" }] }]) {
    const mounted = h.mount(call({ type: "unknown", output }), false);
    assert.ok(h.text(find(h, mounted.tree, "tool-card-body")).includes(fallback));
  }
});

test("upstream #19: failed writes with only input content show the fallback", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  for (const type of ["write", "unknown"]) {
    const item = { ...call({ type, filePath: "sample.txt", content: "Draft file body" }, null), name: "Write" };
    const mounted = h.mount(item, false);
    assert.equal(build(mounted.data).error, fallback);
    assert.equal(build(mounted.data).code, "Draft file body");
    assert.equal(find(h, mounted.tree, "tool-summary-row").props.accessibilityState.expanded, true);
    assert.ok(h.text(find(h, mounted.tree, "tool-card-body")).includes(fallback));
    find(h, mounted.tree, "tool-summary-row").props.onPress();
    find(h, mounted.render(), "tool-summary-row").props.onPress();
    assert.ok(h.text(find(h, mounted.render(), "tool-card-body")).includes(fallback));
  }
});

test("upstream #19: request content is not a reported failure", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  for (const [name, type] of [["Edit", "edit"], ["github", "unknown"]]) {
    const item = { ...call({ type, content: "Sample request body" }, null), name };
    const mounted = h.mount(item, false);
    assert.equal(build(mounted.data).error, fallback);
    assert.ok(h.text(find(h, mounted.tree, "tool-card-body")).includes(fallback));
  }
});

test("upstream #19: running calls open on failure and show the new error", () => {
  const h = createToolHarness();
  const mounted = h.mount({ ...call({ type: "unknown" }), status: "running" }, false);
  const failed = mounted.render({ ...mounted.data, status: "failed", detail: { type: "unknown", output: "Connection lost" } });
  assert.equal(find(h, failed, "tool-summary-row").props.accessibilityState.expanded, true);
  assert.ok(h.text(find(h, failed, "tool-card-body")).includes("Connection lost"));
});

test("upstream #19: non-failed calls do not acquire a failure message", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  for (const status of ["running", "completed", "canceled", "awaiting_approval"]) {
    assert.equal(build({ name: "inspect", status, detail: { type: "unknown", output: "Ordinary output" } }).error, undefined);
  }
});

test("upstream #19: failed final-reply tools also show the error or fallback", () => {
  const h = createToolHarness();
  for (const output of ["Reply could not be delivered", ""]) {
    const item = { ...call({ type: "unknown", input: { message: "Sample reply" }, output }), name: "wrap_up" };
    const { tree } = h.mount(item, false);
    assert.ok(h.text(find(h, tree, "tool-final-reply")).includes(output || fallback));
  }
});

for (const [index, item] of require("./fixtures/real-hermes-errors.json").items.entries()) {
  test(`captured Hermes ${item.name} object error keeps the failed card expanded and readable`, () => {
    const h = createToolHarness();
    const { tree } = h.mount(item, false);
    const text = h.text(tree);
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.equal(find(h, tree, "tool-summary-row").props.accessibilityState.expanded, true);
    assert.ok(text.includes(index === 0
      ? "Read failed: File not found: /workspace/example/missing.txt"
      : "ls: /workspace/example/missing-directory: No such file or directory"));
    if (index === 1) assert.match(text, /exit_code: 1/);
  });
}

for (const key of ["message", "error", "text", "detail", "reason"]) {
  test(`object errors extract ${key} directly and one level down`, () => {
    const h = createToolHarness();
    for (const error of [{ [key]: "Reported failure" }, { [key]: { reason: "Reported failure" } }]) {
      const { tree, data } = h.mount(call({ type: "unknown" }, error), false);
      assert.equal(h.load("client/tool-call-data.ts").buildLiveToolCallData(data).error, "Reported failure");
      assert.match(h.text(tree), /Reported failure/);
      assert.doesNotMatch(h.text(tree), /\[object Object\]/);
    }
  });
}

test("object errors select text fields in priority order and skip empty values", () => {
  const h = createToolHarness();
  const extract = h.load("client/error-text.ts").errorText;
  const keys = ["message", "error", "text", "detail", "reason"];
  for (let index = 0; index < keys.length; index++) {
    const error = Object.fromEntries(keys.map((key, i) => [key, i < index ? " \n " : `${key} failure`]));
    assert.equal(extract(error), `${keys[index]} failure`);
  }
  assert.equal(extract({ message: { detail: "Nested priority" }, error: "Secondary" }), "Nested priority");
  assert.equal(extract(new Error("Native failure")), "Native failure");
  assert.equal(extract({ message: { error: { text: "Too deep" } }, reason: "Visible reason" }), "Visible reason");
});

test("unrecognized object errors omit the error row without exposing JSON or metadata", () => {
  const h = createToolHarness();
  for (const error of [{}, { code: 1, payload: { secret: "Internal metadata" } }, { message: { error: { reason: "Too deep" } } }, ["Array metadata"]]) {
    const { tree } = h.mount(call({ type: "unknown" }, error), false);
    assert.equal(find(h, tree, "tool-error-line"), undefined);
    assert.equal(find(h, tree, "tool-summary-row").props.accessibilityState.expanded, true);
    assert.doesNotMatch(h.text(tree), /\[object Object\]|Internal metadata|Too deep|Array metadata|"code"/);
  }
});

test("recognized errors already visible in output appear once", () => {
  const h = createToolHarness();
  for (const detail of [
    { type: "read", content: "Read failed: Missing file" },
    { type: "shell", command: "sample", output: "Read failed: Missing file\nexit_code: 1" },
    { type: "plain_text", text: "Read failed: Missing file" },
    { type: "unknown", output: "Read failed: Missing file" },
  ]) {
    const { tree } = h.mount(call(detail, { message: "Read failed: Missing file" }), false);
    assert.equal(find(h, tree, "tool-error-line"), undefined);
    assert.equal(h.text(tree).split("Read failed: Missing file").length - 1, 1);
  }
});

test("object errors beyond the output fold remain visible by default", () => {
  const h = createToolHarness();
  const output = [...Array(20).fill("Progress"), "Final failure"].join("\n");
  const { tree } = h.mount(call({ type: "shell", command: "sample", output }, { message: "Final failure" }), false);
  assert.equal(h.text(find(h, tree, "tool-error-line")), "Final failure");
  assert.match(h.text(tree), /Final failure/);
});

test("error deduplication follows manual output expansion and refolding", () => {
  const h = createToolHarness();
  const output = [...Array(20).fill("Progress"), "Final failure"].join("\n");
  const mounted = h.mount(call({ type: "shell", command: "sample", output }, { message: "Final failure" }), false);
  assert.equal(h.text(find(h, mounted.tree, "tool-error-line")), "Final failure");
  h.nodes(mounted.tree, node => node.props.accessibilityLabel === "Show all 21 lines")[0].props.onPress();
  const expanded = mounted.render();
  assert.equal(find(h, expanded, "tool-error-line"), undefined);
  assert.equal(h.text(expanded).split("Final failure").length - 1, 1);
  h.nodes(expanded, node => node.props.accessibilityLabel === "Show fewer lines")[0].props.onPress();
  const folded = mounted.render();
  assert.equal(h.text(find(h, folded, "tool-error-line")), "Final failure");
  assert.equal(h.text(folded).split("Final failure").length - 1, 1);
});

test("error deduplication respects a changed output limit", () => {
  const h = createToolHarness();
  const output = [...Array(20).fill("Progress"), "Final failure"].join("\n");
  const mounted = h.mount(call({ type: "read", filePath: "sample.txt", content: output }, { message: "Final failure" }), false);
  h.preferences.foldLongOutputAfter = "never";
  const complete = mounted.render();
  assert.equal(find(h, complete, "tool-error-line"), undefined);
  h.preferences.foldLongOutputAfter = 10;
  assert.equal(h.text(find(h, mounted.render(), "tool-error-line")), "Final failure");
});

test("typed GitHub, fetch, search and discovery outputs avoid duplicate error lines", () => {
  const h = createToolHarness();
  for (const item of [
    { ...call({ type: "unknown", content: '{"op":"status"}', output: "Request denied" }, { message: "Request denied" }), name: "github" },
    call({ type: "fetch", url: "https://example.org", content: "Request denied" }, { reason: "Request denied" }),
    call({ type: "search", results: [{ path: "sample.txt", snippet: "Request denied" }] }, { text: "Request denied" }),
    { ...call({ type: "unknown", output: "Request denied" }, { detail: "Request denied" }), name: "tool_search" },
  ]) {
    const { tree } = h.mount(item, false);
    assert.equal(find(h, tree, "tool-error-line"), undefined);
    assert.equal(h.text(tree).split("Request denied").length - 1, 1);
  }
});
