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
      assert.equal(summary, "Message received");
      assert.ok(!summary.includes(delivery.agentMessage.sender.id));
      assert.ok(h.nodes(collapsed, n => n.type === "Glyph" && n.props.name === "MessageSquare").length);
      const trees = entries.map(({ item }) => h.mount(item).tree);
      const text = h.text(trees);
      assert.ok(!text.includes("agent_message"));
      assert.equal(text.split(delivery.agentMessage.text).length - 1, 1, "the delivered instruction appears once");
      assert.equal(text.split(entries[0].item.text).length - 1, 1, "the original user prompt appears once");
      assert.ok(text.includes("Sender: sample-coordinator"));
      assert.ok(text.includes("Command failed without output."), "adjacent failed shell retains its existing fallback");
      assert.ok(text.includes("All sample checks passed"), "adjacent successful shell retains its output");
      assert.ok(text.includes("The sample checks are complete"), "the assistant reply remains visible");
      h.dispose();
    });

    test(`${platform} ${width}px: delivery details display and copy the instruction once`, async t => {
      const h = createToolHarness(platform, { width, isPad: platform === "ios" && width >= 744,
        preferences: { collapsedStepAction: "details" } });
      t.after(() => h.unmount());
      const mounted = h.mount(delivery);
      mounted.render();
      const tree = mounted.render();
      const panel = h.nodes(tree, n => n.props.testID === "step-detail-panel");
      assert.equal(panel.length, 1);
      const text = h.text(tree);
      assert.ok(!text.includes("agent_message"));
      assert.ok(text.includes("Message received"));
      assert.equal(text.split(delivery.agentMessage.text).length - 1, 1);
      const output = h.nodes(tree, n => n.props.testID === "step-detail-output")[0];
      const expected = `Sender: sample-coordinator\n\n${delivery.agentMessage.text}`;
      assert.equal(h.text(output), expected);
      await h.nodes(tree, n => n.props.testID === "step-detail-copy-output")[0].props.onPress();
      assert.deepEqual(h.copies, [expected]);
    });
  }
}

test("captured delivery provenance survives the registered transformer and schema", () => {
  const h = createToolHarness();
  const { data } = h.mount(delivery, false);
  assert.deepEqual(data.agentMessage, delivery.agentMessage);
  assert.equal(entries.filter(e => e.item.type === "user_message" && e.item.text === delivery.agentMessage.text).length, 0);
});

for (const [event, label] of Object.entries({
  message: "Message received", finished: "Agent finished", errored: "Agent errored",
  "permission-required": "Agent needs permission", closed: "Agent closed",
})) {
  test(`${event} deliveries retain their meaning and use the sender title`, () => {
    const h = createToolHarness();
    const item = { ...delivery, agentMessage: { ...delivery.agentMessage, event,
      sender: { id: "sample-coordinator", title: "Sample coordinator" } },
      detail: { ...delivery.detail, text: "Stale compatibility copy" } };
    const { tree, data } = h.mount(item);
    const built = h.load("client/tool-call-data.ts").buildLiveToolCallData(data);
    assert.equal(built.title, event === "message" ? "Message from Sample coordinator" : `${label} · Sample coordinator`);
    assert.equal(built.copyResult, `Sender: sample-coordinator\n\n${delivery.agentMessage.text}`);
    assert.ok(!h.text(tree).includes("Stale compatibility copy"));
    assert.equal(built.input, undefined, "legacy icon fields do not become message input");
  });
}

test("ordinary tools and malformed provenance retain the existing adapter", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  for (const { item } of entries.filter(e => e.item.type === "tool_call" && !e.item.agentMessage)) {
    assert.deepEqual(build({ ...item, agentMessage: { event: "message" } }), build(item));
  }
});
