const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/real-claude-session.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const calls = fixture.items.filter(item => item.type === "tool_call");
const style = value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
const node = (h, tree, id) => h.nodes(tree, item => item.props.testID === id)[0];

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: phone rows fit more real steps with 28px buttons and readable text`, () => {
    const h = createToolHarness(platform, { width: 390 });
    for (const call of calls) {
      const { tree, render } = h.mount(call, false);
      const row = node(h, tree, "tool-summary-row");
      if (!row) continue;
      const card = h.nodes(tree, item => /^tool-card-(?!body)/.test(item.props.testID ?? ""))[0];
      const slot = node(h, tree, "tool-summary-slot");
      assert.ok(slot, "a compact visual slot reserves less space than the button");
      const cardStyle = style(card.props.style), rowStyle = style(row.props.style);
      const footprint = style(slot.props.style).height + 2 * (cardStyle.borderWidth + cardStyle.marginVertical);
      assert.ok(footprint < 26, "the visual footprint is smaller than the previous release");
      assert.ok(rowStyle.height >= 28, "the actual button, without hitSlop, is at least 28px tall");
      assert.equal(cardStyle.overflow, "visible", "the button edges remain reachable");
      assert.ok(style(node(h, tree, "tool-summary-text").props.style).fontSize >= 11);
      assert.ok(style(node(h, tree, "tool-summary-text").props.style).fontSize < 12);
      assert.ok(rowStyle.paddingHorizontal < 10);
      const glyphs = h.nodes(row, item => item.type === "Glyph");
      assert.ok(glyphs[0].props.size < 13);
      assert.ok(glyphs.at(-1).props.size < 14);
      row.props.onPress();
      const expanded = render();
      assert.ok(node(h, expanded, "tool-card-body"), "the same button still opens the complete detail");
      assert.ok(style(node(h, expanded, "tool-summary-row").props.style).height >= 28);
      node(h, expanded, "tool-summary-row").props.onPress();
      assert.equal(node(h, render(), "tool-card-body"), undefined);
    }
  });
}

test("the phone breakpoint and all supported text sizes preserve readable row labels", () => {
  for (const width of [390, 743]) {
    for (const textScale of [0.85, 1, 1.15, 1.3]) {
      const h = createToolHarness("ios", { width, preferences: { textScale } });
      for (const status of ["completed", "running", "waiting", "failed", "canceled"]) {
        const { tree } = h.mount({ ...calls[1], status, durationMs: 1000 }, false);
        const row = node(h, tree, "tool-summary-row");
        assert.ok(style(row.props.style).height >= 28);
        for (const text of h.nodes(row, item => item.type === "Text")) {
          const textStyle = style(text.props.style);
          assert.ok(textStyle.fontSize >= 11, `${status}: font stays at least 11px`);
          assert.ok(textStyle.lineHeight <= style(row.props.style).height, "scaled text fits its button");
        }
      }
    }
  }
});

test("tablet and desktop row geometry stays unchanged at and above 744px", () => {
  for (const width of [744, 820, 1024, 1440]) {
    const h = createToolHarness("web", { width });
    const { tree } = h.mount(calls[1], false);
    const row = node(h, tree, "tool-summary-row");
    assert.equal(row.props.style.height, 22);
    assert.equal(row.props.style.paddingHorizontal, 10);
    assert.equal(node(h, tree, "tool-summary-slot"), undefined);
    assert.equal(node(h, tree, "tool-summary-text").props.style.fontSize, 12);
    assert.deepEqual(h.nodes(row, item => item.type === "Glyph").map(item => item.props.size), [13, 14]);
  }
});

test("iPadOS replays the same real steps with the existing tablet layout", () => {
  const h = createToolHarness("ios", { width: 820 });
  for (const call of calls) {
    const { tree, render } = h.mount(call, false);
    const row = node(h, tree, "tool-summary-row");
    if (!row) continue;
    assert.equal(row.props.style.height, 22);
    assert.equal(node(h, tree, "tool-summary-slot"), undefined);
    row.props.onPress();
    assert.ok(node(h, render(), "tool-card-body"));
    node(h, render(), "tool-summary-row").props.onPress();
    assert.equal(node(h, render(), "tool-card-body"), undefined);
  }
});

test("resizing the mounted component switches layout without losing expansion", () => {
  const options = { width: 390 };
  const h = createToolHarness("ios", options);
  const { render } = h.mount(calls[1], false);
  options.width = 820;
  assert.equal(node(h, render(), "tool-summary-slot"), undefined);
  node(h, render(), "tool-summary-row").props.onPress();
  options.width = 390;
  assert.ok(node(h, render(), "tool-card-body"));
  assert.equal(node(h, render(), "tool-summary-slot"), undefined);
  node(h, render(), "tool-summary-row").props.onPress();
  assert.ok(node(h, render(), "tool-summary-slot"));
});
