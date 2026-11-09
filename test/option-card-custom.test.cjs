const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function fixture(t, reply, platform = "web") {
  const h = createToolHarness(platform, { width: 390, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  return { h, s, draw: () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } }) };
}

test("the extra row follows every set of original letters, including gaps and H", t => {
  for (const [letters, extra] of [["ABCD", "E"], ["ABC", "D"], ["ACE", "F"], ["ABH", "I"]]) {
    const { h, s, draw } = fixture(t, `Pick?\n${[...letters].map(c => `${c} Option ${c}`).join("\n")}\n\nReply: A`);
    let tree = draw();
    for (const letter of letters) assert.ok(byId(h, tree, `option-row-${letter}`));
    const row = byId(h, tree, `option-row-${extra}`);
    assert.ok(row);
    assert.match(h.text(row), /Other\s+Write your own answer/);
    assert.equal(byId(h, tree, "option-custom-input"), undefined);
    row.props.onPress();
    tree = draw();
    const input = byId(h, tree, "option-custom-input");
    assert.ok(input);
    assert.equal(input.props.multiline, true);
    input.props.onChangeText("own\nanswer");
    assert.equal(s.getOptionSession("a").customDrafts[0], "own\nanswer");
    assert.equal(byId(h, draw(), "option-custom-input").props.value, "own\nanswer");
    byId(h, draw(), `option-row-${letters[0]}`).props.onPress();
    assert.equal(byId(h, draw(), "option-custom-input"), undefined);
    s.publishUserMessage("a", 11, letters[0]);
    assert.ok(byId(h, draw(), `option-row-${extra}`));
  }
});

test("confirmed custom tab labels use nine Unicode code points and preserve ordinary tabs", t => {
  const reply = "1) First?\nA One\nB Two\n\n2) Second?\nA Yes\nB No\n\nReply: A";
  const { h, s, draw } = fixture(t, reply);
  assert.equal(h.text(byId(h, draw(), "option-question-0")), "Q1 · First");
  for (const [value, expected] of [["😀一二三四五六七八", "✓ 😀一二三四五六七八"], ["😀一二三四五六七八九", "✓ 😀一二三四五六七八…"], ["a\nb", "✓ a b"]]) {
    s.setActiveQuestion("a", 0);
    s.openCustom("a", 0);
    s.setCustomDraft("a", 0, value);
    assert.equal(s.confirmCustom("a", 0), "confirmed");
    s.setActiveQuestion("a", 0);
    assert.equal(h.text(byId(h, draw(), "option-question-0")), expected);
    s.setActiveQuestion("a", 1);
    assert.equal(h.text(byId(h, draw(), "option-question-0")), expected);
    assert.equal(h.text(byId(h, draw(), "option-question-1")), "Q2 · Second");
  }
  s.choose("a", 0, "B");
  assert.equal(h.text(byId(h, draw(), "option-question-0")), "✓ Two");
});

test("all three locales contain the approved labels", () => {
  for (const [locale, expected] of Object.entries({ en: ["Other", "Write your own answer", "Write your answer first"], "zh-CN": ["自己写", "写下你自己的回答", "请先写下你的回答"], ja: ["自分で書く", "自分の回答を書く", "先に回答を書いてください"] })) {
    const card = JSON.parse(readFileSync(`client/locales/${locale}.json`, "utf8")).answerCard;
    assert.deepEqual([card.other, card.otherHint, card.otherEmpty], expected);
  }
});

const twoQuestions = "1) First?\nA One\nB Two\n\n2) Second?\nA Yes\nB No\n\nReply: A";

