const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Choose?\nA One\nB Two (recommended)\n\n2) Next?\nA Yes\nB No\n\nReply with a letter for each.`;

function fixture(t) {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } }, deferEffects: true, themeTokens: true });
  const store = h.load("client/option-session.ts");
  const panels = h.load("client/components/option-panel.ts");
  store.publishAssistantReply("a", { at: 10, text: reply });
  const old = Object.fromEntries(["document", "window", "MutationObserver", "ResizeObserver", "HTMLInputElement", "HTMLTextAreaElement"].map(key => [key, global[key]]));
  const listeners = new Map(), mutations = [], resizes = [];
  let created = 0, throwMount = false;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.isConnected = true; this.value = ""; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 100; }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    matches(selector) {
      if (selector === "[data-composer-input]") return this.marked === true;
      if (selector === '[data-testid="message-input-root"]') return this.attrs["data-testid"] === "message-input-root";
      return false;
    }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) { node.parent = this; node.parentElement = this; } }
    replaceChildren(...nodes) { for (const child of this.children) { child.parent = null; child.parentElement = null; } this.children = []; this.append(...nodes); }
    attachShadow() { this.shadow = new Element("shadow"); this.shadow.activeElement = null; return this.shadow; }
    getRootNode() { return this.parent?.getRootNode() ?? this; }
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(type, fn) { (this.listeners ??= {})[type] = fn; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelector(selector) { const id = /data-testid="([^"]+)"/.exec(selector)?.[1]; return this.find(id); }
    find(id) { if (this.attrs["data-testid"] === id) return this; for (const child of this.children) { const found = child.find(id); if (found) return found; } return null; }
    focus() { this.getRootNode().activeElement = this; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
      const result = [];
      const visit = node => {
        if (selector === '[data-testid="agent-chat-scroll"]' && node.attrs["data-testid"] === "agent-chat-scroll") result.push(node);
        if (selector === 'button, [role="button"]' && (node.tagName === "BUTTON" || node.attrs.role === "button")) result.push(node);
        for (const child of node.children) visit(child);
      };
      for (const child of this.children) visit(child);
      return result;
    }
    getBoundingClientRect() { if (this.throwRect) throw Error("position"); return this.rect; }
    getClientRects() { return this.hidden ? [] : [1]; }
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
  let current = composer, collapsed = false, fallback = 0, sends = 0, entered = false, translate = (key, values) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}`;
  const opts = { agentId: "a", at: 10, composer: () => current, tokens: () => h.tokens,
    t: (key, values) => translate(key, values), collapsed: () => collapsed,
    entered: () => entered, sendFocused: () => false, focusSend: () => {}, enter: () => { if (!entered) { entered = true; panel?.update(); } },
    collapse: () => { collapsed = true; panel?.update(); }, reopen: () => { collapsed = false; panel?.update(); },
    send: () => { sends++; }, fallback: () => { fallback++; collapsed = false; } };
  let panel;
  const mount = () => panel = panels.mountOptionPanel(opts);
  t.after(() => { panels.removeOptionPanels(); h.unmount(); h.dispose(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete global[key]; else global[key] = value; } });
  return { h, store, panels, body, composer, listeners, mutations, resizes, mount, element: tag => new Element(tag),
    replace: value => { current = value; }, translate: value => { translate = value; }, failMount: () => { throwMount = true; },
    get fallback() { return fallback; }, get created() { return created; }, get sends() { return sends; },
    get panel() { return panel; }, get collapsed() { return collapsed; } };
}

test("pointer press keeps the button through click and redraws after release", t => {
  const f = fixture(t), panel = f.mount(), host = panel.host;
  const button = host.shadow.find("option-row-B");
  host.listeners.pointerdown({ composedPath: () => [button] });
  assert.equal(host.shadow.find("option-row-B"), button);
  for (const listener of f.listeners.get("pointerup")) listener({});
  assert.equal(host.shadow.find("option-row-B"), button);
  button.onclick();
  assert.equal(host.shadow.find("option-row-B"), button);
  host.listeners.click({ detail: 1 });
  assert.equal(f.store.getOptionSession("a").choices[0], "B");
  assert.notEqual(host.shadow.find("option-row-B"), button);
  assert.equal(host.shadow.find("option-row-B").getAttribute("aria-pressed"), "true");
});

