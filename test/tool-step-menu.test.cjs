const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createToolHarness: createHarness } = require("./helpers/tool-harness.cjs");
const createToolHarness = (platform, options = {}) => createHarness(platform, { ...options, preferences: { collapsedStepAction: "details", ...options.preferences } });

const fixture = name => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")).items;
const shell = fixture("real-claude-session.json").find(item => item.detail?.type === "shell");
const read = fixture("real-hermes-session.json").find(item => item.detail?.type === "read");
const menuSteps = fixture("real-hermes-step-menu.json");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function open(h, mounted, gesture = "long", coordinates = {}) {
  const row = byId(h, mounted.render(), "tool-summary-row");
  const event = { nativeEvent: coordinates, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  if (gesture === "context") {
    assert.equal(typeof row.props.onContextMenu, "function");
    row.props.onContextMenu(event);
    assert.equal(event.prevented, true);
  } else {
    assert.equal(typeof row.props.onLongPress, "function");
    row.props.onLongPress(event);
  }
  assert.ok(byId(h, mounted.render(), "tool-step-menu"));
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: menu follows gesture coordinates and flips at viewport edges`, () => {
    for (const width of [1440, 1024, 820, 390]) {
      const h = createToolHarness(platform, { width, height: 800 });
      const mounted = h.mount(menuSteps.find(item => item.detail?.type === "read"), false);
      for (const point of [{ x: 48, y: 157 }, { x: width - 24, y: 780 }]) {
        const coordinates = platform === "web"
          ? { clientX: point.x, clientY: point.y, pageX: point.x + 31, pageY: point.y + 183 }
          : { pageX: point.x, pageY: point.y, locationX: 12, locationY: 10 };
        open(h, mounted, platform === "web" ? "context" : "long", coordinates);
        let menu = byId(h, mounted.render(), "tool-step-menu");
        menu.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 178 } } });
        menu = byId(h, mounted.render(), "tool-step-menu");
        const style = Object.assign({}, ...[menu.props.style].flat());
        const flip = point.y === 780;
        assert.ok(Math.abs((flip ? style.left + 280 : style.left) - point.x) <= 8, `${width}: horizontal anchor`);
        assert.ok(Math.abs((flip ? style.top + 178 : style.top) - point.y) <= 8, `${width}: vertical anchor`);
        assert.ok(style.left >= 8 && style.left + 280 <= width - 8);
        assert.ok(style.top >= 8 && style.top + 178 <= 792);
        byId(h, mounted.render(), "step-menu-dismiss").props.onPress();
      }
      h.unmount();
    }
  });
}

test("web touch converts document coordinates once and suppresses only the long-press release", () => {
  const previous = { x: globalThis.scrollX, y: globalThis.scrollY };
  const h = createToolHarness("web", { width: 390, height: 800 });
  try {
    globalThis.scrollX = 31;
    globalThis.scrollY = 183;
    const mounted = h.mount(menuSteps.find(item => item.detail?.type === "read"), false);
    const event = { nativeEvent: { pageX: 79, pageY: 340 } };
    let row = byId(h, mounted.render(), "tool-summary-row");
    row.props.onPressIn(event);
    row.props.onLongPress(event);
    let menu = byId(h, mounted.render(), "tool-step-menu");
    menu.props.onLayout({ nativeEvent: { layout: { width: 280, height: 134 } } });
    menu = byId(h, mounted.render(), "tool-step-menu");
    const style = Object.assign({}, ...[menu.props.style].flat());
    assert.equal(style.left, 52);
    assert.equal(style.top, 161);
    let prevented = false;
    row.props.onTouchEnd({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, "release cannot click the newly mounted backdrop");
    byId(h, mounted.render(), "step-menu-dismiss").props.onPress();
    row = byId(h, mounted.render(), "tool-summary-row");
    row.props.onPressIn(event);
    prevented = false;
    row.props.onTouchEnd({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false, "ordinary taps retain their default behavior");
  } finally {
    if (previous.x === undefined) delete globalThis.scrollX; else globalThis.scrollX = previous.x;
    if (previous.y === undefined) delete globalThis.scrollY; else globalThis.scrollY = previous.y;
    h.unmount();
  }
});
async function copy(h, mounted, id, expected) {
  const action = byId(h, mounted.render(), id);
  assert.ok(action, id);
  await action.props.onPress();
  assert.equal(h.copies.at(-1), expected);
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: captured host-replay steps copy their original command, path and complete result`, async () => {
    const h = createToolHarness(platform);
    for (const item of menuSteps) {
      const mounted = h.mount(item, false);
      const actions = item.detail.type === "shell"
        ? [["step-copy-command", item.detail.command], ["step-copy-result", item.detail.output]]
        : [["step-copy-path", item.detail.filePath], ["step-copy-result", item.detail.content]];
      for (const [id, expected] of actions) {
        open(h, mounted, platform === "web" ? "context" : "long");
        await copy(h, mounted, id, expected);
      }
    }
    h.unmount();
  });

  test(`${platform}: captured steps copy complete commands, paths and results through the SDK`, async () => {
    const h = createToolHarness(platform);
    const mounted = h.mount(shell, false);
    open(h, mounted, platform === "web" ? "context" : "long");
    await copy(h, mounted, "step-copy-command", shell.detail.command);
    open(h, mounted);
    await copy(h, mounted, "step-copy-result", shell.detail.output);
    open(h, mounted);
    assert.equal(byId(h, mounted.render(), "step-copy-path"), undefined);
    assert.equal(byId(h, mounted.render(), "step-open-path"), undefined);
    const file = h.mount(read, false);
    open(h, file);
    await copy(h, file, "step-copy-path", read.detail.filePath);
    open(h, file);
    await copy(h, file, "step-copy-result", read.detail.content);
    if (platform === "web") {
      open(h, file);
      byId(h, file.render(), "step-open-path").props.onPress();
      assert.deepEqual(h.reveals.at(-1), { cwd: "/workspace/demo", path: read.detail.filePath });
    } else assert.equal(byId(h, file.render(), "step-open-path"), undefined);
    h.unmount();
  });

  test(`${platform}: long press does not activate the row; the next ordinary tap still works`, () => {
    const h = createToolHarness(platform);
    const mounted = h.mount(shell, false);
    open(h, mounted);
    const row = byId(h, mounted.render(), "tool-summary-row");
    row.props.onPress();
    assert.equal(byId(h, mounted.render(), "tool-summary-row").props.accessibilityState.expanded, false);
    assert.equal(byId(h, mounted.render(), "step-detail-panel"), undefined);
    byId(h, mounted.render(), "step-menu-dismiss").props.onPress();
    const nextRow = byId(h, mounted.render(), "tool-summary-row");
    nextRow.props.onPressIn?.();
    nextRow.props.onPress();
    assert.equal(byId(h, mounted.render(), "tool-summary-row").props.accessibilityState.expanded, false);
    assert.ok(byId(h, mounted.render(), "step-detail-panel"));
    h.unmount();
  });
}

