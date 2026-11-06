const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Choose?
A One
B Two (recommended)

2) Next?
A Yes
B No

Reply with a letter for each.`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function fixture(t, platform = "web") {
  const listeners = new Map();
  const fakeWindow = {
    addEventListener(type, fn, capture) { assert.equal(capture, true); const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn, capture) { assert.equal(capture, true); listeners.get(type)?.delete(fn); },
    emit(type, event) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
  };
  const previous = global.window;
  global.window = fakeWindow;
  const h = createToolHarness(platform, { agents: { a: { status: "idle" } }, preferences: { showAnswerCard: true } });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const input = { tagName: "TEXTAREA", value: "", focus() { this.focused = true; }, getClientRects: () => [1] };
  const cardTarget = { closest: () => null };
  const sendButton = { closest: () => null, focus() { this.focused = true; } };
  const root = { getClientRects: () => [1], contains: node => node === cardTarget || node === sendButton,
    querySelector: () => sendButton };
  const chat = { getClientRects: () => [1], contains: node => node === root };
  root.parentElement = { parentElement: null, querySelectorAll(selector) { return selector.includes("agent-chat-scroll") ? [chat] : [input]; } };
  let tree;
  function draw() {
    tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    const node = byId(h, tree, "option-card") ?? byId(h, tree, "option-card-strip");
    node?.props.ref?.(root);
    return tree;
  }
  function key(value, attrs = {}) {
    const e = { key: value, target: input, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...attrs };
    fakeWindow.emit("keydown", e);
    return e.prevented;
  }
  draw();
  t.after(() => { h.unmount(); h.dispose(); if (previous === undefined) delete global.window; else global.window = previous; });
  return { h, s, input, root, cardTarget, sendButton, fakeWindow, listeners, draw, key, tree: () => tree };
}

test("entry, picks, bounded cursor and question navigation", t => {
  const f = fixture(t); const { s, key, draw, h } = f;
  assert.equal(key("a"), false);
  assert.equal(key("Enter"), false);
  assert.equal(key("ArrowDown", { ctrlKey: true }), false);
  assert.equal(key("ArrowUp", { isComposing: true }), false);
  assert.equal(key("ArrowUp"), true);
  assert.equal(s.getOptionSession("a").cursor[0], 1);
  assert.match(h.text(byId(h, draw(), "option-row-B")), /Enter/);
  assert.equal(key("ArrowDown"), true);
  assert.equal(s.getOptionSession("a").cursor[0], 1);
  key("ArrowUp"); key("ArrowUp");
  assert.equal(s.getOptionSession("a").cursor[0], 0);
  assert.equal(key("b"), true); assert.equal(s.getOptionSession("a").choices[0], "B");
  assert.equal(key("1"), true); assert.equal(s.getOptionSession("a").choices[0], "A");
  assert.equal(key("8"), false);
  key("ArrowDown");
  assert.equal(key("Tab"), true); assert.equal(s.getOptionSession("a").activeQuestion, 1);
  assert.equal(key("ArrowLeft"), true); assert.equal(s.getOptionSession("a").activeQuestion, 0);
  assert.equal(key("Tab", { shiftKey: true }), false);
  assert.equal(key("ArrowRight"), true); assert.equal(s.getOptionSession("a").activeQuestion, 1);
  assert.equal(key("Tab", { shiftKey: true }), true); assert.equal(s.getOptionSession("a").activeQuestion, 0);
});

test("Enter advances, checks every answer, and Tab focuses Send", t => {
  const { s, key, sendButton } = fixture(t); let sends = 0;
  s.setOptionSender(async () => { sends++; });
  key("ArrowDown"); key("Tab");
  key("Enter"); assert.equal(s.getOptionSession("a").choices[1], "A"); assert.equal(sends, 0);
  assert.equal(key("Tab"), true); assert.equal(sendButton.focused, true);
  assert.equal(key("Enter", { target: sendButton }), true); assert.equal(sends, 0);
  key("Tab", { shiftKey: true, target: sendButton });
  key("ArrowLeft", { target: sendButton });
  key("Enter", { target: sendButton });
  assert.equal(s.getOptionSession("a").choices[0], "B");
  key("Tab", { target: sendButton });
  key("Enter", { target: sendButton });
  assert.equal(sends, 1);
});

test("composer text, input events, other controls and Escape", t => {
  const { h, input, key, draw, fakeWindow, cardTarget } = fixture(t);
  key("ArrowDown");
  for (const attrs of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { isComposing: true }]) assert.equal(key("a", attrs), false);
  assert.equal(key("F1"), false);
  const note = { closest: () => ({}) };
  assert.equal(key("Enter", { target: note }), false);
  assert.equal(key("Escape"), true); assert.equal(input.focused, true);
  assert.ok(byId(h, draw(), "option-card-strip"));
  assert.equal(key("a"), false);
  key("ArrowDown");
  assert.equal(key(" "), false);
  assert.ok(byId(h, draw(), "option-card-strip"));
  key("ArrowUp"); input.value = "draft";
  assert.equal(key("ArrowDown"), false); assert.ok(byId(h, draw(), "option-card-strip"));
  input.value = ""; key("ArrowUp"); input.value = "pasted";
  fakeWindow.emit("input", { target: input });
  assert.ok(byId(h, draw(), "option-card-strip"));
  assert.equal(key("a", { target: cardTarget }), false);
});

test("pressing the composer exits keyboard state without collapsing or consuming choice keys", t => {
  const { h, s, input, cardTarget, sendButton, fakeWindow, draw, key } = fixture(t);
  for (const [choiceKey, shadow] of [["a", false], ["1", true]]) {
    let tree = draw();
    byId(h, tree, "option-card").props.onPointerDown({ target: cardTarget });
    byId(h, tree, "option-row-B").props.onPress();
    assert.equal(s.getOptionSession("a").choices[0], "B");
    byId(h, draw(), "option-send").props.onFocus();
    assert.equal(byId(h, draw(), "option-send").props.style.borderWidth, 2);
    fakeWindow.emit("pointerdown", shadow
      ? { target: {}, composedPath: () => [input] }
      : { target: input, composedPath: () => [input] });
    tree = draw();
    assert.ok(byId(h, tree, "option-card"));
    assert.equal(byId(h, tree, "option-send").props.style.borderWidth, 1);
    assert.doesNotMatch(h.text(byId(h, tree, "option-row-B")), /Enter/);
    const event = { key: choiceKey, target: input, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    fakeWindow.emit("keydown", event);
    assert.equal(event.prevented, false); assert.equal(event.stopped, false);
    assert.equal(s.getOptionSession("a").choices[0], "B");
    // Clear the choice so the next pointer selection exercises the same path.
    byId(h, tree, "option-row-B").props.onPress();
  }
  assert.equal(key("ArrowUp"), true);
  sendButton.focus();
  assert.equal(key("a"), true);
  assert.equal(s.getOptionSession("a").choices[0], "A");
});

test("presses outside the composer and programmatic focus preserve keyboard state", t => {
  const { h, s, input, cardTarget, fakeWindow, draw, key } = fixture(t);
  byId(h, draw(), "option-card").props.onPointerDown({ target: cardTarget });
  fakeWindow.emit("pointerdown", { target: cardTarget, composedPath: () => [cardTarget] });
  fakeWindow.emit("pointerdown", { target: {}, composedPath: () => [{}] });
  input.focus();
  assert.equal(key("b"), true);
  assert.equal(s.getOptionSession("a").choices[0], "B");
  assert.equal(key("Escape"), true);
  assert.ok(byId(h, draw(), "option-card-strip"));
  assert.equal(key("a"), false);
  assert.equal(s.getOptionSession("a").choices[0], "B");
});

test("click enters, hints are web-only and listeners follow lifecycle", t => {
  const f = fixture(t); const { h, draw, listeners, cardTarget, root } = f;
  assert.equal(listeners.get("keydown").size, 1);
  assert.equal(listeners.get("pointerdown").size, 1);
  let tree = draw(); draw(); assert.equal(listeners.get("keydown").size, 1);
  assert.ok(h.text(byId(h, tree, "option-key-hints")).includes("Tab next"));
  byId(h, tree, "option-card").props.onPointerDown({ target: cardTarget });
  tree = draw(); assert.match(h.text(byId(h, tree, "option-row-B")), /Enter/);
  h.dispose(); assert.equal(listeners.get("keydown").size, 0); assert.equal(listeners.get("input").size, 0); assert.equal(listeners.get("pointerdown").size, 0);
  h.unmount();
  const native = fixture(t, "ios");
  assert.equal(native.listeners.get("keydown"), undefined);
  assert.equal(byId(native.h, native.draw(), "option-key-hints"), undefined);
});

test("listeners are removed when the card is removed or unmounted", t => {
  const { h, s, draw, listeners } = fixture(t);
  s.dismiss("a"); draw(); assert.equal(listeners.get("keydown").size, 0); assert.equal(listeners.get("pointerdown").size, 0);
  h.unmount(); assert.equal(listeners.get("input").size, 0);
});

test("the disabled setting installs no listener, and removing the card cleans up", t => {
  const listeners = new Set();
  const previous = global.window;
  global.window = {
    addEventListener(type, listener) { if (type === "keydown") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "keydown") listeners.delete(listener); },
  };
  const h = createToolHarness("web", { agents: { a: { status: "idle" } }, preferences: { showAnswerCard: false } });
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const draw = () => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: reply } }, timestamp: new Date(10), theme: { colors: {} } } });
  t.after(() => { h.unmount(); h.dispose(); if (previous === undefined) delete global.window; else global.window = previous; });
  draw(); assert.equal(listeners.size, 0);
  h.preferences.showAnswerCard = true; draw(); assert.equal(listeners.size, 1);
  // The harness explicitly unmounts the removed subtree when the setting changes.
  h.unmount(); h.preferences.showAnswerCard = false; draw(); assert.equal(listeners.size, 0);
});


test("keyboard choosing survives a renamed composer marker", t => {
  const { root, input, key, s } = fixture(t);
  const chat = { getClientRects: () => [1], contains: node => node === root };
  root.parentElement.querySelectorAll = selector => selector.includes("agent-chat-scroll") ? [chat] : selector.includes("data-composer-input") ? [] : [input];
  assert.equal(key("ArrowUp"), true);
  assert.equal(key("a"), true);
  assert.equal(s.getOptionSession("a").choices[0], "A");
});
