"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { join } = require("node:path");

const fixture = join(__dirname, "fixtures/multi-source/fixture.cjs");
function run(requests) {
  const child = spawnSync(process.execPath, [fixture], {
    input: requests.map(request => typeof request === "string" ? request : JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, "");
  return child.stdout.trim().split("\n").map(JSON.parse);
}
const commands = [
  { id: 1, op: "start" }, { id: 2, op: "human" },
  { id: 3, op: "release", source: "source-b" },
  { id: 4, op: "release", source: "source-a" }, { id: 5, op: "finish" },
];
const expected = [
  { sequence: 1, type: "task_started", source: "source-a" },
  { sequence: 2, type: "task_started", source: "source-b" },
  { sequence: 3, type: "human_message", messageId: "message-human", text: "Synthetic human input." },
  { sequence: 4, type: "message", messageId: "message-source-b", source: "source-b", text: "Identical synthetic message." },
  { sequence: 5, type: "task_finished", source: "source-b" },
  { sequence: 6, type: "message", messageId: "message-source-a", source: "source-a", text: "Identical synthetic message." },
  { sequence: 7, type: "task_finished", source: "source-a" },
  { sequence: 8, type: "run_finished" },
];
const events = rows => rows.filter(row => row.event).map(row => row.event);
const verify = rows => assert.deepEqual(events(rows), expected);

test("two overlapping tasks release identical text around concurrent human input in a controlled order", () => {
  const rows = run(commands);
  verify(rows);
  assert.deepEqual(rows.filter(row => row.id), [
    { id: 1, result: { pending: ["source-a", "source-b"] } },
    { id: 2, result: { pending: ["source-a", "source-b"] } },
    { id: 3, result: { pending: ["source-a"] } },
    { id: 4, result: { pending: [] } },
    { id: 5, result: { complete: true } },
  ]);
  assert.deepEqual(rows, run(commands), "pipelined requests produce the same full transcript");
});

test("the transcript oracle rejects loss, duplication, swapped identities and reordered deliveries", () => {
  const original = run(commands);
  const drop = structuredClone(original); drop.splice(drop.findIndex(row => row.event?.messageId === "message-source-a"), 1);
  const duplicate = structuredClone(original); duplicate.push(structuredClone(duplicate.find(row => row.event?.messageId === "message-source-b")));
  const misattribute = structuredClone(original); misattribute.find(row => row.event?.messageId === "message-source-b").event.source = "source-a";
  const reorder = structuredClone(original);
  const a = reorder.findIndex(row => row.event?.messageId === "message-source-a");
  const b = reorder.findIndex(row => row.event?.messageId === "message-source-b");
  [reorder[a], reorder[b]] = [reorder[b], reorder[a]];
  for (const altered of [drop, duplicate, misattribute, reorder]) assert.throws(() => verify(altered), assert.AssertionError);
});

test("invalid transitions and sources emit errors without releasing or duplicating tasks", () => {
  const rows = run([
    { id: 1, op: "human" }, { id: 2, op: "start" }, { id: 3, op: "start" },
    { id: 4, op: "release", source: "source-a" }, { id: 5, op: "finish" },
    { id: 6, op: "human" }, { id: 7, op: "human" }, { id: 8, op: "release", source: "unknown" },
    { id: 9, op: "release", source: "source-b" }, { id: 10, op: "release", source: "source-b" },
    { id: 11, op: "release", source: "source-a" }, { id: 12, op: "finish" },
    { id: 13, op: "finish" }, { id: 14, op: "unknown" }, "not json",
  ]);
  verify(rows);
  assert.deepEqual(rows.filter(row => row.error).map(row => row.id), [1, 3, 4, 5, 7, 8, 10, 13, 14, null]);
  assert.deepEqual(rows.filter(row => row.result).map(row => row.id), [2, 6, 9, 11, 12]);
});

test("the opposite release order remains controlled and preserves each source identity", () => {
  const rows = run([commands[0], commands[1], { id: 3, op: "release", source: "source-a" },
    { id: 4, op: "release", source: "source-b" }, commands[4]]);
  const messages = events(rows).filter(event => event.type === "message");
  assert.deepEqual(messages.map(({ source, messageId, text }) => ({ source, messageId, text })), [
    { source: "source-a", messageId: "message-source-a", text: "Identical synthetic message." },
    { source: "source-b", messageId: "message-source-b", text: "Identical synthetic message." },
  ]);
});

test("documented protocol inputs reproduce the checked transcript", () => {
  const fs = require("node:fs");
  const directory = join(__dirname, "fixtures/multi-source");
  const input = fs.readFileSync(join(directory, "input.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const output = fs.readFileSync(join(directory, "output.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(input, commands);
  assert.deepEqual(run(input), output);
  verify(output);
});
