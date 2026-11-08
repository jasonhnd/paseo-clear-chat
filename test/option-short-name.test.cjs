const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const { optionShortName } = h.load("client/option-short-name.ts");
test.after(() => h.dispose());

test("derives a short name from the question title", () => {
  assert.equal(optionShortName("Which database?", 1), "Database");
  assert.equal(optionShortName("Release schedule?", 2), "Release schedule");
  assert.equal(optionShortName("Which storage should the first version use?", 1), "Storage");
  assert.equal(optionShortName("Do you want Postgres?", 1), "Postgres");
  assert.equal(optionShortName("Should we use Postgres?", 1), "Postgres");
  assert.equal(optionShortName("What do you want to use for storage?", 1), "For storage");
  assert.equal(optionShortName("Please choose a deployment region?", 1), "A deployment regi…");
  assert.equal(optionShortName("Which?", 3), "Question 3");
});
