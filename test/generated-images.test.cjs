const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Synthetic provider output only; no captured conversations or machine paths.
const embedded = "data:image/png;base64,c2FtcGxl";
const remote = "https://example.org/generated.png?version=2#preview";
const call = output => ({
  type: "tool_call", callId: "image-call", name: "generate_art", status: "completed", error: null,
  detail: { type: "unknown", input: { prompt: "Draw a blue square" }, output },
});
const harness = options => createToolHarness("ios", { markdown: true, images: true, ...options });
const pictures = (h, tree) => h.nodes(tree, node => node.type === "Image");
const sourceLinks = (h, tree) => h.nodes(tree, node => node.props.accessibilityRole === "link" &&
  (node.type === "Pressable" || node.props.accessibilityLabel?.startsWith("Open image")));
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const [label, block] of [
  ["MCP", { type: "image", mimeType: "image/png", data: "c2FtcGxl" }],
  ["Claude", { type: "image", source: { type: "base64", media_type: "image/png", data: "c2FtcGxl" } }],
  ["OpenAI", { type: "image_url", image_url: { url: remote } }],
]) {
  test(`upstream #12: ${label} image content blocks render from tool output with a source link`, () => {
    const h = harness();
    const { tree } = h.mount(call({ content: [{ type: "text", text: "Created an image." }, block] }), false);
    assert.equal(pictures(h, tree).length, 1);
    assert.equal(pictures(h, tree)[0].props.source.uri, label === "OpenAI" ? remote : embedded);
    assert.equal(sourceLinks(h, tree).length, 1);
    sourceLinks(h, tree)[0].props.onPress();
    assert.deepEqual(h.links, [label === "OpenAI" ? remote : embedded]);
    assert.deepEqual(h.imageReads, []);
  });
}

test("upstream #12: assistant image content blocks survive transformation without reply text", () => {
  const h = harness();
  const { tree, data } = h.mount({ type: "assistant_message", text: "", content: [{ type: "image", mimeType: "image/png", data: "c2FtcGxl" }] });
  assert.deepEqual(data.images, [{ source: embedded }]);
  assert.equal(pictures(h, tree)[0].props.source.uri, embedded);
  assert.equal(sourceLinks(h, tree).length, 1);
});

for (const [label, output, path] of [
  ["absolute", "Saved the image to /workspace/output.png", "/workspace/output.png"],
  ["relative", "Created: artifacts/output.webp", "artifacts/output.webp"],
  ["quoted", 'Saved "artifacts/final image.png"', "artifacts/final image.png"],
  ["file URI", "file:///workspace/final%20image.png", "/workspace/final image.png"],
  ["Windows", "Created C:\\artifacts\\output.png", "C:\\artifacts\\output.png"],
  ["nested", { result: { files: ["artifacts/output.png"] } }, "artifacts/output.png"],
]) {
  test(`upstream #12: ${label} image file output uses daemon bytes and a clickable file path`, async () => {
    const h = harness();
    const mounted = h.mount(call(output), false);
    assert.equal(pictures(h, mounted.tree).length, 0);
    assert.equal(sourceLinks(h, mounted.tree).length, 0);
    await settle();
    const tree = mounted.render();
    assert.equal(pictures(h, tree)[0].props.source.uri, embedded);
    assert.deepEqual(h.imageReads, [{ cwd: "/workspace/demo", path }]);
    sourceLinks(h, tree)[0].props.onPress();
    assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path }]);
  });
}

