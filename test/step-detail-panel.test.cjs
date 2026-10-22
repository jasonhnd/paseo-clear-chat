const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness: createHarness } = require("./helpers/tool-harness.cjs");
const fixture = require("./fixtures/real-claude-session.json");

const createToolHarness = (platform, options = {}) => createHarness(platform, { ...options, preferences: { collapsedStepAction: "details", ...options.preferences }, dimensions: { width: 390, height: 844, ...options.dimensions } });

const call = fixture.items.find(item => item.type === "tool_call" && item.detail.type === "shell" && item.status === "completed");
const find = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const row = (h, tree) => find(h, tree, "tool-summary-row");
const tick = () => new Promise(setImmediate);

test("detail breakpoints use the shared phone, tablet and desktop boundaries", () => {
  const h = createToolHarness();
  const { PHONE_MAX, TABLET_MIN, DESKTOP_MIN, stepDetailPresentation } = h.load("client/breakpoints.ts");
  assert.deepEqual([PHONE_MAX, TABLET_MIN, DESKTOP_MIN], [743, 744, 1024]);
  assert.deepEqual([390, 743, 744, 820, 1023, 1024, 1440].map(stepDetailPresentation),
    ["sheet", "sheet", "popover", "popover", "popover", "side", "side"]);
});

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
      if (dismiss === "back") h.nodes(tree, node => node.type === "Native.Modal")[0].props.onRequestClose();
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

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: a replacement timeline row retains its open detail and reading state`, async () => {
    const h = createToolHarness(platform, { dimensions: { width: 820 } });
    let mounted = h.mount(call);
    find(h, mounted.tree, "step-detail-scroll").props.onScroll?.({ nativeEvent: { contentOffset: { y: 400 } } });
    for (const width of [600, 820]) {
      h.dimensions.width = width;
      // One host commit removes the old timeline and mounts its replacement.
      mounted = h.mount(call, false);
      const panel = find(h, mounted.render(), "step-detail-panel");
      assert.equal(panel.props.dataSet.presentation, width === 600 ? "sheet" : "popover");
      assert.equal(find(h, mounted.render(), "step-detail-scroll").props.contentOffset.y, 400);
    }
    h.unmount();
    await tick();
    // Leaving the timeline, rather than replacing it, releases the open session.
    assert.equal(find(h, h.mount(call, false).tree, "step-detail-panel"), undefined);
    h.unmount();
  });

  test(`${platform}: replacement host panes retain the selected step without reopening a closed one`, async () => {
    const h = createToolHarness(platform, { dimensions: { width: 820 } });
    let mounted = h.mount(call);
    find(h, mounted.tree, "step-detail-scroll").props.onScroll?.({ nativeEvent: { contentOffset: { y: 400 } } });
    h.dimensions.width = 1180;
    mounted.render();
    for (const width of [820, 600, 820]) {
      h.dimensions.width = width;
      mounted = h.mount(call, false);
      assert.ok(find(h, mounted.render(), "step-detail-panel"));
      assert.equal(find(h, mounted.render(), "step-detail-scroll").props.contentOffset.y, 400);
    }
    find(h, mounted.render(), "step-detail-close").props.onPress();
    h.unmount();
    await tick();
    assert.equal(find(h, h.mount(call, false).tree, "step-detail-panel"), undefined);
    h.unmount();
  });
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: a hidden image remains hidden after a tablet overlay becomes a side pane`, async () => {
    const h = createToolHarness(platform, { dimensions: { width: 820 }, images: true, isPad: platform === "ios" });
    const mounted = h.mount({ type: "tool_call", callId: "sample-image", name: "read", status: "completed",
      detail: { type: "read", filePath: "artifacts/sample.png", content: "Image file" } });
    await tick();
    const toggle = (tree, label) => h.nodes(tree, node => node.props.accessibilityLabel === label)[0];
    toggle(mounted.render(), "Hide the image").props.onPress();
    assert.ok(toggle(mounted.render(), "Show the image"));
    h.dimensions.width = 1180;
    mounted.render();
    assert.ok(toggle(mounted.render(), "Show the image"));
    h.unmount();
  });

  test(`${platform}: full output survives transfer from a tablet overlay to the host pane`, () => {
    const h = createToolHarness(platform, { dimensions: { width: 820 }, isPad: platform === "ios" });
    const mounted = h.mount(call);
    assert.ok(h.text(find(h, mounted.render(), "step-detail-output")).includes("Sample text line 24."));
    h.dimensions.width = 1180;
    mounted.render();
    assert.ok(h.text(find(h, mounted.render(), "step-detail-output")).includes("Sample text line 24."));
    assert.equal(h.nodes(mounted.render(), node => node.props.accessibilityLabel?.startsWith("Show all ")).length, 0);
    h.unmount();
  });

  test(`${platform}: split view retains the sheet size and restores its reading position`, () => {
    const h = createToolHarness(platform, { isPad: platform === "ios" });
    const mounted = h.mount(call);
    find(h, mounted.render(), "step-detail-drag-handle").props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
    let tree = mounted.render();
    const scroll = find(h, tree, "step-detail-scroll");
    scroll.props.onScroll?.({ nativeEvent: { contentOffset: { y: 250 } } });
    for (const width of [820, 1180, 820, 600]) {
      h.dimensions.width = width;
      mounted.render();
      tree = mounted.render();
      assert.equal(h.nodes(tree, node => node.props.testID === "step-detail-panel").length, 1);
      assert.ok(h.text(find(h, tree, "tool-card-body")).includes(call.detail.command));
    }
    assert.equal(find(h, tree, "step-detail-panel").props.dataSet.snap, "full");
    const restored = find(h, tree, "step-detail-scroll");
    assert.equal(restored.props.contentOffset.y, 250);
    find(h, tree, "step-detail-close").props.onPress();
    assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
    assert.equal(find(h, mounted.render(), "step-detail-backdrop"), undefined);
    h.unmount();
  });
}

