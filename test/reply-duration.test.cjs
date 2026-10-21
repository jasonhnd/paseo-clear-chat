const assert = require("node:assert/strict");
const test = require("node:test");
const entries = require("./fixtures/real-claude-turn-timing.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Read-only capture of the comparison conversation, from both canonical and
// projected timeline APIs. All prose, paths, IDs and dates were replaced;
// keys, nesting, array lengths, value types and relative times are unchanged.
const settle = () => new Promise(resolve => setImmediate(resolve));
function timingHost() {
  const requests = [];
  const agent = { status: "idle", activeTurn: null, cwd: "/workspace/sample" };
  const paseo = { agents: { ref: () => ({ timeline: {
    async refetch(options) {
      requests.push(options);
      return { entries, agent, hasOlder: false, hasNewer: false, error: null };
    },
  } }) } };
  return { paseo, agent, requests };
}

for (const platform of ["web", "ios", "android"]) {
  test(`captured final reply retains exactly one Worked for label on ${platform}`, async () => {
    const source = timingHost();
    const h = createToolHarness(platform, { ...source, markdown: true, replyFooter: true });
    const last = entries.at(-1);
    const mounted = h.mount(last.item, false, { timestamp: new Date(last.timestamp) });
    await settle();
    const tree = mounted.render();
    assert.equal((h.text(tree).match(/Worked for 21s/g) ?? []).length, 1);
    const footers = h.nodes(tree, node => node.props.testID === "reply-footer");
    assert.equal(footers.length, 1);
    assert.match(h.text(footers[0]), /Worked for 21s/);
    assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply").length, 1);
    assert.equal(source.requests.length, 1);
    assert.equal(source.requests[0].projection, "canonical");
    h.unmount();
  });
}
