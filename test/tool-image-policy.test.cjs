const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/real-hermes-readme-images.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const pictures = (h, tree) => h.nodes(tree, node => node.type === "Image");

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
        assert.equal(row.props.dataSet?.clearchattool ?? "closed", "closed");
      }
    });
  }
}
