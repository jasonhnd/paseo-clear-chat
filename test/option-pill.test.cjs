const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Which storage? More details.
A Server
B File (recommended)

2) Ship now?
A Yes
B No

Reply with a letter for each.`;
const flush = () => new Promise(setImmediate);
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function fixture(t) {
  const agents = { a: { status: "idle" }, b: { status: "idle" } };
  const h = createToolHarness("ios", { width: 320, agents, preferences: { showAnswerCard: false } });
  const s = h.load("client/option-session.ts");
  const registrations = [];
  const client = {
    paseo: { agents: { ref: agentId => ({ refresh: async () => ({ agent: { workspaceId: `workspace-${agentId}` } }) }) } },
    addComposerPill(input) {
      const entry = { input, updates: [], removed: false };
      registrations.push(entry);
      return { update: patch => entry.updates.push(patch), remove: () => { entry.removed = true; } };
    },
  };
  const stop = h.load("client/option-pill.tsx").installOptionPills(client);
  t.after(() => { stop(); h.unmount(); h.dispose(); });
  const label = value => h.translations.runtime.resolve(value);
  return { h, s, agents, registrations, client, stop, label };
}

test("registers once per agent, updates counts and removes on invalidation", async t => {
  const { h, s, registrations: pills, label, stop } = fixture(t);
  s.publishAssistantReply("a", { at: 1, text: reply });
  s.publishAssistantReply("b", { at: 1, text: "ordinary reply" });
  await flush();
  assert.equal(pills.length, 0);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  await flush();
  assert.equal(pills.length, 1);
  assert.equal(pills[0].input.workspaceId, "workspace-a");
  assert.equal(pills[0].input.button.icon, "MessageCircle");
  assert.equal(label(pills[0].input.button.label), "Open questions: 2");
  s.choose("a", 0, "B"); s.setNote("a", 0, "note"); s.setActiveQuestion("a", 1);
  assert.equal(pills.length, 1);
  assert.equal(pills[0].updates.length, 1);
  assert.equal(label(pills[0].updates[0].label), "Open questions: 1");
  h.setLocale("ja");
  assert.equal(label(pills[0].updates[0].label), "未回答の質問: 1");
  s.publishAssistantReply("b", { at: 2, text: reply });
  await flush();
  assert.equal(pills.length, 2);
  s.publishUserMessage("a", 2);
  assert.equal(pills[0].removed, true);
  s.publishAssistantReply("b", { at: 3, text: reply });
  assert.equal(pills[1].removed, true);
  await flush();
  assert.equal(pills.length, 3);
  h.preferences.showAnswerCard = false; h.notifyPreferences();
  assert.equal(pills[2].removed, true);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  await flush();
  stop();
  assert.equal(pills[3].removed, true);
});

test("a newer non-question reply removes the pill", async t => {
  const { h, s, registrations: pills } = fixture(t);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  s.publishAssistantReply("a", { at: 1, text: reply }); await flush();
  s.publishAssistantReply("a", { at: 2, text: "ordinary reply" });
  assert.equal(pills[0].removed, true);
  await flush();
  assert.equal(pills.length, 1);
});

test("pending workspace lookup cannot register after removal or replacement", async t => {
  const { h, s, client, registrations: pills } = fixture(t);
  let resolve;
  client.paseo.agents.ref = () => ({ refresh: () => new Promise(ok => { resolve = ok; }) });
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  s.publishAssistantReply("a", { at: 1, text: reply });
  const old = resolve;
  s.publishAssistantReply("a", { at: 2, text: reply });
  old({ agent: { workspaceId: "old" } });
  resolve({ agent: { workspaceId: "new" } });
  await flush();
  assert.equal(pills.length, 1);
  assert.equal(pills[0].input.workspaceId, "new");
});

test("popover shares card choices, disables running sends, and closes only after success", async t => {
  const { h, s, agents, registrations: pills } = fixture(t);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  s.publishAssistantReply("a", { at: 1, text: reply });
  await flush();
  const Content = pills[0].input.button.behavior.Content;
  let closed = 0, resolve, reject;
  const calls = [];
  s.setOptionSender((agent, text) => { calls.push([agent, text]); return new Promise((ok, fail) => { resolve = ok; reject = fail; }); });
  const draw = () => h.draw({ type: Content, props: { context: "agent", agentId: "a", workspaceId: "workspace-a", theme: { colors: {} }, close: () => { closed++; } } }, "popover");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  const card = () => h.draw({ type: Card, props: { agentId: "a", at: 1, tokens: h.tokens } }, "card");
  let tree = draw();
  assert.match(h.text(tree), /Which storage\?\s+More details\./);
  assert.equal(byId(h, tree, "option-row-A").props.style.minHeight, 44);
  byId(h, tree, "option-row-B").props.onPress();
  assert.equal(byId(h, card(), "option-row-B").props.accessibilityState.selected, true);
  byId(h, card(), "option-next").props.onPress();
  byId(h, card(), "option-row-A").props.onPress();
  tree = draw();
  assert.equal(byId(h, tree, "option-row-A").props.accessibilityState.selected, true);
  assert.match(h.text(byId(h, tree, "option-send")), /Send 1B 2A/);
  agents.a.status = "running"; tree = draw();
  assert.ok(byId(h, tree, "option-running"));
  assert.equal(byId(h, tree, "option-send").props.disabled, true);
  byId(h, tree, "option-send").props.onPress();
  assert.equal(calls.length, 0);
  agents.a.status = "idle"; tree = draw();
  byId(h, tree, "option-send").props.onPress();
  assert.equal(byId(h, draw(), "option-send").props.disabled, true);
  reject(new Error("Unavailable")); await flush();
  assert.match(h.text(byId(h, draw(), "option-send-error")), /Unavailable/);
  assert.equal(closed, 0);
  byId(h, draw(), "option-send").props.onPress();
  resolve(); await flush();
  assert.deepEqual(calls, [["a", "1B 2A"], ["a", "1B 2A"]]);
  assert.equal(closed, 1);
  assert.equal(pills[0].removed, true);
});

test("Not options removes the pill", async t => {
  const { h, s, registrations: pills } = fixture(t);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  s.publishAssistantReply("a", { at: 1, text: reply }); await flush();
  const Content = pills[0].input.button.behavior.Content;
  const tree = h.draw({ type: Content, props: { context: "agent", agentId: "a", theme: { colors: {} }, close() {} } });
  byId(h, tree, "option-dismiss").props.onPress();
  assert.equal(pills[0].removed, true);
});

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: pill labels and running message are translated`, async t => {
    const { h, s, agents, registrations: pills, label } = fixture(t);
    h.setLocale(locale);
    const strings = require(`../client/locales/${locale}.json`).answerCard;
    h.preferences.showAnswerCard = true; h.notifyPreferences();
    s.publishAssistantReply("a", { at: 1, text: reply }); await flush();
    assert.equal(label(pills[0].input.button.title), strings.pillTitle);
    assert.equal(label(pills[0].input.button.label), strings.openQuestions.replace("{{count}}", "2"));
    agents.a.status = "running";
    const Content = pills[0].input.button.behavior.Content;
    const tree = h.draw({ type: Content, props: { context: "agent", agentId: "a", theme: { colors: {} }, close() {} } });
    assert.equal(h.text(byId(h, tree, "option-running")), strings.running);
  });
}

test("popover mount and unmount track each agent, and unload clears open flags", async t => {
  const { h, s, registrations: pills, stop } = fixture(t);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  s.publishAssistantReply("a", { at: 1, text: reply });
  s.publishAssistantReply("b", { at: 1, text: reply });
  await flush();
  const draw = (i, agentId) => h.draw({ type: pills[i].input.button.behavior.Content, props: { context: "agent", agentId, theme: { colors: {} }, close() {} } }, agentId);
  draw(0, "a");
  assert.equal(s.isOptionPopoverOpen("a"), true);
  assert.equal(s.isOptionPopoverOpen("b"), false);
  draw(1, "b");
  assert.equal(s.isOptionPopoverOpen("b"), true);
  s.publishAssistantReply("a", { at: 2, text: reply });
  assert.equal(s.isOptionPopoverOpen("a"), true);
  h.unmount();
  assert.equal(s.isOptionPopoverOpen("a"), false);
  assert.equal(s.isOptionPopoverOpen("b"), false);
  draw(1, "b");
  assert.equal(s.isOptionPopoverOpen("b"), true);
  stop();
  assert.equal(s.isOptionPopoverOpen("b"), false);
});