test("a selected desktop call updates its existing panel when new output arrives", () => {
  const h = createToolHarness("web", { dimensions: { width: 1440 } });
  const mounted = h.mount(call);
  const next = { ...mounted.data, detail: { ...mounted.data.detail, output: "Updated sample output" } };
  const tree = mounted.render(next);
  assert.ok(h.text(find(h, tree, "tool-card-body")).includes("Updated sample output"));
  assert.equal(h.panelOpens.length, 1);
  h.unmount();
});

test("a host without a usable panel context falls back to a dismissible popover", () => {
  for (const options of [{ agent: { cwd: "/workspace/demo" } }, { panelError: true }]) {
    const h = createToolHarness("web", { ...options, dimensions: { width: 1440 } });
    const mounted = h.mount(call);
    assert.equal(find(h, mounted.tree, "step-detail-panel").props.dataSet.presentation, "popover");
    find(h, mounted.tree, "step-detail-close").props.onPress();
    assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
    h.unmount();
  }
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

test("820px popovers cap their height to the safe viewport with room for margins", () => {
  const h = createToolHarness("web", { dimensions: { width: 820, height: 600 } });
  const mounted = h.mount(require("./fixtures/real-hermes-hover.json").items.find(item => item.detail?.type === "read"));
  const viewport = h.nodes(mounted.tree, node => typeof node.props.onLayout === "function" && node.props.pointerEvents === "box-none")[0];
  viewport.props.onLayout({ nativeEvent: { layout: { width: 820, height: 550 } } });
  const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  const panel = flatten(find(h, mounted.render(), "step-detail-panel").props.style);
  assert.equal(panel.maxHeight, 502);
  assert.equal(panel.flexShrink, 1);
  assert.ok(find(h, mounted.render(), "step-detail-scroll"));
  h.unmount();
});