test("pointer cancellation, timeout and keyboard clicks preserve redraw behavior", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), panel = f.mount(), host = panel.host;
  let button = host.shadow.find("option-row-A");
  host.listeners.pointerdown({ composedPath: () => [button] });
  host.listeners.click({ detail: 0 });
  panel.update();
  assert.equal(host.shadow.find("option-row-A"), button);
  for (const listener of f.listeners.get("pointercancel")) listener({});
  assert.notEqual(host.shadow.find("option-row-A"), button);
  button = host.shadow.find("option-row-A");
  host.listeners.pointerdown({ composedPath: () => [button] });
  panel.update();
  t.mock.timers.tick(999);
  assert.equal(host.shadow.find("option-row-A"), button);
  t.mock.timers.tick(1);
  assert.notEqual(host.shadow.find("option-row-A"), button);
  button = host.shadow.find("option-row-A");
  panel.update();
  assert.notEqual(host.shadow.find("option-row-A"), button);
  button = host.shadow.find("option-row-A");
  host.listeners.pointerdown({ composedPath: () => [button] });
  panel.update();
  for (const listener of f.listeners.get("pointerup")) listener({});
  assert.equal(host.shadow.find("option-row-A"), button);
  t.mock.timers.tick(0);
  assert.notEqual(host.shadow.find("option-row-A"), button);
});

function page(f, { pill = true, inputRoot = true, other = false, language = false } = {}) {
  window.innerHeight = 900; window.innerWidth = 1280;
  f.composer.rect = { left: 100, right: 500, top: 785, bottom: 835, width: 400, height: 50 };
  const pane = f.element("div"), chat = f.element("div"), root = f.element("div"), row = f.element("div");
  chat.setAttribute("data-testid", "agent-chat-scroll");
  root.rect = { top: 768, bottom: 850, height: 82 };
  if (inputRoot) root.setAttribute("data-testid", "message-input-root");
  root.append(f.composer); pane.append(chat, row, root);
  if (language) f.translate((key, values) => key === "answerCard.openQuestions" ? `質問: ${values.count}` : key);
  let pillButton;
  if (pill) {
    pillButton = f.element("div"); pillButton.setAttribute("role", "button");
    pillButton.textContent = language ? "質問: 2" : 'answerCard.openQuestions {"count":2}';
    pillButton.rect = { top: 726, bottom: 758, height: 32 }; row.append(pillButton);
  }
  if (other) {
    const button = f.element("button"); button.rect = { top: 720, bottom: 756, height: 36 }; row.append(button);
  }
  return { pane, root, pillButton };
}

for (const [name, setup, top] of [
  ["pill row", {}, 726], ["no pill", { pill: false }, 768],
  ["no input root or pill", { pill: false, inputRoot: false }, 785],
  ["another button in the row", { other: true }, 720],
  ["translated pill", { language: true }, 726],
]) test(`panel anchors above ${name}`, t => {
  const f = fixture(t), pageElements = page(f, setup), panel = f.mount();
  assert.equal(panel.host.style.bottom, `${900 - top + 8}px`);
  if (pageElements.pillButton) assert.ok(900 - parseFloat(panel.host.style.bottom) < pageElements.pillButton.rect.top);
  panel.host.shadow.find("option-card-collapse").onclick();
  assert.ok(panel.host.shadow.find("option-panel-strip"));
  assert.equal(panel.host.style.bottom, `${900 - top + 8}px`);
});

test("panel falls back when there is not enough room above the input root", t => {
  const f = fixture(t), parent = f.element("div");
  parent.setAttribute("data-testid", "message-input-root"); parent.rect = { top: 51, height: 100 }; parent.append(f.composer);
  assert.equal(f.mount(), null);
  assert.equal(f.fallback, 1);
});

