const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: repeated prompt text keeps each host message identity across turns`, () => {
    const agent = { status: "idle", updatedAt: "sample-first-revision" };
    const h = createToolHarness(platform, { userMessage: true, promptAnchor: true, agent });
    try {
      const rows = [];
      for (let index = 0; index < 3; index++) {
        agent.status = index === 1 ? "running" : "idle";
        agent.updatedAt = `sample-revision-${index}`;
        rows.push(h.mount({ type: "user_message", messageId: `sample-prompt-${index}`, text: "Repeat the same request." }));
      }
      for (const [index, row] of rows.entries()) {
        assert.equal(row.data.messageId, `sample-prompt-${index}`);
        const anchors = h.nodes(row.render(), node => node.props.dataSet?.historyRowId);
        assert.deepEqual(anchors.map(node => node.props.dataSet.historyRowId), [`sample-prompt-${index}`]);
      }
      const optimistic = h.mount({ type: "user_message", text: "Repeat the same request." });
      assert.equal(h.nodes(optimistic.tree, node => node.props.dataSet?.historyRowId).length, 0);
    } finally { h.unmount(); }
  });
}
