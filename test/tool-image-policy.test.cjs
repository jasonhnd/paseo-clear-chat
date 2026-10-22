const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/real-hermes-readme-images.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const pictures = (h, tree) => h.nodes(tree, node => node.type === "Image");
const call = (name, detail) => ({ type: "tool_call", callId: "sample-image-policy", name, status: "completed", error: null, detail });

for (const platform of ["web", "ios", "android"]) {
  for (const expanded of [false, true]) {
    test(`reading text that mentions image paths shows no previews on ${platform} when ${expanded ? "expanded" : "collapsed"}`, async () => {
      const h = createToolHarness(platform, { markdown: true, images: true });
      const item = fixture.entries[0].item;
      const data = h.load("client/tool-call-data.ts").buildLiveToolCallData(item);
      assert.deepEqual(data.images, []);
      const mounted = h.mount(item, expanded);
      await settle();
      const tree = mounted.render();
      assert.deepEqual(h.imageReads, []);
      assert.equal(pictures(h, tree).length, 0);
      assert.equal(h.nodes(tree, node => node.props.testID === "generated-images").length, 0);
      if (expanded) {
        assert.ok(h.text(tree).includes("images/overview.png"));
        assert.ok(h.text(tree).includes("images/conversation.png"));
      } else {
        const row = h.nodes(tree, node => node.props.testID === "tool-timeline-item")[0];
        if (platform === "web") assert.equal(row.props.dataSet.clearchattool, "collapsed");
      }
    });
  }
}

for (const tool of ["read", "write"]) {
  test(`reading or writing the image file itself shows its preview: ${tool}`, async () => {
    const h = createToolHarness("ios", { markdown: true, images: true });
    const path = "artifacts/sample.png";
    const mounted = h.mount(call(tool, { type: tool, filePath: path, content: "Image file" }), true);
    await settle();
    assert.deepEqual(h.imageReads, [{ cwd: "/workspace/demo", path }]);
    assert.equal(pictures(h, mounted.render()).length, 1);
  });
}

for (const tool of ["read", "write", "edit", "read_file", "write_file"]) {
  test(`image paths inside text file contents never become previews: ${tool}`, async () => {
    const h = createToolHarness("ios", { markdown: true, images: true });
    const content = [
      "![Example](images/example.png)",
      "https://example.org/example.png",
      "/workspace/sample/example.png",
      "Generated image: artifacts/example.png",
      '{"type":"image","path":"artifacts/example.png"}',
    ].join("\n");
    const mounted = h.mount(call(tool, { type: tool.endsWith("_file") ? "unknown" : tool,
      input: { path: "sample.md", content }, content, output: content }), true);
    await settle();
    assert.deepEqual(h.imageReads, []);
    assert.equal(pictures(h, mounted.render()).length, 0);
  });
}

for (const output of [
  "artifacts/example.png",
  "https://example.org/example.png",
  "![Example](artifacts/example.png)",
  { result: { path: "artifacts/example.png" } },
  { images: ["artifacts/example.png"] },
  "No image was generated. Reference: artifacts/example.png",
]) {
  test(`an incidental image address without a generation report shows no preview: ${JSON.stringify(output)}`, async () => {
    const h = createToolHarness("ios", { markdown: true, images: true });
    const mounted = h.mount(call("inspect_result", { type: "unknown", input: {}, output }), false);
    await settle();
    assert.deepEqual(h.imageReads, []);
    assert.equal(pictures(h, mounted.render()).length, 0);
  });
}

for (const [name, output] of [
  ["render_result", "Generated image: artifacts/example.png"],
  ["render_result", "Image generated: artifacts/example.png"],
  ["render_result", { generated_images: ["artifacts/example.png"] }],
  ["render_result", { type: "generated_image", path: "artifacts/example.png" }],
  ["mcp__image_gen__imagegen", "artifacts/example.png"],
]) {
  test(`a tool that explicitly reports generating an image shows its preview: ${name} ${JSON.stringify(output)}`, async () => {
    const h = createToolHarness("ios", { markdown: true, images: true });
    const mounted = h.mount(call(name, { type: "unknown", input: {}, output }), false);
    await settle();
    assert.deepEqual(h.imageReads, [{ cwd: "/workspace/demo", path: "artifacts/example.png" }]);
    assert.equal(pictures(h, mounted.render()).length, 1);
  });
}
