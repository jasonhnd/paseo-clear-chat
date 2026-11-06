const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Choose?\nA One\nB Two (recommended)\n\n2) Next?\nA Yes\nB No\n\nReply with a letter for each.`;

function fixture(t) {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } }, deferEffects: true });
  const store = h.load("client/option-session.ts");
  const panels = h.load("client/components/option-panel.ts");
  store.publishAssistantReply("a", { at: 10, text: reply });
  const old = Object.fromEntries(["document", "window", "MutationObserver", "ResizeObserver", "HTMLInputElement", "HTMLTextAreaElement"].map(key => [key, global[key]]));
  const listeners = new Map(), mutations = [], resizes = [];
  let created = 0, throwMount = false;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.isConnected = true; this.value = ""; }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    matches(selector) { return selector === "[data-composer-input]" && this.marked === true; }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parent = this; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    attachShadow() { this.shadow = new Element("shadow"); this.shadow.activeElement = null; return this.shadow; }
    getRootNode() { return this.parent?.getRootNode() ?? this; }
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(type, fn) { (this.listeners ??= {})[type] = fn; }
    contains(node) { return node === this; }
    querySelector(selector) { const id = /data-testid="([^"]+)"/.exec(selector)?.[1]; return this.find(id); }
    find(id) { if (this.attrs["data-testid"] === id) return this; for (const child of this.children) { const found = child.find(id); if (found) return found; } }
    focus() { this.getRootNode().activeElement = this; }
    closest() { return null; }
    getBoundingClientRect() { if (this.throwRect) throw Error("position"); return this.rect; }
    getClientRects() { return [1]; }
  }
  global.HTMLInputElement = Element; global.HTMLTextAreaElement = Element;
  const body = new Element("body");
  global.document = { body, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, createElement(tag) { created++; if (throwMount) throw Error("mount"); return new Element(tag); } };
  global.window = { innerWidth: 900, innerHeight: 700, getComputedStyle: node => ({ display: node.hidden ? "none" : "block", visibility: "visible", opacity: "1" }),
    addEventListener(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  global.MutationObserver = class { constructor(fn) { this.fn = fn; mutations.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  global.ResizeObserver = class { constructor(fn) { this.fn = fn; resizes.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  const composer = new Element("textarea"); composer.marked = true; composer.rect = { left: 100, right: 500, top: 600, bottom: 650, width: 400, height: 50 };
  let current = composer, collapsed = false, fallback = 0, sends = 0, entered = false;
  const opts = { agentId: "a", at: 10, composer: () => current, tokens: () => h.tokens,
    t: (key, values) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}`, collapsed: () => collapsed,
    entered: () => entered, sendFocused: () => false, focusSend: () => {}, enter: () => { entered = true; },
    collapse: () => { collapsed = true; panel?.update(); }, reopen: () => { collapsed = false; panel?.update(); },
    send: () => { sends++; }, fallback: () => { fallback++; collapsed = false; } };
  let panel;
  const mount = () => panel = panels.mountOptionPanel(opts);
  t.after(() => { panels.removeOptionPanels(); h.unmount(); h.dispose(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete global[key]; else global[key] = value; } });
  return { h, store, panels, body, composer, listeners, mutations, resizes, mount,
    replace: value => { current = value; }, failMount: () => { throwMount = true; },
    get fallback() { return fallback; }, get created() { return created; }, get sends() { return sends; },
    get panel() { return panel; }, get collapsed() { return collapsed; } };
}

test("panel follows the composer and shares choices, notes, send and dismissal", t => {
  const f = fixture(t), panel = f.mount();
  assert.ok(panel); assert.equal(panel.host.style.left, "100px"); assert.equal(panel.host.style.width, "400px"); assert.equal(panel.host.style.bottom, "108px");
  const content = panel.host.shadow;
  assert.match(content.find("option-row-B").children.map(c => c.textContent).join(" "), /recommended/);
  content.find("option-row-B").onclick(); assert.equal(f.store.getOptionSession("a").choices[0], "B");
  content.find("option-note-toggle").onclick(); const note = content.find("option-note"); note.value = "details"; note.oninput(); assert.equal(f.store.getOptionSession("a").notes[0], "details");
  content.find("option-next").onclick(); content.find("option-row-A").onclick();
  assert.match(content.find("option-send").textContent, /1B/); content.find("option-send").onclick(); assert.equal(f.sends, 1);
  content.find("option-card-collapse").onclick(); assert.ok(content.find("option-panel-strip")); content.find("option-panel-strip").onclick(); assert.ok(content.find("option-row-A"));
  f.composer.rect.left = 120; f.composer.rect.right = 520; f.resizes[0].fn(); assert.equal(panel.host.style.left, "120px");
  content.find("option-dismiss").onclick(); assert.equal(f.store.getOptionSession("a"), null);
  panel.dispose(); assert.equal(f.body.children.length, 0); assert.equal(f.listeners.get("resize").size, 0); assert.equal(f.listeners.get("scroll").size, 0); assert.ok(f.mutations[0].disconnected); assert.ok(f.resizes[0].disconnected);
});

