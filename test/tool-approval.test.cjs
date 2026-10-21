const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/real-hermes-approvals.json"), "utf8"));
const approvals = fixture.items.filter(item => item.name?.startsWith("edit-approval-"));
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id);
const assertNoInternalIds = (h, tree) => {
  assert.doesNotMatch(h.text(tree), /edit-approval-/);
  for (const node of h.nodes(tree, node => node.props.accessibilityLabel)) {
    assert.doesNotMatch(node.props.accessibilityLabel, /edit-approval-/);
  }
};

for (const platform of ["web", "ios", "android"]) {
  test(`captured Hermes approvals render as concise Approved rows on ${platform}`, () => {
    const h = createToolHarness(platform);
    assert.equal(approvals.length, 2);
    for (const item of approvals) {
      assert.equal(item.type, "tool_call");
      assert.deepEqual(item.detail, { type: "unknown", input: null, output: null });
      assert.deepEqual(item.metadata, { title: item.name });
      assert.equal(item.callId, item.name);
      const { tree } = h.mount(item, false);
      assert.equal(h.text(tree), "Approved");
      assert.equal(byId(h, tree, "approval-status-approved").length, 1);
      assert.equal(byId(h, tree, "tool-summary-row").length, 0);
      assert.equal(h.nodes(tree, node => node.type === "Glyph" && node.props.name === "Wrench").length, 0);
      assertNoInternalIds(h, tree);
    }
  });

  test(`pending variants of the captured approval open by default on ${platform}`, () => {
    const h = createToolHarness(platform);
    for (const status of ["running", "in_progress", "waiting", "pending", "awaiting_approval", "pending_approval", "waiting_for_approval"]) {
      const { tree, render } = h.mount({ ...approvals[0], status }, false);
      assert.equal(h.text(byId(h, tree, "approval-status-waiting")), "Awaiting approval");
      const row = byId(h, tree, "approval-summary-row")[0];
      assert.equal(row.props.accessibilityState.expanded, true, status);
      assert.equal(byId(h, tree, "approval-body").length, 1);
      assert.match(h.text(byId(h, tree, "approval-body")), /approval/i);
      assertNoInternalIds(h, tree);
      row.props.onPress();
      const collapsed = render();
      assert.equal(byId(h, collapsed, "approval-summary-row")[0].props.accessibilityState.expanded, false);
      assert.equal(byId(h, collapsed, "approval-body").length, 0);
    }
  });

  test(`denied variants of the captured approval render a concise Denied row on ${platform}`, () => {
    const h = createToolHarness(platform);
    for (const status of ["denied", "rejected", "failed", "error", "canceled", "cancelled"]) {
      const { tree } = h.mount({ ...approvals[1], status }, false);
      assert.equal(h.text(tree), "Denied");
      assert.equal(byId(h, tree, "approval-status-denied").length, 1);
      assert.equal(byId(h, tree, "tool-summary-row").length, 0);
      assertNoInternalIds(h, tree);
    }
  });
}

test("captured edits retain their diff cards without guessing approval associations", () => {
  const h = createToolHarness();
  for (const item of fixture.items.filter(item => item.detail?.type === "edit")) {
    const { tree } = h.mount(item);
    assert.equal(byId(h, tree, "tool-card-edit").length, 1);
    assert.match(h.text(tree), /config.txt/);
    assert.match(h.text(byId(h, tree, "tool-card-body")), /old setting[\s\S]*new setting/);
    assert.doesNotMatch(h.text(tree), /Approved/);
  }
});

test("ordinary tools and incomplete approval lookalikes retain tool rendering", () => {
  const h = createToolHarness();
  const sample = approvals[0];
  const lookalikes = [
    { ...sample, name: "sample-tool", callId: "sample-tool", metadata: { title: "sample-tool" } },
    { ...sample, detail: { ...sample.detail, input: { path: "/workspace/sample/config.txt" } } },
    { ...sample, detail: { ...sample.detail, output: "Sample result" } },
    { ...sample, detail: { type: "edit", filePath: "/workspace/sample/config.txt" } },
    { ...sample, callId: "unrelated-call" },
    { ...sample, metadata: { title: "Unrelated tool" } },
  ];
  for (const item of lookalikes) {
    const { tree } = h.mount(item, false);
    assert.equal(byId(h, tree, "tool-summary-row").length, 1);
    assert.equal(byId(h, tree, "approval-status-approved").length, 0);
  }
});
