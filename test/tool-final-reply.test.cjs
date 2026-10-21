const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { createExpansionHost } = require("./helpers/expansion-host.cjs");

const reply = "# Finished\n\n" + Array.from({ length: 40 }, (_, i) => `Report line ${i + 1}`).join("\n");
const call = (name, input, output = "Acknowledged") => ({ type: "tool_call", callId: "final-call", name, status: "completed", error: null, detail: { type: "unknown", input, output } });
const cases = [
  ["mcp__sample__ccd_turn", { phase: "wrap_up", message: reply }],
  ["mcp__sample__ccd_turn", { action: "wrap_up", summary: reply }],
  ["ccd_turn", { kind: "wrap_up", final_reply: reply }],
  ["ccd_turn", { wrap_up: { markdown: reply } }],
  ["ccd_turn", { wrap_up: reply }],
  ["mcp__sample__wrap_up", { response: reply }],
  ["wrap_up", { text: reply }],
];

for (const [name, input] of cases) {
  test(`${name} explicit wrap-up renders the whole reply outside tool and output disclosures`, async () => {
    const host = createExpansionHost();
    const h = createToolHarness("ios", { expansionHost: host, preferences: { foldLongOutputAfter: 10 } });
    const { toolExpansionKey } = h.load("client/tool-expansion-store.ts");
    host.edit({ [toolExpansionKey({ hostId: "demo-host", agentId: "demo-agent", callId: "final-call", name, timestamp: Date.parse("2026-01-01T12:00:00Z") })]: { expanded: false, updatedAt: 1 } });
    const mounted = h.mount(call(name, input), false);
    await new Promise(resolve => setImmediate(resolve));
    const tree = mounted.render();
    assert.ok(h.text(tree).includes(reply));
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-final-reply").length, 1);
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-summary-row" || node.props.testID === "tool-output").length, 0);
    assert.equal(h.nodes(tree, node => node.type === "Pressable").length, 0);
  });
}

test("wrap-up output content blocks stay complete when the input has no reply", () => {
  const h = createToolHarness();
  const { tree } = h.mount(call("mcp__sample__ccd_turn", { phase: "wrap_up" }, { content: [{ type: "text", text: reply }, { type: "text", text: "Additional details" }] }), false);
  assert.ok(h.text(tree).includes(reply));
  assert.ok(h.text(tree).includes("Additional details"));
});

test("unfamiliar explicit wrap-up payloads remain fully visible", () => {
  const h = createToolHarness();
  const { tree } = h.mount(call("ccd_turn", { phase: "wrap_up", findings: ["First", "Last"] }, ""), false);
  assert.ok(h.text(tree).includes("First"));
  assert.ok(h.text(tree).includes("Last"));
  assert.equal(h.nodes(tree, node => node.props.testID === "tool-summary-row").length, 0);
});

for (const item of [
  call("mcp__sample__ccd_turn", { phase: "work", summary: reply }),
  call("mcp__sample__lookup", { phase: "wrap_up", summary: reply }),
  call("mcp__sample__ccd_turn", { summary: "A normal progress update" }),
]) {
  test(`${item.name} without an explicit matching wrap-up operation remains a finished step`, () => {
    const h = createToolHarness();
    const { tree } = h.mount(item, false);
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-final-reply").length, 0);
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-summary-row")[0].props.accessibilityState.expanded, false);
  });
}
