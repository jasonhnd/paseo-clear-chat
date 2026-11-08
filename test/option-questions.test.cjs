const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const { parseOptionQuestions: parse, formatOptionAnswer: format } = h.load("client/option-questions.ts");
test.after(() => h.dispose());

test("parses a set and formats complete choices", () => {
  const set = parse(`1) Which storage should the first version use?
Background: one sentence about why it matters.
A Postgres — runs anywhere, needs a server.
B SQLite — one file, no server. Recommended.
C Files only.

2) Ship the beta this week?
A Yes
B No, wait for review

Reply with a letter for each, for example: 1B 2A`);
  assert.equal(set.hint, true);
  assert.equal(set.recommendedFound, true);
  assert.deepEqual(set.questions.map(q => q.number), [1, 2]);
  assert.equal(set.questions[0].title, "Which storage should the first version use?");
  assert.equal(set.questions[0].text, "Which storage should the first version use?\nBackground: one sentence about why it matters.");
  assert.deepEqual(set.questions[0].options.map(o => [o.letter, o.recommended]), [["A", false], ["B", true], ["C", false]]);
  assert.equal(format(set, { 0: { letter: "B", note: "needs\na server" }, 1: { letter: "A" } }), "1B (needs a server) 2A");
  assert.equal(format(set, { 0: { letter: "B" } }), null);
  assert.equal(format(set, { 0: { letter: "D" }, 1: { letter: "A" } }), null);
});

test("recognizes punctuation, full-width letters and digits, bullets and bold", () => {
  for (const question of ["1） Pick?", "1. Pick?", "1、 Pick?", "**１) Pick?**", "## **1) Pick?**", "- **1) Pick?**"]) {
    for (const options of ["A. One\nB. Two", "A) One\nB) Two", "A：One\nB：Two", "A One\nB Two", "**A** One\n**B** Two", "- **Ａ** One\n* **Ｂ** Two"]) {
      const set = parse(`${question}\n${options}\n\nReply: A`);
      assert.ok(set, `${question} / ${options}`);
      assert.equal(set.questions[0].number, 1);
      assert.deepEqual(set.questions[0].options.map(o => o.letter), ["A", "B"]);
    }
  }
});

test("recognizes full-width spaces and existing punctuation as option separators", () => {
  for (const first of ["A　先做", "Ａ　先做"]) {
    const set = parse(`Pick?\n${first}\nB　先做\nC：先做\nD: 先做\nE）先做\nF、先做\n\nReply: A`);
    assert.deepEqual(set.questions[0].options.map(({ letter, text }) => [letter, text]), [
      ["A", "先做"], ["B", "先做"], ["C", "先做"],
      ["D", "先做"], ["E", "先做"], ["F", "先做"],
    ]);
  }
});

test("full-width spaces still require text and the usual question signals", () => {
  assert.equal(parse("Pick?\nA　\nB　先做\n\nReply: A"), null);
  assert.equal(parse("Pick?\nA　先做\nB　\n\nReply: A"), null);

  // Like an ASCII space, a full-width space can make prose look like an option;
  // a single line alone still does not form an option question.
  assert.equal(parse("A　person walks into a room."), null);
  const set = parse("A　person walks into a room.\nB　person follows.\n\nReply: A");
  assert.deepEqual(set.questions[0].options.map(({ letter, text }) => [letter, text]), [
    ["A", "person walks into a room."], ["B", "person follows."],
  ]);
  assert.equal(parse("A　person walks into a room.\nB　person follows."), null);
});

test("handles an unnumbered question, continuation lines and title length", () => {
  const set = parse(`Which approach works? More context.
Extra context.
A First
  More detail
B Second

Reply with A or B`);
  assert.equal(set.questions[0].number, null);
  assert.equal(set.questions[0].title, "Which approach works?");
  assert.equal(set.questions[0].text, "Which approach works? More context.\nExtra context.");
  assert.equal(set.questions[0].options[0].text, "First\nMore detail");
  assert.equal(format(set, { 0: { letter: "A" } }), "A");
  assert.equal(parse(`${"x".repeat(120)}\nA One\nB Two\n\n回复 A`).questions[0].title.length, 100);
});

test("finds recommendations in options, question text, trailing and closing lines", () => {
  for (const text of [
    "1) Pick?\nA One\nB Two (recommended)",
    "1) Pick?\nA One\nB Two 推荐",
    "1) Pick?\nPM 推荐选 B\nA One\nB Two",
    "1) Pick?\nA One\nB Two\n\n推荐：B",
    "1) Pick?\nA One\nB Two\nRecommended: B",
    "1) Pick?\nA One\nB Two\n\nI recommend B",
  ]) {
    const set = parse(text);
    assert.ok(set, text);
    assert.deepEqual(set.questions[0].options.map(o => o.recommended), [false, true], text);
    assert.equal(set.recommendedFound, true);
  }
  assert.equal(parse("1) Pick?\nA One\nB Two\n\n推荐 C"), null);
  assert.equal(parse("1) Pick?\nA One\nB Two\nRecommended: Z"), null);
  const set = parse("1) Pick?\nA One\nB Two\n\nRecommended: C\nReply: A");
  assert.equal(set.recommendedFound, false);
});

