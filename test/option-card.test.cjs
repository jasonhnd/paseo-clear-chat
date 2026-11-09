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
  assert.equal(typeof byId(h, tree, "option-question-0").props.onPress, "function");
  assert.equal(byId(h, tree, "option-question-0").props.disabled, false);
  assert.notEqual(byId(h, tree, "option-question-0").props.focusable, false);
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
  const choices = { ...before.choices }, customConfirmed = { ...before.customConfirmed };
  const { answeredText, sending } = before;
  let prevented = false;
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "A", "B", "C"]) {
    byId(h, tree, "option-card").props.onKeyDown({ key, target: { closest: () => true }, nativeEvent: {}, preventDefault: () => { prevented = true; }, stopPropagation() {} });
  }
  for (const id of ["option-row-A", "option-row-B"]) {
    const props = byId(h, tree, id).props;
    assert.equal(props.onPress, undefined);
    assert.equal(props.onFocus, undefined);
    assert.equal(props.focusable, undefined);
  }
  for (const id of ["option-question-0", "option-question-1"]) {
    const props = byId(h, tree, id).props;
    assert.equal(typeof props.onPress, "function");
    assert.equal(props.disabled, false);
    assert.notEqual(props.focusable, false);
  }
  byId(h, tree, "option-question-1").props.onPress();
  const viewed = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  assert.equal(byId(h, viewed, "option-question-1").props.accessibilityState.selected, true);
  assert.deepEqual(s.getOptionSession("a", 10).choices, choices);
  assert.deepEqual(s.getOptionSession("a", 10).customConfirmed, customConfirmed);
  assert.equal(s.getOptionSession("a", 10).answeredText, answeredText);
  assert.equal(s.getOptionSession("a", 10).sending, sending);
  assert.equal(prevented, false);
  s.choose("a", 0, "A"); s.moveCursor("a", 0, 1); s.setActiveQuestion("a", 1);
  assert.equal(s.getOptionSession("a", 10), before);
});

