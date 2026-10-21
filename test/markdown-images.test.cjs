const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("upstream #3: image nodes retain alt text and HTTP(S), relative and data sources", () => {
  const { parseMarkdown, inlineToText } = createToolHarness().load("client/components/markdown/parse.ts");
  for (const src of ["http://example.org/chart.png", "https://example.org/chart.png", "./chart.png", "data:image/png;base64,aGVsbG8="]) {
    const [block] = parseMarkdown(`Before ![Chart](${src}) after`);
    assert.deepEqual(block.spans, [
      { kind: "text", text: "Before " },
      { kind: "image", alt: "Chart", src },
      { kind: "text", text: " after" },
    ]);
    assert.equal(inlineToText(block.spans), "Before Chart after");
  }
});

test("upstream #3: image escapes, empty alt and titles parse without changing links or code", () => {
  const { parseMarkdown } = createToolHarness().load("client/components/markdown/parse.ts");
  assert.deepEqual(parseMarkdown(String.raw`![A\] *chart*](https://example.org/a\(b\).png "Chart title")`)[0].spans,
    [{ kind: "image", alt: "A] *chart*", src: "https://example.org/a(b).png" }]);
  assert.deepEqual(parseMarkdown("![](<https://example.org/chart.png>)")[0].spans,
    [{ kind: "image", alt: "", src: "https://example.org/chart.png" }]);
  assert.deepEqual(parseMarkdown("[Guide](https://example.org/guide)")[0].spans,
    [{ kind: "link", href: "https://example.org/guide", spans: [{ kind: "text", text: "Guide" }] }]);
  assert.deepEqual(parseMarkdown("`![Chart](chart.png)`")[0].spans,
    [{ kind: "codeSpan", text: "![Chart](chart.png)" }]);
  for (const source of ["![Chart](chart.png", "![Chart", "!"]) {
    assert.equal(parseMarkdown(source)[0].spans.map(span => span.text).join(""), source);
  }
});

const imageNodes = (h, tree) => h.nodes(tree, node => node.type === "Image");
const dataImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

for (const platform of ["web", "ios", "android"]) {
  test(`upstream #3: ${platform} assistant replies render HTTP(S) and data images between prose`, () => {
    const h = createToolHarness(platform, { markdown: true });
    const sources = ["http://example.org/chart.png", "https://example.org/chart.png", dataImage];
    const { tree } = h.mount({ type: "assistant_message", text: `Before **the chart** ${sources.map(src => `![Chart](${src})`).join(" ")} after [Guide](https://example.org/guide)` }, false);
    assert.deepEqual(imageNodes(h, tree).map(image => image.props.source.uri), sources);
    for (const image of imageNodes(h, tree)) {
      assert.equal(image.props.accessibilityLabel, "Chart");
      assert.equal(image.props.resizeMode, "contain");
      assert.ok(image.props.style.height > 0);
    }
    assert.ok(h.text(tree).includes("Before"));
    assert.ok(h.text(tree).includes("the chart"));
    assert.ok(h.text(tree).includes("after"));
    assert.ok(h.nodes(tree, node => node.props.accessibilityRole === "link").some(link => h.text(link) === "Guide"));
    for (const text of h.nodes(tree, node => node.type === "Text")) {
      assert.equal(imageNodes(h, text).length, 0, "native images never sit inside Text");
    }
  });

  test(`upstream #3: ${platform} load failures show alt text and an address that opens`, () => {
    const h = createToolHarness(platform, { markdown: true });
    const src = "https://example.org/missing.png";
    const mounted = h.mount({ type: "assistant_message", text: `![Missing chart](${src})` }, false);
    imageNodes(h, mounted.tree)[0].props.onError({ nativeEvent: { error: "Not found" } });
    const tree = mounted.render();
    assert.equal(imageNodes(h, tree).length, 0);
    assert.ok(h.text(tree).includes("Missing chart"));
    assert.ok(h.text(tree).includes("The image could not be loaded."));
    const address = h.nodes(tree, node => node.props.accessibilityRole === "link")[0];
    assert.equal(h.text(address), src);
    const originalOpen = globalThis.open;
    const opened = [];
    try {
      if (platform === "web") globalThis.open = (...args) => opened.push(args);
      address.props.onPress();
      if (platform === "web") assert.deepEqual(opened, [[src, "_blank", "noopener,noreferrer"]]);
      else assert.deepEqual(h.links, [src]);
    } finally {
      if (originalOpen === undefined) delete globalThis.open;
      else globalThis.open = originalOpen;
    }
  });
}

