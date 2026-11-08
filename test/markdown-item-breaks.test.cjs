const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const { parseMarkdown, inlineToText } = createToolHarness().load("client/components/markdown/parse.ts");
const parseWithBreaks = text => parseMarkdown(text, undefined, { keepItemBreaks: true });
const textOf = block => inlineToText(block.spans);

test("missing and disabled options retain the original call's output", () => {
  const replies = [
    "Question\nA. First\nB. Second",
    "1. Question\nA. First\nB. Second",
    "> Question\n> A. First\n> B. Second",
    "Question\nA　First\nB：Second\nC: Third",
    "1. Question\nＡ First\n**Ｂ**\tSecond",
  ];
  for (const reply of replies) {
    const original = parseMarkdown(reply);
    assert.deepEqual(parseMarkdown(reply, undefined), original);
    assert.deepEqual(parseMarkdown(reply, undefined, {}), original);
    assert.deepEqual(parseMarkdown(reply, undefined, { keepItemBreaks: false }), original);
  }
  assert.deepEqual(parseMarkdown(replies[0]), [{
    kind: "paragraph", spans: [{ kind: "text", text: "Question A. First B. Second" }],
  }]);
  assert.equal(textOf(parseMarkdown(replies[1])[0].items[0]), "Question A. First B. Second");
  assert.equal(inlineToText(parseMarkdown(replies[2])[0].paragraphs[0]), "Question A. First B. Second");
});

test("lettered paragraph options keep breaks in a single text span", () => {
  assert.deepEqual(parseWithBreaks("A. One\nB. Two\nC. Three\nD. Four"), [{
    kind: "paragraph", spans: [{ kind: "text", text: "A. One\nB. Two\nC. Three\nD. Four" }],
  }]);
});

test("numbered list item continuations keep option breaks and fold wrapped text", () => {
  const [list] = parseWithBreaks("1. Question\nA. First\nwrapped line\nB. Second\n2. Next");
  assert.equal(list.kind, "list");
  assert.equal(list.items.length, 2);
  assert.equal(textOf(list.items[0]), "Question\nA. First wrapped line\nB. Second");
  assert.equal(textOf(list.items[1]), "Next");
  const [newMarkers] = parseWithBreaks("1. Question\nＡ　First\nB: Second");
  assert.equal(textOf(newMarkers.items[0]), "Question\nＡ　First\nB: Second");
});

test("formatted, parenthesized and full-width markers count", () => {
  for (const line of ["**A.** text", "_B._ text", "*C)* text", "D) text", "E）text", "F、text", "\t  G.\ttext", "H） text",
    "A　First", "B：Second", "C: Third", "D:\tFourth", "F\tSixth", "Ａ　First", "Ｈ. Last", "**Ａ** First"]) {
    const [block] = parseWithBreaks(`Question\n${line}`);
    assert.equal(textOf(block), `Question\n${inlineToText(parseMarkdown(line)[0].spans)}`, line);
  }
});

test("plain-space ASCII markers need an adjacent consecutive marker", () => {
  const samples = [
    ["Intro\nA new setting is here.\nMore prose.", "Intro A new setting is here. More prose."],
    ["Intro\nA 先做\nB 先不做", "Intro\nA 先做\nB 先不做"],
    ["Intro\nA One\nB Two\nC Three", "Intro\nA One\nB Two\nC Three"],
    ["Intro\nA 先做\nB. 先不做", "Intro A 先做\nB. 先不做"],
    ["Intro\nB 先做", "Intro B 先做"],
    ["Intro\nA One\nB　Two", "Intro A One\nB　Two"],
    ["Intro\nA One\nC Three", "Intro A One C Three"],
    ["Intro\nB Two\nA One", "Intro B Two A One"],
    ["Intro\n**A** One\n_B_ Two", "Intro\nA One\nB Two"],
  ];
  for (const [source, expected] of samples) {
    assert.equal(textOf(parseWithBreaks(source)[0]), expected, source);
    const disabledText = source.replaceAll("\n", " ");
    assert.deepEqual(parseMarkdown(source, undefined, { keepItemBreaks: false }), parseMarkdown(disabledText), source);
  }
});

test("plain-space sequences respect list items and quote paragraphs", () => {
  const [list] = parseWithBreaks("1. Question\nA One\nB Two\n2. Next\nA Alone\n3. A First\nB Second");
  assert.deepEqual(list.items.map(textOf), ["Question\nA One\nB Two", "Next A Alone", "A First\nB Second"]);
  const [quote] = parseWithBreaks("> Question\n> A One\n> B Two\n>\n> A Alone\n> prose");
  assert.deepEqual(quote.paragraphs.map(inlineToText), ["Question\nA One\nB Two", "A Alone prose"]);
  const [separateItems] = parseWithBreaks("1. Question\nA One\n2. B Two");
  assert.deepEqual(separateItems.items.map(textOf), ["Question A One", "B Two"]);
});

test("similar prose and markers without text do not count", () => {
  for (const line of ["e.g. text", "a. text", "I. text", "Ｉ. text", "A.B.", "A:text", "Also, A. text", "A", "A.", "A)", "A：", "A　", "A: ", "B) ", "C）", "D、**"]) {
    const [block] = parseWithBreaks(`Question\n${line}`);
    assert.equal(textOf(block).includes("\n"), false, line);
    assert.deepEqual(parseWithBreaks(`Question\n${line}`), parseMarkdown(`Question\n${line}`), line);
  }
});

test("quoted paragraphs keep option breaks and preserve paragraph boundaries", () => {
  const [quote] = parseWithBreaks("> Question\n> A. First\n> wrapped line\n> B. Second\n>\n> Another question\n> C、Third\n> Ｄ：Fourth");
  assert.equal(quote.kind, "quote");
  assert.deepEqual(quote.paragraphs.map(inlineToText), [
    "Question\nA. First wrapped line\nB. Second", "Another question\nC、Third\nＤ：Fourth",
  ]);
});

test("ordinary prose and explicit hard breaks retain their existing behavior", () => {
  for (const source of ["Plain prose\ncontinues here.", "First  \nsecond\nthird", "First\\\nsecond"]) {
    assert.deepEqual(parseWithBreaks(source), parseMarkdown(source));
  }
  assert.equal(textOf(parseWithBreaks("First  \nsecond\nB. Choice\nwrapped")[0]),
    "First\nsecond\nB. Choice wrapped");
});

test("other block recognition and heading callbacks are unchanged", () => {
  const source = "# Heading\n\n```\nA. code\n```\n\n---\n\n| Header |\n| --- |\n| A. cell |\n\n- Bullet\n- Next\n\n> Quote";
  const oldHeadings = [];
  const newHeadings = [];
  const before = parseMarkdown(source, (block, line) => oldHeadings.push([block, line]));
  const after = parseMarkdown(source, (block, line) => newHeadings.push([block, line]), { keepItemBreaks: true });
  assert.deepEqual(after, before);
  assert.deepEqual(newHeadings, oldHeadings);
});