test("blank attempts show feedback only for the active question and unmodified Enter", t => {
  const { h, s, draw: render } = fixture(t, twoQuestions);
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
  byId(h, draw(), "option-row-C").props.onPress();
  assert.equal(byId(h, draw(), "option-custom-empty"), undefined);
  const key = (overrides = {}) => {
    draw();
    assert.equal(typeof inputListener, "function");
    let prevented = false;
    inputListener({ key: "Enter", preventDefault() { prevented = true; }, stopPropagation() {}, ...overrides });
    return prevented;
  };
  for (const overrides of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { key: "\n" }]) {
    key(overrides);
    assert.equal(byId(h, draw(), "option-custom-empty"), undefined);
  }
  assert.equal(key(), true);
  assert.equal(s.getOptionSession("a").choices[0], undefined);
  let hint = byId(h, draw(), "option-custom-empty");
  assert.equal(hint.type, "Text");
  assert.equal(h.text(hint), "Write your answer first");
  byId(h, draw(), "option-custom-input").props.onChangeText(" \n ");
  assert.ok(byId(h, draw(), "option-custom-empty"));
  assert.equal(key(), true);
  assert.equal(s.getOptionSession("a").customDrafts[0], " \n ");
  assert.equal(s.getOptionSession("a").choices[0], undefined);
  byId(h, draw(), "option-custom-input").props.onChangeText("answer");
  assert.equal(byId(h, draw(), "option-custom-empty"), undefined);
  key();
  assert.equal(s.getOptionSession("a").customConfirmed[0], "answer");
  assert.equal(s.getOptionSession("a").activeQuestion, 1);
  byId(h, draw(), "option-row-C").props.onPress();
  byId(h, draw(), "option-custom-input").props.onChangeText("");
  key();
  assert.ok(byId(h, draw(), "option-custom-empty"));
  byId(h, draw(), "option-question-0").props.onPress();
  assert.equal(byId(h, draw(), "option-custom-empty"), undefined);
  byId(h, draw(), "option-row-C").props.onPress();
  assert.equal(byId(h, draw(), "option-custom-empty"), undefined);
  byId(h, draw(), "option-question-0").props.onPress();
  assert.equal(byId(h, draw(), "option-custom-empty"), undefined);
});

test("repeated presses and focus retain a confirmed custom answer until edited", t => {
  const { h, s, draw } = fixture(t, twoQuestions);
  byId(h, draw(), "option-row-C").props.onPress();
  byId(h, draw(), "option-custom-input").props.onChangeText("my answer");
  assert.equal(s.confirmCustom("a", 0), "confirmed");
  s.setActiveQuestion("a", 0);
  const before = s.getOptionSession("a");
  const tab = h.text(byId(h, draw(), "option-question-0"));
  for (let i = 0; i < 3; i++) {
    byId(h, draw(), "option-custom-input").props.onFocus({ stopPropagation() {} });
    byId(h, draw(), "option-row-C").props.onPress();
    const after = s.getOptionSession("a");
    assert.deepEqual(after.choices, before.choices);
    assert.deepEqual(after.customConfirmed, before.customConfirmed);
    assert.deepEqual(after.customDrafts, before.customDrafts);
    assert.equal(h.text(byId(h, draw(), "option-question-0")), tab);
  }
  byId(h, draw(), "option-custom-input").props.onChangeText("changed");
  assert.equal(s.getOptionSession("a").customConfirmed[0], undefined);
  assert.equal(s.getOptionSession("a").choices[0], undefined);
  assert.equal(s.getOptionSession("a").customDrafts[0], "changed");
});

test("input height resets when changing questions", t => {
  const { h, draw } = fixture(t, twoQuestions);
  byId(h, draw(), "option-row-C").props.onPress();
  byId(h, draw(), "option-custom-input").props.onContentSizeChange({ nativeEvent: { contentSize: { height: 70 } } });
  assert.equal(byId(h, draw(), "option-custom-input").props.style[0].height, 70);
  byId(h, draw(), "option-question-1").props.onPress();
  byId(h, draw(), "option-row-C").props.onPress();
  assert.equal(byId(h, draw(), "option-custom-input").props.style[0].height, 36);
  byId(h, draw(), "option-custom-input").props.onContentSizeChange({ nativeEvent: { contentSize: { height: 50 } } });
  assert.equal(byId(h, draw(), "option-custom-input").props.style[0].height, 50);
});