test("send row stays outside the scrolling content and header wraps", t => {
  const f = fixture(t), panel = f.mount(), shadow = panel.host.shadow;
  const row = shadow.find("option-send-row"), scroll = shadow.find("option-panel-scroll"), styles = shadow.children.find(child => child.tagName === "STYLE").textContent;
  assert.equal(row.parent, scroll.parent); assert.equal(scroll.parent.children.at(-1), row);
  assert.equal(scroll.contains(row), false); assert.equal(row.style.background, shadow.children.find(child => child.className === "panel").style.background);
  assert.ok(row.contains(shadow.find("option-send")));
  for (const id of ["option-question-0", "option-row-A", "option-row-B", "option-note-toggle", "option-next", "option-dismiss", "option-key-hints"]) assert.ok(scroll.contains(shadow.find(id)), id);
  assert.match(styles, /\.panel\{[^}]*overflow:hidden/);
  assert.match(styles, /\.scroller\{[^}]*overflow:auto;min-height:0/);
  assert.match(styles, /\.send-row\{[^}]*flex-shrink:0/);
  assert.match(styles, /\.send-row\{padding:8px 0 12px;flex-shrink:0\}/);
  assert.match(styles, /\.header\{flex-wrap:wrap\}/);
  assert.match(styles, /\.strip\{white-space:normal/);
  shadow.find("option-card-collapse").onclick();
  assert.ok(shadow.find("option-panel-strip")); assert.equal(shadow.find("option-panel-scroll"), null); assert.equal(shadow.find("option-send-row"), null);
});

test("redraw preserves and clamps scroll position, and changing questions resets it", t => {
  const f = fixture(t), panel = f.mount(), shadow = panel.host.shadow;
  shadow.find("option-panel-scroll").scrollTop = 350;
  shadow.find("option-row-B").onclick();
  assert.equal(shadow.find("option-panel-scroll").scrollTop, 350);
  shadow.find("option-panel-scroll").scrollTop = 1200;
  panel.update();
  assert.equal(shadow.find("option-panel-scroll").scrollTop, 900);
  shadow.find("option-next").onclick();
  assert.equal(shadow.find("option-panel-scroll").scrollTop, 0);
  shadow.find("option-panel-scroll").scrollTop = 300;
  shadow.find("option-question-0").onclick();
  assert.equal(shadow.find("option-panel-scroll").scrollTop, 0);
});

for (const theme of [
  { name: "dark", isDark: true, surface0: "#102030", surface1: "rgba(255, 255, 255, 0.2)", surface2: "#ff000080", success: "rgba(0, 255, 0, 0.5)", panel: [63.8, 76.6, 89.4], disabled: [135.9686, 15.9373, 23.9059], enabled: [8, 143.5, 24] },
  { name: "light", isDark: false, surface0: "#e0d0c0", surface1: "rgba(0, 0, 0, 0.1)", surface2: "rgba(0, 0, 255, 0.25)", success: "#00ff0080", panel: [201.6, 187.2, 172.8], disabled: [168, 156, 207.75], enabled: [111.5608, 231.5922, 95.6235] },
]) test(`panel and send backgrounds are opaque and composited in the ${theme.name} theme`, t => {
  const f = fixture(t);
  Object.assign(f.h.tokens, theme);
  const shadow = f.mount().host.shadow;
  const check = (actual, expected) => {
    const match = /^rgb\(([^)]+)\)$/.exec(actual);
    assert.ok(match, `expected an opaque rgb colour, got ${actual}`);
    const channels = match[1].split(",").map(Number);
    assert.equal(channels.length, 3);
    channels.forEach((channel, i) => assert.ok(Math.abs(channel - expected[i]) < 0.001, `${actual} channel ${i}`));
  };
  check(shadow.children.find(child => child.className === "panel").style.background, theme.panel);
  check(shadow.find("option-send-row").style.background, theme.panel);
  assert.equal(shadow.find("option-send").getAttribute("aria-disabled"), "true");
  check(shadow.find("option-send").style.background, theme.disabled);
  f.store.choose("a", 0, "A"); f.store.choose("a", 1, "A");
  assert.equal(shadow.find("option-send").getAttribute("aria-disabled"), "false");
  check(shadow.find("option-send").style.background, theme.enabled);
});

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
]) test(`mount-time fallback on ${name} can retry`, t => {
  const f = fixture(t); change(f); assert.equal(f.mount(), null); assert.equal(f.fallback, 1); assert.equal(f.body.children.length, 0);
});

test("a missing composer at mount can be retried on the next mount", t => {
  const f = fixture(t); f.replace(null); assert.equal(f.mount(), null); assert.equal(f.fallback, 1);
  f.replace(f.composer); assert.ok(f.mount());
});

for (const [name, change] of [["removed", f => { f.composer.isConnected = false; }], ["replaced", f => f.replace({})], ["wrapped", f => { f.composer.parentElement = {}; }], ["position throws later", f => { f.composer.throwRect = true; }]]) {
  test(`fallback when composer is ${name}`, t => {
    const f = fixture(t); assert.ok(f.mount()); change(f); f.mutations[0].fn(); assert.equal(f.fallback, 1); assert.equal(f.body.children.length, 0); assert.equal(f.listeners.get("resize").size, 0); const count = f.created; assert.equal(f.mount(), null); assert.equal(f.created, count);
  });
}


