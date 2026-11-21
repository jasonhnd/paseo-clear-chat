const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The answer card is a composer pill: it exists only while the conversation in front of the
// user has a current, unanswered card. These tests drive the controller with a fake host edge
// and the real option-session store, so the gating is the product's own logic.

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";

function pillHarness(t, options = {}) {
  const h = createToolHarness("web", { locale: options.locale ?? "zh-CN" });
  const session = h.load("client/option-session.ts");
  const pill = h.load("client/answer-pill.ts");
  const data = {};
  session.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
  const registrations = [];
  const feeds = [];
  let focus = options.focus ?? null;
  const deps = {
    focusedAgent: () => focus,
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
    showAnswerCard: () => (options.showCard ? options.showCard() : true),
    startFeed(agentId) {
      feeds.push(agentId);
      return () => feeds.push(`stop:${agentId}`);
    },
    label: card => `Answer card ${card.answeredCount}/${card.questionCount}`,
    title: card => `Answer card · ${card.answeredCount}/${card.questionCount} answered`,
    content: () => null,
    subscribe: session.subscribeOptionSession,
  };
  const controller = pill.createAnswerPill(deps);
  t.after(() => { controller.stop(); session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  return {
    h, session, pill, controller, registrations, feeds,
    focus(next) { focus = next; },
    live() { return registrations.filter(record => !record.removed); },
  };
}

test("no pill while the answer-card switch is off", async t => {
  const f = pillHarness(t, { focus: { workspaceId: "w1", agentId: "a" }, showCard: () => false });
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  await f.controller.refresh();
  assert.equal(f.registrations.length, 0, "a switched-off card must register nothing");
  assert.deepEqual(f.feeds, [], "a switched-off card must not read a timeline");
});

test("no pill without a card, and no pill outside a conversation", async t => {
  const f = pillHarness(t, { focus: { workspaceId: "w1", agentId: "a" } });
  await f.controller.refresh();
  assert.equal(f.registrations.length, 0, "a conversation with no card shows no pill");
  f.focus(null);
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  await f.controller.refresh();
  assert.equal(f.registrations.length, 0, "no conversation in front of the user means no pill");
});

test("the pill appears above the composer with the answered count", async t => {
  const f = pillHarness(t, { focus: { workspaceId: "w1", agentId: "a" } });
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  await f.controller.refresh();
  const live = f.live();
  assert.equal(live.length, 1, "one card means exactly one pill");
  const { input } = live[0];
  assert.equal(input.agentId, "a");
  assert.equal(input.workspaceId, "w1");
  assert.equal(input.button.visible, true);
  assert.equal(input.button.label, "Answer card 0/2");
  assert.equal(input.button.title, "Answer card · 0/2 answered");
  assert.equal(input.button.behavior.kind, "popover");
  assert.deepEqual(f.feeds, ["a"], "the feed starts for the conversation in front of the user");
  f.session.choose("a", 0, "B");
  await f.controller.refresh();
  assert.equal(f.live()[0].patches.at(-1).label, "Answer card 1/2");
  assert.equal(f.live()[0].patches.at(-1).title, "Answer card · 1/2 answered", "the tooltip keeps the same count");
  assert.equal(f.registrations.length, 1, "the same registration is updated, not re-added");
});

test("answering and sending removes the pill and keeps the conversation feed", async t => {
  const f = pillHarness(t, { focus: { workspaceId: "w1", agentId: "a" } });
  const sent = [];
  f.session.setOptionSender(async (agentId, text) => { sent.push([agentId, text]); });
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  await f.controller.refresh();
  assert.equal(f.live().length, 1);
  f.session.choose("a", 0, "A");
  f.session.choose("a", 1, "B");
  await f.session.sendAnswer("a");
  assert.equal(f.session.getOptionSessionAt("a", 10).readOnly, true);
  await f.controller.refresh();
  assert.equal(f.live().length, 0, "a sent card leaves no pill");
  assert.equal(f.registrations[0].removed, true);
  assert.deepEqual(f.feeds, ["a"], "the conversation keeps its feed: a later card must appear without a switch");
  f.session.publishAssistantReply("a", { at: 30, text: questions });
  await f.controller.refresh();
  assert.equal(f.live().length, 1, "the next card in the same conversation brings the pill back");
  assert.equal(f.live()[0].input.button.label, "Answer card 0/2");
  f.session.setOptionSender(null);
});

test("switching conversations never carries another conversation's card", async t => {
  const f = pillHarness(t, { focus: { workspaceId: "w1", agentId: "a" } });
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  await f.controller.refresh();
  assert.equal(f.live().length, 1);
  assert.equal(f.live()[0].input.agentId, "a");
  f.focus({ workspaceId: "w1", agentId: "b" });
  await f.controller.refresh();
  assert.equal(f.live().length, 0, "b has no card, so b shows no pill");
  assert.equal(f.registrations[0].removed, true, "a's pill is gone once a is not in front");
  assert.deepEqual(f.feeds, ["a", "stop:a", "b"], "a's feed stops, and b's own feed starts");
  f.session.publishAssistantReply("b", { at: 20, text: questions });
  f.session.choose("b", 0, "B");
  await f.controller.refresh();
  const live = f.live();
  assert.equal(live.length, 1);
  assert.equal(live[0].input.agentId, "b");
  assert.equal(live[0].input.button.label, "Answer card 1/2", "b shows b's own progress");
  f.focus({ workspaceId: "w1", agentId: "a" });
  await f.controller.refresh();
  const back = f.live();
  assert.equal(back.length, 1);
  assert.equal(back[0].input.agentId, "a");
  assert.equal(back[0].input.button.label, "Answer card 0/2", "a keeps a's own progress");
  assert.equal(f.registrations.filter(record => record.input.agentId === "b").every(record => record.removed), true);
});

test("a card that is no longer the conversation's current reply is not offered", async t => {
  const f = pillHarness(t, { focus: { workspaceId: "w1", agentId: "a" } });
  f.session.publishAssistantReply("a", { at: 10, text: questions });
  f.session.publishAssistantReply("a", { at: 20, text: "Still thinking about it." });
  assert.equal(f.pill.currentPillCard("a"), null, "an older card cannot be drawn by the card body");
  await f.controller.refresh();
  assert.equal(f.registrations.length, 0);
});

test("the pill body draws the card with a reachable send control and no timeline margin", async t => {
  const h = createToolHarness("web", { locale: "en" });
  const session = h.load("client/option-session.ts");
  const data = {};
  session.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  const Content = h.load("client/components/answer-pill-content.tsx").AnswerPillContent;
  const props = { context: "agent", agentId: "a", workspaceId: "w1", theme: { colors: {} }, close: () => {}, layout: { compact: true, platform: "web" }, host: { id: "h", label: "host" } };
  const tree = h.draw({ type: Content, props });
  assert.equal(h.nodes(tree, node => node.props.testID === "option-card").length, 1, "the popover draws the whole card");
  assert.equal(h.nodes(tree, node => node.props.testID === "option-send").length, 1, "the send control is part of the popover body");
  const root = h.nodes(tree, node => node.props.testID === "option-card")[0];
  assert.equal(root.props.style.marginTop, 0, "the card sits in the popover, not under a timeline row");
  session.choose("a", 0, "B");
  const again = h.draw({ type: Content, props });
  assert.equal(h.nodes(again, node => node.props.accessibilityState?.selected === true).length, 1, "a re-opened popover keeps the chosen answer");
});

test("the popover explains the wait while the reply is still running", async t => {
  const expected = {
    en: "The reply is still running. Answer the card when it finishes.",
    "zh-CN": "回复还在生成，结束后才能作答。",
    ja: "返信を生成中です。完了後に回答できます。",
  };
  for (const [locale, copy] of Object.entries(expected)) {
    const h = createToolHarness("web", { locale, agents: { a: { status: "running" } } });
    const session = h.load("client/option-session.ts");
    const data = {};
    session.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
    session.publishAssistantReply("a", { at: 10, text: questions });
    const Content = h.load("client/components/answer-pill-content.tsx").AnswerPillContent;
    const tree = h.draw({ type: Content, props: { context: "agent", agentId: "a", workspaceId: "w1", theme: { colors: {} }, close: () => {} } });
    assert.equal(h.nodes(tree, node => node.props.testID === "option-pill-waiting").length, 1, `${locale}: the wait is explained`);
    assert.ok(h.text(tree).includes(copy), `${locale}: ${copy}`);
    assert.equal(h.nodes(tree, node => node.props.testID === "option-card").length, 0, `${locale}: no card while the reply runs`);
    session.setAnswerDraftStore(null);
    h.unmount();
    h.dispose();
  }
});

test("the pill body draws nothing once the card is sent", async t => {
  const h = createToolHarness("web", { locale: "en" });
  const session = h.load("client/option-session.ts");
  const data = {};
  session.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
  session.setOptionSender(async () => {});
  t.after(() => { session.setOptionSender(null); session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  session.publishAssistantReply("a", { at: 10, text: questions });
  const Content = h.load("client/components/answer-pill-content.tsx").AnswerPillContent;
  session.choose("a", 0, "A");
  session.choose("a", 1, "B");
  await session.sendAnswer("a");
  const tree = h.draw({ type: Content, props: { context: "agent", agentId: "a", workspaceId: "w1", theme: { colors: {} }, close: () => {} } });
  assert.equal(h.nodes(tree, node => node.props.testID === "option-card").length, 0, "a sent card leaves an empty popover");
});

test("the card status lines are translated with the settings wording in every language", async t => {
  const expected = {
    en: { heading: "Answer card · 1/2 answered · Incomplete", saved: "You stopped at Q2. Your progress is saved.", resume: "Continue answering" },
    "zh-CN": { heading: "回答卡片 · 已答 1/2 · 未完成", saved: "上次停在 Q2，进度已保存。", resume: "继续作答" },
    ja: { heading: "回答カード · 回答済み 1/2 · 未完了", saved: "前回は Q2 で中断しました。進捗は保存されています。", resume: "回答を続ける" },
  };
  for (const [locale, copy] of Object.entries(expected)) {
    const h = createToolHarness("web", { locale });
    const session = h.load("client/option-session.ts");
    const Card = h.load("client/components/option-card.tsx").OptionCard;
    const data = {};
    session.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
    data[session.answerDraftKey("a", 10)] = { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1 };
    session.publishAssistantReply("a", { at: 10, text: questions });
    session.publishUserMessage("a", 11, "Please wait until tomorrow.");
    assert.equal(session.getOptionSessionAt("a", 10).followupStatus, "waiting");
    const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    const text = h.text(tree);
    assert.ok(text.includes(copy.heading), `${locale}: ${copy.heading} in ${text}`);
    const saved = h.nodes(tree, node => node.props.testID === "option-saved-position")[0];
    assert.ok(saved, `${locale}: the saved-position line is missing`);
    assert.equal(h.text(saved), copy.saved, `${locale}: one text node holds the whole saved-position sentence`);
    assert.ok(text.includes(copy.resume), `${locale}: ${copy.resume} in ${text}`);
    assert.equal(text.includes("答题卡"), false, `${locale}: the old hard-coded Chinese label is gone`);
    assert.equal(/Answer card · \d/.test(text) && locale !== "en", false, `${locale}: no English fallback in place of a translation`);
    session.setAnswerDraftStore(null);
    h.unmount();
    h.dispose();
  }
});

test("the card source carries no locale-prefix branches", () => {
  const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../client/components/option-card.tsx"), "utf8");
  assert.equal(source.includes('startsWith("zh")'), false, "every user-visible string goes through the locale files");
});
