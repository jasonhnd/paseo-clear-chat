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
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id);

test("complete wrap-up fields render Markdown recap, a question and lettered options", () => {
  const h = createToolHarness("ios", { markdown: true });
  const payload = {
    recap: "## Release complete\n\n**All checks passed.**",
    ask: "Which step should happen next?",
    actions: ["Review the report", "Prepare another change"],
    blocked: [],
  };
  const { tree } = h.mount(call("mcp__sample__ccd_turn", { phase: "wrap_up", response: JSON.stringify(payload) }), false);
  const recap = byId(h, tree, "wrap-up-recap")[0];
  assert.ok(h.text(recap).includes("Release complete"));
  assert.ok(h.text(recap).includes("All checks passed."));
  assert.equal(h.text(recap).includes("##"), false);
  assert.equal(h.text(recap).includes("**"), false);
  assert.ok(h.text(byId(h, tree, "wrap-up-question")).includes(payload.ask));
  assert.deepEqual(byId(h, tree, "wrap-up-option").map(option => h.text(option)), ["A.\nReview the report", "B.\nPrepare another change"]);
  assert.equal(byId(h, tree, "wrap-up-blocked").length, 0);
  assert.equal(byId(h, tree, "final-reply-plain-text").length, 0);
  assert.equal(byId(h, tree, "tool-summary-row").length, 0);
});

test("a recap-only wrap-up remains a full Markdown reply without empty sections", () => {
  const h = createToolHarness("ios", { markdown: true });
  const { tree } = h.mount(call("ccd_turn", { phase: "wrap_up", recap: "**Ready for review.**" }), false);
  assert.equal(h.text(byId(h, tree, "wrap-up-recap")), "Ready for review.");
  for (const id of ["wrap-up-question", "wrap-up-options", "wrap-up-blocked", "final-reply-plain-text"]) {
    assert.equal(byId(h, tree, id).length, 0);
  }
});

for (const blocked of ["Waiting for the test server.", ["Waiting for the test server.", "A decision is needed."]]) {
  test(`nonempty ${Array.isArray(blocked) ? "list" : "text"} blocked reasons remain visible`, () => {
    const h = createToolHarness();
    const { tree } = h.mount(call("ccd_turn", { wrap_up: { recap: "The change is ready.", ask: "", actions: [], blocked } }), false);
    const section = byId(h, tree, "wrap-up-blocked")[0];
    assert.ok(section);
    assert.ok(h.text(section).includes("Blocked"));
    for (const reason of [blocked].flat()) assert.ok(h.text(section).includes(reason));
  });
}

test("malformed wrap-up JSON is visible verbatim as plain text", () => {
  const h = createToolHarness("ios", { markdown: true });
  const source = '{"recap":"**Keep this text**","actions":["First",}';
  const { tree } = h.mount(call("ccd_turn", { phase: "wrap_up", response: source }), false);
  assert.equal(h.text(byId(h, tree, "final-reply-plain-text")), source);
  assert.equal(byId(h, tree, "wrap-up-reply").length, 0);
});

for (const payload of [
  { ask: "Keep this question visible", actions: ["Continue"] },
  { recap: 42, blocked: "Keep this reason visible" },
  { recap: "Ready", ask: { text: "Unexpected question shape" } },
  { recap: "Ready", actions: [null] },
  { recap: "Ready", blocked: { reason: "Unexpected reason shape" } },
  { recap: "", ask: "", actions: [], blocked: [] },
  { recap: "Ready", extra: "Do not drop unexpected fields" },
]) {
  test(`missing or invalid wrap-up fields preserve the complete plain text (${JSON.stringify(payload)})`, () => {
    const h = createToolHarness("ios", { markdown: true });
    const source = JSON.stringify(payload);
    const { tree } = h.mount(call("wrap_up", { response: source }), false);
    assert.equal(h.text(byId(h, tree, "final-reply-plain-text")), source);
    assert.equal(byId(h, tree, "wrap-up-reply").length, 0);
  });
}

test("JSON content-block results and fenced JSON use the same wrap-up layout", () => {
  const payload = { recap: "The checks passed.", ask: null, actions: [{ label: "Review", description: "Read the report" }], blocked: null };
  for (const output of [
    { content: [{ type: "text", text: JSON.stringify(payload) }] },
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
  ]) {
    const h = createToolHarness();
    const { tree } = h.mount(call("ccd_turn", { phase: "wrap_up" }, output), false);
    assert.ok(h.text(byId(h, tree, "wrap-up-recap")).includes(payload.recap));
    assert.ok(h.text(byId(h, tree, "wrap-up-option")).includes("A.\nReview\n\nRead the report"));
  }
});

test("empty final reply input still has a visible fallback", () => {
  const h = createToolHarness();
  const Component = h.load("client/components/final-tool-reply.tsx").FinalToolReply;
  const tree = h.draw({ type: Component, props: { text: " \n", tokens: h.tokens, variant: "document" } });
  assert.ok(h.text(byId(h, tree, "final-reply-plain-text")).trim());
});

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
