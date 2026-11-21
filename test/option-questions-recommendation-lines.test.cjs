const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const { parseOptionQuestions: parse } = h.load("client/option-questions.ts");
test.after(() => h.dispose());

// A recommendation written on its own line is a marker, not the tail of the option above it.
// Agents put "Recommended: A" on a separate line after the list, so it must not leak into the
// option's text, and it must still pick the option it names.
const forms = [
  ["en", "Recommended: A"],
  ["zh-CN", "推荐：A"],
  ["ja", "おすすめ：A"],
];

test("a recommendation line between two questions never becomes option text", () => {
  for (const [locale, line] of forms) {
    const set = parse(`1) Which rollout?\nA Soft launch\nB Full rollout\nC Wait\n${line}\n\n2) When?\nA Today\nB Next week\n\nReply: A`);
    assert.ok(set, `${locale}: a two-question set is parsed`);
    assert.deepEqual(set.questions[0].options.map(option => option.text), ["Soft launch", "Full rollout", "Wait"], `${locale}: the marker is not part of the option above it`);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [true, false, false], `${locale}: the marker still picks A`);
    assert.deepEqual(set.questions[1].options.map(option => option.text), ["Today", "Next week"], `${locale}: the next question keeps its own options`);
    assert.deepEqual(set.questions[1].options.map(option => option.recommended), [false, false], `${locale}: the next question is not recommended`);
    assert.equal(set.recommendedFound, true, locale);
  }
});

const lastForms = [
  ["en", "Recommended: C"],
  ["zh-CN", "推荐：C"],
  ["ja", "おすすめ：C"],
];

test("a recommendation line after the last question never becomes option text", () => {
  for (const [locale, line] of lastForms) {
    const set = parse(`1) Which rollout?\nA Soft launch\nB Full rollout\nC Wait\n${line}\n\nReply: A`);
    assert.ok(set, `${locale}: the set is parsed`);
    assert.deepEqual(set.questions[0].options.map(option => option.text), ["Soft launch", "Full rollout", "Wait"], `${locale}: the last option keeps only its own text`);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false, true], `${locale}: the marker still picks C`);
    assert.equal(set.recommendedFound, true, locale);
  }
});

test("an option's own wrapped lines still join its text", () => {
  const set = parse("1) Which storage?\nA Postgres\nneeds a server, runs anywhere\nB SQLite\none file, no server\n\nReply: A");
  assert.ok(set);
  assert.deepEqual(set.questions[0].options.map(option => option.text), ["Postgres\nneeds a server, runs anywhere", "SQLite\none file, no server"], "a line that is not a marker stays part of the option above it");
  assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false]);
});
