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

test("preferences becoming ready retries a card already marked unread", async t => {
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
  session.publishUserMessage("a", 11, "wait");
  const unread = session.getOptionSessionAt("a", 10);
  assert.equal(unread.readOnly, true);
  assert.equal(unread.draftUnread, true, "the ordinary follow-up marked the unreadable draft");
  assert.equal(unread.choices[0], undefined);
  await preferences.initializeEnhancerPreferences(rpc);
  const restored = session.getOptionSessionAt("a", 10);
  assert.equal(restored.choices[0], "B");
  assert.equal(restored.followupStatus, "waiting");
  assert.equal(restored.draftUnread, false);
});

test("a continued card stays editable when the first read fails and a later read succeeds", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  const control = { reads: 0, mode: "throw", data: {} };
  control.data[session.answerDraftKey("a", 10)] = {
    schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1, resumed: true,
  };
  session.setAnswerDraftStore(failingThen(control));
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  session.publishUserMessage("a", 11, "wait");
  assert.equal(session.getOptionSessionAt("a", 10).draftUnread, true, "the ordinary follow-up is recorded before the draft can be read");
  control.mode = "ready";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  const restored = session.getOptionSessionAt("a", 10);
  assert.equal(restored.readOnly, false);
  assert.equal(restored.resumed, true);
  assert.equal(restored.choices[0], "B");
  const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  assert.equal(h.nodes(tree, node => node.props?.testID === "option-resume").length, 0);
});

test("a continued card stays editable when preferences become ready after the first read failed", async t => {
  const key = "a\u000010";
  const stored = {
    preferences: {},
    legacyMigrated: true,
    answerDrafts: {
      [key]: { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1, resumed: true },
    },
  };
  const rpc = async (contract, input) => {
    if (String(contract?.name).endsWith(".read")) return { status: "ready", revision: "1", values: structuredClone(stored) };
    return { status: "saved", revision: "2", values: structuredClone(input?.values ?? stored) };
  };
  const h = createToolHarness("ios", { presentationHost: { rpc } });
  const preferences = h.load("client/preferences.ts");
  const session = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.setAnswerDraftStore({
    read: preferences.getStoredAnswerDraft,
    write: preferences.storeAnswerDraft,
    clear: preferences.clearStoredAnswerDraft,
  });
  session.publishAssistantReply("a", { at: 10, text: questions });
  session.publishUserMessage("a", 11, "wait");
  assert.equal(session.getOptionSessionAt("a", 10).draftUnread, true);
  await preferences.initializeEnhancerPreferences(rpc);
  const restored = session.getOptionSessionAt("a", 10);
  assert.equal(restored.readOnly, false);
  assert.equal(restored.resumed, true);
  assert.equal(restored.choices[0], "B");
  const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  assert.equal(h.nodes(tree, node => node.props?.testID === "option-resume").length, 0);
});

test("a late draft does not restore a choice the reader cleared", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const control = {
    reads: 0,
    mode: "throw",
    data: { [session.answerDraftKey("a", 10)]: { schema: 1, choices: { 0: "B", 1: "A" }, customDrafts: {}, customOpen: {}, activeQuestion: 0 } },
  };
  session.setAnswerDraftStore(failingThen(control));
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  session.choose("a", 0, "A");
  session.clearChoice("a", 0);
  assert.equal(session.getOptionSession("a", 10).choices[0], undefined);
  control.mode = "ready";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  assert.equal(session.getOptionSessionAt("a", 10).choices[0], undefined);
  assert.equal(session.getOptionSessionAt("a", 10).choices[1], "A", "an untouched question is still restored once the read can answer");
});

