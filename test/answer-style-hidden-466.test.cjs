"use strict";

// #466: the answer-style composer item is hidden for now; choosing a style had no effect.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { resolve } = require("node:path");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const source = fs.readFileSync(resolve(__dirname, "../index.client.tsx"), "utf8");

test("the plugin registers no composer item with the id answer-style", () => {
  const registrations = [...source.matchAll(/addComposerItem\(\s*\{[\s\S]{0,200}?\}\s*\)/g)].map(match => match[0]);
  const answerStyle = registrations.filter(call => /id:\s*"answer-style"/.test(call));
  assert.deepEqual(answerStyle, [], "no addComposerItem call may register id answer-style");
  assert.equal(/id:\s*"answer-style"/.test(source), false);
});

test("the answer-style control still exists so the saved setting keeps working", t => {
  const h = createToolHarness("web", { presentationHost: {} });
  t.after(() => { h.unmount(); h.dispose(); });
  const m = h.load("client/components/answer-style-control.tsx");
  assert.equal(typeof m.AnswerStyleControl, "function");
  assert.equal(typeof m.composeAnswerText, "function");
});
