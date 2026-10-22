const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const fixture = require("./fixtures/real-claude-session.json");

const call = fixture.items.find(item => item.type === "tool_call" && item.detail.type === "shell" && item.status === "completed");
const find = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const row = (h, tree) => find(h, tree, "tool-summary-row");
const tick = () => new Promise(setImmediate);

for (const platform of ["web", "ios", "android"]) {
  for (const [width, presentation] of [[1440, "side"], [1024, "side"], [820, "popover"], [390, "sheet"]]) {
    test(`${platform} ${width}: a collapsed step opens details, keeps the row folded and closes`, async () => {
      const h = createToolHarness(platform, { dimensions: { width } });
      const mounted = h.mount(call, false);
      assert.equal(find(h, mounted.tree, "step-detail-panel"), undefined);
      row(h, mounted.tree).props.onPress();
      let tree = mounted.render();
      assert.equal(find(h, tree, "step-detail-panel").props.dataSet.presentation, presentation);
      assert.equal(row(h, tree).props.accessibilityState.expanded, false);
      assert.ok(h.text(find(h, tree, "tool-card-body")).includes(call.detail.command));
      if (presentation === "side") {
        assert.equal(h.panelOpens.at(-1).location, "explorer");
        assert.equal(find(h, tree, "step-detail-backdrop"), undefined);
      }
      find(h, tree, "step-detail-close").props.onPress();
      tree = mounted.render();
      assert.equal(find(h, tree, "step-detail-panel"), undefined);
      await tick();
      assert.equal(h.expansionHost.calls.some(call => call.name === "write"), false);
      h.unmount();
    });
  }
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: the phone handle drags to full, half and dismissed without scrolling the body`, () => {
    const h = createToolHarness(platform);
    const mounted = h.mount(call);
    const drag = dy => {
      const handle = find(h, mounted.render(), "step-detail-drag-handle");
      const gesture = { dx: 0, dy, vx: 0, vy: 0 };
      assert.equal(handle.props.onMoveShouldSetResponder({}, gesture), true);
      handle.props.onResponderGrant({}, { ...gesture, dy: 0 });
      handle.props.onResponderMove({}, gesture);
      handle.props.onResponderRelease({}, gesture);
    };
    assert.equal(find(h, mounted.render(), "step-detail-panel").props.dataSet.snap, "half");
    drag(-350);
    assert.equal(find(h, mounted.render(), "step-detail-panel").props.dataSet.snap, "full");
    drag(350);
    assert.equal(find(h, mounted.render(), "step-detail-panel").props.dataSet.snap, "half");
    drag(300);
    assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
    h.unmount();
  });

  test(`${platform}: backdrop, platform back and left-edge back each dismiss the overlay`, () => {
    for (const dismiss of ["backdrop", "back", "edge"]) {
      const h = createToolHarness(platform);
      const mounted = h.mount(call);
      let tree = mounted.render();
      if (dismiss === "backdrop") find(h, tree, "step-detail-backdrop").props.onPress();
      if (dismiss === "back") h.nodes(tree, node => node.type === "NativeModal")[0].props.onRequestClose();
      if (dismiss === "edge") {
        const edge = find(h, tree, "step-detail-back-edge");
        const gesture = { dx: 110, dy: 4, vx: 0.5, vy: 0 };
        assert.equal(edge.props.onMoveShouldSetResponder({}, gesture), true);
        edge.props.onResponderRelease({}, gesture);
      }
      assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
      h.unmount();
    }
  });
}

test("the same open detail changes presentation when the viewport crosses breakpoints", () => {
  const h = createToolHarness("ios");
  const mounted = h.mount(call);
  for (const [width, presentation] of [[390, "sheet"], [820, "popover"], [1024, "side"], [1440, "side"], [820, "popover"], [390, "sheet"]]) {
    h.dimensions.width = width;
    // Effects can hand an overlay to the registered host panel.
    mounted.render();
    const panels = h.nodes(mounted.render(), node => node.props.testID === "step-detail-panel");
    assert.equal(panels.length, 1);
    assert.equal(panels[0].props.dataSet.presentation, presentation);
  }
  h.unmount();
});

test("inline preference restores the original expansion and persisted folding behavior", async () => {
  const h = createToolHarness("ios", { preferences: { collapsedStepAction: "inline" } });
  const mounted = h.mount(call, false);
  row(h, mounted.tree).props.onPress();
  assert.equal(row(h, mounted.render()).props.accessibilityState.expanded, true);
  assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
  assert.ok(find(h, mounted.render(), "tool-card-body"));
  row(h, mounted.render()).props.onPress();
  assert.equal(row(h, mounted.render()).props.accessibilityState.expanded, false);
  h.unmount();
  await tick();
  assert.equal(Object.values(h.expansionHost.values.entries)[0].expanded, false);
});

test("the settings control defaults to details, saves inline and reverts to details", async () => {
  const h = createToolHarness("ios", { settingsPage: true });
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  const page = () => h.draw({ type: Page, props: { theme: { colors: {} } } }, "settings");
  const option = label => h.nodes(page(), node => node.type === "Pressable" && h.text(node) === label)[0];
  assert.equal(option("Open details").props.accessibilityState.selected, true);
  await option("Expand inline").props.onPress();
  assert.equal(h.preferences.collapsedStepAction, "inline");
  const mounted = h.mount(call, false);
  row(h, mounted.tree).props.onPress();
  assert.equal(row(h, mounted.render()).props.accessibilityState.expanded, true);
  await option("Open details").props.onPress();
  row(h, mounted.render()).props.onPress();
  row(h, mounted.render()).props.onPress();
  assert.ok(find(h, mounted.render(), "step-detail-panel"));
  h.unmount();
});