test("recognizes option markers without treating negations as recommendations", () => {
  const cases = [
    ["SQLite（推荐）", true],
    ["SQLite (推荐)", true],
    ["SQLite（recommended）", true],
    ["SQLite (recommended)", true],
    ["SQLite 推荐", true],
    ["SQLite，推荐。", true],
    ["SQLite, recommended.", true],
    ["推荐，因为简单", true],
    ["SQLite — one file. Recommended", true],
    ["Postgres, not recommended for beginners", false],
    ["Postgres — not recommended", false],
    ["不推荐用 Postgres", false],
    ["不推荐", false],
    ["non-recommended", false],
    ["Not Recommended.", false],
  ];
  for (const [option, expected] of cases) {
    const reply = `1) Pick?\nA Other\nB ${option}`;
    for (const hint of ["", "\n\nReply: A or B"]) {
      const set = parse(reply + hint);
      if (!expected && !hint) {
        assert.equal(set, null, option);
      } else {
        assert.equal(set.hint, Boolean(hint), option);
        assert.equal(set.recommendedFound, expected, option);
        assert.deepEqual(set.questions[0].options.map(item => item.recommended), [false, expected], option);
      }
    }
  }
});

test("explicit recommendations require uppercase option letters", () => {
  for (const line of ["I recommend a different approach", "Recommended: b", "推荐 b"]) {
    const set = parse(`1) Pick?\nA One\nB Two\n\n${line}\nReply: A`);
    assert.equal(set.recommendedFound, false, line);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false], line);
  }
  for (const line of ["I recommend B", "RECOMMENDED: Ｂ", "推荐 Ｂ"]) {
    const set = parse(`1) Pick?\nA One\nB Two\n\n${line}`);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, true], line);
  }
  for (const line of ["Recommended: b", "推荐 b"]) {
    const set = parse(`1) Pick?\nA One\nB Two (${line})\n\nReply: A`);
    assert.equal(set.recommendedFound, false, line);
  }
});

test("ignores fences and block quotes", () => {
  const text = `1) Pick?
\`\`\`text
A Hidden
B Hidden
\`\`\`
> A Hidden
> B Hidden
~~~
A Hidden
B Hidden
~~~
A Visible
B Visible

Reply: A`;
  assert.deepEqual(parse(text).questions[0].options.map(o => o.text), ["Visible", "Visible"]);
  assert.equal(parse("1) Pick?\n```\nA One\nB Two\n```\n> Reply: A"), null);
  assert.equal(parse("1) Pick?\n````\n```\nA One\nB Two\n```\n````\nReply: A"), null);
});

test("recognizes options that start later or skip letters", () => {
  for (const [lines, expected] of [
    ["C 先做\nD 后做", [["C", "先做"], ["D", "后做"]]],
    ["A First\nC Third\nE Fifth", [["A", "First"], ["C", "Third"], ["E", "Fifth"]]],
    ["- **Ｃ** 先做\n- **Ｅ** 后做", [["C", "先做"], ["E", "后做"]]],
  ]) {
    const set = parse(`1) Pick?\n${lines}\n\nReply: ${expected[0][0]}`);
    assert.deepEqual(set.questions[0].options.map(({ letter, text }) => [letter, text]), expected);
    assert.equal(format(set, { 0: { letter: expected.at(-1)[0] } }), `1${expected.at(-1)[0]}`);
  }
  const recommended = parse("Pick?\nC One\nE Two\n\n推荐 E");
  assert.deepEqual(recommended.questions[0].options.map(option => option.recommended), [false, true]);
});

test("rejects isolated option-like prose and interrupted or invalid groups", () => {
  for (const text of [
    "A user logs in. B user logs out.",
    "1) First item\n2) Second item\nReply: yes",
    "A\nThis is ordinary prose.\nReply: A",
    "A person walks in.\nThis is ordinary prose.\nReply: A",
    "Pick?\nA One\nOrdinary prose.\nC Three\nReply: A",
    "Pick?\nA One\n\nC Three\nReply: A",
    "Pick?\nA One\n> hidden\nC Three\nReply: A",
    "Pick?\nC One\nC Two\nReply: C",
    "Pick?\nC One\nA Two\nReply: C",
    "1) Pick?\nA One\nB Two",
  ]) assert.equal(parse(text), null, text);
});

test("handles a long reply in linear time", () => {
  const script = `
    const assert = require("node:assert/strict");
    const h = require("./test/helpers/tool-harness.cjs").createToolHarness();
    const parse = h.load("client/option-questions.ts").parseOptionQuestions;
    assert.ok(parse("x".repeat(200000) + "\\n1) Pick?\\nA One\\nB Two\\n\\nReply: A"));
    assert.equal(parse("1) Pick?\\nA One\\nB Two\\n\\n推荐" + " ".repeat(200000) + "!"), null);
    h.dispose();
  `;
  const result = spawnSync(process.execPath, ["-e", script], { timeout: 10000, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test("formats only valid chosen answers as a composer prefix", () => {
  const partial = h.load("client/option-questions.ts").formatPartialOptionAnswer;
  const set = parse("1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A");
  assert.equal(partial(set, {}), "");
  assert.equal(partial(set, { 1: { letter: "B" } }), "2B ");
  assert.equal(partial(set, { 0: { letter: "A" }, 1: { letter: "B" } }), "1A 2B ");
  assert.equal(partial(set, { 0: { letter: "A", note: " hello\nworld " } }), "1A (hello world) ");
  assert.equal(partial(set, { 0: { letter: "Z" }, 1: { letter: "A" } }), "2A ");
  assert.equal(partial(parse("Pick?\nA One\nB Two\nReply: A"), { 0: { letter: "B" } }), "B ");
});
