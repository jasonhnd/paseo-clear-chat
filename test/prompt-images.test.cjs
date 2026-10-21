const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Handwritten payloads exercise the actual transformer, schema and prompt UI.
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const remote = "https://example.org/attachment.png";
const prompt = fields => ({ type: "user_message", text: "Inspect the attachments.", messageId: "sample-prompt", ...fields });
const thumbnails = (h, tree) => h.nodes(tree, node => node.type === "Image" && node.props.accessibilityLabel === "Attached image");
const visibleText = (h, tree) => h.text(tree).replace(/\s+/g, " ");

for (const platform of ["web", "ios", "android"]) {
  test(`upstream #17: one pasted image survives the prompt pipeline on ${platform}`, () => {
    const h = createToolHarness(platform, { userMessage: true });
    const mounted = h.mount(prompt({ images: [png] }));
    assert.equal(mounted.data.imageCount, 1);
    assert.equal(mounted.data.messageId, "sample-prompt");
    assert.deepEqual(thumbnails(h, mounted.tree).map(node => node.props.source.uri), [png]);
    assert.match(visibleText(h, mounted.tree), /1 image attached/);
    assert.match(visibleText(h, mounted.tree), /Inspect the attachments\./);
  });

  test(`upstream #17: multiple image formats keep their thumbnails and total on ${platform}`, () => {
    const h = createToolHarness(platform, { userMessage: true });
    const { tree, data } = h.mount(prompt({ content: [
      { type: "text", text: "https://example.org/mentioned.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.split(",")[1] } },
      { type: "image_url", image_url: { url: remote } },
      { type: "input_image", image_url: "https://example.org/signed-attachment?id=sample" },
    ] }));
    assert.equal(data.imageCount, 3);
    assert.deepEqual(thumbnails(h, tree).map(node => node.props.source.uri), [png, remote, "https://example.org/signed-attachment?id=sample"]);
    assert.match(visibleText(h, tree), /3 images attached/);
  });

  test(`upstream #17: missing image data still has a visible count on ${platform}`, () => {
    const h = createToolHarness(platform, { userMessage: true });
    for (const fields of [
      { images: [{}] },
      { images: [null, { type: "image", source: null }] },
      { attachments: [{ type: "image", mimeType: "image/png" }, { type: "image", data: "" }] },
      { imageCount: 2 },
    ]) {
      const { tree, data } = h.mount(prompt(fields));
      const count = fields.images?.length ?? fields.attachments?.length ?? fields.imageCount;
      assert.equal(data.imageCount, count);
      assert.equal(thumbnails(h, tree).length, 0);
      assert.match(visibleText(h, tree), new RegExp(`${count} ${count === 1 ? "image" : "images"} attached`));
    }
  });

  test(`upstream #17: mixed available and unavailable images retain the full total on ${platform}`, () => {
    const h = createToolHarness(platform, { userMessage: true });
    const { tree, data } = h.mount(prompt({ images: [{ uri: png }, { mimeType: "image/png" }, { uri: "unsupported:sample" }] }));
    assert.equal(data.imageCount, 3);
    assert.deepEqual(data.images, [png]);
    assert.equal(thumbnails(h, tree).length, 1);
    assert.match(visibleText(h, tree), /3 images attached/);
    const extracted = h.load("client/prompt-images.ts").extractPromptImages(prompt({ images: [png, {}] }));
    assert.equal(extracted.hasUnrenderable, true);
  });

  test(`upstream #17: image load failures leave the count visible on ${platform}`, () => {
    const h = createToolHarness(platform, { userMessage: true });
    const mounted = h.mount(prompt({ images: [png, remote] }));
    const [first, second] = thumbnails(h, mounted.tree);
    first.props.onError({ nativeEvent: { error: "Cannot decode image" } });
    const partial = mounted.render();
    assert.deepEqual(thumbnails(h, partial).map(node => node.props.source.uri), [remote]);
    assert.match(visibleText(h, partial), /2 images attached/);
    second.props.onError({ nativeEvent: { error: "Image unavailable" } });
    const failed = mounted.render();
    assert.equal(thumbnails(h, failed).length, 0);
    assert.match(visibleText(h, failed), /2 images attached/);
  });
}

test("upstream #17: plain text content and empty image arrays add no attachment notice", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const { tree, data } = h.mount(prompt({ images: [], content: [{ type: "text", text: "A description of an image." }] }));
  assert.equal(data.imageCount, undefined);
  assert.doesNotMatch(visibleText(h, tree), /images? attached/);
  assert.equal(thumbnails(h, tree).length, 0);
});

