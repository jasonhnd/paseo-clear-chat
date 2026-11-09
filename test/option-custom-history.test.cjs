const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const { parseOptionQuestions } = h.load("client/option-questions.ts");
const { formatCustomAnswers } = h.load("client/option-custom-answer.ts");
const { parseCustomAnswerHistory: decode } = h.load("client/option-custom-history.ts");
test.after(() => h.dispose());

function questions(...sections) {
  const set = parseOptionQuestions(`${sections.join("\n\n")}\n\nReply: A`);
  assert.ok(set);
  return set;
}
const mixed = questions("1) First?\nA One\nB Two", "2) Second?\nA One\nB Two\nC Three\nD Four", "3) Third?\nA One\nB Two");
const multiple = questions("Z9 First?\nA One\nC Three\nE Five", "1) Second?\nA One\nB Two", "A3 Third?\nA One\nB Two\nH Eight");

test("restores the literal mixed message without mutating questions", () => {
  const before = structuredClone(mixed);
  const message = "1B 2E 3A\n\n2E：\nline one\nline two";
  const expected = { 0: { kind: "option", letter: "B" }, 1: { kind: "custom", letter: "E", content: "line one\nline two" }, 2: { kind: "option", letter: "A" } };
  assert.deepEqual(decode(mixed, message), expected);
  assert.equal(formatCustomAnswers(mixed, expected).message, message);
  assert.deepEqual(mixed, before);
});

test("restores all-custom blocks and preserves content bytes and question order", () => {
  const message = "Z9F 1C A3I\n\nZ9F：\n  雪：🌸\r\n second \n\n\n1C：\nsingle line\n\nA3I：\n end  \n\n";
  const expected = { 0: { kind: "custom", letter: "F", content: "  雪：🌸\r\n second \n" }, 1: { kind: "custom", letter: "C", content: "single line" }, 2: { kind: "custom", letter: "I", content: " end  \n\n" } };
  assert.deepEqual(decode(multiple, message), expected);
  assert.equal(formatCustomAnswers(multiple, expected).message, message);
  const single = questions("Pick?\nA One\nB Two");
  assert.deepEqual(decode(single, "C\n\nC：\nhello"), { 0: { kind: "custom", letter: "C", content: "hello" } });
});

test("rejects malformed headers, incorrect letters and ordinary-only answers", () => {
  for (const message of [
    "1B 2D 3A", "1B 2D 3A\n\n2D：\nordinary", "1B 2E\n\n2E：\ntext",
    "1B 2E 3A 4A\n\n2E：\ntext", "1B  2E 3A\n\n2E：\ntext",
    "1B 2E 2E\n\n2E：\ntext", "2E 1B 3A\n\n2E：\ntext",
    "1C 2E 3A\n\n2E：\ntext", "1B 2F 3A\n\n2F：\ntext",
    "1B 2E 3A\r\n\r\n2E：\ntext", "1B 2E 3A\n\n2E：\n \t\n　",
  ]) assert.equal(decode(mixed, message), null, message);
  const duplicate = structuredClone(mixed);
  duplicate.questions[2].number = 2;
  assert.equal(decode(duplicate, "1B 2E 2A\n\n2E：\ntext"), null);
  const duplicateNull = structuredClone(mixed);
  duplicateNull.questions[0].number = duplicateNull.questions[1].number = null;
  assert.equal(decode(duplicateNull, "B E 3A\n\nE：\ntext"), null);
});

test("rejects missing, changed, reordered, duplicate and ambiguous blocks", () => {
  for (const message of [
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C：\ntwo",
    "Z9F 1C A3I\n\nZ9F：\none\n\nA3I：\nthree\n\n1C：\ntwo",
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C：\ntwo\n\nA3I：\nthree\n\nA3I：\nextra",
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C：\ntwo\n\nA3I：\nthree\n\n9A：\nextra",
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C:\ntwo\n\nA3I：\nthree",
    "Z9F 1C A3I\n\nZ9F：\none\n\n2C：\ntwo\n\nA3I：\nthree",
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C：\nA3I：\nambiguous\n\nA3I：\nthree",
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C：\ntwo\n\nA3I：\nthree\n\n1C：\nambiguous",
    "Z9F 1C A3I\n\nZ9F：\none\n\n1C：\n \n\nA3I：\nthree",
  ]) assert.equal(decode(multiple, message), null, message);
});
