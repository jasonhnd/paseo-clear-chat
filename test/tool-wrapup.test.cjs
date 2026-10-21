const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { createExpansionHost } = require("./helpers/expansion-host.cjs");

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/real-claude-wrapup.json"), "utf8"));
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id);

for (const platform of ["web", "ios", "android"]) {
  test(`captured object wrap-up reaches the full reply card on ${platform}`, async () => {
    const source = structuredClone(fixture);
    const host = createExpansionHost();
    const h = createToolHarness(platform, { markdown: true, expansionHost: host, preferences: { foldLongOutputAfter: 10 } });
    const { toolExpansionKey } = h.load("client/tool-expansion-store.ts");
    host.edit({ [toolExpansionKey({ hostId: "demo-host", agentId: "demo-agent", callId: source.callId, name: source.name, timestamp: Date.parse("2026-01-01T12:00:00Z") })]: { expanded: false, updatedAt: 1 } });
    const transformed = h.transformers.get("tool_call").transform({ item: source, phase: "complete" });
    assert.equal(transformed.items[0].kind, "omp-tool-call");
    assert.deepEqual(transformed.items[0].data.detail, source.detail);
    const mounted = h.mount(source, false);
    await new Promise(resolve => setImmediate(resolve));
    const tree = mounted.render();
    assert.equal(byId(h, tree, "tool-final-reply").length, 1);
    assert.equal(h.text(byId(h, tree, "final-reply-header")), "Wrap up");
    assert.equal(h.text(byId(h, tree, "wrap-up-recap")), "Checks complete\nThe sample change is ready.");
    assert.ok(h.text(byId(h, tree, "wrap-up-question")).includes(source.detail.input.ask));
    const options = byId(h, tree, "wrap-up-option");
    assert.equal(options.length, 2);
    for (const [index, action] of source.detail.input.actions.entries()) {
      assert.ok(h.text(options[index]).startsWith(`${String.fromCharCode(65 + index)}.`));
      assert.ok(h.text(options[index]).includes(action.label));
      assert.ok(h.text(options[index]).includes(action.message));
    }
    const blocked = byId(h, tree, "wrap-up-blocked")[0];
    assert.equal(h.text(blocked), "Blocked");
    assert.equal(blocked.props.accessibilityRole, "alert");
    assert.ok(blocked.props.style.borderLeftWidth > 0);
    for (const id of ["tool-summary-row", "tool-card-body", "tool-output", "tool-card-mcp", "tool-card-unknown", "final-reply-plain-text"]) {
      assert.equal(byId(h, tree, id).length, 0, `${id} cannot replace or fold the reply`);
    }
    assert.doesNotMatch(h.text(tree), /"recap"\s*:|"blocked"\s*:|\*\*|##/);
    assert.equal(h.nodes(tree, node => node.type === "Pressable" || node.props.numberOfLines !== undefined).length, 0);
    assert.deepEqual(source, fixture, "the projected input stays unchanged");
  });
}

test("boolean false omits the blocked section while keeping every reply field", () => {
  const h = createToolHarness();
  const item = structuredClone(fixture);
  item.detail.input.blocked = false;
  const { tree } = h.mount(item, false);
  assert.equal(byId(h, tree, "wrap-up-blocked").length, 0);
  assert.equal(byId(h, tree, "wrap-up-option").length, 2);
  assert.equal(byId(h, tree, "final-reply-plain-text").length, 0);
});

function renderOptions(labels) {
  const h = createToolHarness("web", { markdown: true });
  const item = structuredClone(fixture);
  item.detail.input.actions = labels.map(label => ({ label, message: "Keep this sample message." }));
  const { tree } = h.mount(item, false);
  return { h, rows: byId(h, tree, "wrap-up-option") };
}

test("wrap-up labels with an existing option letter keep a single prefix", () => {
  for (const label of ["A", "A Review first", "A. Review first", "A) Review first", "A: Review first", "A\u3001Review first"]) {
    const { h, rows } = renderOptions([label]);
    assert.equal(rows[0].props.children[0], null, "an authored option letter needs no generated marker");
    assert.ok(h.text(rows[0]).startsWith(label));
    assert.ok(h.text(rows[0]).includes("Keep this sample message."));
  }
});

test("wrap-up labels without an option letter receive sequential prefixes", () => {
  const labels = ["Review first", "Apply the change", "Backup the sample"];
  const { h, rows } = renderOptions(labels);
  assert.equal(rows.length, labels.length);
  for (const [index, row] of rows.entries()) {
    assert.equal(h.text(row.props.children[0]), `${String.fromCharCode(65 + index)}.`);
    assert.ok(h.text(row).includes(labels[index]));
  }
});

test("wrap-up labels retain authored letters even when they differ from their order", () => {
  const labels = ["C) Apply later", "A: Review first"];
  const { h, rows } = renderOptions(labels);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.props.children[0], null);
    assert.ok(h.text(row).startsWith(labels[index]));
  }
});