test("blank feedback replaces the normal hint in one reserved line, with reduced motion respected", t => {
  for (const reduced of [false, true]) {
    const h = createToolHarness("web", { width: 390, globals: { matchMedia: () => ({ matches: reduced }) }, agents: { a: { status: "idle" } } });
    t.after(() => { h.unmount(); h.dispose(); });
    const s = h.load("client/option-session.ts");
    const Card = h.load("client/components/option-card.tsx").OptionCard;
    s.publishAssistantReply("a", { at: 10, text: twoQuestions });
    const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    byId(h, draw(), "option-row-C").props.onPress();
    let tree = draw(), listener;
    byId(h, tree, "option-custom-input").props.ref({ addEventListener: (_type, fn) => { listener = fn; }, removeEventListener() {} });
    const inspect = (tree, empty) => {
      const line = byId(h, tree, "option-custom-hint-line");
      assert.ok(line, "one permanent hint line is present");
      const hints = h.nodes(line, node => node.type === "Text");
      assert.deepEqual(hints.map(node => h.text(node)), ["Write your own answer", "Write your answer first"]);
      assert.deepEqual(hints.map(node => node.props.numberOfLines), [1, 1]);
      assert.deepEqual(hints.map(node => node.props.style.opacity), empty ? [0, 1] : [1, 0]);
      const element = { style: {}, children: [{ style: {} }, { style: {} }] };
      line.props.ref(element);
      assert.equal(element.style.display, "grid");
      assert.deepEqual(element.children.map(child => child.style.gridArea), ["1 / 1", "1 / 1"]);
      assert.deepEqual(element.children.map(child => child.style.transition), [reduced ? "none" : "opacity 120ms linear, color 120ms linear", reduced ? "none" : "opacity 120ms linear, color 120ms linear"]);
    };
    inspect(tree, false);
    listener({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    tree = draw();
    inspect(tree, true);
    assert.equal(h.text(byId(h, tree, "option-custom-empty")), "Write your answer first");
    byId(h, tree, "option-custom-input").props.onChangeText("answer");
    inspect(draw(), false);
  }
});

test("opening the custom row focuses on mount and expands row and card, including reduced motion", t => {
  for (const reduced of [false, true]) {
    const h = createToolHarness("web", { width: 390, globals: { matchMedia: () => ({ matches: reduced }) }, agents: { a: { status: "idle" } } });
    t.after(() => { h.unmount(); h.dispose(); });
    const s = h.load("client/option-session.ts");
    const Card = h.load("client/components/option-card.tsx").OptionCard;
    s.publishAssistantReply("a", { at: 10, text: twoQuestions });
    const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    const calls = [], focused = [], never = new Promise(() => {});
    const animation = name => ({ animate(frames, options) { calls.push({ name, frames, options }); return { finished: never, cancel() {} }; } });
    const scroller = { style: {}, scrollTop: 100, clientHeight: 500, scrollHeight: 1200, addEventListener() {}, removeEventListener() {} };
    const row = { style: {}, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 120 : 70 }), ...animation("row") };
    const card = { style: {}, closest: () => scroller, querySelector: selector => selector.includes("option-row-C") ? row : null, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 550 : 500 }), ...animation("card") };
    let tree = draw();
    byId(h, tree, "option-card").props.ref(card);
    byId(h, tree, "option-row-C").props.onPress();
    tree = draw();
    const input = { addEventListener() {}, removeEventListener() {}, focus() { focused.push("input"); } };
    byId(h, tree, "option-custom-input").props.ref(input);
    assert.deepEqual(focused, ["input"], "input is focused in the mounting frame");
    assert.equal(scroller.scrollTop, 100);
    if (reduced) assert.deepEqual(calls, []);
    else {
      assert.ok(calls.some(call => call.name === "row" && call.options.duration === 200 && call.frames[0].height === "70px" && call.frames.at(-1).height === "120px"));
      assert.ok(calls.some(call => call.name === "row" && call.frames[0].backgroundColor && call.frames.at(-1).backgroundColor && call.frames[0].borderColor && call.frames.at(-1).borderColor));
      assert.ok(calls.some(call => call.name === "card" && call.options.duration === 200 && call.frames[0].height === "500px" && call.frames.at(-1).height === "550px"));
    }
    byId(h, tree, "option-custom-input").props.ref(null);
  }
});

