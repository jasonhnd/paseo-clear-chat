const assert = require("node:assert/strict");
const test = require("node:test");
const {
  JUMP_CHIPS_MIN_LENGTH,
  JUMP_CHIPS_MIN_ANCHORS,
  JUMP_CHIPS_MAX,
  JUMP_CHIPS_LABEL_MAX,
  buildJumpChips,
  jumpHeadingLines,
} = require("../client/jump-chips.ts");

const longReply = text => text + "\n" + "x".repeat(JUMP_CHIPS_MIN_LENGTH);
const three = "# First\n## Second\n### Third";

test("the length threshold is inclusive", () => {
  assert.equal(JUMP_CHIPS_MIN_LENGTH, 1200);
  const atThreshold = three + "\n" + "x".repeat(JUMP_CHIPS_MIN_LENGTH - three.length - 1);
  assert.deepEqual(buildJumpChips(atThreshold.slice(0, -1)), []);
  assert.deepEqual(buildJumpChips(atThreshold), [
    { index: 0, label: "First" },
    { index: 1, label: "Second" },
    { index: 2, label: "Third" },
  ]);
  const astral = three + "\n" + "😀".repeat(JUMP_CHIPS_MIN_LENGTH - three.length - 2);
  assert.deepEqual(buildJumpChips(astral), []);
  assert.equal(buildJumpChips(astral + "😀").length, 3);
});

test("two anchors are required, including when both are headings", () => {
  assert.equal(JUMP_CHIPS_MIN_ANCHORS, 2);
  assert.deepEqual(buildJumpChips(longReply("# First\n#### Fourth")), []);
  assert.deepEqual(buildJumpChips(longReply("# First\n## Second\n#### Fourth")), [
    { index: 0, label: "First" }, { index: 1, label: "Second" },
  ]);
});

test("two bold anchors meet the inclusive length threshold", () => {
  const anchors = "**First**\n\t__Second__";
  const reply = anchors + "\n" + "x".repeat(JUMP_CHIPS_MIN_LENGTH - anchors.length - 1);
  assert.deepEqual(buildJumpChips(reply.slice(0, -1)), []);
  assert.deepEqual(buildJumpChips(reply), [
    { index: 0, label: "First" }, { index: 1, label: "Second" },
  ]);
});

test("bold anchors exclude fenced, table, list and quoted content and partial phrases", () => {
  const reply = [
    "**First**", "```", "**Hidden in fence**", "```", "  ~~~", "__Hidden too__", "  ~~~",
    "| Header | Other |", "| --- | --- |", "**Table | row**", "# Table | row", "",
    "- **List item**", "  **List continuation**", "", "> **Quote**", "",
    "**A.** text", "**Trailing** prose", "**one** and **two**", "__one__ and __two__",
    "**mixed __ markers**", "**   **", "__\t__", "**Second**",
  ].join("\n");
  assert.deepEqual(jumpHeadingLines(reply), [
    { line: 0, index: 0, heading: "First" },
    { line: 24, index: 1, heading: "Second" },
  ]);
});

test("bold labels are cleaned and shortened, and share indices with headings", () => {
  const reply = ["# Heading", "**[Link](https://example.org) _and_ `code`**", "__`_`__", "## Next", "**" + "😀".repeat(25) + "**"].join("\n");
  assert.deepEqual(jumpHeadingLines(reply), [
    { line: 0, index: 0, heading: "Heading" },
    { line: 1, index: 1, heading: "Link and code" },
    { line: 2, index: 2, heading: "" },
    { line: 3, index: 3, heading: "Next" },
    { line: 4, index: 4, heading: "😀".repeat(25) },
  ]);
  assert.deepEqual(buildJumpChips(longReply(reply)), [
    { index: 0, label: "Heading" }, { index: 1, label: "Link and code" },
    { index: 3, label: "Next" }, { index: 4, label: "😀".repeat(24) + "…" },
  ]);
  const many = Array.from({ length: 10 }, (_, i) => i % 2 ? `**Bold ${i}**` : `# Heading ${i}`).join("\n");
  assert.equal(jumpHeadingLines(many).length, 10);
  assert.deepEqual(jumpHeadingLines(many).map(anchor => anchor.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(buildJumpChips(longReply(many)).length, 8);
});

test("only unindented level one to three headings count", () => {
  assert.deepEqual(buildJumpChips(longReply(
    "# One\n#### Four\n    # Indented\n   ## Also indented\n#No space\n## Two\n### Three"
  )), [
    { index: 0, label: "One" },
    { index: 1, label: "Two" },
    { index: 2, label: "Three" },
  ]);
});

test("fenced code, including an unclosed fence, has no headings", () => {
  const reply = ["# One", "```js", "# Hidden", "```", "## Two", "~~~", "## Hidden", "~~~", "### Three", "```", "# Hidden to end"].join("\n");
  assert.deepEqual(buildJumpChips(longReply(reply)), [
    { index: 0, label: "One" },
    { index: 1, label: "Two" },
    { index: 2, label: "Three" },
  ]);
  assert.deepEqual(buildJumpChips(longReply("# One\n~~~\n# Hidden\n## Hidden")), []);
  assert.deepEqual(buildJumpChips(longReply("# One\n```\n# Hidden\n~~~\n# Two\n# Three")), [
    { index: 0, label: "One" }, { index: 1, label: "Two" }, { index: 2, label: "Three" },
  ]);
});

test("only the first eight headings can become chips", () => {
  assert.equal(JUMP_CHIPS_MAX, 8);
  const headings = Array.from({ length: 12 }, (_, i) => `# Heading ${i}`);
  headings[1] = "# ***";
  assert.deepEqual(buildJumpChips(longReply(headings.join("\n"))),
    [0, 2, 3, 4, 5, 6, 7].map(index => ({ index, label: `Heading ${index}` })));
  assert.equal(buildJumpChips(longReply(Array.from({ length: 12 }, (_, i) => `# Heading ${i}`).join("\n"))).length, 8);
});

test("labels remove markup and trailing hashes, and truncate by character", () => {
  assert.equal(JUMP_CHIPS_LABEL_MAX, 24);
  const chinese = "中文标题".repeat(6);
  const japanese = "日本語の見出し".repeat(4);
  const reply = ["#  **Bold** _and_ `code` ###  ", "## [Link text](https://example.com/path)", "### " + "a".repeat(25), "# " + chinese, "# " + japanese, "# " + "😀".repeat(25)].join("\n");
  assert.deepEqual(buildJumpChips(longReply(reply)), [
    { index: 0, label: "Bold and code" },
    { index: 1, label: "Link text" },
    { index: 2, label: "a".repeat(24) + "…" },
    { index: 3, label: chinese },
    { index: 4, label: Array.from(japanese).slice(0, 24).join("") + "…" },
    { index: 5, label: "😀".repeat(24) + "…" },
  ]);
});

test("empty labels still count toward the minimum and later indices", () => {
  assert.deepEqual(buildJumpChips(longReply("# ***\n## _`_\n### Kept")), [
    { index: 2, label: "Kept" },
  ]);
});
