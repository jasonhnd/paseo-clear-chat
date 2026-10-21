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
