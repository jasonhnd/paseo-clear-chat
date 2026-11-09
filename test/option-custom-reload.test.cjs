const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\nC Three\nD Four\n\n3) Third?\nA One\nB Two\n\nReply: A";
const duplicateQuestions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\nC Three\nD Four\n\n2) Third?\nA One\nB Two\n\nReply: A";

function harness(t) {
  const h = createToolHarness("web");
  t.after(() => h.dispose());
  return { h, s: h.load("client/option-session.ts") };
}

function assertRestored(s, expected, choices, message) {
  const session = s.getOptionSession("a", 10);
  assert.equal(session.readOnly, true);
  assert.equal(session.sending, false);
  assert.equal(session.answeredText, message);
  assert.deepEqual(session.choices, choices);
  assert.deepEqual(session.customConfirmed, expected);
  assert.deepEqual(session.customDrafts, expected);
  assert.equal(s.answerText("a"), message);
  for (const index of Object.keys(expected)) assert.equal(session.customOpen[index], true);
}

test("send mixed answer and replay the actual message in either order", async t => {
  const { h, s } = harness(t);
  s.publishAssistantReply("a", { at: 10, text: questions });
  s.choose("a", 0, "B");
  s.setCustomDraft("a", 1, "  雪🌸\r\n second line \n");
  s.confirmCustom("a", 1);
  s.choose("a", 2, "A");
  let sent;
  s.setOptionSender(async (_agent, text) => { sent = text; });
  await s.sendAnswer("a");
  assert.equal(sent, "1B 2E 3A\n\n2E：\n  雪🌸\r\n second line \n");
  h.dispose();
  for (const userFirst of [true, false]) {
    const { s: replay } = harness(t);
    if (userFirst) replay.publishUserMessage("a", 20, sent);
    replay.publishAssistantReply("a", { at: 10, text: questions });
    if (!userFirst) replay.publishUserMessage("a", 20, sent);
    assertRestored(replay, { 1: "  雪🌸\r\n second line \n" }, { 0: "B", 1: "E", 2: "A" }, sent);
    replay.setCustomDraft("a", 1, "changed");
    assert.equal(replay.getOptionSession("a").customDrafts[1], "  雪🌸\r\n second line \n");
  }
});

test("multiple custom blocks preserve literal single-line and multiline text", t => {
  const { s } = harness(t);
  const message = "1C 2B 3C\n\n1C：\n 一行 😀 \n\n3C：\n  last\r\n行\n\n";
  s.publishUserMessage("a", 20, message);
  s.publishAssistantReply("a", { at: 10, text: questions });
  assertRestored(s, { 0: " 一行 😀 ", 2: "  last\r\n行\n\n" }, { 0: "C", 1: "B", 2: "C" }, message);
});

test("replay boundaries and changed messages discard old custom data", t => {
  const { s } = harness(t);
  const first = "1B 2E 3A\n\n2E：\nfirst";
  const later = "1C 2B 3A\n\n1C：\nlater";
  s.publishUserMessage("a", 40, later);
  s.publishAssistantReply("a", { at: 10, text: questions });
  s.publishAssistantReply("a", { at: 30, text: questions });
  assert.equal(s.getOptionSession("a", 10), null);
  s.publishUserMessage("a", 20, first);
  assert.equal(s.getOptionSession("a", 10).customConfirmed[1], "first");
  assert.equal(s.getOptionSession("a", 30).customConfirmed[0], "later");
  s.publishUserMessage("a", 20, "1A 2D 3B");
  const changed = s.getOptionSession("a", 10);
  assert.deepEqual(changed.choices, { 0: "A", 1: "D", 2: "B" });
  assert.deepEqual(changed.customConfirmed, {});
  assert.deepEqual(changed.customDrafts, {});
  assert.equal(changed.answeredText, "1A 2D 3B");
  assert.equal(s.getOptionSession("a", 30).customConfirmed[0], "later");
});

test("a late assistant boundary removes a wrongly matched later message", t => {
  const { s } = harness(t);
  s.publishAssistantReply("a", { at: 10, text: questions });
  s.publishUserMessage("a", 40, "1B 2E 3A\n\n2E：\nlater");
  s.publishAssistantReply("a", { at: 30, text: "Another reply" });
  s.publishAssistantReply("a", { at: 50, text: questions });
  assert.equal(s.getOptionSession("a", 10), null);
});

test("invalid and ambiguous blocks fall back to the complete raw message", t => {
  const invalid = [
    "1B 2E 3A\n\n2F：\nwrong label",
    "1B 2E 3A\n\n2E：\ntext\n\n2E：\nduplicate",
    "1B 2E 3A\n\n2E：\ntext\n\n9A：\nextra",
    "1C 2B 3C\n\n1C：\nfirst",
    "1C 2B 3C\n\n1C：\nfirst\n\n3C：\ninside content\n\n3C：\nlast",
    "1B 2E 3A\n\n2E:\ninvalid punctuation",
    "ordinary prose mentioning 2E：\ntext",
  ];
  for (const [i, message] of invalid.entries()) {
    const { s } = harness(t);
    s.publishAssistantReply("a", { at: 10, text: questions });
    s.publishUserMessage("a", 20, message);
    const session = s.getOptionSession("a");
    assert.equal(session.answeredText, message, String(i));
    assert.deepEqual(session.customConfirmed, {}, String(i));
    assert.deepEqual(session.customDrafts, {}, String(i));
    assert.deepEqual(session.choices, {}, String(i));
  }
  const { s } = harness(t);
  s.publishAssistantReply("a", { at: 10, text: duplicateQuestions });
  assert.ok(s.getOptionSession("a"));
  s.publishUserMessage("a", 20, "1B 2E 2A\n\n2E：\ntext");
  assert.equal(s.getOptionSession("a").answeredText, "1B 2E 2A\n\n2E：\ntext");
  assert.deepEqual(s.getOptionSession("a").customConfirmed, {});
});

test("ordinary messages stay unchanged and unsent drafts do not survive a reload", t => {
  const { h, s } = harness(t);
  s.publishAssistantReply("a", { at: 10, text: questions });
  s.setCustomDraft("a", 1, "never sent");
  h.dispose();
  const { s: replay } = harness(t);
  replay.publishAssistantReply("a", { at: 10, text: questions });
  assert.deepEqual(replay.getOptionSession("a").customDrafts, {});
  replay.publishUserMessage("a", 20, " 1B 2D 3A \n");
  assert.equal(replay.getOptionSession("a").answeredText, " 1B 2D 3A \n");
  assert.deepEqual(replay.getOptionSession("a").choices, { 0: "B", 1: "D", 2: "A" });
  assert.deepEqual(replay.getOptionSession("a").customConfirmed, {});
});
