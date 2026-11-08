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
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const flush = () => new Promise(setImmediate);

function fixture(t) {
  const agents = { a: { status: "idle" } };
  const h = createToolHarness("ios", { width: 390, agents, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const draw = (at = 10) => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: reply } }, timestamp: new Date(at), theme: { colors: {} } } }, `reply-${at}`);
  return { h, s, agents, draw };
}

test("inline card advances only for a first choice and changes an existing choice in place", t => {
  const { h, s, draw } = fixture(t);
  let tree = draw();
  assert.ok(byId(h, tree, "option-card"));
  assert.equal(byId(h, tree, "option-send").props.disabled, true);
  assert.equal(byId(h, tree, "option-note-toggle"), undefined);
  byId(h, tree, "option-row-B").props.onPress();
  tree = draw();
  assert.equal(s.getOptionSession("a").activeQuestion, 1);
  assert.equal(byId(h, tree, "option-send").props.disabled, true);
  assert.match(h.text(byId(h, tree, "option-send")), /Choose an answer for Q2/);
  byId(h, tree, "option-row-A").props.onPress();
  tree = draw();
  assert.equal(byId(h, tree, "option-send").props.disabled, false);
  assert.match(h.text(byId(h, tree, "option-send")), /Send 1B 2A/);
  byId(h, tree, "option-question-0").props.onPress();
  byId(h, draw(), "option-row-A").props.onPress();
  tree = draw();
  assert.equal(s.getOptionSession("a").activeQuestion, 0);
  assert.equal(byId(h, tree, "option-row-A").props.accessibilityState.selected, true);
  assert.match(h.text(byId(h, tree, "option-send")), /Send 1A 2A/);
});

test("tabs show short names or the chosen answer", t => {
  const { h, s, draw } = fixture(t);
  let tree = draw();
  assert.equal(h.text(byId(h, tree, "option-question-0")), "Q1 · Storage");
  assert.equal(h.text(byId(h, tree, "option-question-1")), "Q2 · Ship now");
  assert.doesNotMatch(h.text(byId(h, tree, "option-card")), /Options detected/);
  s.choose("a", 0, "B");
  tree = draw();
  assert.equal(h.text(byId(h, tree, "option-question-0")), "✓ File (recommended)");
  assert.equal(h.text(byId(h, tree, "option-question-1")), "Q2 · Ship now");
  s.getOptionSession("a").set.questions[0].options[1].text = "An unusually long answer";
  assert.equal(h.text(byId(h, draw(), "option-question-0")), "✓ An unusually long…");
  byId(h, tree, "option-question-0").props.onPress();
  assert.equal(h.text(byId(h, draw(), "option-question-0")), "Q1 · Storage");
});

test("disabled Send is marked inaccessible and cannot be focused", t => {
  const { h, s, draw } = fixture(t);
  let send = byId(h, draw(), "option-send");
  assert.equal(send.props.accessibilityState.disabled, true);
  assert.equal(send.props.disabled, true);
  assert.equal(send.props.focusable, false);
  assert.equal(send.props.style[0].borderStyle, "dashed");
  assert.equal(send.props.style[0].backgroundColor, "transparent");
  s.choose("a", 0, "A"); s.choose("a", 1, "A");
  send = byId(h, draw(), "option-send");
  assert.equal(send.props.focusable, true);
  assert.equal(send.props.accessibilityState.disabled, false);
});

test("typed messages make the matching card read-only and newer replies replace it", t => {
  const { h, s, draw } = fixture(t);
  draw();
  byId(h, draw(), "option-row-B").props.onPress();
  s.publishUserMessage("a", 11);
  let tree = draw();
  assert.equal(byId(h, tree, "option-card").props.accessibilityState.disabled, true);
  assert.equal(byId(h, tree, "option-row-A").props.disabled, true);
  assert.equal(byId(h, tree, "option-send").props.disabled, true);
  byId(h, tree, "option-question-0").props.onPress();
  assert.equal(s.getOptionSession("a").choices[0], "B");
  s.publishAssistantReply("a", { at: 12, text: reply });
  assert.equal(byId(h, draw(), "option-card"), undefined);
  assert.ok(byId(h, draw(12), "option-card"));
});