test("a rejected draft shape is not read again", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const control = { reads: 0, mode: "throw", data: {} };
  session.setAnswerDraftStore({
    read() {
      control.reads += 1;
      if (control.mode === "throw") throw new Error("preferences are not ready");
      return { schema: 2 };
    },
    write() {},
    clear() {},
  });
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  assert.equal(control.reads, 1);
  control.mode = "invalid";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  assert.equal(control.reads, 2, "the first successful read sees the rejected shape");
  assert.equal(session.getOptionSessionAt("a", 10).choices[0], undefined);
  session.publishAssistantReply("a", { at: 30, text: "Still here." });
  assert.equal(control.reads, 2, "a rejected shape is not read again");
});

function replyEntry(at, text) {
  return { agentId: "a", timestamp: new Date(at).toISOString(), seqStart: 0, item: { type: "assistant_message", text } };
}

test("leaving a conversation and coming back does not keep the old running state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const status = { a: "idle", b: "idle" };
  const listeners = new Map();
  const refreshCounts = { a: 0, b: 0 };
  const listOptions = [];
  let released = false;
  const composerA = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  const composerB = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  let current = composerA;
  const h = createToolHarness("web", {
    locale: "en",
    composers: selector => {
      if ("focused" in selector) return current ? [current] : [];
      if (selector.agentId === "a" && current === composerA) return [composerA];
      if (selector.agentId === "b" && current === composerB) return [composerB];
      return [];
    },
    paseo: {
      agents: {
        ref(id) {
          return {
            current: () => null,
            get status() { return null; },
            refresh: async () => {
              refreshCounts[id] += 1;
              return { agent: { status: status[id], activeTurn: null } };
            },
            subscribe(handler) {
              listeners.set(id, handler);
              return () => { if (listeners.get(id) === handler) listeners.delete(id); };
            },
            timeline: {
              refetch: async () => ({ entries: id === "a" ? [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] : [], hasOlder: false }),
              subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
            },
          };
        },
        async list(options) {
          listOptions.push(options ?? null);
          return {
            entries: [{ agent: { id: "a", workspaceId: "w1" } }, { agent: { id: "b", workspaceId: "w1" } }],
            subscription: options?.subscribe ? { release: async () => { released = true; } } : undefined,
          };
        },
      },
    },
  });
  t.after(() => h.dispose());
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  const live = () => h.composerPills.filter(record => !record.removed);
  await flush();
  assert.equal(live().length, 1, "an idle agent shows the button");
  assert.ok(listOptions.some(options => options && options.subscribe), "the pin opens the agent list stream");
  assert.equal(listeners.has("a"), true);
  const seen = refreshCounts.a;
  current = composerB;
  t.mock.timers.tick(750);
  await flush();
  assert.equal(listeners.has("a"), true, "the background conversation keeps its status listener");
  status.a = "running";
  current = composerA;
  t.mock.timers.tick(750);
  await flush();
  assert.ok(refreshCounts.a > seen, "coming back refreshes instead of reusing the cached status");
  assert.equal(live().length, 0, "the button is hidden once the refresh reports running");
  status.a = "idle";
  current = composerB;
  t.mock.timers.tick(750);
  await flush();
  current = composerA;
  t.mock.timers.tick(750);
  await flush();
  assert.equal(live().length, 1, "the button returns when a fresh refresh reports idle");
  h.dispose();
  assert.equal(released, true, "stopping the pin releases the agent list stream");
});

test("stopping the pin releases a list subscription that resolves later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishList = () => {};
  const pending = new Promise(resolve => { finishList = resolve; });
  let releases = 0;
  const composer = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  const h = createToolHarness("web", {
    locale: "en",
    composers: selector => ("focused" in selector || selector.agentId === "a") ? [composer] : [],
    paseo: {
      agents: {
        ref() {
          return {
            current: () => null,
            refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
            subscribe: () => () => {},
            timeline: {
              refetch: async () => ({ entries: [], hasOlder: false }),
              subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
            },
          };
        },
        list: () => pending.then(() => ({
          entries: [{ agent: { id: "a", workspaceId: "w1" } }],
          subscription: { release: async () => { releases += 1; } },
        })),
      },
    },
  });
  await Promise.resolve();
  h.dispose();
  finishList();
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(releases, 1, "a list that returns after stop is still released");
});

