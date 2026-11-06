const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Which storage? Full context here.
A Server
B File (recommended)

2) Ship now?
A Yes
B No

Reply with a letter for each.`;
const flush = () => new Promise(setImmediate);
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function fixture(t, options = {}) {
  const agents = { a: { status: "idle" }, b: { status: "idle" } };
  const h = createToolHarness("ios", { agents, preferences: { showAnswerCard: true }, ...options });
  const s = h.load("client/option-session.ts");
  const records = [];
  let refresh = async id => ({ agent: { workspaceId: `workspace-${id}` } });
  const client = {
    paseo: { agents: { ref: id => ({ refresh: () => refresh(id) }) } },
    addComposerPill(input) {
      const record = { input, updates: [], removed: 0 };
      records.push(record);
      return { update: patch => record.updates.push(patch), remove: () => record.removed++ };
    },
  };
  const stop = h.load("client/option-pill.tsx").installOptionPills(client);
  t.after(() => { stop(); h.unmount(); h.dispose(); });
  const content = (record, close = () => {}) => h.draw({ type: record.input.button.behavior.Content, props: { context: "agent", agentId: record.input.agentId, workspaceId: record.input.workspaceId, theme: { colors: {} }, layout: { compact: true, platform: "ios" }, host: { id: "host" }, close } });
  const resolve = message => h.translations.runtime.resolve(message);
  return { h, s, agents, records, stop, content, resolve, setRefresh: fn => { refresh = fn; } };
}

test("pill tracks eligibility, labels, replies, preferences, and cleanup per agent", async t => {
  const { h, s, records, stop, resolve, content } = fixture(t);
  s.publishAssistantReply("a", { at: 1, text: "plain" });
  await flush(); assert.equal(records.length, 0);
  h.preferences.showAnswerCard = false; h.notifyPreferences();
  s.publishAssistantReply("a", { at: 2, text: reply });
  await flush(); assert.equal(records.length, 0);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  s.publishAssistantReply("b", { at: 1, text: reply });
  s.choose("a", 0, "A"); s.setNote("a", 0, "note");
  await flush(); assert.equal(records.length, 2);
  const a = records.find(r => r.input.agentId === "a");
  const b = records.find(r => r.input.agentId === "b");
  assert.equal(a.input.workspaceId, "workspace-a");
  assert.equal(resolve(a.input.button.label), "Open questions: 1");
  assert.equal(a.input.button.icon, "MessageSquare");
  s.choose("a", 1, "B"); s.setNote("a", 1, "note");
  assert.equal(a.updates.length, 1); assert.equal(resolve(a.updates[0].label), "Open questions: 0");
  s.publishAssistantReply("a", { at: 3, text: reply });
  assert.equal(a.removed, 1);
  await flush(); assert.equal(records.length, 3);
  s.publishUserMessage("a", 4); assert.equal(records[2].removed, 1);
  byId(h, content(b), "option-dismiss").props.onPress(); assert.equal(b.removed, 1);
  s.publishAssistantReply("b", { at: 5, text: reply }); await flush();
  h.preferences.showAnswerCard = false; h.notifyPreferences(); assert.equal(records[3].removed, 1);
  h.preferences.showAnswerCard = true; h.notifyPreferences(); await flush();
  stop(); assert.equal(records[4].removed, 1);
});

test("pending workspace lookups cannot register after dismissal, setting change, or cleanup", async t => {
  const { h, s, records, stop, setRefresh } = fixture(t);
  const pending = [];
  setRefresh(() => new Promise(resolve => pending.push(resolve)));
  s.publishAssistantReply("a", { at: 1, text: reply });
  s.dismiss("a");
  pending.shift()({ agent: { workspaceId: "one" } }); await flush(); assert.equal(records.length, 0);
  s.publishAssistantReply("a", { at: 2, text: reply });
  h.preferences.showAnswerCard = false; h.notifyPreferences();
  pending.shift()({ agent: { workspaceId: "one" } }); await flush(); assert.equal(records.length, 0);
  h.preferences.showAnswerCard = true; h.notifyPreferences();
  stop(); pending.shift()({ agent: { workspaceId: "one" } }); await flush(); assert.equal(records.length, 0);
});

test("popover shares choices with card and keeps errors open, then closes on success", async t => {
  const { h, s, agents, records, content } = fixture(t);
  s.publishAssistantReply("a", { at: 1, text: reply }); await flush();
  let closed = 0, calls = 0;
  const draw = () => content(records[0], () => { closed++; });
  let tree = draw();
  assert.match(h.text(tree), /Which storage\? Full context here\./);
  assert.match(h.text(byId(h, tree, "option-row-B")), /Recommended/);
  assert.ok(byId(h, tree, "option-row-B").props.style.minHeight >= 44);
  byId(h, tree, "option-row-B").props.onPress();
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  tree = h.draw({ type: Card, props: { agentId: "a", at: 1, tokens: h.tokens } }, "card");
  assert.equal(byId(h, tree, "option-row-B").props.accessibilityState.selected, true);
  byId(h, tree, "option-next").props.onPress();
  byId(h, h.draw({ type: Card, props: { agentId: "a", at: 1, tokens: h.tokens } }, "card"), "option-row-A").props.onPress();
  tree = draw(); assert.equal(byId(h, tree, "option-row-A").props.accessibilityState.selected, true);
  agents.a.status = "running"; tree = draw();
  assert.equal(byId(h, tree, "option-send").props.disabled, true);
  assert.ok(byId(h, tree, "option-running"));
  agents.a.status = "idle";
  s.setOptionSender(async (id, text) => { calls++; assert.equal(id, "a"); assert.equal(text, s.answerText("a")); if (calls === 1) throw new Error("Unavailable"); });
  byId(h, draw(), "option-send").props.onPress(); await flush();
  assert.equal(closed, 0); assert.match(h.text(byId(h, draw(), "option-send-error")), /Unavailable/);
  byId(h, draw(), "option-send").props.onPress(); await flush();
  assert.equal(closed, 1); assert.equal(records[0].removed, 1);
});

for (const locale of ["en", "zh-CN", "ja"]) test(`${locale}: pill strings are present and localized`, async t => {
  const { h, s, records, resolve, content, agents } = fixture(t, { locale });
  const strings = require(`../client/locales/${locale}.json`).answerCard;
  assert.ok(strings.pill && strings.running);
  s.publishAssistantReply("a", { at: 1, text: reply }); await flush();
  assert.equal(resolve(records[0].input.button.label), strings.pill.replace("{{count}}", "2"));
  agents.a.status = "running";
  assert.ok(h.text(content(records[0])).includes(strings.running));
});
