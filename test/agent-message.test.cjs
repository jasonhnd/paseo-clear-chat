const assert = require("node:assert/strict");
const test = require("node:test");
const entries = require("./fixtures/real-claude-agent-message.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const delivery = entries.find(entry => entry.item.agentMessage).item;

for (const platform of ["web", "ios", "android"]) {
  for (const width of [1440, 1024, 820, 390]) {
    test(`${platform} ${width}px: captured delivery has a readable title and one instruction`, () => {
      const h = createToolHarness(platform, { width, userMessage: true, markdown: true });
      const collapsed = h.mount(delivery, false).tree;
      const summary = h.text(h.nodes(collapsed, n => n.props.testID === "tool-summary-text"));
      assert.match(summary, /Message received/, `legacy title before the fix: ${summary}`);
      assert.ok(summary.includes(delivery.agentMessage.sender.id));
      assert.ok(h.nodes(collapsed, n => n.type === "Glyph" && n.props.name === "MessageSquare").length);
      const trees = entries.map(({ item }) => h.mount(item).tree);
      const text = h.text(trees);
      assert.ok(!text.includes("agent_message"));
      assert.equal(text.split(delivery.agentMessage.text).length - 1, 1, "the delivered instruction appears once");
      assert.equal(text.split(entries[0].item.text).length - 1, 1, "the original user prompt appears once");
      assert.ok(text.includes("From agent: sample-coordinator"));
      assert.ok(text.includes("Expected sample failure"), "adjacent failed shell retains its error");
      assert.ok(text.includes("All sample checks passed"), "adjacent successful shell retains its output");
      assert.ok(text.includes("The sample checks are complete"), "the assistant reply remains visible");
      h.dispose();
    });
  }
}

test("captured delivery provenance survives the registered transformer and schema", () => {
  const h = createToolHarness();
  const { data } = h.mount(delivery, false);
  assert.deepEqual(data.agentMessage, delivery.agentMessage);
  assert.equal(entries.filter(e => e.item.type === "user_message" && e.item.text === delivery.agentMessage.text).length, 0);
});
