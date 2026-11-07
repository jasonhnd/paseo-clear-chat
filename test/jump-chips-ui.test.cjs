const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const title = "A heading long enough to need truncation";
const reply = `# First\n\`\`\`\n# Hidden\n\`\`\`\n  # Indented\n## ${title}\n### Third\n${"body ".repeat(700)}`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function fixture(t, platform = "web") {
  const h = createToolHarness(platform, { markdown: true, preferences: { showJumpChips: true }, width: 390 });
  t.after(() => { h.unmount(); h.dispose(); });
  const transformer = h.transformers.get("assistant_message");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const draw = (text = reply, phase = "complete") => {
    const result = transformer.transform({ item: { type: "assistant_message", text }, phase });
    const item = result.items[0];
    assert.equal(item.data.phase, phase);
    return h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item, timestamp: new Date(10), theme: { colors: {} } } });
  };
  return { h, draw };
}

for (const platform of ["ios", "android"]) {
  test(`${platform}: finished long replies have no chips with the setting on or off`, t => {
    const { h, draw } = fixture(t, platform);
    const enabled = draw();
    assert.equal(byId(h, enabled, "jump-chips"), undefined);
    const enabledText = h.text(enabled);
    assert.ok(enabledText.includes("First"));
    assert.ok(enabledText.includes(title));
    h.preferences.showJumpChips = false;
    const disabled = draw();
    assert.equal(byId(h, disabled, "jump-chips"), undefined);
    assert.equal(h.text(disabled), enabledText);
  });
}

test("chips appear only for enabled, finished long replies and preserve the reply", t => {
  const { h, draw } = fixture(t);
  h.preferences.showJumpChips = false;
  assert.equal(byId(h, draw(), "jump-chips"), undefined);
  h.preferences.showJumpChips = true;
  assert.equal(byId(h, draw("# One\n## Two\n### Three"), "jump-chips"), undefined);
  assert.equal(byId(h, draw(reply, "streaming"), "jump-chips"), undefined);
  const tree = draw();
  const row = byId(h, tree, "jump-chips");
  assert.ok(row.props.horizontal);
  assert.equal(row.props.style.maxWidth, "100%");
  const buttons = h.nodes(row, node => node.type === "Pressable");
  assert.deepEqual(buttons.map(button => button.props.accessibilityLabel), ["First", title, "Third"]);
  assert.ok(buttons.every(button => button.props.accessibilityRole === "button" && button.props.style.minHeight >= 44));
  assert.equal(h.text(buttons[1]), title.slice(0, 24) + "…");
  h.preferences.showJumpChips = false;
  const withoutChips = h.text(draw());
  h.preferences.showJumpChips = true;
  const withChips = h.text(draw());
  assert.equal(withChips, buttons.map(button => h.text(button)).join("\n") + "\n" + withoutChips);
});

test("headings use builder indices and pressing is scoped to the reply", t => {
  const { h, draw } = fixture(t);
  const tree = draw();
  const headings = h.nodes(tree, node => node.props.dataSet?.jumpHeading !== undefined);
  assert.deepEqual(headings.map(node => [node.props.dataSet.jumpHeading, h.text(node)]), [["0", "First"], ["1", title], ["2", "Third"]]);
  const root = h.nodes(tree, node => typeof node.props.ref === "function")[0];
  let selector, options;
  root.props.ref({ querySelector(value) { selector = value; return { scrollIntoView(value) { options = value; } }; } });
  byId(h, tree, "jump-chip-1").props.onPress();
  assert.equal(selector, '[data-jump-heading="1"]');
  assert.deepEqual(options, { block: "start" });
  root.props.ref({ querySelector: () => null });
  assert.doesNotThrow(() => byId(h, tree, "jump-chip-1").props.onPress());
  root.props.ref({ querySelector: () => ({}) });
  assert.doesNotThrow(() => byId(h, tree, "jump-chip-1").props.onPress());
  root.props.ref(null);
  assert.doesNotThrow(() => byId(h, tree, "jump-chip-1").props.onPress());
});
