const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Two known limits of the published card: the composer button must use the same
// running-agent gate as the card body, and a draft read that failed (rather than
// a read that found nothing) must be tried again once the store can answer.

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";
const draft = { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1 };

function pillHarness(t, options = {}) {
  const agents = options.agents ?? { a: { status: "idle" } };
  const h = createToolHarness("web", { locale: "en", agents });
  const session = h.load("client/option-session.ts");
  const pill = h.load("client/answer-pill.ts");
  const data = {};
  session.setAnswerDraftStore({
    read: key => data[key],
    write: (key, value) => { data[key] = value; },
    clear: key => { delete data[key]; },
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
    agentStatus: () => agents.a.status,
  };
  const controller = pill.createAnswerPill(deps);
  t.after(() => { controller.stop(); session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  return {
    h, session, pill, agents, controller, registrations,
    live() { return registrations.filter(record => !record.removed); },
  };
}

function continuedCard(f) {
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  f.session.publishUserMessage("a", 11, "wait a moment");
  f.session.publishAssistantReply("a", { at: 12, text: "Waiting." });
}

test("a continued card hides the composer button while the agent is still replying", async t => {
  const f = pillHarness(t);
  const store = {};
  store[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  f.session.setAnswerDraftStore({ read: key => store[key], write: (key, value) => { store[key] = value; }, clear: key => { delete store[key]; } });
  continuedCard(f);
  assert.equal(await f.session.resumeAnswerDraft("a", 10), true, "Continue makes the older card editable again");
  assert.equal(f.session.getOptionSessionAt("a", 10).readOnly, false);
  assert.equal(f.session.getOptionSessionAt("a", 10).resumed, true);
  f.agents.a.status = "running";
  assert.equal(f.pill.currentPillCard("a", "running"), null, "the button uses the same running gate as the card body");
  await f.controller.refresh();
  assert.equal(f.live().length, 0, "a running agent does not keep the button above the input");
  const Card = f.h.load("client/components/option-card.tsx").OptionCard;
  const tree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
  assert.equal(f.h.nodes(tree, node => node.props?.testID === "option-card").length, 0, "the card body also draws nothing while the reply runs");
});

test("the composer button stays while the agent is idle, including a continued card", async t => {
  const f = pillHarness(t);
  const store = {};
  store[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  f.session.setAnswerDraftStore({ read: key => store[key], write: (key, value) => { store[key] = value; }, clear: key => { delete store[key]; } });
  continuedCard(f);
  assert.equal(await f.session.resumeAnswerDraft("a", 10), true);
  f.agents.a.status = "idle";
  const card = f.pill.currentPillCard("a", "idle");
  assert.equal(card?.at, 10, "an idle agent still offers the continued card");
  await f.controller.refresh();
  assert.equal(f.live().length, 1, "the button is registered while the agent is not replying");
  assert.equal(f.live()[0].input.button.visible, true);
});

test("the composer button comes back when the agent finishes replying", async t => {
  const f = pillHarness(t);
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  f.agents.a.status = "running";
  await f.controller.refresh();
  assert.equal(f.live().length, 0, "no button while the reply is running");
  assert.equal(f.pill.currentPillCard("a", f.agents.a.status), null);
  f.agents.a.status = "idle";
  await f.controller.refresh();
  assert.equal(f.live().length, 1, "the button returns under the same rules once the agent is idle");
  assert.equal(f.live()[0].input.button.label, "Answer card 0/2");
  const Card = f.h.load("client/components/option-card.tsx").OptionCard;
  const tree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
  assert.equal(f.h.nodes(tree, node => node.props?.testID === "option-card").length, 1, "the card body draws again once the reply has finished");
});

test("a read-only waiting card keeps its button while the agent is running", async t => {
  const f = pillHarness(t);
  const store = {};
  store[f.session.answerDraftKey("a", 10)] = structuredClone(draft);
  f.session.setAnswerDraftStore({ read: key => store[key], write: (key, value) => { store[key] = value; }, clear: key => { delete store[key]; } });
  continuedCard(f);
  assert.equal(f.session.getOptionSessionAt("a", 10).readOnly, true, "Continue has not been clicked");
  f.agents.a.status = "running";
  assert.equal(f.pill.currentPillCard("a", "running")?.at, 10, "a read-only card is still offered; only an editable card waits");
  await f.controller.refresh();
  assert.equal(f.live().length, 1);
});

function failingThen(control) {
  return {
    read(key) {
      control.reads += 1;
      if (control.mode === "throw") throw new Error("preferences are not ready");
      return control.data[key];
    },
    write(key, value) { control.data[key] = value; },
    clear(key) { delete control.data[key]; },
  };
}

test("a draft the first read could not load is restored on the next timeline event", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const control = { reads: 0, mode: "throw", data: {} };
  control.data[session.answerDraftKey("a", 10)] = structuredClone(draft);
  session.setAnswerDraftStore(failingThen(control));
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  assert.equal(session.getOptionSession("a", 10).choices[0], undefined, "a failed first read leaves the card unanswered");
  assert.equal(control.reads, 1);
  control.mode = "ready";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  const restored = session.getOptionSessionAt("a", 10);
  assert.equal(restored.choices[0], "B", "the stored draft is applied once the read can answer");
  assert.equal(restored.choices[1], undefined, "an untouched question is not given an answer");
  assert.equal(restored.activeQuestion, 1);
});

test("a draft the first read could not load is restored when preferences become ready", async t => {
  const key = "a\u000010";
  const stored = {
    preferences: {},
    legacyMigrated: true,
    answerDrafts: {
      [key]: { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1 },
    },
  };
  const rpc = async (contract, input) => {
    if (String(contract?.name).endsWith(".read")) return { status: "ready", revision: "1", values: structuredClone(stored) };
    return { status: "saved", revision: "2", values: structuredClone(input?.values ?? stored) };
  };
  const h = createToolHarness("ios", { presentationHost: { rpc } });
  const preferences = h.load("client/preferences.ts");
  const session = h.load("client/option-session.ts");
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.setAnswerDraftStore({
    read: preferences.getStoredAnswerDraft,
    write: preferences.storeAnswerDraft,
    clear: preferences.clearStoredAnswerDraft,
  });
  session.publishAssistantReply("a", { at: 10, text: questions });
  assert.equal(session.getOptionSession("a", 10).choices[0], undefined, "the cache is not authoritative at the first read");
  await preferences.initializeEnhancerPreferences(rpc);
  assert.equal(session.getOptionSession("a", 10).choices[0], "B", "preferences becoming ready retries the failed read");
  assert.equal(session.getOptionSession("a", 10).activeQuestion, 1);
});

test("a successful read that finds no draft is not retried", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const control = { reads: 0, mode: "throw", data: {} };
  session.setAnswerDraftStore(failingThen(control));
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  assert.equal(control.reads, 1, "the failing read is the only one at publish");
  control.mode = "absent";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  assert.equal(control.reads, 2, "the next timeline event reads once more");
  assert.equal(session.getOptionSessionAt("a", 10).choices[0], undefined, "no draft is invented");
  session.publishAssistantReply("a", { at: 30, text: "Still here." });
  assert.equal(control.reads, 2, "a confirmed absence is not read again");
});

test("a draft restored later does not replace an answer the reader already chose", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const control = {
    reads: 0,
    mode: "throw",
    data: { [session.answerDraftKey("a", 10)]: { schema: 1, choices: { 0: "A", 1: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 0 } },
  };
  session.setAnswerDraftStore(failingThen(control));
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  session.choose("a", 1, "A");
  assert.equal(session.getOptionSession("a", 10).choices[1], "A");
  control.mode = "ready";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  const restored = session.getOptionSessionAt("a", 10);
  assert.equal(restored.choices[1], "A", "the reader's own choice stays");
  assert.equal(restored.choices[0], "A", "an untouched question still takes the stored draft");
});

test("a draft restored later does not change a question the history already answered", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const control = {
    reads: 0,
    mode: "throw",
    data: { [session.answerDraftKey("a", 10)]: structuredClone(draft) },
  };
  session.setAnswerDraftStore(failingThen(control));
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  control.mode = "ready";
  session.publishUserMessage("a", 11, "1A");
  const settled = session.getOptionSessionAt("a", 10);
  assert.equal(settled.choices[0], "A", "history wins over the stored draft");
  assert.equal(settled.choices[1], undefined, "a closed card does not gain an answer the history did not give");
  assert.equal(settled.readOnly, true);
  session.publishAssistantReply("a", { at: 20, text: "Noted." });
  assert.equal(session.getOptionSessionAt("a", 10).choices[0], "A", "a later event still leaves the historical answer alone");
});
