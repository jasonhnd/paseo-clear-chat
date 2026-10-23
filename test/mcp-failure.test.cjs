const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

// Claude fixture derives from the real projected shape documented in docs/STEP-DETAIL-FIELDS.md.
// Paseo v0.12.0 claude/agent.ts:5581-5590 stores the failed mcp_tool_result block in error;
// :5638-5671 omits detail.output on failure (full source URLs are in the fixture).
for (const provider of ["claude", "codex", "omp"]) {
  const fixture = require(`./fixtures/${provider}-mcp-failure.json`);
  for (const [index, item] of fixture.items.entries()) {
    for (const platform of ["web", "ios", "android"]) {
      test(`${platform}: ${provider} MCP failure ${index} appears once and preserves full detail/copy`, async t => {
        const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
        t.after(() => h.unmount());
        const before = structuredClone(item);
        if (provider === "claude") assert.equal(Object.hasOwn(item.detail, "output"), false);
        const mounted = h.mount(item, false);
        const marker = fixture.expected.split("\n")[0];
        assert.equal(h.text(mounted.tree).split(marker).length - 1, 1, "error occurs exactly once on the card");
        assert.equal(h.load("client/tool-call-data.ts").buildLiveToolCallData(mounted.data).error, fixture.expected);
        byId(h, mounted.tree, "tool-summary-row").props.onPress();
        byId(h, mounted.render(), "tool-summary-row").props.onPress();
        const details = mounted.render();
        assert.equal(h.text(byId(h, details, "step-detail-error")), fixture.expected.replace(/\n$/, ""));
        await byId(h, details, "step-detail-copy-error").props.onPress();
        assert.equal(h.copies.at(-1), fixture.expected);
        assert.deepEqual(item, before);
      });
    }
  }
}