test("viewing a sent custom answer leaves the answers and sent state unchanged", async t => {
  const { h, s, draw } = fixture(t);
  draw();
  s.openCustom("a", 0); s.setCustomDraft("a", 0, "My answer");
  assert.equal(s.confirmCustom("a", 0), "confirmed");
  s.choose("a", 1, "A");
  s.setOptionSender(async () => {});
  byId(h, draw(), "option-send").props.onPress();
  await flush();
  const before = s.getOptionSession("a", 10);
  assert.equal(before.customConfirmed[0], "My answer");
  assert.ok(before.answeredText);
  const choices = { ...before.choices }, customConfirmed = { ...before.customConfirmed };
  const { answeredText, sending, readOnly } = before;
  byId(h, draw(), "option-question-0").props.onPress();
  assert.equal(byId(h, draw(), "option-question-0").props.accessibilityState.selected, true);
  const after = s.getOptionSession("a", 10);
  assert.deepEqual(after.choices, choices);
  assert.deepEqual(after.customConfirmed, customConfirmed);
  assert.equal(after.answeredText, answeredText);
  assert.equal(after.sending, sending);
  assert.equal(after.readOnly, readOnly);
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

function keyboardFixture(t) {
  const agents = { a: { status: "idle" } };
  const h = createToolHarness("web", { agents });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const press = (tree, key, extra = {}) => {
    const result = { prevented: false, stopped: false };
    byId(h, tree, "option-card").props.onKeyDown({
      key, target: { closest: selector => selector.includes("option-row") ? {} : null }, nativeEvent: {},
      ...extra,
      preventDefault: () => { result.prevented = true; },
      stopPropagation: () => { result.stopped = true; },
    });
    return result;
  };
  return { h, s, agents, draw, press };
}

test("letter keys choose the current answer and focus the next question or Send", async t => {
  for (const key of ["B", "b"]) {
    const { h, s, draw, press } = keyboardFixture(t);
    const focused = [];
    let tree = draw();
    byId(h, tree, "option-card").props.ref({ querySelector: selector => ({ focus: () => focused.push(selector) }) });
    assert.deepEqual(press(tree, key), { prevented: true, stopped: true });
    assert.equal(s.getOptionSession("a").choices[0], "B");
    assert.equal(s.getOptionSession("a").activeQuestion, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(focused.pop(), /option-row-A/);
    tree = draw();
    assert.deepEqual(press(tree, key), { prevented: true, stopped: true });
    assert.equal(s.getOptionSession("a").choices[1], "B");
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(focused.pop(), /option-send/);
  }
});

test("letters on tabs and Send choose in the current question and change answers in place", async t => {
  const { h, s, draw, press } = keyboardFixture(t);
  const focused = [];
  let tree = draw();
  byId(h, tree, "option-card").props.ref({ querySelector: selector => ({ focus: () => focused.push(selector) }) });
  const target = { closest: () => null };
  assert.deepEqual(press(tree, "a", { target }), { prevented: true, stopped: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  tree = draw();
  assert.deepEqual(press(tree, "a", { target }), { prevented: true, stopped: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  focused.length = 0;
  byId(h, draw(), "option-question-0").props.onPress();
  assert.deepEqual(press(draw(), "b", { target }), { prevented: true, stopped: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.getOptionSession("a").choices[0], "B");
  assert.equal(s.getOptionSession("a").choices[1], "A");
  assert.equal(s.getOptionSession("a").activeQuestion, 0);
  assert.deepEqual(focused, []);
});

test("unavailable keys, modifiers, composition, and editable targets are ignored", async t => {
  const { h, s, draw, press } = keyboardFixture(t);
  const tree = draw();
  const focused = [];
  byId(h, tree, "option-card").props.ref({ querySelector: selector => ({ focus: () => focused.push(selector) }) });
  const ignored = [
    ["D", {}], ["1", {}], ["Escape", {}], ["ArrowLeft", {}], ["ArrowRight", {}],
    ...["ctrlKey", "metaKey", "altKey", "shiftKey"].map(flag => ["b", { [flag]: true }]),
    ["b", { nativeEvent: { isComposing: true } }],
    ...["input", "textarea"].map(tag => ["b", { target: { closest: selector => selector === "input, textarea" ? { tag } : null } }]),
    ["b", { target: { isContentEditable: true, closest: () => null } }],
  ];
  for (const [key, extra] of ignored) {
    assert.deepEqual(press(tree, key, extra), { prevented: false, stopped: false }, `${key} ${JSON.stringify(extra)}`);
    assert.equal(s.getOptionSession("a").choices[0], undefined);
    assert.equal(s.getOptionSession("a").activeQuestion, 0);
  }
  assert.deepEqual(press(tree, "C"), { prevented: true, stopped: true });
  assert.ok(byId(h, draw(), "option-custom-input"));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(focused.pop(), /option-custom-input/);
});

test("letters are ignored while sending, read-only, or running", t => {
  const { h, s, agents, draw, press } = keyboardFixture(t);
  let tree = draw();
  s.choose("a", 0, "A"); s.choose("a", 1, "A");
  s.setOptionSender(() => new Promise(() => {}));
  byId(h, draw(), "option-send").props.onPress();
  tree = draw();
  assert.deepEqual(press(tree, "b"), { prevented: false, stopped: false });
  assert.equal(s.getOptionSession("a").choices[0], "A");
  assert.equal(s.getOptionSession("a").choices[1], "A");
  s.publishUserMessage("a", 11, "1A 2A");
  tree = draw();
  assert.deepEqual(press(tree, "b"), { prevented: false, stopped: false });
  agents.a.status = "running";
  tree = draw();
  assert.deepEqual(press(tree, "b"), { prevented: false, stopped: false });
  assert.equal(s.getOptionSession("a", 10).choices[0], "A");
  assert.equal(s.getOptionSession("a", 10).choices[1], "A");
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

// The web motion uses the browser animation API. These nodes record the actual
// keyframes applied by the card while the harness drives a question change.
function motionFixture(t, reduced = false) {
  const animations = [];
  const globals = { matchMedia: () => ({ matches: reduced }) };
  const h = createToolHarness("web", { agents: { a: { status: "idle" } }, globals });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  let height = 300;
  function node(name) {
    return {
      name, style: {}, clientTop: 1, clientLeft: 1, parentElement: null,
      getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: name === "card" ? height : 200 }),
      querySelectorAll: () => [], setAttribute() {}, remove() {},
      cloneNode: () => node("old-content"), appendChild() {},
      animate(keyframes, options) {
        const animation = { name, keyframes, options, cancel() {}, finished: Promise.resolve() };
        animations.push(animation);
        return animation;
      },
    };
  }
  const card = node("card"), content = node("content");
  card.querySelector = selector => selector === '[data-testid="option-question-content"]' ? content : null;
  const draw = () => {
    const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    byId(h, tree, "option-card").props.ref(card);
    return tree;
  };
  return { h, draw, animations, switchQuestion() { byId(h, draw(), "option-question-1").props.onPress(); height = 400; return draw(); } };
}

test("question changes cross-fade content while the card animates its measured height", t => {
  const f = motionFixture(t);
  f.switchQuestion();
  const height = f.animations.find(a => a.name === "card" && a.keyframes.some(frame => frame.height));
  assert.ok(height, "the card must animate between its old and new heights");
  assert.deepEqual(height.keyframes.map(frame => frame.height), ["300px", "400px"]);
  assert.equal(height.options.duration, 180);
  assert.equal(height.options.easing.replace(/\s/g, ""), "cubic-bezier(.2,0,0,1)");
  for (const name of ["old-content", "content"]) {
    const fade = f.animations.find(a => a.name === name && a.keyframes.some(frame => frame.opacity !== undefined));
    assert.ok(fade, `${name} must fade during the switch`);
    assert.equal(fade.options.duration, 120);
  }
});

test("reduced motion switches questions without height or opacity animations", t => {
  const f = motionFixture(t, true);
  const tree = f.switchQuestion();
  assert.equal(f.animations.length, 0);
  const content = f.h.nodes(tree, node => node.type === "Animated.View")[0];
  assert.ok(content, "the current question content must remain rendered");
  assert.equal(content.props.style.opacity ?? 1, 1, "reduced motion must not use an animated opacity value");
});

test("question switches preserve the chat scroll position, including reduced motion", t => {
  for (const reduced of [false, true]) {
    const f = motionFixture(t, reduced);
    const scroller = { style: { overflowAnchor: "auto" }, scrollTop: 100 };
    let height = 300;
    const animation = { cancel() {}, finished: new Promise(() => {}) };
    const content = {
      style: {}, getBoundingClientRect: () => ({ top: 120, left: 10, width: 380, height: 200 }),
      cloneNode: () => ({ style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => animation }),
      animate: () => animation,
    };
    const card = {
      style: {}, clientTop: 1, clientLeft: 1, closest: () => scroller,
      getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height }),
      querySelector: () => content, appendChild() {}, animate: () => animation,
    };
    const tree = f.draw();
    byId(f.h, tree, "option-card").props.ref(card);
    byId(f.h, tree, "option-question-1").props.onPress();
    assert.equal(scroller.style.overflowAnchor, "none", `anchoring disabled, reduced=${reduced}`);
    height = 400;
    scroller.scrollTop = 140;
    f.draw();
    assert.equal(scroller.scrollTop, 100, `scroll restored at commit, reduced=${reduced}`);
  }
});

test("a shrinking question keeps enough scrollable space at the bottom, including reduced motion", t => {
  for (const reduced of [false, true]) {
    const f = motionFixture(t, reduced);
    let naturalHeight = 693, scroll = 205;
    const animation = { cancel() {}, finished: new Promise(() => {}) };
    const content = {
      style: {}, getBoundingClientRect: () => ({ top: 120, left: 10, width: 380, height: 500 }),
      cloneNode: () => ({ style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => animation }),
      animate: () => animation,
    };
    const card = {
      style: {}, clientTop: 1, clientLeft: 1,
      getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: Number.parseFloat(card.style.height) || naturalHeight }),
      querySelector: () => content, appendChild() {}, animate: () => animation,
    };
    const scroller = {
      style: {}, clientHeight: 800,
      get scrollHeight() { return 312 + naturalHeight + (Number.parseFloat(card.style.marginBottom) || 0); },
      get scrollTop() { return scroll = Math.min(scroll, Math.max(0, this.scrollHeight - this.clientHeight)); },
      set scrollTop(value) { scroll = Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)); },
    };
    card.closest = () => scroller;
    const tree = f.draw();
    byId(f.h, tree, "option-card").props.ref(card);
    byId(f.h, tree, "option-question-1").props.onPress();
    naturalHeight = 357;
    f.draw();
    assert.equal(scroller.scrollTop, 205, `bottom scroll preserved, reduced=${reduced}`);
    assert.ok(Number.parseFloat(card.style.marginBottom) >= 205, `space reserved, reduced=${reduced}`);
  }
});

test("scroll compensation accounts for content shorter than the viewport", t => {
  const f = motionFixture(t, true);
  let naturalHeight = 693, scroll = 205;
  const content = { getBoundingClientRect: () => ({ top: 120, left: 10, width: 380, height: 500 }) };
  const card = {
    style: {}, clientTop: 1, clientLeft: 1,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: Number.parseFloat(card.style.height) || naturalHeight }),
    querySelector: () => content,
  };
  const scroller = {
    style: {}, clientHeight: 800,
    get scrollHeight() { return Math.max(this.clientHeight, 312 + naturalHeight + (Number.parseFloat(card.style.marginBottom) || 0)); },
    get scrollTop() { return scroll = Math.min(scroll, this.scrollHeight - this.clientHeight); },
    set scrollTop(value) { scroll = Math.min(value, this.scrollHeight - this.clientHeight); },
  };
  card.closest = () => scroller;
  const tree = f.draw();
  byId(f.h, tree, "option-card").props.ref(card);
  byId(f.h, tree, "option-question-1").props.onPress();
  naturalHeight = 357;
  f.draw();
  assert.equal(scroller.scrollTop, 205);
});