for (const channel of ["tool output", "assistant prose"]) {
  test(`upstream #12: unquoted image paths with spaces stay complete in ${channel}`, async () => {
    for (const path of [
      "/workspace/output/final image.png",
      "/workspace/output folder/final image.png",
      "artifacts/final image.webp",
      "./output folder/final image.png",
      "~/output/final image.png",
      "C:\\output folder\\final image.png",
    ]) {
      const correctImage = "data:image/png;base64,Y29ycmVjdA==";
      const h = harness({ imageRpc: async ({ path: requested }) => ({
        dataUri: requested === path ? correctImage : embedded,
        width: 32, height: 24, bytes: 7, error: null,
      }) });
      const output = `Saved image: ${path}`;
      const mounted = h.mount(channel === "tool output" ? call(output) : { type: "assistant_message", text: output }, false);
      await settle();
      const tree = mounted.render();
      assert.deepEqual(h.imageReads, [{ cwd: "/workspace/demo", path }], path);
      assert.equal(pictures(h, tree).length, 1, path);
      assert.equal(pictures(h, tree)[0].props.source.uri, correctImage, path);
      const links = sourceLinks(h, tree);
      assert.equal(links.length, 1, path);
      assert.equal(links[0].props.accessibilityLabel, `Show ${path} in the file manager`);
      assert.equal(h.text(links[0]), path);
      links[0].props.onPress();
      assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path }], path);
    }
  });
}

test("upstream #12: unquoted spaced paths stop at image boundaries and preserve adjacent URLs", async () => {
  const h = harness();
  const paths = ["/workspace/output/first image.png", "./artifacts/second image.webp"];
  const extract = h.load("client/generated-images.ts").extractGeneratedImages;
  assert.deepEqual(extract(`${paths[0]} and ${paths[1]}.`), paths.map(path => ({ source: path, path })));
  const mounted = h.mount(call(`Saved images:\n${paths[0]} and ${paths[1]}. Ready to view.\nRemote: ${remote}`), false);
  await settle();
  const tree = mounted.render();
  assert.deepEqual(h.imageReads, paths.map(path => ({ cwd: "/workspace/demo", path })));
  assert.equal(pictures(h, tree).length, 3);
  const links = sourceLinks(h, tree);
  assert.deepEqual(links.map(link => h.text(link)).sort(), [...paths, remote].sort());
  links.forEach(link => link.props.onPress());
  assert.deepEqual(h.reveals, paths.map(path => ({ cwd: "/workspace/demo", path })));
  assert.deepEqual(h.links, [remote]);
});

test("upstream #12: remote URLs in assistant Markdown render once and open the complete source URL", () => {
  const h = harness();
  const { tree } = h.mount({ type: "assistant_message", text: `The image is ready.\n\n![Generated square](${remote})\n\n${remote}` });
  assert.equal(pictures(h, tree).length, 1);
  assert.equal(pictures(h, tree)[0].props.source.uri, remote);
  sourceLinks(h, tree)[0].props.onPress();
  assert.deepEqual(h.links, [remote]);
  assert.deepEqual(h.imageReads, []);
});

test("upstream #12: explicit image URLs do not require a filename extension", () => {
  const h = harness();
  const source = "https://example.org/render?id=sample";
  for (const item of [
    call({ content: [{ type: "image", source: { type: "url", url: source } }] }),
    { type: "assistant_message", text: `![Generated image](${source})` },
  ]) {
    const { tree } = h.mount(item);
    assert.equal(pictures(h, tree)[0].props.source.uri, source);
    sourceLinks(h, tree)[0].props.onPress();
    assert.deepEqual(h.links, [source]);
  }
});

test("upstream #12: assistant local Markdown images retain spaces and use the agent cwd", async () => {
  const h = harness();
  const mounted = h.mount({ type: "assistant_message", text: "Created ![Square](<artifacts/final image.png>)" });
  await settle();
  const tree = mounted.render();
  assert.equal(pictures(h, tree).length, 1);
  assert.doesNotMatch(h.text(tree), /not supported/);
  assert.deepEqual(h.imageReads, [{ cwd: "/workspace/demo", path: "artifacts/final image.png" }]);
  sourceLinks(h, tree)[0].props.onPress();
  assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path: "artifacts/final image.png" }]);
});