test("failed sends remain retryable; successful sends leave a read-only card", async t => {
  const { h, s, draw } = fixture(t);
  draw(); s.choose("a", 0, "B"); s.choose("a", 1, "A");
  let reject;
  const calls = [];
  s.setOptionSender((agent, answer) => { calls.push([agent, answer]); return new Promise((_, fail) => { reject = fail; }); });
  byId(h, draw(), "option-send").props.onPress();
  assert.equal(byId(h, draw(), "option-send").props.disabled, true);
  reject(new Error("Unavailable")); await flush();
  assert.match(h.text(byId(h, draw(), "option-send-error")), /Unavailable/);
  s.setOptionSender(async (agent, answer) => { calls.push([agent, answer]); });
  byId(h, draw(), "option-send").props.onPress(); await flush();
  assert.deepEqual(calls, [["a", "1B 2A"], ["a", "1B 2A"]]);
  assert.equal(byId(h, draw(), "option-card").props.accessibilityState.disabled, true);
});

test("the setting and reply identity control visibility", t => {
  const { h, s, agents, draw } = fixture(t);
  h.preferences.showAnswerCard = false;
  assert.equal(byId(h, draw(), "option-card"), undefined);
  h.preferences.showAnswerCard = true;
  assert.ok(byId(h, draw(), "option-card"));
  agents.a.status = "running";
  assert.equal(byId(h, draw(), "option-card"), undefined);
  agents.a.status = "idle";
  assert.equal(byId(h, draw(9), "option-card"), undefined);
  s.dismiss("a");
  assert.equal(byId(h, draw(), "option-card"), undefined);
});

test("web focus follows first choices and arrows stay scoped to option rows", async t => {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const focused = [];
  let tree = draw();
  assert.equal(h.text(byId(h, tree, "option-hint")), "↑↓ move · ↵ choose");
  byId(h, tree, "option-row-B").props.onFocus();
  tree = draw();
  assert.equal(byId(h, tree, "option-row-B").props.style[1].outlineStyle, "solid");
  assert.equal(byId(h, tree, "option-row-B").props.style[1].outlineOffset, 1);
  byId(h, tree, "option-card").props.ref({ querySelector: selector => ({ focus: () => focused.push(selector) }) });
  byId(h, tree, "option-row-B").props.onPress();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(focused.pop(), /option-row-A/);
  tree = draw();
  let prevented = false;
  const target = { closest: () => true, getAttribute: () => "option-row-A" };
  byId(h, tree, "option-card").props.onKeyDown({ key: "ArrowDown", target, nativeEvent: {}, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(prevented, true);
  assert.match(focused.pop(), /option-row-B/);
  tree = draw();
  byId(h, tree, "option-row-A").props.onPress();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(focused.pop(), /option-send/);
  tree = draw();
  byId(h, tree, "option-send").props.onFocus();
  tree = draw();
  assert.equal(h.text(byId(h, tree, "option-hint")), "↵ send");
  assert.equal(byId(h, tree, "option-send").props.style[1].outlineWidth, 2);
  assert.equal(byId(h, tree, "option-send").props.style[1].outlineStyle, "solid");
  byId(h, tree, "option-send").props.onBlur();
  assert.equal(h.text(byId(h, draw(), "option-hint")), "↑↓ move · ↵ choose");
  byId(h, draw(), "option-question-0").props.onPress();
  byId(h, draw(), "option-row-A").props.onPress();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(focused.length, 0);
  assert.equal(s.getOptionSession("a").activeQuestion, 0);
});

test("a single choice moves focus to Send", async t => {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: "Pick?\nA One\nB Two (recommended)\n\nReply: A" });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const focused = [];
  const tree = draw();
  byId(h, tree, "option-card").props.ref({ querySelector: selector => ({ focus: () => focused.push(selector) }) });
  byId(h, tree, "option-row-A").props.onPress();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(focused.pop(), /option-send/);
  assert.equal(byId(h, draw(), "option-send").props.disabled, false);
});