test("custom text growth animates to its cap and then stays inside the field", t => {
  const { h, s, draw } = fixture(t, twoQuestions);
  s.openCustom("a", 0);
  let expanded = false, calls = [];
  const never = new Promise(() => {});
  const animation = name => ({ animate(frames, options) { calls.push({ name, frames, options }); return { finished: never, cancel() {} }; } });
  const scroller = { style: {}, scrollTop: 100, clientHeight: 500, scrollHeight: 1200, addEventListener() {}, removeEventListener() {} };
  const inputNode = { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ height: expanded ? 72 : 44 }), ...animation("input") };
  const row = { style: {}, getBoundingClientRect: () => ({ height: expanded ? 148 : 120 }), ...animation("row") };
  const card = { style: {}, closest: () => scroller, querySelector: selector => selector.includes("option-row-C") ? row : selector.includes("option-custom-input") ? inputNode : null, getBoundingClientRect: () => ({ height: expanded ? 578 : 550 }), ...animation("card") };
  let tree = draw(); byId(h, tree, "option-card").props.ref(card);
  let input = byId(h, tree, "option-custom-input"); input.props.ref(inputNode);
  assert.equal(input.props.numberOfLines, 2);
  assert.ok(input.props.style[0].minHeight >= 36);
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 100 } } });
  expanded = true; tree = draw(); input = byId(h, tree, "option-custom-input");
  assert.equal(input.props.style[0].height, 72);
  assert.ok(calls.some(call => call.name === "input" && call.options.duration === 120));
  assert.ok(calls.some(call => call.name === "card" && call.options.duration === 180));
  calls = [];
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 150 } } });
  tree = draw();
  assert.equal(byId(h, tree, "option-custom-input").props.style[0].height, 72);
  assert.equal(calls.length, 0, "growth past the cap does not move the card");
  byId(h, tree, "option-custom-input").props.ref(null);
});

test("opening leaves enough animation time for the observed 150 ms frame window", t => {
  const { h, s, draw } = fixture(t, twoQuestions);
  const calls = [], never = new Promise(() => {});
  const animate = name => ({ animate(frames, options) { calls.push({ name, frames, options }); return { finished: never, cancel() {} }; } });
  const row = { style: {}, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 120 : 70 }), ...animate("row") };
  const card = { style: {}, closest: () => null, querySelector: selector => selector.includes("option-row-C") ? row : null, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 550 : 500 }), ...animate("card") };
  const tree = draw();
  byId(h, tree, "option-card").props.ref(card);
  byId(h, tree, "option-row-C").props.onPress();
  draw();
  const rowAnimation = calls.find(call => call.name === "row");
  const cardAnimation = calls.find(call => call.name === "card");
  assert.ok(rowAnimation.options.duration >= 150 + 2 * (1000 / 60), "the row allows 150 ms plus two 60 Hz sampling intervals");
  assert.ok(cardAnimation.options.duration >= rowAnimation.options.duration, "the card does not clip the row animation");
});


// Synthetic commit ordering: the mounted input reports its retained draft size
// after its ref attaches but before the opening commit's layout effect runs.
for (const reduced of [false, true]) {
  test(`synthetic opening size event restores original styles (reduced=${reduced})`, t => {
    const h = createToolHarness("web", { deferEffects: true, width: 390, globals: { matchMedia: () => ({ matches: reduced }) }, agents: { a: { status: "idle" } } });
    t.after(() => { h.unmount(); h.dispose(); });
    const s = h.load("client/option-session.ts");
    const Card = h.load("client/components/option-card.tsx").OptionCard;
    s.publishAssistantReply("a", { at: 10, text: twoQuestions });
    s.openCustom("a", 0); s.setCustomDraft("a", 0, "retained\nmultiline draft");
    // Selecting an ordinary option closes Other while retaining its draft.
    s.choose("a", 0, "A"); s.setActiveQuestion("a", 0);
    const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    const never = new Promise(() => {}), animations = [];
    const animate = name => ({ animate(frames, options) { const a = { name, frames, options, cancelled: false }; animations.push(a); return { finished: never, cancel() { a.cancelled = true; } }; } });
    const scroller = { style: { overflowAnchor: "auto" }, scrollTop: 100, clientHeight: 500, scrollHeight: 1600, addEventListener() {}, removeEventListener() {} };
    const row = { style: { overflow: "visible" }, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 148 : 70 }), ...animate("row") };
    const inputNode = { addEventListener() {}, removeEventListener() {}, focus() {}, getBoundingClientRect: () => ({ height: 44 }), ...animate("input") };
    const card = { style: { height: "auto", overflow: "visible" }, closest: () => scroller, querySelector: selector => selector.includes("option-row-C") ? row : inputNode, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 578 : 500 }), ...animate("card") };
    let tree = draw(); h.flushEffects();
    byId(h, tree, "option-card").props.ref(card);
    byId(h, tree, "option-row-C").props.onPress();
    tree = draw();
    const input = byId(h, tree, "option-custom-input");
    assert.equal(input.props.value, "retained\nmultiline draft");
    input.props.ref(inputNode);
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 100 } } });
    h.flushEffects();
    tree = draw(); h.flushEffects();
    assert.equal(byId(h, tree, "option-custom-input").props.style[0].height, 72);
    h.unmount();
    assert.equal(card.style.height, "auto", "restore the original height, not the opening lock");
    assert.equal(card.style.overflow, "visible");
    assert.equal(scroller.style.overflowAnchor, "auto");
    assert.equal(row.style.overflow, "visible");
    assert.ok(animations.every(a => a.cancelled));
    input.props.ref(null);
  });
}