test("upstream #12: Markdown parsing preserves image addresses with spaces and titles", () => {
  const h = harness();
  const parse = h.load("client/components/markdown/parse.ts").parseMarkdown;
  assert.equal(parse('![Square](<artifacts/final image.png> "Preview")')[0].spans[0].src, "artifacts/final image.png");
});

for (const [label, imageRpc] of [
  ["RPC rejection", async () => { throw new Error("Image unavailable"); }],
  ["missing file", async () => ({ dataUri: null, width: null, height: null, bytes: null, error: "File not found" })],
  ["size limit", async () => ({ dataUri: null, width: 1200, height: 800, bytes: 4_000_000, error: "Too large to preview" })],
]) {
  test(`upstream #12: ${label} removes the unavailable image card`, async () => {
    const h = harness({ imageRpc });
    const mounted = h.mount(call("artifacts/output.png"), false);
    await settle();
    const tree = mounted.render();
    assert.equal(pictures(h, tree).length, 0);
    assert.equal(sourceLinks(h, tree).length, 0);
    assert.doesNotMatch(h.text(tree), /Image unavailable|File not found|Too large to preview/);
  });
}

for (const source of [remote, embedded]) {
  test(`upstream #12: ${source === remote ? "remote load" : "embedded decode"} failure removes the image card`, () => {
    const h = harness();
    const mounted = h.mount(call({ content: [{ type: "image_url", image_url: { url: source } }] }), false);
    pictures(h, mounted.tree)[0].props.onError({ nativeEvent: { error: "Decode failed" } });
    const tree = mounted.render();
    assert.equal(pictures(h, tree).length, 0);
    assert.equal(sourceLinks(h, tree).length, 0);
    assert.doesNotMatch(h.text(tree), /Decode failed|could not be displayed/);
  });
}

test("upstream #12: a new source can load after the preceding image failed", () => {
  const h = harness();
  const mounted = h.mount({ type: "assistant_message", text: remote });
  pictures(h, mounted.tree)[0].props.onError();
  assert.equal(pictures(h, mounted.render()).length, 0);
  const tree = mounted.render({ text: "https://example.org/next.png" });
  assert.equal(pictures(h, tree)[0].props.source.uri, "https://example.org/next.png");
});

test("upstream #12: extraction deduplicates sources, ignores unsafe schemes, and leaves inputs alone", () => {
  const h = harness();
  const extract = h.load("client/generated-images.ts").extractGeneratedImages;
  assert.deepEqual(extract([remote, { type: "image_url", image_url: { url: remote } }, "javascript:alert(1).png", "data:text/html;base64,AAAA"]), [{ source: remote }]);
  assert.deepEqual(extract("Read the documentation at https://example.org/guide"), []);
  const circular = { output: remote }; circular.self = circular;
  assert.deepEqual(extract(circular), [{ source: remote }]);
  const item = call("No image was generated.");
  item.detail.input.reference = "artifacts/input.png";
  assert.equal(pictures(h, h.mount(item).tree).length, 0);
});

test("upstream #12: image extension checks preserve spaces and strip only line selectors", () => {
  const h = harness();
  const { isImagePath } = h.load("client/image-file.ts");
  const { stripFileSelector } = h.load("shared/file-path.ts");
  for (const path of ["artifacts/final image.png:1-20", "C:\\artifacts\\final image.PNG:2", "artifacts/final image.png 1-20"]) {
    assert.equal(isImagePath(path), true);
    assert.match(stripFileSelector(path), /final image\.png$/i);
  }
  assert.equal(isImagePath("artifacts/output.txt"), false);
});

