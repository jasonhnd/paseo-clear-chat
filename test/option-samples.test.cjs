const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const h = require("./helpers/tool-harness.cjs").createToolHarness();
const { parseOptionQuestions } = h.load("client/option-questions.ts");

const samples = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "answer-card-samples.json"), "utf8"));

test("real replies split into their questions even with blank lines and prose between options", () => {
  for (const sample of samples) {
    const set = parseOptionQuestions(sample.text);
    assert.notEqual(set, null, `${sample.name}: expected an option set`);
    assert.equal(set.questions.length, sample.questions, `${sample.name}: question count`);
    for (const question of set.questions) {
      const letters = question.options.map((option) => option.letter);
      assert.ok(letters.length >= 2, `${sample.name}: every question has options`);
      for (let i = 1; i < letters.length; i++) {
        assert.ok(letters[i] > letters[i - 1], `${sample.name}: letters move forward (${letters.join(",")})`);
      }
      for (const option of question.options) assert.ok(option.text.trim().length > 0, `${sample.name}: option text`);
    }
  }
});

test("options with no blank lines between them still split as before", () => {
  const tight = ["1) Which storage?", "A one", "B two", "", "Reply: A"].join("\n");
  const set = parseOptionQuestions(tight);
  assert.notEqual(set, null);
  assert.equal(set.questions.length, 1);
  assert.deepEqual(set.questions[0].options.map((option) => option.letter), ["A", "B"]);
});

test("letters that go backwards still void the section", () => {
  const backwards = ["1) Pick?", "B two", "A one", "", "Reply: A"].join("\n");
  assert.equal(parseOptionQuestions(backwards), null);
});