test("a blocked-only reply retains its alert and card header", () => {
  const h = createToolHarness();
  const item = structuredClone(fixture);
  item.detail.input = { recap: "", ask: "", actions: [], blocked: true };
  const { tree } = h.mount(item, false);
  assert.equal(h.text(byId(h, tree, "wrap-up-blocked")), "Blocked");
  assert.equal(h.text(byId(h, tree, "final-reply-header")), "Wrap up");
  assert.equal(byId(h, tree, "wrap-up-recap").length, 0);
});

for (const mode of ["direct", "response", "fenced", "operation"]) {
  test(`legacy ${mode} JSON strings retain the structured wrap-up layout`, () => {
    const h = createToolHarness();
    const item = structuredClone(fixture);
    const payload = JSON.stringify(item.detail.input);
    item.detail.input = mode === "direct" ? payload : mode === "response" ? { response: payload }
      : mode === "fenced" ? { response: `\`\`\`json\n${payload}\n\`\`\`` }
      : JSON.stringify({ phase: "wrap_up", ...item.detail.input });
    if (mode === "operation") item.name = "ccd_turn";
    const { tree } = h.mount(item, false);
    assert.equal(byId(h, tree, "wrap-up-reply").length, 1);
    assert.equal(byId(h, tree, "wrap-up-option").length, 2);
    assert.equal(byId(h, tree, "final-reply-plain-text").length, 0);
  });
}

test("long captured-shape recap and option messages stay complete at every output limit", () => {
  const item = structuredClone(fixture);
  const lines = Array.from({ length: 40 }, (_, index) => `Sample report line ${index + 1}`).join("\n");
  item.detail.input.recap = lines;
  item.detail.input.actions[1].message = lines;
  for (const foldLongOutputAfter of [10, 15, 30, "never"]) {
    const h = createToolHarness("web", { preferences: { foldLongOutputAfter } });
    const { tree } = h.mount(item, false);
    assert.ok(h.text(byId(h, tree, "wrap-up-recap")).includes(lines));
    assert.ok(h.text(byId(h, tree, "wrap-up-option")[1]).includes(lines));
    assert.equal(byId(h, tree, "tool-output").length, 0);
  }
});

for (const extra of [{ message: 42 }, { message: { text: "Keep the unexpected content" } }, { target: "Keep the extra field" }]) {
  test(`unsupported action fields remain visible in the full fallback (${JSON.stringify(extra)})`, () => {
    const h = createToolHarness();
    const item = structuredClone(fixture);
    Object.assign(item.detail.input.actions[0], extra);
    const { tree } = h.mount(item, false);
    assert.equal(h.text(byId(h, tree, "final-reply-plain-text")), JSON.stringify(item.detail.input, null, 2));
    assert.equal(byId(h, tree, "final-reply-header").length, 1);
    assert.equal(byId(h, tree, "tool-summary-row").length, 0);
  });
}
