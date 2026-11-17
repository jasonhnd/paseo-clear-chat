const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Which storage?
A Server
B File (recommended)

2) Ship now?
A Yes
B No

Reply with a letter for each.`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" }, b: { status: "idle" } }, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, s: h.load("client/option-session.ts") };
}

function memoryStore(seed = {}) {
  const data = { ...seed };
  const writes = [];
  const clears = [];
  return {
    data, writes, clears,
    read: key => data[key],
    write: (key, draft) => { data[key] = draft; writes.push([key, draft]); },
    clear: key => { delete data[key]; clears.push(key); },
  };
}

test("an unsent draft survives a reload for its own card and invents nothing", async t => {
  const store = memoryStore();
  const first = fixture(t);
  first.s.setAnswerDraftStore(store);
  first.s.publishAssistantReply("a", { at: 10, text: reply });
  first.s.choose("a", 0, "B");
  first.s.openCustom("a", 1);
  first.s.setCustomDraft("a", 1, "typed but unsent");
  await sleep(700);
  first.s.setAnswerDraftStore(null);
  assert.ok(store.writes.length >= 1, "the draft reached the store before the reload");

  // A new module instance is what a page reload gives us.
  const second = fixture(t);
  second.s.setAnswerDraftStore(store);
  second.s.publishAssistantReply("a", { at: 10, text: reply });
  const session = second.s.getOptionSession("a", 10);
  assert.equal(session.choices[0], "B", "the chosen option comes back");
  assert.equal(session.customDrafts[1], "typed but unsent");
  assert.equal(session.customOpen[1], true);
  assert.equal(session.choices[1], undefined, "no answer is invented for an untouched question");
  second.s.setAnswerDraftStore(null);
});

test("a draft never overrides an answer the history already holds", async t => {
  const { s } = fixture(t);
  const store = memoryStore();
  s.setAnswerDraftStore(store);
  s.publishAssistantReply("a", { at: 10, text: reply });
  store.data[s.answerDraftKey("a", 10)] = { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 0 };
  s.publishUserMessage("a", 11, "1A");
  assert.equal(s.getOptionSession("a", 10).choices[0], "A", "history wins over the draft");
  s.setAnswerDraftStore(null);
});

test("a foreign or malformed draft is dropped without throwing", async t => {
  for (const bad of [
    { schema: 2, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 0 },
    { schema: 1, choices: { 0: 7 }, customDrafts: {}, customOpen: {}, activeQuestion: 0 },
    { schema: 1, choices: {}, customDrafts: {}, customOpen: {}, activeQuestion: -1 },
    { schema: 1, choices: "nope" },
    "not an object",
    null,
  ]) {
    const { s } = fixture(t);
    const store = memoryStore({ [s.answerDraftKey("a", 10)]: bad });
    s.setAnswerDraftStore(store);
    s.publishAssistantReply("a", { at: 10, text: reply });
    const session = s.getOptionSession("a", 10);
    assert.ok(session, "the card still opens");
    assert.deepEqual(session.choices, {}, "a bad draft leaves the card unanswered");
    assert.equal(session.activeQuestion, 0);
    s.setAnswerDraftStore(null);
  }
});

test("drafts are written for their own card only, and cleared once sent", async t => {
  const { s } = fixture(t);
  const store = memoryStore();
  s.setAnswerDraftStore(store);
  s.publishAssistantReply("a", { at: 10, text: reply });
  s.publishAssistantReply("b", { at: 20, text: reply });
  s.choose("a", 0, "B");
  await sleep(700);
  const written = store.writes.filter(([key]) => key === s.answerDraftKey("a", 10));
  assert.ok(written.length >= 1, "the chosen card is written");
  assert.equal(written.at(-1)[1].schema, 1);
  assert.equal(written.at(-1)[1].choices["0"], "B");
  assert.equal(store.writes.some(([key]) => key === s.answerDraftKey("b", 20)), false, "another agent's card is untouched");

  s.setOptionSender(async () => {});
  s.choose("a", 1, "A");
  await s.sendAnswer("a");
  await sleep(700);
  assert.ok(store.clears.includes(s.answerDraftKey("a", 10)), "a sent card clears its draft");
  s.setAnswerDraftStore(null);
});

test("the card shows how many questions are answered", t => {
  const h = createToolHarness("ios", { width: 390, agents: { a: { status: "idle" } }, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const byId = (tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
  const draw = () => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: reply } }, timestamp: new Date(10), theme: { colors: {} } } }, "reply-10");
  s.publishAssistantReply("a", { at: 10, text: reply });
  assert.match(h.text(byId(draw(), "option-progress")), /0 of 2 answered · 2 to go/);
  s.choose("a", 0, "B");
  assert.match(h.text(byId(draw(), "option-progress")), /1 of 2 answered · 1 to go/);
});

test("answering publishes only the open-question counts", async t => {
  const { s } = fixture(t);
  const seen = [];
  s.setAnswerStatePublisher({ publish: (agentId, pending, total) => seen.push([agentId, pending, total]) });
  s.publishAssistantReply("a", { at: 10, text: reply });
  s.choose("a", 0, "B");
  assert.deepEqual(seen.at(-1), ["a", 1, 2], "one of two questions remains open");
  s.choose("a", 1, "A");
  assert.deepEqual(seen.at(-1), ["a", 0, 2], "none remain open");
  s.setAnswerStatePublisher(null);
});

test("explicit timestamp selects and updates an older unanswered card without changing the latest", t => {
  const { s } = fixture(t);
  s.publishAssistantReply("a", { at: 10, text: reply });
  s.openCustom("a", 1);
  s.setCustomDraft("a", 1, "older custom draft");
  s.publishAssistantReply("a", { at: 20, text: reply });
  assert.equal(s.getOptionSession("a", 10), null, "legacy lookup still hides older unanswered cards");
  assert.ok(s.getOptionSessionAt("a", 10), "explicit lookup exposes older card");
  s.choose("a", 0, "B", 10);
  assert.equal(s.getOptionSessionAt("a", 10).choices[0], "B");
  assert.equal(s.getOptionSession("a").choices[0], undefined, "latest remains unchanged");
  s.setActiveQuestion("a", 1, 10);
  assert.equal(s.getOptionSessionAt("a", 10).activeQuestion, 1);
  assert.equal(s.confirmCustom("a", 1, 10), "confirmed");
  assert.equal(s.getOptionSessionAt("a", 10).customConfirmed[1], "older custom draft");
  s.choose("a", 0, "A");
  assert.equal(s.getOptionSession("a").choices[0], "A", "omitting at still updates latest");
  assert.equal(s.getOptionSessionAt("a", 10).choices[0], "B");
});

test("new unanswered card publishes initial pending count", t => {
  const { s } = fixture(t);
  const seen = [];
  s.setAnswerStatePublisher({ publish: () => {}, initialize: (id, pending, total) => seen.push([id, pending, total]) });
  s.publishAssistantReply("a", { at: 10, text: reply });
  s.initializeAnswerState("a", 10);
  assert.deepEqual(seen.at(-1), ["a", 2, 2]);
  s.setAnswerStatePublisher(null);
});
