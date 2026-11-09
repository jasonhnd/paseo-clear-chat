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

test("outer frame has no horizontal margin or fixed width", t => {
  const { h, draw } = fixture(t);
  const style = byId(h, draw(), "option-card").props.style;
  for (const property of ["marginHorizontal", "marginLeft", "marginRight", "width"]) {
    assert.equal(style[property], undefined, property);
  }
});

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

test("typed answers leave a read-only frame beside a new operable frame", t => {
  const { h, s, draw } = fixture(t);
  draw();
  s.publishUserMessage("a", 11, "1B 2A");
  let tree = draw();
  assert.equal(byId(h, tree, "option-card").props.accessibilityState.disabled, true);
  assert.equal(byId(h, tree, "option-row-B").props.accessibilityState.selected, true);
  assert.match(h.text(byId(h, tree, "option-row-B")), /✓/);
  assert.equal(h.text(byId(h, tree, "option-question-0")), "✓ File (recommended)");
  assert.equal(h.text(byId(h, tree, "option-question-1")), "✓ Yes");
  assert.equal(h.text(byId(h, tree, "option-answered")), "Answered in the chat: 1B 2A");
  for (const id of ["option-send", "option-hint", "option-dismiss"]) assert.equal(byId(h, tree, id), undefined);
  assert.equal(byId(h, tree, "option-row-B").props.onPress, undefined);
  assert.equal(byId(h, tree, "option-question-0").props.onPress, undefined);
  s.publishAssistantReply("a", { at: 12, text: reply });
  tree = draw();
  assert.ok(byId(h, tree, "option-answered"));
  const newer = draw(12);
  assert.ok(byId(h, newer, "option-send"));
  byId(h, newer, "option-row-A").props.onPress();
  assert.equal(s.getOptionSession("a").choices[0], "A");
  assert.equal(s.getOptionSession("a", 10).choices[0], "B");
  s.publishAssistantReply("a", { at: 13, text: "Ordinary reply" });
  assert.ok(byId(h, draw(), "option-answered"));
  assert.equal(byId(h, draw(12), "option-card"), undefined);
});

test("read-only option rows share a background while operable selection stays highlighted", t => {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  Object.assign(h.tokens, { surface1: "frame", surface2: "row", accentBg: "selected", border: "border" });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: "Pick?\nA One\nB Two\nC Three\n\nReply: A" });
  s.choose("a", 0, "B");
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  let tree = draw();
  for (const letter of ["A", "C"]) {
    assert.notEqual(byId(h, tree, "option-row-B").props.style[0].backgroundColor, byId(h, tree, `option-row-${letter}`).props.style[0].backgroundColor);
  }

  s.publishUserMessage("a", 11, "B");
  tree = draw();
  for (const letter of ["A", "B", "C"]) {
    const row = byId(h, tree, `option-row-${letter}`);
    assert.equal(row.props.style.backgroundColor, h.tokens.surface2);
    assert.equal(row.props.style.borderColor, h.tokens.border);
  }
  assert.equal(byId(h, tree, "option-row-B").props.accessibilityState.selected, true);
  assert.match(h.text(byId(h, tree, "option-row-B")), /✓/);
});

test("Not options dismisses only the current frame and stays dismissed", t => {
  const { h, s, draw } = fixture(t);
  const button = byId(h, draw(), "option-dismiss");
  assert.equal(h.text(button), "Not options");
  assert.equal(button.props.style.minHeight, 44);
  assert.equal(button.props.accessibilityRole, "button");
  button.props.onPress();
  assert.equal(byId(h, draw(), "option-card"), undefined);
  s.publishAssistantReply("a", { at: 10, text: reply });
  assert.equal(byId(h, draw(), "option-card"), undefined);
  assert.ok(byId(h, draw(11), "option-dismiss"));
});

test("read-only frames ignore keyboard, clicks and focus", t => {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  s.publishUserMessage("a", 11, "1B 2A");
  const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const before = s.getOptionSession("a", 10);
  let prevented = false;
  for (const key of ["ArrowDown", "ArrowUp", "Enter"]) {
    byId(h, tree, "option-card").props.onKeyDown({ key, target: { closest: () => true }, nativeEvent: {}, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  }
  for (const id of ["option-row-A", "option-row-B", "option-question-0", "option-question-1"]) {
    const props = byId(h, tree, id).props;
    assert.equal(props.onPress, undefined);
    assert.equal(props.onFocus, undefined);
    assert.equal(props.focusable, undefined);
  }
  assert.equal(prevented, false);
  s.choose("a", 0, "A"); s.moveCursor("a", 0, 1); s.setActiveQuestion("a", 1);
  assert.equal(s.getOptionSession("a", 10), before);
});

test("failed sends remain retryable; successful sends leave a read-only card", async t => {
  const { h, s, draw } = fixture(t);
  draw(); s.choose("a", 0, "B"); s.choose("a", 1, "A");
  let reject;
  const calls = [];
  s.setOptionSender((agent, answer) => { calls.push([agent, answer]); return new Promise((_, fail) => { reject = fail; }); });
  byId(h, draw(), "option-send").props.onPress();
  assert.equal(byId(h, draw(), "option-send").props.disabled, true);
  assert.equal(byId(h, draw(), "option-dismiss"), undefined);
  reject(new Error("Unavailable")); await flush();
  assert.match(h.text(byId(h, draw(), "option-send-error")), /Unavailable/);
  s.setOptionSender(async (agent, answer) => { calls.push([agent, answer]); });
  byId(h, draw(), "option-send").props.onPress(); await flush();
  assert.deepEqual(calls, [["a", "1B 2A"], ["a", "1B 2A"]]);
  assert.equal(byId(h, draw(), "option-card").props.accessibilityState.disabled, true);
  assert.equal(h.text(byId(h, draw(), "option-answered")), "Answered in the chat: 1B 2A");
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