test("synthetic opening interruption before the commit restores the first snapshot", t => {
  const h = createToolHarness("web", { deferEffects: true, width: 390, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts"), Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: twoQuestions });
  s.openCustom("a", 0); s.setCustomDraft("a", 0, "retained\ntext"); s.choose("a", 0, "A"); s.setActiveQuestion("a", 0);
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const scroller = { style: { overflowAnchor: "auto" }, scrollTop: 100, clientHeight: 500, scrollHeight: 2000 };
  const row = { style: {}, getBoundingClientRect: () => ({ height: 70 }) };
  const card = { style: { height: "auto", overflow: "visible" }, closest: () => scroller, querySelector: () => row, getBoundingClientRect: () => ({ height: 500 }) };
  let tree = draw(); h.flushEffects(); byId(h, tree, "option-card").props.ref(card); byId(h, tree, "option-row-C").props.onPress();
  tree = draw(); const input = byId(h, tree, "option-custom-input");
  input.props.ref({ focus() {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ height: 44 }) });
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 100 } } });
  h.unmount();
  assert.deepEqual(card.style, { height: "auto", overflow: "visible" });
  assert.equal(scroller.style.overflowAnchor, "auto");
});

test("synthetic opening finishes its animation and restores the original styles", async t => {
  const h = createToolHarness("web", { deferEffects: true, width: 390, globals: { matchMedia: () => ({ matches: false }) }, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts"), Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: twoQuestions });
  s.openCustom("a", 0); s.setCustomDraft("a", 0, "retained\ntext"); s.choose("a", 0, "A"); s.setActiveQuestion("a", 0);
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  let finish; const done = new Promise(resolve => { finish = resolve; });
  const animations = [], animate = name => ({ animate(frames, options) { const record = { name, frames, options, cancelled: false }; animations.push(record); return { finished: done, cancel() { record.cancelled = true; } }; } });
  const scroller = { style: { overflowAnchor: "auto" }, scrollTop: 100, clientHeight: 500, scrollHeight: 2000, addEventListener() {}, removeEventListener() {} };
  const row = { style: { overflow: "visible" }, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 148 : 70 }), ...animate("row") };
  const card = { style: { height: "auto", overflow: "visible" }, closest: () => scroller, querySelector: () => row, getBoundingClientRect: () => ({ height: s.getOptionSession("a").customOpen[0] ? 578 : 500 }), ...animate("card") };
  let tree = draw(); h.flushEffects(); byId(h, tree, "option-card").props.ref(card); byId(h, tree, "option-row-C").props.onPress();
  tree = draw(); const input = byId(h, tree, "option-custom-input");
  input.props.ref({ focus() {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ height: 44 }) });
  input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 100 } } }); h.flushEffects();
  assert.deepEqual(animations.find(a => a.name === "card").frames.map(frame => frame.height), ["500px", "578px"]);
  assert.ok(animations.some(a => a.name === "row"));
  finish(); await new Promise(setImmediate);
  assert.equal(card.style.height, "auto"); assert.equal(card.style.overflow, "visible");
  assert.equal(row.style.overflow, "visible"); assert.equal(scroller.style.overflowAnchor, "auto");
  assert.ok(animations.every(a => a.cancelled));
});
