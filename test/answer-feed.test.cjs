const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const one = "1) Pick?\nA One\nB Two\n\nReply: A";
const two = "1) Pick?\nA One\nB Two\n\n2) Next?\nA Yes\nB No\n\nReply: A";

function entry(type, text, at, turnId) {
  return {
    provider: "mock",
    item: { type, text },
    ...(turnId ? { turnId } : {}),
    timestamp: new Date(at).toISOString(),
    seqStart: at,
    seqEnd: at,
    sourceSeqRanges: [{ startSeq: at, endSeq: at }],
    collapsed: [],
  };
}

function page(entries, hasOlder) {
  return {
    requestId: "r",
    agentId: "a",
    agent: null,
    direction: hasOlder ? "tail" : "before",
    projection: "projected",
    epoch: "e1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
    startCursor: hasOlder ? { epoch: "e1", seq: 1 } : null,
    endCursor: { epoch: "e1", seq: 2 },
    hasOlder,
    hasNewer: false,
    entries,
    error: null,
  };
}

function createAgent(id) {
  const state = { older: [], recent: [], activeTurn: null, stopped: 0 };
  const subscribers = [];
  const handle = {
    id,
    async refresh() {
      return {
        agent: {
          id,
          activeTurn: state.activeTurn
            ? { turnId: state.activeTurn, startedAt: new Date(0).toISOString() }
            : null,
        },
      };
    },
    timeline: {
      async refetch(options = {}) {
        const older = options.direction === "before";
        return page(older ? state.older : state.recent, !older && state.older.length > 0);
      },
      subscribe(handler) {
        subscribers.push(handler);
        const stop = () => {
          state.stopped += 1;
          const index = subscribers.indexOf(handler);
          if (index >= 0) subscribers.splice(index, 1);
        };
        return Object.assign(stop, {
          ready: Promise.resolve(),
          async release() { stop(); },
        });
      },
    },
    emit(event) {
      for (const handler of [...subscribers]) handler({ agentId: id, event });
    },
  };
  return { state, handle };
}

