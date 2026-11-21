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

// The marker may wear a period or bold around it; the line is still nothing but the marker.
const tailForms = [
  ["en period", "Recommended: C."],
  ["en bold", "**Recommended: C**"],
  ["zh bold", "**推荐：C**"],
  ["ja bold", "**おすすめ：C**"],
  ["ja period", "おすすめ：C。"],
  ["ja synonym", "オススメ：C"],
];

test("a marker line may end in a period or bold and still stays out of the option text", () => {
  for (const [label, line] of tailForms) {
    const set = parse(`1) Which rollout?\nA Soft launch\nB Full rollout\nC Wait\n${line}\n\nReply: A`);
    assert.ok(set, label);
    assert.deepEqual(set.questions[0].options.map(option => option.text), ["Soft launch", "Full rollout", "Wait"], `${label}: the whole marker line is cut out`);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false, true], `${label}: the marker still picks C`);
    assert.equal(set.recommendedFound, true, label);
  }
});

test("a marker in the middle of a line stays with the option as text", () => {
  const cases = [
    ["en", "runs a server, per Recommended: A"],
    ["zh-CN", "说明见推荐：A"],
    ["ja", "runs a server, per おすすめ：A"],
  ];
  for (const [locale, line] of cases) {
    const set = parse(`1) Which storage?\nA Postgres\n${line}\nB SQLite\n\nReply: A`);
    assert.ok(set, locale);
    assert.deepEqual(set.questions[0].options.map(option => option.text), [`Postgres\n${line}`, "SQLite"], `${locale}: an in-line mention is option text, not a marker line`);
  }
});

test("prose after the marker keeps the line as option text", () => {
  const set = parse("1) Which rollout?\nA Soft launch\nB Full rollout\nC Wait\nRecommended: A because it ships today\n\nReply: A");
  assert.ok(set);
  assert.deepEqual(set.questions[0].options.map(option => option.text), ["Soft launch", "Full rollout", "Wait\nRecommended: A because it ships today"], "a sentence that merely starts with the marker is still text");
});

test("a Japanese marker line alone, with no reply hint, still carries a card", () => {
  for (const line of ["おすすめ：C", "オススメ：C"]) {
    const set = parse(`1) Which rollout?\nA Soft launch\nB Full rollout\nC Wait\n${line}`);
    assert.ok(set, `${line}: a card without a reply hint`);
    assert.equal(set.hint, false, `${line}: no reply hint`);
    assert.equal(set.recommendedFound, true, line);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false, true], line);
  }
});

test("a Japanese marker needs a separator, so prose does not become a card", () => {
  assert.equal(parse("変更点:\nA API追加\nB バグ修正\nおすすめAプランを参照"), null, "おすすめAプラン is prose, not a marker");
  const set = parse("変更点:\nA API追加\nB バグ修正\nおすすめAプランを参照\nReply: A");
  assert.ok(set);
  assert.equal(set.recommendedFound, false);
  assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false]);
});

test("a Japanese marker accepts a full-width space as its separator", () => {
  for (const [label, line] of [
    ["space after the word", "おすすめ　C"],
    ["space before the colon", "おすすめ　：C"],
    ["space after the colon", "おすすめ：　C"],
    ["synonym with a space", "オススメ　C"],
  ]) {
    const set = parse(`1) Which rollout?\nA Soft launch\nB Full rollout\nC Wait\n${line}\n\nReply: A`);
    assert.ok(set, label);
    assert.deepEqual(set.questions[0].options.map(option => option.text), ["Soft launch", "Full rollout", "Wait"], `${label}: the marker line is cut out`);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false, true], `${label}: the marker picks C`);
  }
  assert.equal(parse("変更点:\nA API追加\nB バグ修正\nおすすめAプランを参照"), null, "a full-width space separator must not let おすすめAプラン match");
});

test("a negated marker never marks an option", () => {
  for (const line of ["不推荐：A", "not recommended: A", "Not recommended: A."]) {
    const set = parse(`1) Pick?\nA One\nB Two\n\n${line}\nReply: A`);
    assert.ok(set, line);
    assert.equal(set.recommendedFound, false, line);
    assert.deepEqual(set.questions[0].options.map(option => option.recommended), [false, false], line);
  }
});