test("upstream #12: embedded web sources open an inert image viewer in a new tab", async t => {
  const h = createToolHarness("web", { images: true, markdown: true });
  const { tree } = h.mount(call({ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" }), false);
  const opened = [], blobs = [], revoked = [], timers = [];
  const previous = globalThis.open;
  globalThis.open = (...args) => opened.push(args);
  t.after(() => { if (previous) globalThis.open = previous; else delete globalThis.open; });
  t.mock.method(URL, "createObjectURL", blob => { blobs.push(blob); return "blob:image-preview"; });
  t.mock.method(URL, "revokeObjectURL", value => revoked.push(value));
  t.mock.method(globalThis, "setTimeout", callback => { timers.push(callback); return 0; });
  sourceLinks(h, tree)[0].props.onPress();
  assert.deepEqual(opened, [["blob:image-preview", "_blank", "noopener,noreferrer"]]);
  const viewer = await blobs[0].text();
  assert.match(viewer, /default-src 'none'; img-src data: blob:/);
  assert.match(viewer, /<img[^>]+src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
  timers[0]();
  assert.deepEqual(revoked, ["blob:image-preview"]);
});

test("upstream #12: daemon image reads preserve complete files and filenames with spaces", async t => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const root = fs.mkdtempSync(join(tmpdir(), "image-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(join(root, "generated image.png"), bytes);
  const handlers = new Map();
  const h = harness();
  h.load("index.server.ts").default({ registerSettings() {}, handle(contract, handler) { handlers.set(contract.name, handler); } });
  const read = handlers.get("file.image");
  const file = await read({ cwd: root, path: "generated image.png:1-20" });
  assert.equal(file.error, null);
  assert.equal(file.width, 1);
  assert.equal(file.height, 1);
  assert.equal(file.dataUri, `data:image/png;base64,${bytes.toString("base64")}`);
  const missing = await read({ cwd: root, path: "missing.png" });
  assert.equal(missing.dataUri, null);
  assert.match(missing.error, /ENOENT/);
  fs.truncateSync(join(root, "generated image.png"), 4_000_000);
  const oversized = await read({ cwd: root, path: "generated image.png" });
  assert.equal(oversized.dataUri, null);
  assert.equal(oversized.error, "Too large to preview");
});

test("upstream #12: local image decode failures remove the image card", async () => {
  const h = harness();
  const mounted = h.mount(call("artifacts/output.png"), false);
  await settle();
  pictures(h, mounted.render())[0].props.onError();
  const tree = mounted.render();
  assert.equal(pictures(h, tree).length, 0);
  assert.equal(sourceLinks(h, tree).length, 0);
  assert.doesNotMatch(h.text(tree), /could not be displayed/);
});

test("upstream #12: explicit wrap-up replies preview output images once", () => {
  const h = harness();
  const item = call(`![Generated image](${remote})`);
  item.name = "wrap_up";
  const { tree } = h.mount(item, false);
  assert.equal(pictures(h, tree).length, 1);
  sourceLinks(h, tree)[0].props.onPress();
  assert.deepEqual(h.links, [remote]);
});

test("upstream #12: visible tool images terminate compact collapsed-row sequences", () => {
  const h = harness();
  const { tree } = h.mount(call(remote), false);
  const row = h.nodes(tree, node => node.props.testID === "tool-timeline-item")[0];
  assert.equal(row.props.dataSet.clearchattool, "open");
});

test("upstream #12: escaped Markdown image addresses do not create a duplicate gallery preview", () => {
  const h = harness();
  const { tree } = h.mount({ type: "assistant_message", text: String.raw`![Square](https://example.org/square\(blue\).png)` });
  assert.equal(pictures(h, tree).length, 1);
  assert.equal(pictures(h, tree)[0].props.source.uri, "https://example.org/square(blue).png");
});

test("upstream #12: iOS image source links remain tappable before and after load failure", () => {
  const h = harness();
  const mounted = h.mount({ type: "assistant_message", text: `![Square](${remote})` });
  const success = sourceLinks(h, mounted.tree)[0];
  assert.equal(success.props.selectable, false);
  success.props.onPress();
  pictures(h, mounted.tree)[0].props.onError();
  const failure = sourceLinks(h, mounted.render())[0];
  assert.equal(failure.props.selectable, false);
  failure.props.onPress();
  assert.deepEqual(h.links, [remote, remote]);
});