test("turning the answer card off releases the stream and turning it on opens it again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listOptions = [];
  let releases = 0;
  let agentSubscribes = 0;
  let agentStops = 0;
  const composer = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  const h = createToolHarness("web", {
    locale: "en",
    preferences: { showAnswerCard: true },
    composers: selector => ("focused" in selector || selector.agentId === "a") ? [composer] : [],
    paseo: {
      agents: {
        ref() {
          return {
            current: () => null,
            refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
            subscribe: () => {
              agentSubscribes += 1;
              return () => { agentStops += 1; };
            },
            timeline: {
              refetch: async () => ({ entries: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)], hasOlder: false }),
              subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
            },
          };
        },
        async list(options) {
          listOptions.push(options ?? null);
          return {
            entries: [{ agent: { id: "a", workspaceId: "w1" } }],
            subscription: options?.subscribe ? { release: async () => { releases += 1; } } : undefined,
          };
        },
      },
    },
  });
  t.after(() => h.dispose());
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  await flush();
  assert.equal(listOptions.filter(options => options && options.subscribe).length, 1);
  assert.equal(agentSubscribes, 1, "the focused agent is listened to while the card is on");
  h.preferences.showAnswerCard = false;
  h.notifyPreferences();
  await flush();
  assert.equal(releases, 1, "turning the card off releases the agent list stream");
  assert.equal(agentStops, 1, "turning the card off stops per-agent listeners");
  h.preferences.showAnswerCard = true;
  h.notifyPreferences();
  t.mock.timers.tick(750);
  await flush();
  assert.equal(listOptions.filter(options => options && options.subscribe).length, 2, "turning the card on opens the stream again");
  assert.equal(agentSubscribes, 2, "turning the card on attaches the listener again");
});

test("an unread card does not refill a choice the reader cleared", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } } });
  const session = h.load("client/option-session.ts");
  const key = session.answerDraftKey("a", 10);
  const data = { [key]: { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 0 } };
  let mode = "throw";
  session.setAnswerDraftStore({
    read() {
      if (mode === "throw") throw new Error("preferences are not ready");
      return data[key];
    },
    write() { /* the seeded draft stays; the debounce must not replace it */ },
    clear() {},
  });
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  session.choose("a", 0, "A");
  session.clearChoice("a", 0);
  t.mock.timers.tick(400);
  await Promise.resolve();
  await Promise.resolve();
  session.publishUserMessage("a", 11, "wait");
  assert.equal(session.getOptionSessionAt("a", 10).draftUnread, true);
  mode = "ready";
  session.publishAssistantReply("a", { at: 20, text: "Still thinking." });
  assert.equal(session.getOptionSessionAt("a", 10).choices[0], undefined, "the cleared question stays empty");
  assert.equal(session.getOptionSessionAt("a", 10).followupStatus, "waiting");
});

test("a running update received while away is not replaced by a stale refresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = new Set();
  let refreshStatus = "idle";
  const composerA = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  const composerB = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  let current = composerA;
  const h = createToolHarness("web", {
    locale: "en",
    composers: selector => {
      if ("focused" in selector) return [current];
      if (selector.agentId === "a" && current === composerA) return [composerA];
      if (selector.agentId === "b" && current === composerB) return [composerB];
      return [];
    },
    paseo: {
      agents: {
        subscribe(handler) {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
        ref() {
          return {
            current: () => null,
            refresh: async () => ({ agent: { status: refreshStatus, activeTurn: null } }),
            subscribe: () => () => {},
            timeline: {
              refetch: async () => ({ entries: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)], hasOlder: false }),
              subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
            },
          };
        },
        async list(options) {
          return {
            entries: [
              { agent: { id: "a", workspaceId: "w1" } },
              { agent: { id: "b", workspaceId: "w1" } },
            ],
            subscription: options?.subscribe ? { release: async () => {} } : undefined,
          };
        },
      },
    },
  });
  t.after(() => h.dispose());
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  const live = () => h.composerPills.filter(record => !record.removed);
  await flush();
  assert.equal(live().length, 1);
  current = composerB;
  t.mock.timers.tick(750);
  await flush();
  for (const handler of listeners) handler({ kind: "upsert", agent: { id: "a", status: "running" } });
  refreshStatus = "idle";
  current = composerA;
  t.mock.timers.tick(750);
  await flush();
  assert.equal(live().length, 0, "coming back hides the button when the stream already said running");
});

