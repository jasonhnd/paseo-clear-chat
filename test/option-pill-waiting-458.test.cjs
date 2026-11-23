const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// A card with a valid new-version draft must stay reachable after an ordinary
// follow-up message. The card lives only in the composer pill, so the pill's
// gating is the product's answer to "can the reader get back to this card".

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";
const draft = { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1 };

function pillHarness(t, data = {}, control = { readThrows: false }) {
  const h = createToolHarness("web", { locale: "en", agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const pill = h.load("client/answer-pill.ts");
  session.setAnswerDraftStore({
    read: key => {
      if (control.readThrows) throw new Error("draft store unavailable");
      return data[key];
    },
    write: (key, value) => { data[key] = value; },
    clear: key => {
      if (control.clearHangs) return new Promise(() => {});
      delete data[key];
    },
  });
  const registrations = [];
  const deps = {
    focusedAgent: () => ({ workspaceId: "w1", agentId: "a" }),
    register(input) {
      const record = {
        input,
        patches: [],
        removed: false,
        update(patch) { this.patches.push(patch); },
        remove() { this.removed = true; },
      };
      registrations.push(record);
      return record;
    },
    showAnswerCard: () => true,
    startFeed: () => () => {},
    label: card => `Answer card ${card.answeredCount}/${card.questionCount}`,
    title: card => `Answer card · ${card.answeredCount}/${card.questionCount} answered`,
    content: () => null,
    subscribe: session.subscribeOptionSession,
  };
  const controller = pill.createAnswerPill(deps);
  t.after(() => { controller.stop(); session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  return {
    h, session, pill, data, controller, registrations, control,
    live() { return registrations.filter(record => !record.removed); },
  };
}

function replay(f) {
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  f.session.publishUserMessage("a", 11, "wait a moment");
  f.session.publishAssistantReply("a", { at: 12, text: "Waiting." });
}

test("a drafted card stays on the pill after an ordinary message and survives Continue", async t => {
  const f = pillHarness(t);
  f.data[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  replay(f);
  const waiting = f.session.getOptionSessionAt("a", 10);
  assert.equal(waiting.followupStatus, "waiting", "the valid draft keeps the card in the waiting state");
  assert.equal(waiting.readOnly, true, "waiting still needs the explicit Continue click");

  const card = f.pill.currentPillCard("a");
  assert.ok(card, "the pill must still offer the waiting card after a plain message");
  assert.equal(card.at, 10);
  assert.equal(card.answeredCount, 1, "the saved answer is part of the pill count");
  assert.equal(card.questionCount, 2);
  await f.controller.refresh();
  assert.equal(f.live().length, 1, "the composer button is back");
  assert.equal(f.live()[0].input.button.label, "Answer card 1/2");

  const Card = f.h.load("client/components/option-card.tsx").OptionCard;
  const waitingTree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
  assert.equal(f.h.nodes(waitingTree, node => node.props?.testID === "option-resume").length, 1, "the reopened card offers Continue");

  assert.equal(await f.session.resumeAnswerDraft("a", 10), true, "Continue restores this card's draft");
  await f.controller.refresh();
  assert.equal(f.live().length, 1, "the pill stays while the resumed card is editable");
  assert.equal(f.live()[0].input.button.label, "Answer card 1/2");

  const tree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
  assert.equal(f.h.nodes(tree, node => node.props?.testID === "option-resume").length, 0, "the card is editable again");
  assert.equal(f.h.nodes(tree, node => node.props?.testID === "option-row-A").length, 1, "the reader can answer the next question");
});

test("a card with no draft record keeps the ended state and stays off the pill", async t => {
  const f = pillHarness(t);
  replay(f);
  const ended = f.session.getOptionSessionAt("a", 10);
  assert.equal(ended.followupStatus, "ended", "history without a draft ends the card");
  assert.equal(ended.readOnly, true);
  assert.equal(f.pill.currentPillCard("a"), null, "an ended card offers no composer button");
  await f.controller.refresh();
  assert.equal(f.registrations.length, 0);
  assert.equal(await f.session.resumeAnswerDraft("a", 10), false, "there is nothing to resume");
});

test("a card replaced by a newer answer card ends and leaves the pill to the newer card", async t => {
  const f = pillHarness(t);
  f.data[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  replay(f);
  f.session.publishAssistantReply("a", { at: 14, text: questions });
  const older = f.session.getOptionSessionAt("a", 10);
  assert.equal(older.followupStatus, "ended", "a newer answer card ends the older one");
  assert.equal(older.readOnly, true);
  assert.equal(await f.session.resumeAnswerDraft("a", 10), false);
  const card = f.pill.currentPillCard("a");
  assert.equal(card?.at, 14, "the pill belongs to the newer card");
  assert.equal(card?.answeredCount, 0);
  await f.controller.refresh();
  assert.equal(f.live().length, 1);
  assert.equal(f.live()[0].input.button.label, "Answer card 0/2");
});

test("a recognized answer after a drafted card still ends it", async t => {
  const f = pillHarness(t);
  f.data[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  f.session.publishUserMessage("a", 11, "1B");
  f.session.publishAssistantReply("a", { at: 12, text: "Done." });
  const answered = f.session.getOptionSessionAt("a", 10);
  assert.equal(answered.readOnly, true, "a recognized answer keeps the read-only history");
  assert.equal(answered.choices[0], "B");
  assert.equal(f.pill.currentPillCard("a"), null, "an answered card offers no composer button");
  assert.equal(await f.session.resumeAnswerDraft("a", 10), false);
});

test("an unreadable draft store hides the card but keeps its answer for a later recovery", async t => {
  const f = pillHarness(t);
  f.data[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  assert.equal(f.session.getOptionSessionAt("a", 10).choices[0], "B", "the stored draft was restored");

  // A read that cannot answer must not be treated as "no draft", but it also must not
  // lock the card away for the rest of the session.
  f.control.readThrows = true;
  f.session.publishUserMessage("a", 11, "wait a moment");
  const unread = f.session.getOptionSessionAt("a", 10);
  assert.equal(unread.followupStatus, "unsafe");
  assert.equal(unread.readOnly, true);
  assert.deepEqual(unread.choices, {}, "the unreadable state keeps the legacy presentation, not an unsent selection");
  assert.equal(f.pill.currentPillCard("a"), null, "the unreadable state offers no composer button");
  await f.controller.refresh();
  assert.equal(f.registrations.length, 0);

  const Card = f.h.load("client/components/option-card.tsx").OptionCard;
  const tree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
  assert.equal(f.h.nodes(tree, node => node.props?.testID === "option-resume").length, 0, "no Continue while the draft cannot be read");

  // The store answers again: the next timeline event re-reads this card's draft and
  // rebuilds exactly what was saved, not what was once selected in memory.
  f.control.readThrows = false;
  f.session.publishAssistantReply("a", { at: 12, text: "Waiting." });
  const recovered = f.session.getOptionSessionAt("a", 10);
  assert.equal(recovered.followupStatus, "waiting", "a readable draft lifts the card out of the unsafe state");
  assert.equal(recovered.readOnly, true);
  assert.equal(recovered.choices[0], "B", "the recovered card shows the saved answer");
  const card = f.pill.currentPillCard("a");
  assert.equal(card?.at, 10);
  assert.equal(card?.answeredCount, 1);
  await f.controller.refresh();
  assert.equal(f.live().length, 1, "the composer button comes back");
  assert.equal(f.live()[0].input.button.label, "Answer card 1/2");
});

test("a continued card stays editable and on the button when another plain message arrives", async t => {
  const f = pillHarness(t);
  f.data[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  replay(f);
  assert.equal(await f.session.resumeAnswerDraft("a", 10), true);
  f.session.publishUserMessage("a", 13, "still here");
  const card = f.session.getOptionSessionAt("a", 10);
  assert.equal(card.readOnly, false, "a later plain message does not re-lock a card the reader continued");
  assert.equal(card.choices[0], "B");
  const pinned = f.pill.currentPillCard("a");
  assert.equal(pinned?.at, 10);
  assert.equal(pinned?.answeredCount, 1);
  await f.controller.refresh();
  assert.equal(f.live().length, 1);
});

test("sending from a continued card removes the button", async t => {
  const f = pillHarness(t);
  f.data[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  replay(f);
  assert.equal(await f.session.resumeAnswerDraft("a", 10), true);
  f.session.setOptionSender(async () => {});
  t.after(() => f.session.setOptionSender(null));
  f.session.choose("a", 1, "A", 10);
  await f.session.sendAnswer("a", 10);
  const sent = f.session.getOptionSessionAt("a", 10);
  assert.equal(sent.readOnly, true);
  assert.equal(f.pill.currentPillCard("a"), null, "a sent card leaves no composer button");
  await f.controller.refresh();
  assert.equal(f.live().length, 0);
  assert.equal(f.registrations[0].removed, true);
});

test("a pending draft operation does not promote a card whose draft still cannot be read", async t => {
  // The draft write is debounced; drive it with the same fake clock the other draft tests use.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise(setImmediate);
  const f = pillHarness(t);
  const key = f.session.answerDraftKey("a", 10);
  f.data[key] = structuredClone(draft);
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  f.session.choose("a", 1, "A", 10);

  // Send while the sender hangs: the sending-state write leaves the debounce window and
  // clears its timer before the ordinary message arrives.
  let release;
  f.session.setOptionSender(() => { release = null; return new Promise(resolve => { release = resolve; }); });
  const sent = f.session.sendAnswer("a", 10);
  t.mock.timers.tick(400);
  await flush();
  assert.equal(f.data[key].choices["1"], "A", "the debounced write landed with both answers");

  f.control.readThrows = true;
  f.session.publishUserMessage("a", 11, "wait a moment");
  assert.equal(f.session.getOptionSessionAt("a", 10).followupStatus, "unsafe");

  // The send settles and schedules a draft clear that never completes, so a draft timer
  // exists for this card while no readable draft does.
  f.control.clearHangs = true;
  release();
  await sent;
  t.mock.timers.tick(0);
  await flush();
  assert.equal(f.session.getOptionSessionAt("a", 10).readOnly, true);

  f.session.publishAssistantReply("a", { at: 12, text: "Waiting." });
  const after = f.session.getOptionSessionAt("a", 10);
  assert.equal(after.followupStatus, "unsafe", "a pending timer is not a readable draft");
  assert.equal(f.pill.currentPillCard("a"), null, "the card stays out of reach until a draft is read");
  await f.controller.refresh();
  assert.equal(f.live().length, 0, "the earlier registration is removed");
});
