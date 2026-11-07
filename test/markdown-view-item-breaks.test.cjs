const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const paragraph = "Pick one:\nA. First\nB. Second\nC. Third";
const numbered = `1. ${paragraph}`;
const folded = "Pick one: A. First B. Second C. Third";

function fixture(t, platform = "web") {
  const h = createToolHarness(platform, { markdown: true });
  t.after(() => { h.unmount(); h.dispose(); });
  const MarkdownView = h.load("client/components/markdown/markdown-view.tsx").MarkdownView;
  const draw = text => h.draw({ type: MarkdownView, props: { text, tokens: h.tokens, variant: "document" } });
  return { h, draw };
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: reply option lines follow the preference`, t => {
    const { h, draw } = fixture(t, platform);
    assert.equal(h.preferences.keepItemLineBreaks, false);
    assert.equal(h.text(draw(paragraph)), folded);
    assert.equal(h.text(draw(numbered)), `1.\n${folded}`);

    h.preferences.keepItemLineBreaks = true;
    assert.equal(h.text(draw(paragraph)), paragraph);
    const list = draw(numbered);
    assert.equal(h.text(list), `1.\n${paragraph}`);
    assert.ok(h.nodes(list, node => node.type === "Text").some(node => h.text(node) === paragraph));
  });

  test(`${platform}: ordinary paragraphs retain their original rendering`, t => {
    const { h, draw } = fixture(t, platform);
    const source = "Ordinary prose\ncontinues here.\n\nAnother paragraph\ncontinues too.";
    const before = h.text(draw(source));
    assert.equal(before, "Ordinary prose continues here.\nAnother paragraph continues too.");
    h.preferences.keepItemLineBreaks = true;
    assert.equal(h.text(draw(source)), before);
  });
}

test("switching the preference redraws an existing reply in both directions", t => {
  const { h, draw } = fixture(t);
  assert.equal(h.text(draw(paragraph)), folded);
  h.preferences.keepItemLineBreaks = true;
  assert.equal(h.text(draw(paragraph)), paragraph);
  h.preferences.keepItemLineBreaks = false;
  assert.equal(h.text(draw(paragraph)), folded);
});

test("heading marks keep the jump chip builder indices when the preference changes", t => {
  const { h, draw } = fixture(t);
  const source = `# First\n\n${paragraph}\n\n## \n\n### Third\n\n# Last\n\n${"body ".repeat(700)}`;
  const chips = h.load("client/jump-chips.ts").buildJumpChips(source);
  assert.deepEqual(chips.map(chip => chip.index), [0, 2, 3]);
  for (const enabled of [false, true, false]) {
    h.preferences.keepItemLineBreaks = enabled;
    const headings = h.nodes(draw(source), node => node.props.dataSet?.jumpHeading !== undefined);
    const marked = new Map(headings.map(node => [Number(node.props.dataSet.jumpHeading), h.text(node)]));
    for (const chip of chips) assert.equal(marked.get(chip.index), chip.label);
  }
});
