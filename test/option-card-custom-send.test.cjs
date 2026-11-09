const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) First?
A One
B Two (recommended)
C Three
D Four

2) Second?
A One
B Two
C Three
D Four

3) Third?
A One
B Two
C Three
D Four

Reply: A`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function fixture(t, locale = "en", reduced = false) {
  const h = createToolHarness("web", { locale, width: 390, globals: { matchMedia: () => ({ matches: reduced }) }, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const custom = (index, value) => { s.openCustom("a", index); s.setCustomDraft("a", index, value); assert.equal(s.confirmCustom("a", index), "confirmed"); };
  return { h, s, draw, custom };
}

test("the complete custom answer appears as selectable plain text and the button shows only the index", t => {
  const { h, s, draw, custom } = fixture(t);
  s.choose("a", 0, "B"); custom(1, "line one\nline two"); s.choose("a", 2, "A");
  const tree = draw();
  const preview = byId(h, tree, "option-send-preview");
  assert.equal(preview.type, "Text");
  assert.equal(preview.props.selectable, true);
  assert.equal(h.text(preview), "1B 2E 3A\n\n2E：\nline one\nline two");
  assert.equal(preview.props.style.fontSize, 13);
  assert.equal(h.text(byId(h, tree, "option-send")), "Send 1B 2E 3A");
});

test("multiple custom answers have separate blocks; ordinary answers have no preview", t => {
  const { h, s, draw, custom } = fixture(t);
  s.choose("a", 0, "B"); s.choose("a", 1, "A"); s.choose("a", 2, "A");
  assert.equal(byId(h, draw(), "option-send-preview"), undefined);
  custom(1, "first <b>plain</b>"); custom(2, "second\nline");
  assert.equal(h.text(byId(h, draw(), "option-send-preview")), "1B 2E 3E\n\n2E：\nfirst <b>plain</b>\n\n3E：\nsecond\nline");
});

test("two-question send label uses the index in English and Chinese", t => {
  for (const [locale, expected] of [["en", "Send 1B 2E"], ["zh-CN", "发送 1B 2E"]]) {
    const { h, s, draw, custom } = fixture(t, locale);
    s.getOptionSession("a").set.questions.pop();
    s.choose("a", 0, "B"); custom(1, "line one\nline two");
    assert.equal(h.text(byId(h, draw(), "option-send")), expected);
  }
});

test("sent custom text is read-only with a check, muted badge, and final status", async t => {
  const { h, s, draw, custom } = fixture(t);
  custom(0, "line one\nline two"); s.choose("a", 1, "A"); s.choose("a", 2, "A");
  s.setActiveQuestion("a", 0);
  s.setOptionSender(async () => {});
  await s.sendAnswer("a");
  const tree = draw();
  const row = byId(h, tree, "option-row-E");
  const content = h.nodes(row, node => node.type === "Text" && h.text(node) === "line one\nline two")[0];
  assert.ok(content);
  assert.equal(content.props.selectable, true);
  assert.match(h.text(row), /✓/);
  assert.equal(row.props.onPress, undefined);
  assert.equal(byId(h, tree, "option-custom-input"), undefined);
  assert.equal(byId(h, tree, "option-send"), undefined);
  assert.ok(byId(h, tree, "option-answered"));
  const status = byId(h, tree, "option-read-only-status");
  assert.equal(status.type, "Text");
  assert.equal(status.props.onPress, undefined);
  assert.equal(h.text(status), "Answered · read-only");
  const tabs = byId(h, tree, "option-tabs");
  const tabNodes = h.nodes(tabs, node => node.props.testID?.startsWith("option-question-") || node.props.testID === "option-read-only-status");
  assert.equal(tabNodes.at(-1), status);
  const badge = h.nodes(byId(h, tree, "option-row-B"), node => node.type === "Text" && h.text(node) === "Recommended")[0];
  assert.equal(badge.props.style.backgroundColor, "transparent");
  assert.equal(badge.props.style.color, h.tokens.foregroundMuted);
  for (const letter of "ABCDE") assert.equal(byId(h, tree, `option-row-${letter}`).props.style.backgroundColor, h.tokens.surface2);
});

test("all locales contain the approved read-only status", () => {
  for (const [locale, value] of Object.entries({ en: "Answered · read-only", "zh-CN": "已答 · 只读", ja: "回答済み · 読み取り専用" })) {
    assert.equal(JSON.parse(readFileSync(`client/locales/${locale}.json`, "utf8")).answerCard.readOnlyStatus, value);
  }
});

test("sent answers can be viewed by question without changing the answers or message", async t => {
  const { h, s, draw: render } = fixture(t);
  let inputListener, inputRef, mounted = false;
  const inputNode = new EventTarget();
  const add = inputNode.addEventListener.bind(inputNode);
  const remove = inputNode.removeEventListener.bind(inputNode);
  inputNode.addEventListener = (type, listener, ...args) => { if (type === "keydown") inputListener = listener; add(type, listener, ...args); };
  inputNode.removeEventListener = (type, listener, ...args) => { if (type === "keydown" && inputListener === listener) inputListener = undefined; remove(type, listener, ...args); };
  t.after(() => { if (mounted) inputRef(null); });
  const draw = () => {
    const tree = render();
    const input = byId(h, tree, "option-custom-input");
    if (input && !mounted) { inputRef = input.props.ref; inputRef(inputNode); mounted = true; }
    else if (!input && mounted) { inputRef(null); mounted = false; }
    return tree;
  };
  const press = id => byId(h, draw(), id).props.onPress();
  const key = (key, id) => {
    const target = { getAttribute: () => id, closest: () => null };
    byId(h, draw(), "option-card").props.onKeyDown({ key, target, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
  };
  press("option-row-B");
  press("option-row-E");
  byId(h, draw(), "option-custom-input").props.onChangeText("line one\nline two");
  draw();
  assert.equal(typeof inputListener, "function");
  inputListener({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  press("option-row-A");
  let sent;
  s.setOptionSender(async (_, text) => { sent = text; });
  press("option-send");
  await new Promise(setImmediate);
  const before = s.getOptionSession("a");
  assert.equal(sent, "1B 2E 3A\n\n2E：\nline one\nline two");
  assert.equal(byId(h, draw(), "option-question-2").props.accessibilityState.selected, true);
  for (const i of [1, 2, 0]) {
    const tab = byId(h, draw(), `option-question-${i}`);
    assert.equal(tab.type, "Pressable");
    assert.notEqual(tab.props.disabled, true);
    tab.props.onPress();
    const tree = draw();
    assert.equal(byId(h, tree, `option-question-${i}`).props.accessibilityState.selected, true);
    const row = byId(h, tree, `option-row-${["B", "E", "A"][i]}`);
    assert.match(h.text(row), /✓/);
    if (i === 1) assert.ok(h.nodes(row, n => n.type === "Text" && h.text(n) === "line one\nline two").length);
    assert.equal(byId(h, tree, "option-custom-input"), undefined);
    assert.equal(byId(h, tree, "option-send"), undefined);
  }
  assert.deepEqual(s.getOptionSession("a").choices, before.choices);
  assert.deepEqual(s.getOptionSession("a").customConfirmed, before.customConfirmed);
  assert.equal(s.getOptionSession("a").answeredText, sent);
  for (const id of ["option-row-A", "option-row-B", "option-row-E"]) assert.equal(byId(h, draw(), id).props.onPress, undefined);
  key("a", "option-card"); key("e", "option-card");
  assert.deepEqual(s.getOptionSession("a").choices, before.choices);
  assert.equal(s.getOptionSession("a").answeredText, sent);
});

test("sending fades the editable card before collapsing to its read-only height", async t => {
  const { h, s, draw } = fixture(t);
  s.choose("a", 0, "A"); s.choose("a", 1, "A"); s.choose("a", 2, "A");
  s.setOptionSender(async () => {});
  const animations = [];
  let finishFade;
  const fadeDone = new Promise(resolve => { finishFade = resolve; });
  const content = {
    style: {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 380, height: 400 }),
  };
  const scroller = { style: {}, scrollTop: 100, clientHeight: 500, scrollHeight: 1000, addEventListener() {}, removeEventListener() {} };
  const card = {
    style: {}, clientTop: 0, clientLeft: 0, closest: () => scroller,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 380, height: s.getOptionSession("a").readOnly ? 300 : 500 }),
    querySelector: () => content, appendChild() {},
    cloneNode: () => ({ style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {},
      animate(frames, options) { animations.push({ name: "old", frames, options }); return { finished: fadeDone, cancel() {} }; } }),
    animate(frames, options) { animations.push({ name: "card", frames, options }); return { finished: new Promise(() => {}), cancel() {} }; },
  };
  let tree = draw();
  byId(h, tree, "option-card").props.ref(card);
  byId(h, tree, "option-send").props.onPress();
  await new Promise(setImmediate);
  tree = draw();
  const fade = animations.find(a => a.name === "old" && a.options.duration === 120);
  assert.ok(fade, "editable content fades for 120 ms");
  assert.equal(card.style.height, "500px", "height remains locked during the fade");
  assert.equal(animations.some(a => a.name === "card" && a.options.duration === 200), false);
  finishFade();
  await new Promise(setImmediate);
  const collapse = animations.find(a => a.name === "card" && a.options.duration === 200);
  assert.ok(collapse, "height collapses over 200 ms after the fade");
  assert.deepEqual(collapse.frames.map(f => f.height), ["500px", "300px"]);
  assert.equal(scroller.scrollTop, 100);
  assert.ok(byId(h, tree, "option-answered"));
});


test("sending reserves bottom scroll space even with reduced motion", async t => {
  for (const reduced of [false, true]) {
    const { h, s, draw } = fixture(t, "en", reduced);
    s.choose("a", 0, "A"); s.choose("a", 1, "A"); s.choose("a", 2, "A");
    s.setOptionSender(async () => {});
    let scroll = 400;
    const never = new Promise(() => {});
    const old = { style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ finished: never, cancel() {} }) };
    const card = {
      style: {}, closest: () => scroller, cloneNode: () => old, appendChild() {},
      getBoundingClientRect: () => ({ height: card.style.height && card.style.height !== "auto" ? Number.parseFloat(card.style.height) : s.getOptionSession("a").readOnly ? 300 : 700 }),
      animate: () => ({ finished: never, cancel() {} }),
    };
    const scroller = {
      style: {}, clientHeight: 500, addEventListener() {}, removeEventListener() {},
      get scrollHeight() { return Math.max(500, 200 + card.getBoundingClientRect().height + (Number.parseFloat(card.style.marginBottom) || 0)); },
      get scrollTop() { return scroll = Math.min(scroll, this.scrollHeight - this.clientHeight); },
      set scrollTop(value) { scroll = Math.min(value, this.scrollHeight - this.clientHeight); },
    };
    const tree = draw();
    byId(h, tree, "option-card").props.ref(card);
    byId(h, tree, "option-send").props.onPress();
    await new Promise(setImmediate);
    draw();
    assert.equal(scroller.scrollTop, 400, `scroll retained with reduced motion ${reduced}`);
    assert.ok(Number.parseFloat(card.style.marginBottom) >= 400, `space retained with reduced motion ${reduced}`);
    if (reduced) assert.equal(card.style.height, "auto");
  }
});

test("confirming the final custom answer expands the preview while retaining scroll and focus", async t => {
  for (const reduced of [false, true]) {
    const { h, s, draw } = fixture(t, "en", reduced);
    s.choose("a", 0, "B"); s.choose("a", 1, "A");
    s.openCustom("a", 2); s.setCustomDraft("a", 2, "line one\nline two");
    const calls = [], focused = [];
    const never = new Promise(() => {});
    const animated = name => ({ animate(frames, options) { calls.push({ name, frames, options }); return { finished: never, cancel() {} }; } });
    const preview = animated("preview"), check = animated("check");
    const scroller = { style: {}, scrollTop: 125, clientHeight: 500, scrollHeight: 1200, addEventListener() {}, removeEventListener() {} };
    const card = {
      style: {}, closest: () => scroller,
      getBoundingClientRect: () => ({ height: s.getOptionSession("a").customConfirmed[2] === undefined ? 500 : 620 }),
      querySelector: selector => selector.includes("option-send-preview") ? preview : selector.includes("option-confirmed-check") ? check : selector.includes("option-send") ? { focus: () => focused.push("send") } : null,
      ...animated("card"),
    };
    let listener;
    const input = { addEventListener(type, fn) { if (type === "keydown") listener = fn; }, removeEventListener() {} };
    let tree = draw();
    byId(h, tree, "option-card").props.ref(card);
    byId(h, tree, "option-custom-input").props.ref(input);
    listener({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    tree = draw();
    assert.equal(h.text(byId(h, tree, "option-send-preview")), "1B 2A 3E\n\n3E：\nline one\nline two");
    assert.equal(scroller.scrollTop, 125);
    assert.deepEqual(focused, ["send"], "Send is focused on the confirmation render");
    if (reduced) assert.equal(calls.length, 0, "reduced motion skips animations");
    else {
      const height = calls.find(call => call.name === "card" && call.options.duration === 180);
      assert.ok(height, "card height expands for 180 ms");
      assert.equal(height.options.easing, "ease-out", "confirmation height uses ease-out");
      assert.deepEqual(height.frames.map(frame => frame.height), ["500px", "620px"]);
      assert.ok(calls.some(call => call.name === "preview" && call.options.duration === 120 && call.frames[0].opacity === 0 && call.frames.at(-1).opacity === 1));
      assert.ok(calls.some(call => call.name === "check" && call.options.duration === 120 && call.frames[0].transform === "scale(0.9)" && call.frames.at(-1).transform === "scale(1)"));
    }
    byId(h, tree, "option-custom-input").props.ref(null);
  }
});

// Synthetic geometry and input events exercise the real send/session path. The
// events below model trusted input; they are not browser-generated trusted events.
for (const path of ["success", "echo"]) {
  for (const reduced of [false, true]) {
    for (const movement of ["click then host scroll", "user then host scroll", "no intermediate scroll"]) {
      test(`synthetic delayed ${path}: ${movement}, reduced=${reduced}`, async t => {
        const { h, s, draw } = fixture(t, "en", reduced);
        for (let i = 0; i < 3; i++) s.choose("a", i, "A");
        let resolveSend;
        s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
        let scroll = 500;
        const listeners = new Map();
        const scroller = {
          style: {}, clientTop: 0, clientHeight: 500, scrollHeight: 5000,
          getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }),
          get scrollTop() { return scroll; }, set scrollTop(value) { scroll = Math.max(0, Math.min(4500, value)); },
          scrollBy(_x, y) { this.scrollTop += typeof _x === "object" ? _x.top : y; },
          addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
          removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
          dispatch(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
        };
        let fadeFinish, collapseFinish;
        const fadeDone = new Promise(resolve => { fadeFinish = resolve; });
        const collapseDone = new Promise(resolve => { collapseFinish = resolve; });
        const old = { style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ finished: fadeDone, cancel() {} }) };
        const card = {
          style: {}, closest: () => scroller, cloneNode: () => old, appendChild() {},
          getBoundingClientRect() {
            const height = this.style.height && this.style.height !== "auto" ? parseFloat(this.style.height) : s.getOptionSession("a").readOnly ? 120 : 200;
            const top = 100 + 200 - scroll;
            return { top, bottom: top + height, height, left: 0, width: 380 };
          },
          animate(frames) { return { finished: frames[0].height ? collapseDone : fadeDone, cancel() {} }; },
        };
        let tree = draw(); byId(h, tree, "option-card").props.ref(card);
        byId(h, tree, "option-send").props.onPress();
        assert.equal(s.getOptionSession("a").sending, true);
        if (movement !== "no intermediate scroll") {
          scroller.dispatch("pointerdown", { isTrusted: true }); // synthetic representation of a trusted click
          if (movement === "user then host scroll") { scroller.scrollTop += 20; scroller.dispatch("scroll", { isTrusted: true }); }
          scroller.scrollTop += 30; scroller.dispatch("scroll", { isTrusted: true }); // synthetic host movement
        }
        const before = scroller.scrollTop;
        if (path === "echo") s.publishUserMessage("a", 11, s.answerText("a"));
        else { resolveSend(); await new Promise(setImmediate); }
        assert.equal(s.getOptionSession("a").readOnly, true, "actual session entered read-only");
        draw();
        if (!reduced) { fadeFinish(); await new Promise(setImmediate); collapseFinish(); await new Promise(setImmediate); }
        assert.equal(scroller.scrollTop - before, -80, "only the 80px lost above the viewport is compensated relative to current scroll");
        if (path === "echo") { resolveSend(); await new Promise(setImmediate); }
      });
    }
  }
}

for (const reduced of [false, true]) {
  for (const geometry of [
    { name: "partially above", top: -50, next: 120, expected: -30 },
    { name: "wholly visible", top: 120, next: 120, expected: 0 },
    { name: "new bottom at viewport edge", top: -20, next: 120, expected: 0 },
    { name: "no shrink", top: -200, next: 200, expected: 0 },
    { name: "growth", top: -200, next: 240, expected: 0 },
  ]) {
    test(`synthetic relative geometry: ${geometry.name}, reduced=${reduced}`, async t => {
      const { h, s, draw } = fixture(t, "en", reduced);
      for (let i = 0; i < 3; i++) s.choose("a", i, "A");
      let resolveSend;
      s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
      let scroll = 500;
      const scroller = { style: {}, clientTop: 0, clientHeight: 500, scrollHeight: 5000,
        getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }),
        get scrollTop() { return scroll; }, set scrollTop(v) { scroll = Math.max(0, Math.min(4500, v)); },
        scrollBy(x, y) { this.scrollTop += typeof x === "object" ? x.top : y; }, addEventListener() {}, removeEventListener() {},
      };
      let endFade, endCollapse;
      const fade = new Promise(resolve => { endFade = resolve; }), collapse = new Promise(resolve => { endCollapse = resolve; });
      const old = { style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ finished: fade, cancel() {} }) };
      const docTop = geometry.top - 100 + 545;
      const card = { style: {}, closest: () => scroller, cloneNode: () => old, appendChild() {},
        getBoundingClientRect() { const height = this.style.height && this.style.height !== "auto" ? parseFloat(this.style.height) : s.getOptionSession("a").readOnly ? geometry.next : 200; const top = 100 + docTop - scroll; return { top, bottom: top + height, height, left: 0, width: 380 }; },
        animate(frames) { return { finished: frames[0].height ? collapse : fade, cancel() {} }; },
      };
      const tree = draw(); byId(h, tree, "option-card").props.ref(card); byId(h, tree, "option-send").props.onPress();
      scroller.scrollTop += 45; // synthetic host scroll while the sender is pending
      const before = scroller.scrollTop;
      resolveSend(); await new Promise(setImmediate); draw();
      if (!reduced) { endFade(); await new Promise(setImmediate); endCollapse(); await new Promise(setImmediate); }
      assert.equal(scroller.scrollTop - before, geometry.expected, "preserve host movement and compensate only the card's removed portion above the viewport");
    });
  }
}

test("synthetic compensation clamps at the viewport scroll boundary", async t => {
  const { h, s, draw } = fixture(t, "en", true);
  for (let i = 0; i < 3; i++) s.choose("a", i, "A");
  let resolveSend; s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  let scroll = 20;
  const scroller = { style: {}, clientTop: 0, clientHeight: 500, scrollHeight: 5000,
    getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }),
    get scrollTop() { return scroll; }, set scrollTop(v) { scroll = Math.max(0, Math.min(4500, v)); },
    scrollBy(x, y) { this.scrollTop += typeof x === "object" ? x.top : y; }, addEventListener() {}, removeEventListener() {},
  };
  const card = { style: {}, closest: () => scroller,
    getBoundingClientRect() { const height = s.getOptionSession("a").readOnly ? 0 : 200; const top = 100 - scroll; return { top, bottom: top + height, height, left: 0, width: 380 }; },
  };
  const tree = draw(); byId(h, tree, "option-card").props.ref(card); byId(h, tree, "option-send").props.onPress();
  resolveSend(); await new Promise(setImmediate); draw();
  assert.equal(scroller.scrollTop, 0, "only the 20px of removed card above the viewport can be compensated");
});

test("synthetic animated collapse preserves host and user scroll between frames", async t => {
  const callbacks = new Map(); let nextId = 0;
  const globals = { matchMedia: () => ({ matches: false }), requestAnimationFrame(fn) { const id = ++nextId; callbacks.set(id, fn); return id; }, cancelAnimationFrame(id) { callbacks.delete(id); } };
  const h = createToolHarness("web", { locale: "en", width: 390, globals, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts"), Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  for (let i = 0; i < 3; i++) s.choose("a", i, "A");
  let resolveSend; s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  let scroll = 500, animatedHeight = null, finishFade, finishCollapse;
  const fade = new Promise(resolve => { finishFade = resolve; }), collapse = new Promise(resolve => { finishCollapse = resolve; });
  const scroller = { style: {}, clientTop: 0, clientHeight: 500, scrollHeight: 5000,
    getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }),
    get scrollTop() { return scroll; }, set scrollTop(v) { scroll = Math.max(0, Math.min(4500, v)); },
    scrollBy(x, y) { this.scrollTop += typeof x === "object" ? x.top : y; }, addEventListener() {}, removeEventListener() {},
  };
  const old = { style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ finished: fade, cancel() {} }) };
  const card = { style: {}, closest: () => scroller, cloneNode: () => old, appendChild() {},
    getBoundingClientRect() { const height = animatedHeight ?? (this.style.height && this.style.height !== "auto" ? parseFloat(this.style.height) : s.getOptionSession("a").readOnly ? 120 : 200); const top = 300 - scroll; return { top, bottom: top + height, height, left: 0, width: 380 }; },
    animate(frames) { return { finished: frames[0].height ? collapse : fade, cancel() {} }; },
  };
  const frame = time => { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(time); };
  const tree = draw(); byId(h, tree, "option-card").props.ref(card); byId(h, tree, "option-send").props.onPress();
  resolveSend(); await new Promise(setImmediate); draw(); finishFade(); await new Promise(setImmediate);
  animatedHeight = 160; frame(16);
  assert.equal(scroll, 460, "first 40px loss above viewport compensates relatively");
  scroll += 25; // synthetic host or user movement during animation
  animatedHeight = 120; frame(32);
  assert.equal(scroll, 445, "second loss preserves intervening movement");
  finishCollapse(); await new Promise(setImmediate);
  h.unmount(); assert.equal(callbacks.size, 0, "animation frame work is cleaned up");
});

for (const reduced of [false, true]) {
  test(`synthetic editable size changes while send is pending, reduced=${reduced}`, async t => {
    const observers = new Set();
    const globals = { matchMedia: () => ({ matches: reduced }), ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { observers.add(this); } disconnect() { observers.delete(this); } } };
    const h = createToolHarness("web", { locale: "en", width: 390, globals, agents: { a: { status: "idle" } } });
    t.after(() => { h.unmount(); h.dispose(); });
    const s = h.load("client/option-session.ts"), Card = h.load("client/components/option-card.tsx").OptionCard;
    s.publishAssistantReply("a", { at: 10, text: reply }); for (let i = 0; i < 3; i++) s.choose("a", i, "A");
    let resolveSend; s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
    const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    let scroll = 500, editableHeight = 200, finishFade, finishCollapse;
    const fade = new Promise(resolve => { finishFade = resolve; }), collapse = new Promise(resolve => { finishCollapse = resolve; });
    const scroller = { style: {}, clientTop: 0, clientHeight: 500, scrollHeight: 5000, getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }),
      get scrollTop() { return scroll; }, set scrollTop(v) { scroll = Math.max(0, Math.min(4500, v)); }, scrollBy(x, y) { this.scrollTop += typeof x === "object" ? x.top : y; }, addEventListener() {}, removeEventListener() {} };
    const old = { style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ finished: fade, cancel() {} }) };
    const card = { style: {}, closest: () => scroller, cloneNode: () => old, appendChild() {}, getBoundingClientRect() { const height = this.style.height && this.style.height !== "auto" ? parseFloat(this.style.height) : s.getOptionSession("a").readOnly ? 120 : editableHeight; const top = 200 - scroll; return { top, bottom: top + height, height, left: 0, width: 380 }; }, animate(frames) { return { finished: frames[0].height ? collapse : fade, cancel() {} }; } };
    const tree = draw(); byId(h, tree, "option-card").props.ref(card); byId(h, tree, "option-send").props.onPress();
    editableHeight = 240;
    for (const observer of observers) observer.fn([{ target: card, contentRect: { height: editableHeight } }]); // synthetic ResizeObserver delivery
    resolveSend(); await new Promise(setImmediate); draw();
    if (!reduced) { finishFade(); await new Promise(setImmediate); finishCollapse(); await new Promise(setImmediate); }
    assert.equal(scroll, 380, "the 120px lost from the latest editable geometry is compensated");
    h.unmount(); assert.equal(observers.size, 0, "observers are disconnected");
  });
}
