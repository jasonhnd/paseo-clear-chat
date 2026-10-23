const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/derived-same-source-images.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

for (const platform of ["web", "ios", "android"]) {
  for (const original of fixture.items) {
    for (const source of ["https://example.org/chart.png", "/workspace/chart.png"]) {
      test(`${platform} ${original.type} retains each occurrence of ${source}`, async () => {
        const item = JSON.parse(JSON.stringify(original).replaceAll("https://example.org/chart.png", source));
        const h = createToolHarness(platform, { markdown: true, images: true });
        const mounted = h.mount(item, false);
        await new Promise(resolve => setImmediate(resolve));
        const images = () => h.nodes(mounted.render(), node => node.type === "Image");
        assert.equal(images().length, 2);
        images()[0].props.onError({ nativeEvent: { error: "Decode failed" } });
        assert.equal(images().length, 1, "each occurrence owns its load state");
      });
    }
  }
}

for (const source of ["https://example.org/chart.png", "/workspace/chart.png"]) {
  test(`tool output image lists preserve repeated ${source}`, async () => {
    const h = createToolHarness("ios", { markdown: true, images: true });
    const item = structuredClone(fixture.items[1]);
    item.detail.output = { content: [
      { type: "image", source: { type: "url", url: source } },
      { type: "image", source: { type: "url", url: source } },
    ] };
    const mounted = h.mount(item, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.nodes(mounted.render(), node => node.type === "Image").length, 2);
    const extract = h.load("client/generated-images.ts").extractGeneratedImages;
    const block = item.detail.output.content[0];
    assert.equal(extract([block, block], { toolOutput: true }).length, 2);
    const cyclic = [block];
    cyclic.push(cyclic);
    assert.equal(extract(cyclic, { toolOutput: true }).length, 1);
  });
}
