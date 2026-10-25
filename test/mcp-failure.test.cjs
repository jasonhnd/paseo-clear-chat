const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

// Minimal projected provider shapes and v0.12.0 source links are in each fixture.
for (const provider of ["claude", "codex", "omp"]) {
  const fixture = require(`./fixtures/${provider}-mcp-failure.json`);
  for (const [index, item] of fixture.items.entries()) {
    for (const platform of ["web", "ios", "android"]) {
      test(`${platform}: ${provider} MCP failure ${index} appears once and preserves provider error detail/copy`, async t => {
        const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
        t.after(() => h.unmount());
        const before = structuredClone(item);
        assert.deepEqual(Object.keys(item.detail).sort(), ["input", "output", "type"]);
        if (provider === "claude") {
          assert.equal(item.detail.output, null);
          assert.equal(item.error.tool_use_id, item.callId);
        }
        const mounted = h.mount(item, false);
        const marker = fixture.expected.split("\n")[0];
        assert.equal(h.text(mounted.tree).split(marker).length - 1, 1, "error occurs exactly once on the card");
        const data = h.load("client/tool-call-data.ts").buildLiveToolCallData(mounted.data);
        assert.equal(data.error, fixture.expected);
        if (provider === "omp") {
          assert.equal(data.tool, "unknown");
          assert.equal(fixture.expected, item.detail.output.content[0].text.split("\n")[0].slice(0, 240));
        }
        byId(h, mounted.tree, "tool-summary-row").props.onPress();
        byId(h, mounted.render(), "tool-summary-row").props.onPress();
        const details = mounted.render();
        const errorText = h.text(byId(h, details, "step-detail-error"));
        assert.equal(errorText, fixture.expected.replace(/\n$/, ""));
        if (provider === "omp") assert.equal(errorText.includes("\n"), false);
        await byId(h, details, "step-detail-copy-error").props.onPress();
        assert.equal(h.copies.at(-1), fixture.expected);
        assert.deepEqual(item, before);
      });
    }
  }
}
