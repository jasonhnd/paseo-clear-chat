const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/real-hermes-image-listing.json");
const pathReply = require("./fixtures/real-hermes-image-path-reply.json");
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
  test(`guessed tool-output image: ${label} hides the card and system errors`, async () => {
    const h = harness({ imageRpc });
    const mounted = h.mount(call("/workspace/sample/image.png"), false);
    await settle();
    const tree = mounted.render();
    assert.equal(pictures(h, tree).length, 0);
    assert.equal(sourceLinks(h, tree).length, 0);
    assert.doesNotMatch(h.text(tree), /ENOENT|EACCES|\bstat\b|permission denied/);
  });
}

test("guessed tool-output image hides unreadable files; explicit reply Markdown and paths show reason and address", async () => {
  for (const imageRpc of [
    async () => ({ dataUri: null, width: null, height: null, bytes: null, error: missing }),
    async () => { throw new Error(missing); },
  ]) {
    const path = "/workspace/sample/image.png";
    const h = harness({ imageRpc });
    const guessed = h.mount(call(path), false);
    await settle();
    const toolTree = guessed.render();
    assert.equal(pictures(h, toolTree).length, 0);
    assert.equal(sourceLinks(h, toolTree).length, 0, "a guessed candidate must not leave a card header");
    assert.doesNotMatch(h.text(toolTree), /could not be loaded|ENOENT|\bstat\b/);

    for (const item of [
      { type: "assistant_message", text: `![Missing chart](${path})` },
      { type: "assistant_message", text: `The chart is ready: ${path}` },
      { type: "tool_call", name: "wrap_up", status: "completed", detail: {
        type: "unknown", input: { response: JSON.stringify({ image: path }) }, output: "Acknowledged",
      } },
    ]) {
      const reply = h.mount(item);
      await settle();
      const replyTree = reply.render();
      assert.deepEqual(h.imageReads, [{ cwd: "/workspace/demo", path }]);
      assert.equal(pictures(h, replyTree).length, 0);
      assert.ok(h.text(replyTree).includes("The image could not be loaded."));
      if (item.text?.startsWith("![")) assert.ok(h.text(replyTree).includes("Missing chart"));
      const address = h.nodes(replyTree, node => node.props.accessibilityLabel === "Copy image address");
      assert.equal(address.length, 1, "an explicit image must retain its address action");
      assert.equal(h.text(address[0]), path);
      await address[0].props.onPress();
      assert.deepEqual(h.copies, [path]);
      assert.doesNotMatch(h.text(replyTree), /ENOENT|\bstat\b/);
    }
  }
});

for (const platform of ["web", "ios", "android"]) {
  test(`explicit reply image: ${platform} local decode failures retain reason, alt and address`, async () => {
    const h = createToolHarness(platform, { markdown: true, images: true });
    const path = "artifacts/chart.png";
    for (const text of [`![Chart](${path})`, `Chart: ${path}`]) {
      const mounted = h.mount({ type: "assistant_message", text });
      await settle();
      const image = pictures(h, mounted.render())[0];
      image.props.onError({ nativeEvent: { error: missing } });
      const tree = mounted.render();
      assert.equal(pictures(h, tree).length, 0);
      assert.ok(h.text(tree).includes("The image could not be loaded."));
      if (text.startsWith("![")) assert.ok(h.text(tree).includes("Chart"));
      const address = h.nodes(tree, node => node.props.accessibilityLabel === "Copy image address")[0];
      assert.equal(h.text(address), path);
      assert.doesNotMatch(h.text(tree), /ENOENT|\bstat\b/);
    }
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

for (const platform of ["web", "ios", "android"]) {
  test(`captured plain-path reply still shows both images on ${platform}`, async () => {
    const h = createToolHarness(platform, { markdown: true, images: true });
    const mounted = h.mount(pathReply);
    await settle();
    assert.deepEqual(h.imageReads, [
      { cwd: "/workspace/demo", path: "/workspace/sample/image.png" },
      { cwd: "/workspace/demo", path: "image.png" },
    ]);
    assert.equal(pictures(h, mounted.render()).length, 2);
  });
}

for (const output of [
  "sample image.png",
  "Found sample image.png in the directory.",
  "image.png other.png",
  "output folder/sample image.png",
  "Saved output folder/sample image.png",
  '-rw-r--r--@  1 visitor  staff  128 Jan 01 12:00 "sample image.png"',
  "-rw-r--r--  1 visitor  staff  128 Jan 01 2026 /workspace/sample image.png",
  "lrwxrwxrwx  1 visitor  staff  128 Jan 01 12:00 sample.png -> ./target image.png",
]) {
  test(`ambiguous tool text does not create an image path: ${output}`, () => {
    const h = harness();
    const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
    assert.deepEqual(build(call(output)).images, []);
  });
}

for (const output of ["image.png", { images: ["sample image.png"] }, { type: "image", path: "sample image.png" }]) {
  test(`complete standalone or explicit tool image paths remain supported: ${JSON.stringify(output)}`, () => {
    const h = harness();
    const images = h.load("client/tool-call-data.ts").buildLiveToolCallData(call(output)).images;
    const path = typeof output === "string" ? output : "sample image.png";
    assert.deepEqual(images, [{ source: path, path }]);
  });
}

test("explicit reply image: a failed replacement shows reason and address without borrowing the preceding preview", async () => {
  let finish;
  const h = harness({ imageRpc: ({ path }) => path.endsWith("first.png")
    ? Promise.resolve({ dataUri: "data:image/png;base64,c2FtcGxl", width: 32, height: 24, bytes: 6, error: null })
    : new Promise(resolve => { finish = resolve; }) });
  const mounted = h.mount({ type: "assistant_message", text: "/workspace/first.png" });
  assert.equal(sourceLinks(h, mounted.tree).length, 0);
  await settle();
  assert.equal(pictures(h, mounted.render()).length, 1);
  const replacement = { ...mounted.data, text: "/workspace/missing.png" };
  assert.equal(pictures(h, mounted.render(replacement)).length, 0);
  assert.equal(sourceLinks(h, mounted.render(replacement)).length, 0);
  finish({ dataUri: null, width: null, height: null, bytes: null, error: missing });
  await settle();
  const tree = mounted.render(replacement);
  assert.equal(sourceLinks(h, tree).length, 0);
  assert.ok(h.text(tree).includes("The image could not be loaded."));
  const address = h.nodes(tree, node => node.props.accessibilityLabel === "Copy image address")[0];
  assert.equal(h.text(address), "/workspace/missing.png");
  assert.doesNotMatch(h.text(tree), /ENOENT|\bstat\b/);
});

for (const tool of ["read", "write"]) {
  test(`failed ${tool} image previews also hide the card and filesystem error`, async () => {
    const h = harness({ imageRpc: async () => { throw new Error(missing); } });
    const mounted = h.mount({ type: "tool_call", name: tool, status: "completed", detail: {
      type: tool, filePath: "/workspace/sample/image.png", content: "Image file",
    } });
    await settle();
    const tree = mounted.render();
    assert.equal(pictures(h, tree).length, 0);
    assert.equal(sourceLinks(h, tree).length, 0);
    assert.doesNotMatch(h.text(tree), /ENOENT|\bstat\b/);
  });
}
