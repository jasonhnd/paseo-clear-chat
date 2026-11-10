const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const { parseOptionQuestions: parse, formatOptionAnswer } = h.load("client/option-questions.ts");
const { customAnswerLetter, formatCustomAnswers } = h.load("client/option-custom-answer.ts");
test.after(() => h.dispose());

function questionSet(sections) {
  const set = parse(`${sections.join("\n\n")}\n\nReply: A`);
  assert.ok(set);
  return set;
}
const option = (letter, note) => ({ kind: "option", letter, note });
const custom = (letter, content) => ({ kind: "custom", letter, content });

test("derives the next letter from the last original option without mutation", () => {
  for (const [letters, expected] of [["ABCD", "E"], ["ABC", "D"], ["ACE", "F"], ["ABH", "I"]]) {
    const set = questionSet([`Pick?\n${[...letters].map(c => `${c} Option ${c}`).join("\n")}`]);
    const q = set.questions[0];
    const before = structuredClone(q.options);
    assert.equal(customAnswerLetter(q), expected);
    assert.deepEqual(q.options, before);
  }
});

test("ordinary-only messages match the existing formatter and preserve question order", () => {
  const cases = [
    [questionSet(["Pick?\nA One\nC Three\nE Five"]), { 0: option("E", " first\nsecond ") }],
    [questionSet(["12) First?\nA One\nC Three", "2) Second?\nB Two\nD Four", "A3 Third?\nA One\nC Three"]),
      { 0: option("C", "one\r\ntwo"), 1: option("D"), 2: option("A", " ok ") }],
  ];
  for (const [set, answers] of cases) {
    const formatted = formatCustomAnswers(set, answers);
    assert.equal(formatted.message, formatOptionAnswer(set, answers));
  }
  assert.equal(formatCustomAnswers(...cases[0]).index, "1E");
  assert.equal(formatCustomAnswers(...cases[1]).index, "1C 2D 3A");
});

test("formats a normal/custom mix with the custom question in the middle", () => {
  const set = questionSet(["1) First?\nA One\nB Two", "2) Second?\nA One\nB Two\nC Three\nD Four", "3) Third?\nA One\nB Two"]);
  assert.deepEqual(formatCustomAnswers(set, { 0: option("B"), 1: custom("E", "Use the existing plan.\nPreserve this second line."), 2: option("A") }), {
    index: "1B 2E 3A",
    message: "1B 2E 3A\n\n2E：\nUse the existing plan.\nPreserve this second line.",
  });
});

test("preserves custom content and labels multiple blocks in question order", () => {
  const set = questionSet(["Z9 First?\nA One\nC Three\nE Five", "1) Second?\nA One\nB Two", "A3 Third?\nA One\nB Two\nH Eight"]);
  assert.deepEqual(formatCustomAnswers(set, { 0: custom("F", "  雪：🌸\r\n second \n"), 1: custom("C", "single line"), 2: custom("I", " end  ") }), {
    index: "1F 2C 3I",
    message: "1F 2C 3I\n\n1F：\n  雪：🌸\r\n second \n\n\n2C：\nsingle line\n\n3I：\n end  ",
  });
  const single = questionSet(["Pick?\nA One\nB Two"]);
  assert.deepEqual(formatCustomAnswers(single, { 0: custom("C", "hello") }), { index: "1C", message: "1C\n\n1C：\nhello" });
});

test("rejects incomplete, invalid, draft and unsupported mixed-note answers", () => {
  const set = questionSet(["1) First?\nA One\nC Three", "2) Second?\nA One\nB Two"]);
  for (const answers of [
    { 0: option("A") },
    { 0: option("B"), 1: option("A") },
    { 0: custom("C", "wrong letter"), 1: option("A") },
    { 0: custom("D", " \t\n\u3000"), 1: option("A") },
    { 0: { kind: "draft", letter: "D", content: "not confirmed" }, 1: option("A") },
    { 0: { letter: "D", content: "untagged" }, 1: option("A") },
    { 0: custom("D", "confirmed"), 1: option("A", "important note") },
  ]) assert.equal(formatCustomAnswers(set, answers), null);
});