test("card and panel share collapse, typing and fallback", t => {
  const f = fixture(t), Card = f.h.load("client/components/option-card.tsx").OptionCard;
  let rootHidden = false;
  const root = { getClientRects: () => rootHidden ? [] : [1], contains: () => false, querySelector: () => null };
  const chat = { getClientRects: () => [1], contains: node => node === root };
  const parent = { parentElement: null, querySelectorAll: selector => selector.includes("agent-chat-scroll") ? [chat] : [f.composer] };
  let rootReads = 0;
  Object.defineProperty(root, "parentElement", { get() { rootReads++; return parent; } });
  const byId = (tree, id) => f.h.nodes(tree, node => node.props.testID === id)[0];
  const draw = () => {
    const tree = f.h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } });
    rootHidden = byId(tree, "option-card-strip")?.props.style.display === "none";
    (byId(tree, "option-card") ?? byId(tree, "option-card-strip"))?.props.ref(root);
    return tree;
  };
  assert.ok(byId(draw(), "option-card")); f.h.flushEffects();
  const strip = byId(draw(), "option-card-strip");
  assert.equal(strip.props.style.display, "none");
  assert.equal(typeof strip.props.ref, "function");
  rootReads = 0; f.h.flushEffects();
  assert.ok(rootReads > 0, "the panel still locates the composer through the strip ref");
  assert.equal(f.body.children.length, 1);
  const key = (value, target, actual = target) => {
    const event = { key: value, target, composedPath: () => [actual, target], prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
    for (const listener of f.listeners.get("keydown")) listener(event);
    return event.prevented;
  };
  assert.equal(key("ArrowUp", f.composer), true); draw(); f.h.flushEffects();
  const host = f.body.children[0];
  const pressed = host.shadow.find("option-row-A");
  host.listeners.pointerdown({ composedPath: () => [pressed] });
  draw(); f.h.flushEffects();
  assert.equal(key("ArrowDown", f.composer), true); draw(); f.h.flushEffects();
  assert.equal(host.shadow.find("option-row-A"), pressed);
  for (const listener of f.listeners.get("pointercancel")) listener({});
  assert.notEqual(host.shadow.find("option-row-A"), pressed);
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
  byId(draw(), "option-card-collapse").props.onPress();
  const fallbackStrip = byId(draw(), "option-card-strip");
  assert.equal(fallbackStrip.props.style.display, "flex");
  assert.equal(fallbackStrip.props.style.minHeight, 44);
  assert.equal(fallbackStrip.props.style.height, undefined);
  assert.equal(fallbackStrip.props.style.maxHeight, undefined);
  assert.ok(fallbackStrip.props.style.paddingVertical > 0);
});

test("an open popover hides the panel and pauses positioning until it closes", t => {
  const f = fixture(t), panel = f.mount(), host = panel.host;
  f.store.setOptionPopoverOpen("b", true);
  assert.equal(host.style.display, "block");
  const oldRow = host.shadow.find("option-row-B");
  host.listeners.pointerdown({ composedPath: () => [oldRow] });
  f.store.setOptionPopoverOpen("a", true);
  assert.equal(host.style.display, "none");
  f.composer.throwRect = true;
  f.resizes[0].fn(); f.mutations[0].fn();
  f.store.choose("a", 0, "B");
  assert.equal(host.shadow.find("option-row-B"), oldRow);
  assert.equal(f.fallback, 0);
  f.composer.throwRect = false;
  f.composer.rect.left = 120; f.composer.rect.right = 520;
  f.store.setOptionPopoverOpen("a", false);
  assert.equal(host.style.display, "block");
  assert.equal(host.style.left, "120px");
  assert.notEqual(host.shadow.find("option-row-B"), oldRow);
  assert.equal(host.shadow.find("option-row-B").getAttribute("aria-pressed"), "true");
  panel.dispose();
  assert.ok(f.mount());
  assert.equal(f.fallback, 0);
});

test("a panel mounted while its popover is open stays hidden until it closes", t => {
  const f = fixture(t);
  f.store.setOptionPopoverOpen("a", true);
  f.composer.throwRect = true;
  const panel = f.mount();
  assert.ok(panel);
  assert.equal(panel.host.style.display, "none");
  assert.equal(f.fallback, 0);
  f.composer.throwRect = false;
  f.store.setOptionPopoverOpen("a", false);
  assert.equal(panel.host.style.display, "block");
  assert.ok(panel.host.shadow.find("option-row-B"));
});
