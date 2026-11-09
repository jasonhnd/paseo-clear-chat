const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const three = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\nC Three\nD Four\n\n3) Third?\nA One\nB Two\n\nReply: A";

function fixture(t) {
  const h = createToolHarness("web");
  const s = h.load("client/option-session.ts");
  t.after(() => { h.unmount(); h.dispose(); });
  s.publishAssistantReply("a", { at: 1, text: three });
  return s;
}

test("blank drafts remain unanswered and confirmation advances only on a first answer", t => {
  const s = fixture(t);
  s.openCustom("a", 0);
  s.setCustomDraft("a", 0, " \n\t");
  assert.equal(s.confirmCustom("a", 0), "blank");
  assert.equal(s.missingQuestion("a"), 0);
  assert.equal(s.answerText("a"), null);
  assert.equal(s.answerIndex("a"), null);
  assert.equal(s.getOptionSession("a").customOpen[0], true);
  s.choose("a", 2, "A");
  s.setActiveQuestion("a", 0);
  s.setCustomDraft("a", 0, " first ");
  assert.equal(s.confirmCustom("a", 0), "confirmed");
  assert.equal(s.getOptionSession("a").activeQuestion, 1);
  assert.equal(s.getOptionSession("a").customConfirmed[0], " first ");
  s.setActiveQuestion("a", 0);
  assert.equal(s.confirmCustom("a", 0), "confirmed");
  assert.equal(s.getOptionSession("a").activeQuestion, 0);
  s.choose("a", 1, "B");
  s.setActiveQuestion("a", 2);
  s.openCustom("a", 2);
  s.setCustomDraft("a", 2, "last");
  s.confirmCustom("a", 2);
  assert.equal(s.getOptionSession("a").activeQuestion, 2);
});

test("editing invalidates confirmation and switching choices preserves the draft", t => {
  const s = fixture(t);
  s.choose("a", 0, "B");
  s.choose("a", 2, "A");
  s.openCustom("a", 1);
  s.setCustomDraft("a", 1, "line one\nline two");
  s.confirmCustom("a", 1);
  assert.equal(s.answerIndex("a"), "1B 2E 3A");
  assert.equal(s.answerText("a"), "1B 2E 3A\n\n2E：\nline one\nline two");
  const unchanged = s.getOptionSession("a");
  s.setCustomDraft("a", 1, "line one\nline two");
  assert.equal(s.getOptionSession("a"), unchanged);
  s.setCustomDraft("a", 1, " changed \r\ntext ");
  assert.equal(s.missingQuestion("a"), 1);
  assert.equal(s.answerText("a"), null);
  assert.equal(s.getOptionSession("a").customConfirmed[1], undefined);
  s.confirmCustom("a", 1);
  assert.equal(s.answerText("a"), "1B 2E 3A\n\n2E：\n changed \r\ntext ");
  s.choose("a", 1, "D");
  assert.equal(s.answerText("a"), "1B 2D 3A");
  assert.equal(s.getOptionSession("a").customOpen[1], false);
  assert.equal(s.getOptionSession("a").customDrafts[1], " changed \r\ntext ");
  s.openCustom("a", 1);
  assert.equal(s.answerText("a"), null);
  s.confirmCustom("a", 1);
  assert.equal(s.answerText("a"), "1B 2E 3A\n\n2E：\n changed \r\ntext ");
  s.clearChoice("a", 1);
  assert.equal(s.getOptionSession("a").customConfirmed[1], undefined);
  assert.equal(s.getOptionSession("a").customDrafts[1], " changed \r\ntext ");
  assert.equal(s.missingQuestion("a"), 1);
});

test("multiple custom answers follow question order and ordinary notes retain their old format", t => {
  const s = fixture(t);
  s.choose("a", 1, "C");
  s.setCustomDraft("a", 2, "third");
  s.confirmCustom("a", 2);
  s.setCustomDraft("a", 0, "first");
  s.confirmCustom("a", 0);
  assert.equal(s.answerIndex("a"), "1C 2C 3C");
  assert.equal(s.answerText("a"), "1C 2C 3C\n\n1C：\nfirst\n\n3C：\nthird");
  s.choose("a", 0, "B");
  s.choose("a", 2, "A");
  s.setNote("a", 1, " one\ntwo ");
  assert.equal(s.answerIndex("a"), "1B 2C 3A");
  assert.equal(s.answerText("a"), "1B 2C (one two) 3A");
});

