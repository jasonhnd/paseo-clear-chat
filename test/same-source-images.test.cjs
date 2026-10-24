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