function createClient() {
  const agents = new Map();
  function agent(id) {
    let found = agents.get(id);
    if (!found) {
      found = createAgent(id);
      agents.set(id, found);
    }
    return found;
  }
  return {
    agent,
    client: { agents: { ref: id => agent(id).handle } },
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function settingsRpc() {
  let revision = 0;
  let values = { preferences: {}, legacyMigrated: true, answerDrafts: {} };
  return async (contract, input) => {
    const name = String(contract && contract.name || "");
    if (name.endsWith(".read")) return { status: "ready", revision: String(revision), values: structuredClone(values) };
    if (name.endsWith(".write")) {
      values = structuredClone(input.values);
      return { status: "saved", revision: String(++revision), values: structuredClone(values) };
    }
    throw new Error(`unexpected rpc ${name}`);
  };
}

async function fixture(t) {
  const rpc = settingsRpc();
  const h = createToolHarness("web", { presentationHost: { rpc } });
  const session = h.load("client/option-session.ts");
  const feed = h.load("client/answer-feed.ts");
  const preferences = h.load("client/preferences.ts");
  await preferences.initializeEnhancerPreferences(rpc);
  const drafts = new Map();
  session.setAnswerDraftStore({
    read: key => drafts.get(key),
    write: (key, value) => { drafts.set(key, value); },
    clear: key => { drafts.delete(key); },
  });
  const host = createClient();
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, session, feed, host, preferences, drafts };
}

test("loads history, including an older page, and does not feed the same reply twice", async t => {
  const { session, feed, host } = await fixture(t);
  const agent = host.agent("a");
  agent.state.older = [entry("assistant_message", one, 10, "t0"), entry("user_message", "B", 11, "t0")];
  agent.state.recent = [entry("assistant_message", two, 20, "t1")];
  const watched = feed.startAnswerFeed({ serverId: "srv", agentId: "a", client: host.client });
  t.after(() => watched.stop());
  await watched.ready;
  assert.equal(session.getOptionSessionAt("a", 10).readOnly, true);
  assert.equal(session.getOptionSessionAt("a", 10).choices[0], "B");
  assert.equal(session.getOptionSession("a").at, 20);
  assert.equal(session.getOptionSession("a").readOnly, false);
  const card = watched.currentCard();
  assert.equal(card.questionCount, 2);
  assert.equal(card.answeredCount, 0);
  assert.equal(card.at, 20);
  let notices = 0;
  const stop = session.subscribeOptionSession(() => { notices += 1; });
  t.after(stop);
  agent.handle.emit({ type: "subscription_restored" });
  await settle();
  assert.equal(notices, 0);
  assert.equal(session.getOptionSession("a").at, 20);
});

test("a streaming reply does not open a card until the turn finishes", async t => {
  const { session, feed, host } = await fixture(t);
  const agent = host.agent("a");
  agent.state.activeTurn = "live";
  agent.state.recent = [entry("assistant_message", one, 30, "live")];
  const watched = feed.startAnswerFeed({ serverId: "srv", agentId: "a", client: host.client });
  t.after(() => watched.stop());
  await watched.ready;
  assert.equal(session.getOptionSession("a"), null);
  assert.equal(watched.currentCard(), null);
  agent.handle.emit({
    type: "timeline",
    provider: "mock",
    turnId: "live",
    item: { type: "assistant_message", text: "\n2) Next?\nA Yes\nB No" },
  });
  await settle();
  assert.equal(watched.currentCard(), null);
  agent.state.activeTurn = null;
  agent.state.recent = [entry("assistant_message", two, 31, "live")];
  agent.handle.emit({ type: "turn_completed", provider: "mock" });
  await settle();
  const card = watched.currentCard();
  assert.ok(card, "finished reply is missing");
  assert.equal(card.questionCount, 2);
  assert.equal(card.answeredCount, 0);
  assert.equal(session.getOptionSession("a").at, 31);
});

test("a later user answer makes the card read-only and a prose note keeps the draft", async t => {
  const { session, feed, host, drafts } = await fixture(t);
  const agent = host.agent("a");
  agent.state.recent = [entry("assistant_message", two, 10, "t1")];
  const watched = feed.startAnswerFeed({ serverId: "srv", agentId: "a", client: host.client });
  t.after(() => watched.stop());
  await watched.ready;
  session.choose("a", 0, "A");
  assert.equal(watched.currentCard().answeredCount, 1);
  agent.state.recent = [
    entry("assistant_message", two, 10, "t1"),
    entry("user_message", "wait a moment", 11, "t1"),
  ];
  agent.handle.emit({
    type: "timeline",
    provider: "mock",
    item: { type: "user_message", text: "wait a moment" },
  });
  await settle();
  await new Promise(resolve => setTimeout(resolve, 450));
  const held = session.getOptionSessionAt("a", 10);
  assert.equal(held.readOnly, true);
  assert.equal(held.answeredText, "wait a moment");
  assert.equal(watched.currentCard(), null);
  assert.equal(drafts.get("a\u000010").choices["0"], "A");

  const answered = host.agent("b");
  answered.state.recent = [entry("assistant_message", two, 10, "tb")];
  const other = feed.startAnswerFeed({ serverId: "srv", agentId: "b", client: host.client });
  t.after(() => other.stop());
  await other.ready;
  answered.state.recent = [
    entry("assistant_message", two, 10, "tb"),
    entry("user_message", "1A 2B", 12, "tb"),
  ];
  answered.handle.emit({
    type: "timeline",
    provider: "mock",
    item: { type: "user_message", text: "1A 2B" },
  });
  await settle();
  const done = session.getOptionSessionAt("b", 10);
  assert.equal(done.readOnly, true);
  assert.deepEqual(done.choices, { 0: "A", 1: "B" });
  assert.equal(other.currentCard(), null);
  assert.equal(session.getOptionSessionAt("a", 10).answeredText, "wait a moment");
  assert.equal(session.getOptionSessionAt("b", 10).readOnly, true);
});

test("a system envelope and a dismissed reply stay off the card", async t => {
  const { session, feed, host, preferences } = await fixture(t);
  const agent = host.agent("a");
  const envelope = `<system-notice>\n${two}\n</system-notice>`;
  agent.state.recent = [
    entry("assistant_message", envelope, 10, "t0"),
    entry("assistant_message", two, 20, "t1"),
  ];
  const watched = feed.startAnswerFeed({ serverId: "srv", agentId: "a", client: host.client });
  t.after(() => watched.stop());
  await watched.ready;
  assert.equal(session.getOptionSessionAt("a", 10), null);
  assert.equal(watched.currentCard().at, 20);
  session.dismiss("a");
  await settle();
  assert.equal(session.getOptionSession("a"), null);
  assert.ok(preferences.getEnhancerPreferences().dismissedOptionReplies.some(item => item.agentId === "a" && item.at === 20));
  agent.handle.emit({ type: "subscription_restored" });
  await settle();
  assert.equal(session.getOptionSessionAt("a", 20), null);
  assert.equal(watched.currentCard(), null);
});

test("switching agents does not mix timelines and unmount cancels the subscription", async t => {
  const { session, feed, host } = await fixture(t);
  const first = host.agent("a");
  const second = host.agent("b");
  first.state.recent = [entry("assistant_message", one, 10, "ta")];
  second.state.recent = [entry("assistant_message", two, 10, "tb")];
  const watchedA = feed.startAnswerFeed({ serverId: "srv", agentId: "a", client: host.client });
  const watchedB = feed.startAnswerFeed({ serverId: "srv", agentId: "b", client: host.client });
  await Promise.all([watchedA.ready, watchedB.ready]);
  assert.equal(session.getOptionSession("a").set.questions.length, 1);
  assert.equal(session.getOptionSession("b").set.questions.length, 2);
  assert.equal(watchedA.currentCard().questionCount, 1);
  assert.equal(watchedB.currentCard().questionCount, 2);
  watchedA.stop();
  assert.equal(first.state.stopped, 1);
  first.state.recent = [entry("assistant_message", two, 40, "later")];
  first.handle.emit({ type: "turn_completed", provider: "mock" });
  await settle();
  assert.equal(session.getOptionSession("a").set.questions.length, 1);
  assert.equal(session.getOptionSessionAt("a", 40), null);
  watchedB.stop();
  second.handle.emit({ type: "turn_completed", provider: "mock" });
  await settle();
  assert.equal(second.state.stopped, 1);
});

test("the current card reports how many questions are answered while it is still open", async t => {
  const { h, session, feed, host } = await fixture(t);
  const agent = host.agent("a");
  agent.state.recent = [entry("assistant_message", two, 10, "t1")];
  const watched = feed.startAnswerFeed({ serverId: "srv", agentId: "a", client: host.client });
  t.after(() => watched.stop());
  await watched.ready;
  function Probe() {
    const card = feed.useCurrentAnswerCard("a");
    return card ? `${card.questionCount}/${card.answeredCount}` : "empty";
  }
  assert.equal(h.text(h.draw({ type: Probe, props: {} })), "2/0");
  session.choose("a", 0, "B");
  assert.equal(h.text(h.draw({ type: Probe, props: {} })), "2/1");
  assert.equal(feed.currentAnswerCard("a").answeredCount, 1);
  agent.state.recent = [entry("assistant_message", "Ordinary reply", 50, "t2")];
  agent.handle.emit({ type: "turn_completed", provider: "mock" });
  await settle();
  assert.equal(session.getOptionSession("a"), null);
  assert.equal(feed.currentAnswerCard("a").at, 10);
  assert.equal(h.text(h.draw({ type: Probe, props: {} })), "2/1");
});