test("copies retain whitespace, multiple text blocks and structured stdout/stderr", async () => {
  const h = createToolHarness("ios");
  const command = "  printf 'sample'\n\n  ";
  const path = "src/a file.ts";
  for (const output of ["  first\nlast\n  ", { content: [{ type: "text", text: " first\n" }, { type: "text", text: "last  " }] }, { stdout: "out\n", stderr: "err\n", exitCode: 1 }]) {
    const mounted = h.mount({ ...shell, detail: { type: "shell", command, filePath: path, output } }, false);
    open(h, mounted);
    await copy(h, mounted, "step-copy-command", command);
    open(h, mounted);
    await copy(h, mounted, "step-copy-path", path);
    open(h, mounted);
    const expected = typeof output === "string" ? output : output.content ? output.content.map(block => block.text).join("\n") : JSON.stringify(output, null, 2);
    await copy(h, mounted, "step-copy-result", expected);
  }
  h.unmount();
});

test("iOS and iPadOS summaries cannot start native text selection", () => {
  for (const width of [390, 820]) {
    const h = createToolHarness("ios", { width, height: 900, realSelection: true });
    const mounted = h.mount(shell, false);
    open(h, mounted);
    const summary = byId(h, mounted.render(), "tool-summary-text");
    assert.equal(summary.props.selectable, false);
    const styles = Object.assign({}, ...[summary.props.style].flat());
    assert.notEqual(styles.userSelect, "text");
    h.unmount();
  }
});

