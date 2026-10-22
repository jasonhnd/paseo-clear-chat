const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const fixture = name => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")).items;
const shell = fixture("real-claude-session.json").find(item => item.detail?.type === "shell");
const read = fixture("real-hermes-session.json").find(item => item.detail?.type === "read");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function open(h, mounted, gesture = "long") {
  const row = byId(h, mounted.render(), "tool-summary-row");
  const event = { nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() {} };
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
async function copy(h, mounted, id, expected) {
  const action = byId(h, mounted.render(), id);
  assert.ok(action, id);
  await action.props.onPress();
  assert.equal(h.copies.at(-1), expected);
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: captured steps copy complete commands, paths and results through the SDK`, async () => {
    const h = createToolHarness(platform);
    const mounted = h.mount(shell, false);
    open(h, mounted, platform === "web" ? "context" : "long");
    await copy(h, mounted, "step-copy-command", shell.detail.command);
    open(h, mounted);
    await copy(h, mounted, "step-copy-result", shell.detail.output);
    assert.equal(byId(h, mounted.render(), "step-copy-path"), undefined);
    assert.equal(byId(h, mounted.render(), "step-open-path"), undefined);
    const file = h.mount(read, false);
    open(h, file);
    await copy(h, file, "step-copy-path", read.detail.filePath);
    open(h, file);
    await copy(h, file, "step-copy-result", read.detail.content);
    if (platform === "web") {
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
    byId(h, mounted.render(), "step-menu-dismiss").props.onPress();
    const nextRow = byId(h, mounted.render(), "tool-summary-row");
    nextRow.props.onPressIn?.();
    nextRow.props.onPress();
    assert.equal(byId(h, mounted.render(), "tool-summary-row").props.accessibilityState.expanded, true);
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