test("a second registration opens the agent list stream again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listOptions = [];
  const composer = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  const options = {
    locale: "en",
    composers: selector => ("focused" in selector || selector.agentId === "a") ? [composer] : [],
    paseo: {
      agents: {
        ref() {
          return {
            current: () => null,
            refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
            subscribe: () => () => {},
            timeline: {
              refetch: async () => ({ entries: [], hasOlder: false }),
              subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
            },
          };
        },
        async list(opts) {
          listOptions.push(opts ?? null);
          return {
            entries: [{ agent: { id: "a", workspaceId: "w1" } }],
            subscription: opts?.subscribe ? { release: async () => {} } : undefined,
          };
        },
      },
    },
  };
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  const first = createToolHarness("web", options);
  await flush();
  first.dispose();
  const second = createToolHarness("web", options);
  t.after(() => second.dispose());
  await flush();
  assert.equal(listOptions.filter(opts => opts && opts.subscribe).length, 2, "the next registration opens its own stream");
});

test("a refresh that resolves after the focus moved is ignored", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = [];
  const composerA = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  const composerB = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  let current = composerA;
  let refreshRound = 0;
  const h = createToolHarness("web", {
    locale: "en",
    composers: selector => {
      if ("focused" in selector) return [current];
      if (selector.agentId === "a" && current === composerA) return [composerA];
      if (selector.agentId === "b" && current === composerB) return [composerB];
      return [];
    },
    paseo: {
      agents: {
        ref() {
          return {
            current: () => null,
            refresh: () => new Promise(resolve => { pending.push(resolve); }),
            subscribe: () => () => {},
            timeline: {
              refetch: async () => ({ entries: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)], hasOlder: false }),
              subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
            },
          };
        },
        async list() {
          refreshRound += 0;
          return {
            entries: [
              { agent: { id: "a", workspaceId: "w1" } },
              { agent: { id: "b", workspaceId: "w1" } },
            ],
          };
        },
      },
    },
  });
  t.after(() => h.dispose());
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  const live = () => h.composerPills.filter(record => !record.removed && record.contribution.agentId === "a");
  await flush();
  const first = pending.splice(0);
  for (const resolve of first) resolve({ agent: { status: "idle", activeTurn: null } });
  await flush();
  assert.equal(live().length, 1);
  current = composerB;
  t.mock.timers.tick(750);
  await flush();
  const stale = pending.splice(0);
  current = composerA;
  t.mock.timers.tick(750);
  await flush();
  const latest = pending.splice(0);
  for (const resolve of latest) resolve({ agent: { status: "idle", activeTurn: null } });
  await flush();
  for (const resolve of stale) resolve({ agent: { status: "running", activeTurn: null } });
  await flush();
  assert.equal(live().length, 1, "a refresh from the previous visit does not hide the button");
  current = composerB;
  t.mock.timers.tick(750);
  await flush();
  current = composerA;
  t.mock.timers.tick(750);
  await flush();
  const stillCurrent = pending.splice(0);
  assert.equal(stillCurrent.length > 0, true, "returning to the agent asks for its status again");
  for (const resolve of stillCurrent) resolve({ agent: { status: "running", activeTurn: null } });
  await flush();
  assert.equal(live().length, 0, "a refresh that is still for this visit hides the button while the agent is running");
});