test("a stale editable tab does not freeze the old card or its scroller", t => {
  const f = motionFixture(t);
  const scroller = { style: { overflowAnchor: "auto" }, scrollTop: 10 };
  const content = {
    getBoundingClientRect: () => ({ top: 120, left: 10, width: 380, height: 200 }),
    cloneNode: () => ({ style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {} }),
  };
  const card = {
    style: {}, clientTop: 1, clientLeft: 1, closest: () => scroller,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: 300 }),
    querySelector: () => content, appendChild() {}, animate() {},
  };
  const tree = f.draw();
  byId(f.h, tree, "option-card").props.ref(card);
  f.h.load("client/option-session.ts").publishAssistantReply("a", { at: 20, text: reply });
  byId(f.h, tree, "option-question-1").props.onPress();
  assert.equal(card.style.height, undefined);
  assert.equal(scroller.style.overflowAnchor, "auto");
});

test("a rapid question switch starts from the currently rendered height", t => {
  const f = motionFixture(t);
  const animations = [];
  let naturalHeight = 300, renderedHeight = 300, active = false;
  const content = {
    getBoundingClientRect: () => ({ top: 120, left: 10, width: 380, height: 200 }),
    cloneNode: () => ({ style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ cancel() {} }) }),
    animate: () => ({ cancel() {} }),
  };
  const card = {
    style: {}, clientTop: 1, clientLeft: 1,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: card.style.height === "auto" ? naturalHeight : active ? renderedHeight : naturalHeight }),
    querySelector: () => content, appendChild() {},
    animate(keyframes) {
      active = true;
      const animation = { keyframes, cancel() { active = false; }, finished: new Promise(() => {}) };
      animations.push(animation);
      return animation;
    },
  };
  const initial = f.draw();
  byId(f.h, initial, "option-card").props.ref(card);
  byId(f.h, initial, "option-question-1").props.onPress();
  naturalHeight = 400;
  const second = f.draw();
  byId(f.h, second, "option-card").props.ref(card);
  renderedHeight = 350;
  byId(f.h, second, "option-question-0").props.onPress();
  naturalHeight = 300;
  f.draw();
  assert.equal(animations[1].keyframes[0].height, "350px");
});
