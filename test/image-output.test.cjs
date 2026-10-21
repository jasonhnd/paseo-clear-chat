const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/real-hermes-image-listing.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const harness = options => createToolHarness("ios", { markdown: true, images: true, ...options });
const pictures = (h, tree) => h.nodes(tree, node => node.type === "Image");
const sourceLinks = (h, tree) => h.nodes(tree, node => node.props.accessibilityLabel?.startsWith("Show ") && node.props.accessibilityRole === "link");
const call = output => ({
  type: "tool_call", callId: "sample-image-call", name: "generate_art", status: "completed", error: null,
  detail: { type: "unknown", input: {}, output },
});
const missing = "ENOENT: no such file or directory, stat '/workspace/sample/image.png'";

for (const expand of [false, true]) {
  test(`captured Hermes listing has no image candidate or error preview when ${expand ? "expanded" : "collapsed"}`, async () => {
    const h = harness({ imageRpc: async () => { throw new Error(missing); } });
    const item = fixture.entries.find(entry => entry.item.type === "tool_call").item;
    const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
    assert.deepEqual(build(item).images, []);
    const mounted = h.mount(item, expand);
    await settle();
    const tree = mounted.render();
    assert.deepEqual(h.imageReads, []);
    assert.equal(pictures(h, tree).length, 0);
    assert.equal(sourceLinks(h, tree).length, 0);
    assert.doesNotMatch(h.text(tree), /ENOENT|\bstat\b/);
    if (expand) assert.ok(h.text(tree).includes("sample image.png"));
  });
}

for (const [label, imageRpc] of [
  ["missing file result", async () => ({ dataUri: null, width: null, height: null, bytes: null, error: missing })],
  ["permission failure", async () => ({ dataUri: null, width: null, height: null, bytes: null, error: "EACCES: permission denied, open '/workspace/sample/image.png'" })],
  ["RPC rejection", async () => { throw new Error(missing); }],
]) {
  test(`${label} removes the generated image card and hides system errors`, async () => {
    const h = harness({ imageRpc });
    const mounted = h.mount(call("/workspace/sample/image.png"), false);
    await settle();
    const tree = mounted.render();
    assert.equal(pictures(h, tree).length, 0);
    assert.equal(sourceLinks(h, tree).length, 0);
    assert.doesNotMatch(h.text(tree), /ENOENT|EACCES|\bstat\b|permission denied/);
  });
}

test("captured assistant reply preserves complete spaced paths and the remote URL", async () => {
  const h = harness();
  const item = fixture.entries.find(entry => entry.item.type === "assistant_message").item;
  const mounted = h.mount(item);
  await settle();
  const tree = mounted.render();
  assert.deepEqual(h.imageReads, [
    { cwd: "/workspace/demo", path: "/workspace/sample/sample image.png" },
    { cwd: "/workspace/demo", path: "./sample image.png" },
  ]);
  assert.equal(pictures(h, tree).length, 3);
  assert.ok(pictures(h, tree).some(image => image.props.source.uri === "https://example.org/avatar.png?size=80"));
});