test("upstream #3: relative and unsafe sources stay visible with a working copy-address action", async () => {
  for (const src of ["./chart.png", "/images/chart.png", "//example.org/chart.png", "file:///workspace/chart.png", "javascript:alert(1)", "data:text/html;base64,SGVsbG8="]) {
    const h = createToolHarness("ios", { markdown: true });
    const { tree } = h.mount({ type: "assistant_message", text: `![Chart](${src})` }, false);
    assert.equal(imageNodes(h, tree).length, 0, "never resolve against the host page or load a non-image data URL");
    assert.ok(h.text(tree).includes("Chart"));
    assert.ok(h.text(tree).includes("This image source is not supported."));
    const address = h.nodes(tree, node => node.props.accessibilityLabel === "Copy image address")[0];
    assert.equal(h.text(address), src);
    await address.props.onPress();
    assert.deepEqual(h.copies, [src]);
    assert.deepEqual(h.links, []);
  }
});

test("upstream #3: a failed data image and empty alt have visible labels and copyable addresses", async () => {
  const h = createToolHarness("ios", { markdown: true });
  const mounted = h.mount({ type: "assistant_message", text: `![](${dataImage})` }, false);
  assert.equal(imageNodes(h, mounted.tree)[0].props.accessibilityLabel, "Image");
  imageNodes(h, mounted.tree)[0].props.onError({ nativeEvent: { error: "Decode error" } });
  const tree = mounted.render();
  assert.ok(h.text(tree).includes("Image"));
  assert.ok(h.text(tree).includes("The image could not be loaded."));
  await h.nodes(tree, node => node.props.accessibilityLabel === "Copy image address")[0].props.onPress();
  assert.deepEqual(h.copies, [dataImage]);
});

test("upstream #3: images render in headings, nested formatting, lists, quotes and table cells", () => {
  const h = createToolHarness("ios", { markdown: true });
  const image = "![Chart](https://example.org/chart.png)";
  const { tree } = h.mount({ type: "assistant_message", text: `# Heading ${image}\n\n**Before ${image} after**\n\n- ${image}\n\n> ${image}\n\n| Chart |\n| --- |\n| ${image} |` }, false);
  assert.equal(imageNodes(h, tree).length, 5);
  assert.ok(h.text(tree).includes("Before"));
  assert.ok(h.text(tree).includes("after"));
  for (const text of h.nodes(tree, node => node.type === "Text")) assert.equal(imageNodes(h, text).length, 0);
});

test("upstream #3: image dimensions fit the available width and height without enlarging icons", () => {
  const h = createToolHarness("ios", { markdown: true });
  const mounted = h.mount({ type: "assistant_message", text: "![Chart](https://example.org/chart.png)" }, false);
  h.nodes(mounted.tree, node => typeof node.props.onLayout === "function")[0].props.onLayout({ nativeEvent: { layout: { width: 320 } } });
  const load = imageNodes(h, mounted.tree)[0].props.onLoad;
  for (const [width, height, expected] of [[800, 400, [320, 160]], [400, 800, [140, 280]], [16, 16, [16, 16]]]) {
    load({ nativeEvent: { source: { width, height } } });
    const style = imageNodes(h, mounted.render())[0].props.style;
    assert.deepEqual([style.width, style.height], expected);
  }
});

test("upstream #3: streaming source changes recover from failures and ignore stale error events", () => {
  const h = createToolHarness("ios", { markdown: true });
  const mounted = h.mount({ type: "assistant_message", text: "![Chart](https://example.org/old.png)" }, false);
  const oldError = imageNodes(h, mounted.tree)[0].props.onError;
  oldError({ nativeEvent: { error: "Not found" } });
  assert.equal(imageNodes(h, mounted.render()).length, 0);
  const data = { ...mounted.data, text: "![Chart](https://example.org/new.png)" };
  assert.equal(imageNodes(h, mounted.render(data))[0].props.source.uri, "https://example.org/new.png");
  oldError({ nativeEvent: { error: "Late error" } });
  assert.equal(imageNodes(h, mounted.render(data)).length, 1);
});
