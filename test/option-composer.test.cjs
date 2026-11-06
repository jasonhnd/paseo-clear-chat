const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";

function fixture(t, { card = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = { HTMLInputElement: global.HTMLInputElement, HTMLTextAreaElement: global.HTMLTextAreaElement, document: global.document };
  class Input {
    constructor(value = "typed") { this._value = value; this.selectionStart = this.selectionEnd = value.length; this.listeners = new Set(); }
    get value() { return this._value; }
    set value(v) { this._value = v; }
    matches(selector) { return selector === "textarea, input"; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; this.onSelect?.(); }
    addEventListener(type, fn) { if (type === "input") this.listeners.add(fn); }
    removeEventListener(type, fn) { if (type === "input") this.listeners.delete(fn); }
    dispatchEvent(event) { this.onInput?.(event); for (const fn of [...this.listeners]) fn(event); return true; }
  }
  global.HTMLInputElement = Input;
  global.HTMLTextAreaElement = class extends Input {};
  let marked = new Input();
  const listeners = new Set();
  const doc = {
    querySelector: () => marked,
    addEventListener: (name, fn) => { if (name === "keydown") listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === "keydown") listeners.delete(fn); },
    execCommand: (_command, _ui, text) => { marked.value = text + marked.value; return true; },
  };
  global.document = doc;
  const agents = { a: { status: "idle" } };
  const h = createToolHarness("web", { agents, preferences: { showAnswerCard: true } });
  const store = h.load("client/option-session.ts");
  store.publishAssistantReply("a", { at: 10, text: reply });
  store.choose("a", 0, "A");
  let cleanup;
  let draw;
  if (card) {
    const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
    draw = () => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: reply } }, timestamp: new Date(10), theme: { colors: {} } } });
    draw();
  } else cleanup = h.load("client/option-composer.ts").installOptionComposer(doc, "a", 10);
  function key(options = {}) {
    const event = { key: "Enter", shiftKey: false, isComposing: false, altKey: false, defaultPrevented: false, target: marked, ...options };
    for (const fn of [...listeners]) fn(event);
    return event;
  }
  t.after(() => { cleanup?.(); h.unmount(); h.dispose(); Object.assign(global, previous); });
  return { h, store, agents, doc, key, draw, Input, listeners, get input() { return marked; }, set input(value) { marked = value; } };
}

test("prefix precedes typed and multiline text for Enter and Mod+Enter", t => {
  const f = fixture(t);
  f.input.value = "typed\nsecond line";
  f.store.setNote("a", 0, "note");
  assert.equal(f.key().defaultPrevented, false);
  assert.equal(f.input.value, "1A (note) typed\nsecond line");
  t.mock.timers.tick(300);
  assert.equal(f.input.value, "typed\nsecond line");
  f.key({ metaKey: true });
  assert.equal(f.input.value, "1A (note) typed\nsecond line");
  t.mock.timers.tick(300);
  f.key({ ctrlKey: true });
  assert.equal(f.input.value, "1A (note) typed\nsecond line");
});

test("skips unsupported keys, composition, empty and unrelated inputs, and missing choices", t => {
  const f = fixture(t);
  for (const options of [{ shiftKey: true }, { isComposing: true }, { key: "a" }, { target: new f.Input() }]) {
    assert.equal(f.key(options).defaultPrevented, false);
    assert.equal(f.input.value, "typed");
  }
  f.input.value = ""; f.key(); assert.equal(f.input.value, "");
  f.input.value = "typed"; f.store.clearChoice("a", 0); f.key(); assert.equal(f.input.value, "typed");
  f.store.choose("a", 0, "A"); f.store.publishAssistantReply("a", { at: 11, text: reply }); f.key(); assert.equal(f.input.value, "typed");
});

test("card setting, running status, user messages and unmount control the listener", t => {
  const f = fixture(t, { card: true });
  assert.equal(f.listeners.size, 1);
  f.h.preferences.showAnswerCard = false; f.h.unmount(); f.draw(); assert.equal(f.listeners.size, 0); f.key(); assert.equal(f.input.value, "typed");
  f.h.preferences.showAnswerCard = true; f.draw(); assert.equal(f.listeners.size, 1);
  f.agents.a.status = "running"; f.draw(); assert.equal(f.listeners.size, 0); f.key(); assert.equal(f.input.value, "typed");
  f.agents.a.status = "idle"; f.draw(); assert.equal(f.listeners.size, 1);
  f.store.publishUserMessage("a", 11); f.draw(); f.key(); assert.equal(f.input.value, "typed");
  f.h.unmount(); assert.equal(f.listeners.size, 0);
});

test("failed writes and failed value checks preserve the draft and key", t => {
  const f = fixture(t);
  f.doc.execCommand = () => false;
  f.input.onInput = () => { throw new Error("write rejected"); };
  assert.equal(f.key().defaultPrevented, false); assert.equal(f.input.value, "typed");
  f.input.onInput = undefined;
  f.doc.execCommand = () => { f.input.value = "wrong"; return true; };
  assert.equal(f.key().defaultPrevented, false); assert.equal(f.input.value, "typed");
});

test("timeout retains host edits and quick keys do not repeat the prefix", t => {
  const f = fixture(t);
  f.key(); f.key(); assert.equal(f.input.value, "1A typed");
  f.input.value += "\n";
  t.mock.timers.tick(299); assert.equal(f.input.value, "1A typed\n");
  t.mock.timers.tick(1); assert.equal(f.input.value, "typed\n");
  f.key(); f.input.value = ""; t.mock.timers.tick(300); assert.equal(f.input.value, "");
});

test("changed page structure leaves the draft and key alone", t => {
  const f = fixture(t);
  const original = f.input;
  f.input = null; assert.equal(f.key({ target: original }).defaultPrevented, false); assert.equal(original.value, "typed");
  f.input = { matches: () => false, querySelector: () => null, textContent: "typed" };
  assert.equal(f.key().defaultPrevented, false); assert.equal(f.input.textContent, "typed");
  f.input = original;
  const replacement = new f.Input("typed");
  original.onSelect = () => { f.input = replacement; };
  assert.equal(f.key().defaultPrevented, false);
  assert.equal(original.value, "typed"); assert.equal(replacement.value, "typed");
});

test("native setter fallback updates the host and removes a pending prefix", t => {
  const f = fixture(t);
  let inputs = 0;
  f.input.onInput = () => { inputs++; };
  f.doc.execCommand = () => false;
  f.key();
  assert.equal(f.input.value, "1A typed");
  assert.equal(inputs, 1);
  f.store.dismiss("a");
  f.key();
  assert.equal(f.input.value, "1A typed");
  t.mock.timers.tick(300);
  assert.equal(f.input.value, "typed");
  assert.equal(inputs, 2);
});

test("unmount removes the listener and restores a pending draft", t => {
  const f = fixture(t, { card: true });
  f.key(); assert.equal(f.input.value, "1A typed");
  f.h.unmount();
  assert.equal(f.input.value, "typed");
  assert.equal(f.listeners.size, 0);
  f.key(); assert.equal(f.input.value, "typed");
});


test("a new draft after a send is never mistaken for the old prefix", t => {
  const f = fixture(t);
  f.key();
  f.input.value = ""; f.input.dispatchEvent(new Event("input"));
  f.input.value = "1A new draft"; f.input.dispatchEvent(new Event("input"));
  t.mock.timers.tick(300);
  assert.equal(f.input.value, "1A new draft");
});
