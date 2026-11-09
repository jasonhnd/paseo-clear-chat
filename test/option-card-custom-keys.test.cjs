const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) First?\nA One\nB Two\nC Three\nD Four\n\n2) Second?\nA One\nB Two\nC Three\nD Four\n\n3) Third?\nA One\nB Two\nC Three\nD Four\n\nReply: A`;
const byId = (h, tree, id) => h.nodes(tree, n => n.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(t, text = reply, width = 390) {
  const agents = { a: { status: "idle" } };
  const h = createToolHarness("web", { width, agents });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text });
  let active = null;
  let inputListener;
  const inputNode = new EventTarget();
  const add = inputNode.addEventListener.bind(inputNode);
  const remove = inputNode.removeEventListener.bind(inputNode);
  inputNode.addEventListener = (type, listener, ...args) => { if (type === "keydown") inputListener = listener; add(type, listener, ...args); };
  inputNode.removeEventListener = (type, listener, ...args) => { if (type === "keydown" && inputListener === listener) inputListener = undefined; remove(type, listener, ...args); };
  let inputRef, mounted = false;
  t.after(() => { if (mounted) inputRef(null); });
  const draw = () => {
    const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    byId(h, tree, "option-card")?.props.ref({ querySelector: selector => ({ focus: () => { active = selector.match(/"([^"]+)"/)[1]; } }) });
    const input = byId(h, tree, "option-custom-input");
    if (input && !mounted) { inputRef = input.props.ref; inputRef(inputNode); mounted = true; }
    else if (!input && mounted) { inputRef(null); mounted = false; }
    return tree;
  };
  const press = id => byId(h, draw(), id).props.onPress();
  const change = value => byId(h, draw(), "option-custom-input").props.onChangeText(value);
  const key = (key, id = "option-card", extra = {}) => {
    let prevented = false, stopped = false;
    const target = { getAttribute: () => id, closest: selector => selector === '[data-testid="option-custom-input"]' && id === "custom-input-child" ? { getAttribute: () => "option-custom-input" } : selector === "input, textarea" && (id === "option-custom-input" || id === "normal-input") ? {} : selector.startsWith('[data-testid^="option-row-"]') && id.startsWith("option-row-") ? {} : null };
    byId(h, draw(), "option-card").props.onKeyDown({ key, target, nativeEvent: {}, ...extra, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    return { prevented, stopped };
  };
  const inputKey = (key, extra = {}) => {
    let prevented = 0, stopped = 0, cardCalls = 0;
    const target = { getAttribute: () => "option-custom-input", closest: () => ({}) };
    const event = { key, target, nativeEvent: {}, ...extra, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
    const tree = draw();
    assert.equal(byId(h, tree, "option-custom-input").props.onKeyDown, undefined);
    assert.equal(typeof inputListener, "function");
    inputListener(event);
    if (!stopped) { cardCalls++; byId(h, tree, "option-card").props.onKeyDown({ ...event, nativeEvent: event.nativeEvent ?? event }); }
    return { prevented, stopped, cardCalls };
  };
  return { h, s, agents, draw, press, change, key, inputKey, inputNode, getInputRef: () => inputRef, active: () => active };
}

// The harness leaves Pressable as a host node. Give the tab a real event target
// and model react-native-web's Enter activation for role=tab.
function dispatchTabKey(f, index, key) {
  const tree = f.draw();
  const tab = byId(f.h, tree, `option-question-${index}`);
  const element = new EventTarget();
  element.getAttribute = name => name === "data-testid" ? tab.props.testID : null;
  element.closest = () => null;
  element.addEventListener("keydown", event => {
    tab.props.onKeyDown?.(event);
    if (!event.defaultPrevented && event.key === "Enter") tab.props.onPress();
    byId(f.h, tree, "option-card").props.onKeyDown(event);
  });
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, { key, nativeEvent: { isComposing: false } });
  element.dispatchEvent(event);
  return event;
}

function assertReadOnlyView(f, selected) {
  const tree = f.draw();
  const expected = ["✓ Two", "✓ custom an…", "✓ One"];
  for (let i = 0; i < 3; i++) {
    const tab = byId(f.h, tree, `option-question-${i}`);
    assert.equal(tab.props.accessibilityRole, "tab");
    assert.equal(tab.props.focusable, true);
    assert.equal(tab.props.accessibilityState.selected, i === selected);
    assert.equal(tab.props.style.backgroundColor, i === selected ? f.h.tokens.surface2 : "transparent");
    assert.equal(f.h.text(tab), expected[i]);
  }
  const row = byId(f.h, tree, selected === 0 ? "option-row-B" : selected === 1 ? "option-row-E" : "option-row-A");
  assert.match(f.h.text(row), /✓/);
  if (selected === 1) assert.match(f.h.text(row), /custom answer\nsecond line/);
  assert.equal(byId(f.h, tree, "option-send"), undefined);
  assert.equal(byId(f.h, tree, "option-custom-input"), undefined);
}

test("read-only tabs respond to dispatched Enter and Space without changing the sent answer", async t => {
  const f = fixture(t); const sent = [];
  f.press("option-row-B"); f.press("option-row-E"); f.change("custom answer\nsecond line");
  f.inputKey("Enter"); f.press("option-row-A");
  f.s.setOptionSender(async (_agent, text) => sent.push(text));
  f.press("option-send"); await tick();
  const before = structuredClone(f.s.getOptionSession("a", 10));
  assert.equal(before.readOnly, true);
  assert.equal(sent.length, 1);
  dispatchTabKey(f, 0, "Enter"); assertReadOnlyView(f, 0);
  const space = dispatchTabKey(f, 1, " ");
  assert.equal(space.defaultPrevented, true); assertReadOnlyView(f, 1);
  dispatchTabKey(f, 2, "Enter"); assertReadOnlyView(f, 2);
  assert.deepEqual(f.s.getOptionSession("a", 10), before);
  assert.deepEqual(sent, [before.answeredText]);
});

test("a mounted replay shows the checked answers and full custom text for each question", t => {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishUserMessage("a", 20, "1B 2E 3A\n\n2E：\ncustom answer\nsecond line");
  s.publishAssistantReply("a", { at: 10, text: reply });
  const f = { h, s, draw: () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } }) };
  assertReadOnlyView(f, 0);
  dispatchTabKey(f, 1, " "); assertReadOnlyView(f, 1);
  dispatchTabKey(f, 2, " "); assertReadOnlyView(f, 2);
});

test("custom row click and synthetic letters open and focus the input", async t => {
  for (const [letters, shortcut] of [["ABCD", "E"], ["ACE", "F"], ["ABH", "I"]]) {
    for (const key of [shortcut, shortcut.toLowerCase()]) {
      const f = fixture(t, `Pick?\n${[...letters].map(x => `${x} Option ${x}`).join("\n")}\n\nReply: A`);
      f.key(key); await tick();
      assert.ok(byId(f.h, f.draw(), "option-custom-input"));
      assert.equal(f.active(), "option-custom-input");
      assert.equal(f.s.getOptionSession("a").choices[0], undefined);
    }
  }
  const f = fixture(t); f.press("option-row-E"); await tick();
  assert.equal(f.active(), "option-custom-input");
});

test("text fields keep letters, digits, space and arrow keys for editing", t => {
  const f = fixture(t);
  for (const key of ["a", "b", "c"]) assert.equal(f.key(key, "normal-input").prevented, false);
  assert.deepEqual(f.s.getOptionSession("a").choices, {});
  f.press("option-row-E");
  for (const key of ["a", "b", "c", "1", " ", "ArrowUp", "ArrowDown"]) assert.equal(f.key(key, "option-custom-input").prevented, false);
  f.change("abc1 ");
  assert.equal(f.s.getOptionSession("a").customDrafts[0], "abc1 ");
  assert.deepEqual(f.s.getOptionSession("a").choices, {});
});

test("confirmation advances, wraps to unanswered questions and focuses Send without sending", async t => {
  const f = fixture(t); let sent = 0;
  f.s.setOptionSender(async () => { sent++; });
  f.press("option-question-2"); f.press("option-row-E"); f.change("third"); f.inputKey("Enter");
  await tick(); assert.equal(f.s.getOptionSession("a").activeQuestion, 0); assert.equal(f.active(), "option-row-A");
  f.press("option-row-B"); f.press("option-row-E"); f.change("second"); f.inputKey("Enter");
  await tick(); assert.equal(f.active(), "option-send"); assert.equal(sent, 0);
  assert.equal(f.h.text(byId(f.h, f.draw(), "option-send")), "Send 1B 2E 3E");
  f.press("option-send"); await tick(); assert.equal(sent, 1);
});

test("blank Enter prevents insertion, leaves the question missing and shows feedback", async t => {
  for (const value of ["", "   ", "\t", "\n\n"]) {
    const f = fixture(t); f.press("option-row-E"); await tick(); f.change(value);
    const event = f.inputKey("Enter");
    assert.equal(event.prevented, 1); assert.equal(f.s.getOptionSession("a").customDrafts[0] ?? "", value);
    assert.equal(f.s.getOptionSession("a").choices[0], undefined); assert.equal(f.active(), "option-custom-input");
    assert.equal(f.h.text(byId(f.h, f.draw(), "option-custom-empty")), "Write your answer first");
    assert.match(f.h.text(byId(f.h, f.draw(), "option-send")), /1/);
  }
});

test("Shift+Enter and composing Enter do not confirm, but a later Enter does", t => {
  const f = fixture(t); f.press("option-row-E"); f.change("first");
  assert.equal(f.inputKey("Enter", { shiftKey: true }).prevented, 0);
  f.change("first\nsecond");
  assert.equal(f.inputKey("Enter", { isComposing: true }).prevented, 0);
  assert.equal(f.s.getOptionSession("a").choices[0], undefined);
  assert.equal(f.s.getOptionSession("a").customDrafts[0], "first\nsecond");
  f.inputKey("Enter");
  assert.equal(f.s.getOptionSession("a").customConfirmed[0], "first\nsecond");
  assert.equal(f.s.getOptionSession("a").activeQuestion, 1);
});

test("editing invalidates confirmation, unchanged reconfirmation stays, and switching preserves the draft", async t => {
  const f = fixture(t); f.press("option-row-E"); f.change("original"); f.inputKey("Enter");
  f.press("option-question-0"); f.inputKey("Enter");
  assert.equal(f.s.getOptionSession("a").activeQuestion, 0);
  f.change(""); assert.equal(f.s.getOptionSession("a").choices[0], undefined);
  f.change("changed"); f.inputKey("Enter");
  assert.equal(f.s.getOptionSession("a").customConfirmed[0], "changed");
  f.press("option-question-0"); f.press("option-row-B");
  assert.equal(f.s.getOptionSession("a").customDrafts[0], "changed");
  f.press("option-question-1"); f.press("option-row-A"); f.press("option-row-A");
  let sent; f.s.setOptionSender(async (_, text) => { sent = text; }); f.press("option-send"); await tick();
  assert.equal(sent, "1B 2A 3A");
  const g = fixture(t); g.press("option-row-E"); g.change("draft"); g.inputKey("Enter");
  g.press("option-question-0"); g.press("option-row-B"); g.press("option-row-E");
  assert.equal(g.s.getOptionSession("a").customDrafts[0], "draft"); assert.equal(g.s.getOptionSession("a").choices[0], undefined);
  g.inputKey("Enter"); assert.equal(g.s.getOptionSession("a").customConfirmed[0], "draft");
});

test("shortcuts ignore modifiers, composition, unavailable letters, sending and running", t => {
  const f = fixture(t);
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { nativeEvent: { isComposing: true } }]) assert.equal(f.key("e", "option-card", extra).prevented, false);
  assert.equal(f.key("z").prevented, false); assert.equal(f.key("i").prevented, false);
  assert.equal(byId(f.h, f.draw(), "option-custom-input"), undefined);
  f.press("option-row-A"); f.press("option-row-A"); f.press("option-row-A");
  f.s.setOptionSender(() => new Promise(() => {})); f.press("option-send");
  assert.equal(f.key("e").prevented, false);
  f.agents.a.status = "running"; assert.equal(f.draw(), null);
});

test("ordinary A through H shortcuts still select the corresponding options", t => {
  for (const letter of "ABCDEFGH") {
    const f = fixture(t, `Pick?\n${[..."ABCDEFGH"].map(x => `${x} Option ${x}`).join("\n")}\n\nReply: A`);
    assert.equal(f.key(letter.toLowerCase()).prevented, true); assert.equal(f.s.getOptionSession("a").choices[0], letter);
  }
});

test("the custom editing key hint appears only before confirmation", t => {
  const f = fixture(t); const hint = () => f.h.text(byId(f.h, f.draw(), "option-hint"));
  const ordinary = hint(); f.press("option-row-E"); assert.equal(hint(), "Enter · Write your own answer");
  f.change("answer"); f.inputKey("Enter"); f.press("option-question-0"); assert.equal(hint(), ordinary);
  f.change("edited"); assert.equal(hint(), "Enter · Write your own answer");
  f.press("option-row-A"); assert.equal(hint(), ordinary);
});

test("phone input has at least a 44px minimum while desktop keeps 36px", t => {
  for (const [width, min] of [[390, 44], [1440, 36]]) {
    const f = fixture(t, reply, width); f.press("option-row-E");
    const input = byId(f.h, f.draw(), "option-custom-input");
    assert.equal(input.props.style[0].minHeight, min);
    assert.equal(input.props.style[0].fontSize, f.h.tokens.fs(width <= 390 ? 16 : 13));
    const row = byId(f.h, f.draw(), "option-row-E");
    assert.ok(f.h.nodes(row, n => n.type === "View" && n.props.style?.minWidth === 0).length);
  }
});


test("input Enter confirms once and focuses the next unanswered control or Send", async t => {
  const f = fixture(t); f.press("option-row-E"); f.change("first");
  f.s.moveCursor("a", 1, 1);
  const confirm = f.s.confirmCustom; let confirmations = 0;
  f.s.confirmCustom = (...args) => { confirmations++; return confirm(...args); };
  assert.deepEqual(f.inputKey("Enter"), { prevented: 1, stopped: 1, cardCalls: 0 });
  assert.equal(confirmations, 1);
  await tick();
  assert.equal(f.s.getOptionSession("a").customConfirmed[0], "first");
  assert.equal(f.s.getOptionSession("a").activeQuestion, 1);
  assert.equal(f.active(), "option-row-B");
  f.press("option-row-A"); f.press("option-row-E"); f.change("third");
  assert.deepEqual(f.inputKey("Enter"), { prevented: 1, stopped: 1, cardCalls: 0 });
  await tick(); assert.equal(f.active(), "option-send");
  f.press("option-question-2");
  assert.deepEqual(f.inputKey("Enter"), { prevented: 1, stopped: 1, cardCalls: 0 });
  await tick(); assert.equal(f.s.getOptionSession("a").activeQuestion, 2);
});

test("the card handler ignores Enter from the custom input and its descendants", t => {
  const f = fixture(t); f.press("option-row-E"); f.change("first");
  for (const id of ["option-custom-input", "custom-input-child"]) {
    assert.deepEqual(f.key("Enter", id), { prevented: false, stopped: false });
  }
  assert.deepEqual(f.s.getOptionSession("a").choices, {});
  assert.equal(f.s.getOptionSession("a").customConfirmed[0], undefined);
});

test("input blank Enter keeps the draft and focus and shows the hint", async t => {
  for (const value of ["", "   ", "\t"]) {
    const f = fixture(t); f.press("option-row-E"); await tick(); f.change(value);
    assert.deepEqual(f.inputKey("Enter"), { prevented: 1, stopped: 1, cardCalls: 0 });
    assert.equal(f.s.getOptionSession("a").customDrafts[0] ?? "", value);
    assert.equal(f.s.getOptionSession("a").choices[0], undefined);
    assert.equal(f.s.getOptionSession("a").activeQuestion, 0);
    assert.equal(f.active(), "option-custom-input");
    assert.equal(f.h.text(byId(f.h, f.draw(), "option-custom-empty")), "Write your answer first");
  }
});

test("input leaves typing, Shift+Enter and composition to the input", t => {
  const f = fixture(t); f.press("option-row-E");
  for (const key of ["a", "b", "c"]) {
    assert.equal(f.inputKey(key).prevented, 0);
  }
  f.change("abc");
  assert.equal(f.inputKey("Enter", { shiftKey: true }).prevented, 0);
  f.change("abc\n");
  assert.equal(f.inputKey("Enter", { nativeEvent: undefined, isComposing: true }).prevented, 0);
  assert.equal(f.s.getOptionSession("a").customDrafts[0], "abc\n");
  assert.deepEqual(f.s.getOptionSession("a").choices, {});
});

test("native input listener handles dispatched Enter and is removed when the node changes", async t => {
  const f = fixture(t); f.press("option-row-E"); f.change("first"); f.draw();
  if (typeof f.inputNode.addEventListener !== "function" || typeof f.inputNode.dispatchEvent !== "function") return;
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "Enter", isComposing: false });
  f.inputNode.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.s.getOptionSession("a").customConfirmed[0], "first");
  await tick(); assert.equal(f.active(), "option-row-A");
  const ref = f.getInputRef();
  const replacement = new EventTarget();
  ref(replacement);
  const oldEvent = new Event("keydown", { cancelable: true });
  Object.assign(oldEvent, { key: "Enter" });
  f.inputNode.dispatchEvent(oldEvent);
  assert.equal(oldEvent.defaultPrevented, false);
  ref(null);
  const detachedEvent = new Event("keydown", { cancelable: true });
  Object.assign(detachedEvent, { key: "Enter" });
  replacement.dispatchEvent(detachedEvent);
  assert.equal(detachedEvent.defaultPrevented, false);
});

test("phone custom input uses a 16px font without losing the touch target or flexible column", t => {
  for (const [width, expected] of [[390, 16], [391, 13], [1440, 13]]) {
    const f = fixture(t, reply, width);
    f.press("option-row-E");
    const tree = f.draw();
    const input = byId(f.h, tree, "option-custom-input");
    assert.equal(input.props.style[0].fontSize, f.h.tokens.fs(expected), `font at ${width}px`);
    if (width === 390) assert.ok(input.props.style[0].minHeight >= 44);
    const row = byId(f.h, tree, "option-row-E");
    assert.ok(f.h.nodes(row, node => node.type === "View" && node.props.style?.flex === 1 && node.props.style?.minWidth === 0).length);
  }
});

test("custom confirmation focuses the saved cursor in the next unanswered question, then Send", async t => {
  const f = fixture(t);
  let sent = 0;
  f.s.setOptionSender(async () => { sent++; });
  f.s.moveCursor("a", 1, 2);
  f.press("option-row-E"); f.change("first");
  assert.equal(f.inputKey("Enter").prevented, 1);
  await tick();
  assert.equal(f.s.getOptionSession("a").activeQuestion, 1);
  assert.equal(f.active(), "option-row-C");
  f.press("option-question-2");
  f.s.moveCursor("a", 1, -1);
  f.press("option-row-E"); f.change("third"); f.inputKey("Enter");
  await tick();
  assert.equal(f.s.getOptionSession("a").activeQuestion, 1);
  assert.equal(f.active(), "option-row-B");
  f.press("option-row-E"); f.change("second"); f.inputKey("Enter");
  await tick();
  assert.equal(f.active(), "option-send");
  assert.equal(sent, 0);
  assert.equal(f.h.text(byId(f.h, f.draw(), "option-send-preview")), "1E 2E 3E\n\n1E：\nfirst\n\n2E：\nsecond\n\n3E：\nthird");
});