test("upstream #17: image-only prompts and older payloads still announce their attachments", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const mounted = h.mount(prompt({ text: "", images: [png] }));
  const { imageCount, ...legacy } = mounted.data;
  assert.equal(imageCount, 1);
  assert.equal(thumbnails(h, mounted.render(legacy)).length, 1);
  assert.match(visibleText(h, mounted.render(legacy)), /1 image attached/);
});

test("upstream #17: a failed single thumbnail keeps its notice and a new source can render", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const mounted = h.mount(prompt({ images: [remote] }));
  thumbnails(h, mounted.tree)[0].props.onError({ nativeEvent: { error: "Not found" } });
  const failed = mounted.render();
  assert.equal(thumbnails(h, failed).length, 0);
  assert.match(visibleText(h, failed), /1 image attached/);
  const updated = mounted.render({ ...mounted.data, images: [png] });
  assert.deepEqual(thumbnails(h, updated).map(node => node.props.source.uri), [png]);
});

test("upstream #17: image metadata counts entries once and retains a larger reported total", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const item = prompt({ images: [{ uri: png, url: png, mimeType: "image/png", data: png.split(",")[1] }], imageCount: 3 });
  const extracted = h.load("client/prompt-images.ts").extractPromptImages(item);
  assert.deepEqual(extracted, { uris: [png], count: 3, hasUnrenderable: true, hasOtherAttachments: false });
  const { tree } = h.mount(item);
  assert.equal(thumbnails(h, tree).length, 1);
  assert.match(visibleText(h, tree), /3 images attached/);
});

test("upstream #17: image counts cannot hide available sources or become invalid schema data", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const schema = h.renderers.get("omp-user-message").schema;
  for (const imageCount of [-1, 1.5, "2", NaN, Infinity]) {
    assert.equal(schema.safeParse({ text: "Sample", imageCount }).success, false);
    assert.equal(h.load("client/prompt-images.ts").extractPromptImages(prompt({ imageCount })).count, null);
  }
  const mounted = h.mount(prompt({ images: [png, remote], imageCount: 1 }));
  assert.equal(mounted.data.imageCount, 2);
  assert.match(visibleText(h, mounted.render({ ...mounted.data, imageCount: 0 })), /2 images attached/);
});

test("upstream #17: stripped host payloads stay native because their image count is unknown", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const item = prompt();
  const before = structuredClone(item);
  assert.equal(h.load("client/prompt-images.ts").extractPromptImages(item).count, null);
  assert.equal(h.transformers.get("user_message").transform({ item }), undefined);
  assert.deepEqual(item, before);
  for (const fields of [{ imageCount: 0 }, { images: [] }]) {
    const { tree, data } = h.mount(prompt(fields));
    assert.equal(data.imageCount, undefined);
    assert.doesNotMatch(visibleText(h, tree), /images? attached/);
  }
});

test("upstream #17: non-image attachments and disabled enhanced prompts remain with the host", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const transform = item => h.transformers.get("user_message").transform({ item });
  assert.equal(transform(prompt({ attachments: [{ type: "file", mimeType: "application/pdf", name: "sample.pdf" }] })), undefined);
  assert.equal(transform(prompt({ images: [png], attachments: [{ type: "file", name: "sample.pdf" }] })), undefined);
  for (const key of ["content", "blocks", "parts"]) {
    assert.equal(transform(prompt({ [key]: [{ type: "image", source: { uri: png } }, { type: "file", name: "sample.pdf" }] })), undefined);
  }
  h.preferences.enhancedUserBubble = false;
  assert.equal(transform(prompt({ images: [png] })), undefined);
});