test("synthetic letters follow each question's last option", t => {
  const s = fixture(t);
  for (const [letters, expected] of [["ABCD", "E"], ["ABC", "D"], ["ACE", "F"], ["ABH", "I"]]) {
    const agent = `agent-${letters}`;
    s.publishAssistantReply(agent, { at: 1, text: `Pick?\n${[...letters].map(c => `${c} Option ${c}`).join("\n")}\n\nReply: A` });
    assert.equal(s.customLetterFor(agent, 0), expected);
  }
  assert.equal(s.customLetterFor("a", 3), null);
  assert.equal(s.customLetterFor("missing", 0), null);
});

test("wrong questions and read-only or sending sessions ignore custom mutations", async t => {
  const s = fixture(t);
  const original = s.getOptionSession("a");
  s.openCustom("a", 5); s.setCustomDraft("a", 5, "invalid");
  assert.equal(s.confirmCustom("a", 5), "ignored");
  assert.equal(s.getOptionSession("a"), original);
  s.choose("a", 0, "A"); s.choose("a", 1, "B"); s.choose("a", 2, "A");
  let resolve;
  s.setOptionSender(() => new Promise(r => { resolve = r; }));
  const pending = s.sendAnswer("a");
  const sending = s.getOptionSession("a");
  s.openCustom("a", 0); s.setCustomDraft("a", 0, "ignored");
  assert.equal(s.confirmCustom("a", 0), "ignored");
  assert.equal(s.getOptionSession("a"), sending);
  resolve(); await pending;
  const readOnly = s.getOptionSession("a");
  s.openCustom("a", 0); s.setCustomDraft("a", 0, "ignored");
  assert.equal(s.confirmCustom("a", 0), "ignored");
  assert.equal(s.getOptionSession("a"), readOnly);
});

test("typed host answers clear custom state and disappearing answers reset it", t => {
  const s = fixture(t);
  s.setCustomDraft("a", 0, "kept draft"); s.confirmCustom("a", 0);
  s.publishUserMessage("a", 3, "1B 2D 3A");
  assert.deepEqual(s.getOptionSession("a").choices, { 0: "B", 1: "D", 2: "A" });
  assert.deepEqual(s.getOptionSession("a").customConfirmed, {});
  assert.deepEqual(s.getOptionSession("a").customOpen, {});
  assert.equal(s.getOptionSession("a").customDrafts[0], "kept draft");
  s.publishAssistantReply("a", { at: 2, text: three });
  assert.equal(s.getOptionSession("a", 1), null);
  s.publishAssistantReply("b", { at: 1, text: three });
  s.setCustomDraft("b", 0, "sent"); s.confirmCustom("b", 0);
  s.publishUserMessage("b", 3, "prose");
  s.publishAssistantReply("b", { at: 2, text: "plain reply" });
  s.publishAssistantReply("b", { at: 4, text: three });
  assert.deepEqual(s.getOptionSession("b", 1), null);
});

test("a message sent by the session retains confirmed custom text", async t => {
  const s = fixture(t);
  s.setCustomDraft("a", 0, " full\ntext "); s.confirmCustom("a", 0);
  s.choose("a", 1, "D"); s.choose("a", 2, "A");
  let resolve;
  s.setOptionSender(() => new Promise(r => { resolve = r; }));
  const pending = s.sendAnswer("a");
  s.publishUserMessage("a", 2, "1C 2D 3A\n\n1C：\n full\ntext ");
  assert.equal(s.getOptionSession("a").customConfirmed[0], " full\ntext ");
  assert.equal(s.getOptionSession("a").customOpen[0], true);
  resolve(); await pending;
  assert.equal(s.getOptionSession("a").readOnly, true);
});
