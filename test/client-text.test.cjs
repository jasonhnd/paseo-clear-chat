const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));

test("Hub operation titles ignore object values", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  const data = build({ name: "hub", status: "completed", detail: { input: { op: { name: "logs" } } } });
  assert.equal(data.title, "Hub: operation");
  assert.doesNotMatch(h.text(h.mount({ type: "tool_call", name: "hub", status: "completed", detail: { input: { op: {} } } }).tree), /\[object Object\]/);
});

test("GitHub pull request subjects retain strings and numbers and ignore objects", () => {
  const h = createToolHarness();
  const build = h.load("client/github-request.ts").buildGitHubData;
  for (const [pr, expected] of [[[12, { number: 13 }, "#14", null, [15]], "#12 #14"], [[{}], undefined], [16, "#16"], ["#17", "#17"], [{ number: 18 }, undefined]]) {
    const data = build(JSON.stringify({ op: "pr_checks", repo: "example/project", pr }), "No checks reported");
    assert.equal(data.subject, expected);
  }
});

test("search paths discard objects before building reveal links", () => {
  const h = createToolHarness();
  const search = h.load("client/tool-detail.ts").searchData;
  for (const [filePaths, expected] of [[[{}], "/workspace/example"], [[{}, "sample.txt"], "sample.txt"], [["other.txt"], "other.txt"]]) {
    const data = search({ filePaths }, { path: "/workspace/example" }, "Sample prose result", false);
    assert.equal(data.results[0].path, expected);
    assert.doesNotMatch(data.results[0].path, /\[object Object\]/);
  }
});

test("unserializable tool values use a safe fallback without object coercion", () => {
  const h = createToolHarness();
  const { valueText, fallbackData, unknownTitle } = h.load("client/tool-detail.ts");
  const circular = {}; circular.self = circular;
  for (const value of [circular, { toJSON() { throw new Error("Cannot serialize"); } }, { toJSON() { return undefined; } }]) {
    assert.equal(valueText(value), undefined);
    assert.equal(fallbackData({ value }, null).parameters[0].value, "Value unavailable");
    assert.equal(unknownTitle("inspect", { value }), "inspect · Value unavailable");
  }
  assert.equal(valueText({ count: 1 }), '{\n  "count": 1\n}');
  assert.equal(fallbackData({ enabled: false }, null).parameters[0].value, "false");
});

for (const [label, cause, expected] of [
  ["text", "Connection lost", "Connection lost"],
  ["native", new Error("Connection lost"), "Connection lost"],
  ["object", { error: { reason: "Connection lost" } }, "Connection lost"],
  ["unknown", { code: 500 }, undefined],
]) {
  test(`image RPC ${label} failures hide the unavailable preview`, async () => {
    const h = createToolHarness("ios", { images: true, imageRpc: async () => { throw cause; } });
    const mounted = h.mount({ type: "tool_call", name: "read", status: "failed", detail: { type: "read", filePath: "sample.png" } }, false);
    await settle();
    const tree = mounted.render();
    assert.equal(h.nodes(tree, node => node.type === "Image").length, 0);
    assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Show sample.png in the file manager").length, 0);
    assert.doesNotMatch(h.text(tree), /Connection lost|Image could not be loaded|\[object Object\]|"code"/);
  });

  test(`preference RPC ${label} failures display readable text`, async () => {
    const h = createToolHarness("ios", { presentationHost: { rpc: async () => { throw cause; } } });
    await settle();
    const message = h.load("client/preferences.ts").useEnhancerPreferencesError();
    assert.match(message, /cannot read.*settings.*Reconnect.*Retry/);
    assert.doesNotMatch(message, /Connection lost|\[object Object\]|"code"/);
  });

  test(`expansion RPC ${label} failures display readable text`, async () => {
    const h = createToolHarness();
    const store = h.load("client/tool-expansion-store.ts").createToolExpansionStore();
    await store.connect(async () => { throw cause; }, async () => { throw cause; });
    assert.equal(store.getError(), expected ?? "Tool expansion choice could not be saved or loaded.");
  });

  test(`font probe ${label} failures display readable text`, async t => {
    const h = createToolHarness("ios", { fonts: true });
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    t.after(() => previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document);
    globalThis.document = {
      getElementById: () => ({}),
      fonts: { load: async () => { throw cause; } },
      createElement: () => ({ getContext: () => null }),
    };
    const text = await h.load("client/components/embed-fonts.ts").probeFonts();
    assert.ok(text.includes(expected ?? "Font could not be loaded."));
    assert.doesNotMatch(text, /\[object Object\]|"code"/);
  });
}