test("four viewport widths constrain the shared menu and hide mobile file opening", () => {
  for (const width of [1440, 1024, 820, 390]) {
    const h = createToolHarness("web", { width, height: 700 });
    const mounted = h.mount(read, false);
    open(h, mounted, "context");
    const menu = byId(h, mounted.render(), "tool-step-menu");
    const styles = Object.assign({}, ...[menu.props.style].flat());
    assert.ok(styles.width <= width - 16, `${width}: horizontal clearance`);
    assert.ok(styles.maxHeight <= 700 - 16, `${width}: vertical clearance`);
    assert.equal(Boolean(byId(h, mounted.render(), "step-open-path")), width >= 1024);
    h.unmount();
  }
});


test("copy rejection keeps the full text in the existing selectable fallback", async () => {
  const h = createToolHarness("ios", { copyText: async () => { throw new Error("Denied"); } });
  const mounted = h.mount(shell, false);
  open(h, mounted);
  await copy(h, mounted, "step-copy-result", shell.detail.output);
  const fallback = h.nodes(mounted.render(), node => node.props.accessibilityLabel === "Text to copy")[0];
  assert.equal(fallback.props.value, shell.detail.output);
  assert.equal(fallback.props.readOnly, true);
  assert.match(h.toasts.at(-1), /Could not copy/);
  assert.equal(byId(h, mounted.render(), "tool-step-menu"), undefined);
  h.unmount();
});

test("streaming menu actions use the current step data, including an empty result", async () => {
  const h = createToolHarness("android");
  const mounted = h.mount(shell, false);
  open(h, mounted);
  const detail = { ...shell.detail, command: "printf 'updated'", output: "" };
  const render = () => mounted.render({ ...mounted.data, detail });
  await copy(h, { render }, "step-copy-result", "");
  open(h, { render });
  await copy(h, { render }, "step-copy-command", detail.command);
  h.unmount();
});

test("platform Back closes the menu without changing the disclosure", () => {
  const h = createToolHarness("android");
  const mounted = h.mount(shell, false);
  open(h, mounted);
  h.nodes(mounted.render(), node => node.type === "Native.Modal")[0].props.onRequestClose();
  assert.equal(byId(h, mounted.render(), "tool-step-menu"), undefined);
  assert.equal(byId(h, mounted.render(), "tool-summary-row").props.accessibilityState.expanded, false);
  h.unmount();
});


for (const platform of ["web", "ios", "android"]) {
  const fileSteps = fixture("claude-session.json").filter(item => ["write", "edit"].includes(item.detail?.type));
  test(`${platform}: Write and Edit without reported results only copy the original path`, async () => {
    const h = createToolHarness(platform);
    assert.deepEqual(fileSteps.map(item => item.detail.type).sort(), ["edit", "write"]);
    for (const item of fileSteps) {
      const mounted = h.mount(item, false);
      open(h, mounted, platform === "web" ? "context" : "long");
      assert.equal(byId(h, mounted.render(), "step-copy-result"), undefined, `${item.name}: no result action`);
      assert.deepEqual(h.copies, [], "opening the menu does not copy input or a fabricated empty result");
      await copy(h, mounted, "step-copy-path", item.detail.filePath);
      assert.deepEqual(h.copies, [item.detail.filePath], "the SDK receives only the original path");
    }
    h.unmount();
  });

  test(`${platform}: Write and Edit copy reported results instead of their file or patch inputs`, async () => {
    const h = createToolHarness(platform);
    for (const item of fileSteps) {
      for (const [field, result] of [["output", "  File updated.\n  "], ["result", "  Edit applied.\n"], ["output", ""]]) {
        const mounted = h.mount({ ...item, detail: { ...item.detail, [field]: result } }, false);
        open(h, mounted);
        await copy(h, mounted, "step-copy-result", result);
        assert.deepEqual(h.copies, [result], `${item.name}: verbatim ${field}`);
      }
    }
    h.unmount();
  });
}