for (const [name, change] of [
  ["missing", f => f.replace(null)], ["zero size", f => { f.composer.rect.width = 0; }], ["hidden composer", f => { f.composer.hidden = true; }],
  ["off screen", f => { f.composer.rect.top = 20; }], ["position throws", f => { f.composer.throwRect = true; }],
  ["mount throws", f => f.failMount()], ["marker renamed", f => { f.composer.marked = false; }],
  ["marker moved to a wrapper", f => { f.composer.marked = false; }], ["non-input replacement", f => f.replace(null)],
]) test(`fallback on ${name} without retry`, t => {
  const f = fixture(t); change(f); assert.equal(f.mount(), null); assert.equal(f.fallback, 1); assert.equal(f.body.children.length, 0); const count = f.created; assert.equal(f.mount(), null); assert.equal(f.created, count);
});

for (const [name, change] of [["removed", f => { f.composer.isConnected = false; }], ["replaced", f => f.replace({})], ["wrapped", f => { f.composer.parentElement = {}; }], ["position throws later", f => { f.composer.throwRect = true; }]]) {
  test(`fallback when composer is ${name}`, t => {
    const f = fixture(t); assert.ok(f.mount()); change(f); f.mutations[0].fn(); assert.equal(f.fallback, 1); assert.equal(f.body.children.length, 0); assert.equal(f.listeners.get("resize").size, 0); const count = f.created; assert.equal(f.mount(), null); assert.equal(f.created, count);
  });
}


test("card and panel share collapse, typing and fallback", t => {
  const f = fixture(t), Card = f.h.load("client/components/option-card.tsx").OptionCard;
  const root = { getClientRects: () => [1], contains: () => false, querySelector: () => null };
  const chat = { getClientRects: () => [1], contains: node => node === root };
  root.parentElement = { parentElement: null, querySelectorAll: selector => selector.includes("agent-chat-scroll") ? [chat] : [f.composer] };
  const byId = (tree, id) => f.h.nodes(tree, node => node.props.testID === id)[0];
  const draw = () => {
    const tree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
    (byId(tree, "option-card") ?? byId(tree, "option-card-strip"))?.props.ref(root);
    return tree;
  };
  assert.ok(byId(draw(), "option-card")); f.h.flushEffects();
  assert.ok(byId(draw(), "option-card-strip")); f.h.flushEffects();
  assert.equal(f.body.children.length, 1);
  const key = (value, target, actual = target) => {
    const event = { key: value, target, composedPath: () => [actual, target], prevented: false, preventDefault() { this.prevented = true; } };
    for (const listener of f.listeners.get("keydown")) listener(event);
    return event.prevented;
  };
  assert.equal(key("ArrowUp", f.composer), true); draw(); f.h.flushEffects();
  const host = f.body.children[0];
  assert.equal(key("Escape", host, host.shadow.find("option-row-A")), true);
  draw(); f.h.flushEffects(); assert.ok(host.shadow.find("option-panel-strip"));
  host.shadow.find("option-panel-strip").onclick(); draw(); f.h.flushEffects();
  const prevented = key("x", f.composer);
  f.composer.value = "x";
  for (const listener of f.listeners.get("input")) listener({ target: f.composer });
  assert.equal(prevented, false); assert.equal(f.composer.getRootNode().activeElement, f.composer);
  draw(); f.h.flushEffects(); assert.ok(f.body.children[0].shadow.find("option-panel-strip"));
  f.composer.isConnected = false; f.mutations[0].fn();
  assert.ok(byId(draw(), "option-card")); f.h.flushEffects(); assert.equal(f.body.children.length, 0);
});
