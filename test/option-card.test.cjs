const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Which storage? More details.
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
  const h = createToolHarness("ios", { width: 320, height: 640, agents, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const draw = (at = 10) => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: reply } }, timestamp: new Date(at), theme: { colors: {} } } }, `reply-${at}`);
  return { h, s, agents, draw };
}

test("card is limited to the matching enabled and idle reply", t => {
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

test("later and skipped letters render and remain selectable across display settings", t => {
  const h = createToolHarness("ios", { width: 320, height: 640, markdown: true, agents: { a: { status: "idle" } }, preferences: { showAnswerCard: false } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const cases = [
    ["Pick?\nC 先做\nD 后做\n\nReply: C", [["C", "先做"], ["D", "后做"]]],
    ["Pick?\nA First\nC Third\nE Fifth\n\nReply: A", [["A", "First"], ["C", "Third"], ["E", "Fifth"]]],
  ];
  let at = 10;
  for (const [text, options] of cases) {
    const timestamp = new Date(at++);
    const draw = () => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text } }, timestamp, theme: { colors: {} } } }, `reply-${timestamp.getTime()}`);
    for (const keepItemLineBreaks of [false, true]) {
      h.preferences.keepItemLineBreaks = keepItemLineBreaks;
      h.preferences.showAnswerCard = false;
      assert.equal(byId(h, draw(), "option-card"), undefined);
      h.preferences.showAnswerCard = true;
      let tree = draw();
      assert.ok(byId(h, tree, "option-card"));
      for (const [letter, label] of options) {
        const row = byId(h, tree, `option-row-${letter}`);
        assert.ok(row, letter);
        assert.ok(h.text(row).includes(label));
      }
      const letter = options.at(-1)[0];
      byId(h, tree, `option-row-${letter}`).props.onPress();
      tree = draw();
      assert.equal(s.answerText("a"), letter);
      assert.match(h.text(byId(h, tree, "option-send")), new RegExp(`Send ${letter}`));
      byId(h, tree, `option-row-${letter}`).props.onPress();
    }
  }
});

test("letter-number questions display their choices and send their original identifiers", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } }, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const text = `A3 First?
A One (recommended)
B Two
C Three

**A12** Second?
A Red
B Blue (recommended)
C Green
D Yellow`;
  const draw = () => h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text } }, timestamp: new Date(10), theme: { colors: {} } } }, "reply-10");
  let tree = draw();
  assert.ok(byId(h, tree, "option-card"));
  assert.match(h.text(byId(h, tree, "option-row-A")), /One[\s\S]*Recommended/);
  assert.match(h.text(byId(h, tree, "option-row-C")), /Three/);
  byId(h, tree, "option-row-A").props.onPress();
  byId(h, draw(), "option-next").props.onPress();
  tree = draw();
  assert.match(h.text(byId(h, tree, "option-row-B")), /Blue[\s\S]*Recommended/);
  assert.match(h.text(byId(h, tree, "option-row-D")), /Yellow/);
  byId(h, tree, "option-row-B").props.onPress();
  const calls = [];
  s.setOptionSender(async (agent, answer) => { calls.push([agent, answer]); });
  byId(h, draw(), "option-send").props.onPress();
  await flush();
  assert.deepEqual(calls, [["a", "A3A A12B"]]);
});

test("a numbered question without a hint displays the card", t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } }, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const tree = h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text: "1. Which database?\nA One\nB Two" } }, timestamp: new Date(10), theme: { colors: {} } } }, "baseline");
  assert.ok(byId(h, tree, "option-card"));
  assert.match(h.text(byId(h, tree, "option-row-A")), /One/);
  assert.match(h.text(byId(h, tree, "option-row-B")), /Two/);
});

test("option selection, navigation, notes, collapse and dismissal", t => {
  const { h, s, draw } = fixture(t);
  let tree = draw();
  const rowB = byId(h, tree, "option-row-B");
  assert.equal(rowB.props.accessibilityState.selected, false);
  assert.match(h.text(rowB), /Recommended/);
  assert.equal(s.getOptionSession("a").cursor[0], 1);
  assert.match(h.text(byId(h, tree, "option-send")), /Choose 1 to send/);
  byId(h, tree, "option-note-toggle").props.onPress();
  tree = draw();
  byId(h, tree, "option-note").props.onChangeText("needs a server");
  tree = draw();
  assert.match(h.text(byId(h, tree, "option-note-warning")), /Choose an option first/);
  byId(h, tree, "option-row-B").props.onPress();
  tree = draw();
  assert.equal(byId(h, tree, "option-row-B").props.accessibilityState.selected, true);
  assert.match(h.text(byId(h, tree, "option-send")), /Choose 2 to send/);
  byId(h, tree, "option-row-B").props.onPress();
  assert.equal(s.getOptionSession("a").choices[0], undefined);
  byId(h, draw(), "option-row-B").props.onPress();
  byId(h, draw(), "option-next").props.onPress();
  tree = draw();
  assert.equal(s.getOptionSession("a").activeQuestion, 1);
  byId(h, tree, "option-row-A").props.onPress();
  tree = draw();
  assert.equal(h.text(byId(h, tree, "option-send")), `Send ${s.answerText("a")}`);
  byId(h, tree, "option-question-0").props.onPress();
  assert.equal(s.getOptionSession("a").activeQuestion, 0);
  byId(h, draw(), "option-card-collapse").props.onPress();
  tree = draw();
  assert.ok(byId(h, tree, "option-card-strip"));
  byId(h, tree, "option-card-strip").props.onPress();
  assert.ok(byId(h, draw(), "option-card"));
  byId(h, draw(), "option-dismiss").props.onPress();
  assert.equal(byId(h, draw(), "option-card"), undefined);
});

test("send reports failure, prevents double sends, and removes the card on success", async t => {
  const { h, s, draw } = fixture(t);
  draw();
  s.choose("a", 0, "B"); s.choose("a", 1, "A");
  let reject, resolve;
  const calls = [];
  s.setOptionSender((agent, text) => { calls.push([agent, text]); return new Promise((ok, fail) => { resolve = ok; reject = fail; }); });
  const send = byId(h, draw(), "option-send");
  send.props.onPress(); send.props.onPress();
  assert.equal(calls.length, 1);
  assert.equal(byId(h, draw(), "option-send").props.disabled, true);
  reject(new Error("Unavailable"));
  await flush();
  assert.match(h.text(byId(h, draw(), "option-send-error")), /Unavailable/);
  byId(h, draw(), "option-send").props.onPress();
  assert.equal(calls.length, 2);
  resolve();
  await flush();
  assert.equal(byId(h, draw(), "option-card"), undefined);
});


test("a pending send for an older reply cannot dismiss a newer card", async t => {
  const { h, s, draw } = fixture(t);
  draw();
  s.choose("a", 0, "B"); s.choose("a", 1, "A");
  let resolve;
  let calls = 0;
  s.setOptionSender(() => { calls++; return new Promise(ok => { resolve = ok; }); });
  byId(h, draw(), "option-send").props.onPress();
  s.publishAssistantReply("a", { at: 11, text: reply });
  s.choose("a", 0, "A"); s.choose("a", 1, "B");
  byId(h, draw(11), "option-send").props.onPress();
  await flush();
  assert.equal(calls, 1);
  assert.ok(byId(h, draw(11), "option-card"));
  resolve();
  await flush();
  assert.ok(byId(h, draw(11), "option-card"));
});

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: answer card renders translated controls`, t => {
    const h = createToolHarness("ios", { locale, agents: { a: { status: "idle" } } });
    t.after(() => { h.unmount(); h.dispose(); });
    const s = h.load("client/option-session.ts");
    const Card = h.load("client/components/option-card.tsx").OptionCard;
    const strings = require(`../client/locales/${locale}.json`).answerCard;
    s.publishAssistantReply("a", { at: 10, text: reply });
    const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    for (const value of [strings.detected, strings.recommended, strings.writeOwn, strings.next, strings.notOptions]) assert.ok(h.text(tree).includes(value));
    assert.equal(byId(h, tree, "option-card-collapse").props.accessibilityLabel, strings.collapse);
  });
}

test("popover bounds its scrolling middle while keeping the header and send row visible", async t => {
  const agents = { a: { status: "idle" } };
  const h = createToolHarness("ios", { dimensions: { height: 844 }, agents });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const { OptionCard: Card, POPOVER_MAX_HEIGHT_RATIO } = h.load("client/components/option-card.tsx");
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = (popover = true) => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, popover } });
  const scrollOf = tree => h.nodes(tree, node => node.type === "ScrollView")[0];
  let tree = draw();
  let scroll = scrollOf(tree);
  assert.equal(POPOVER_MAX_HEIGHT_RATIO, 0.65);
  assert.equal(byId(h, tree, "option-popover").props.style.maxHeight, 844 * 0.65);
  assert.deepEqual(scroll.props.style, { flexShrink: 1, minHeight: 0 });
  for (const id of ["option-question-0", "option-question-1", "option-send"]) {
    assert.ok(byId(h, tree, id));
    assert.equal(byId(h, scroll, id), undefined);
  }
  for (const id of ["option-row-A", "option-row-B", "option-note-toggle", "option-next", "option-dismiss"]) assert.ok(byId(h, scroll, id));
  assert.match(h.text(scroll), /Which storage\?\s+More details\./);
  assert.match(h.text(tree), /detected/i);
  assert.doesNotMatch(h.text(scroll), /detected/i);
  for (const id of ["option-question-0", "option-question-1", "option-row-A", "option-row-B", "option-note-toggle", "option-next", "option-dismiss", "option-send"]) {
    const node = byId(h, tree, id);
    assert.ok(node.props.style.minHeight >= 44, id);
    // Rows and full-width buttons stretch to the available width; tabs set a minimum width.
    if (id.startsWith("option-question-") || !id.startsWith("option-row-")) assert.ok(node.props.style.minWidth >= 44, id);
  }
  let send = byId(h, tree, "option-send");
  assert.equal(send.props.disabled, true);
  assert.equal(send.props.accessibilityState.disabled, true);
  byId(h, tree, "option-note-toggle").props.onPress();
  tree = draw();
  byId(h, tree, "option-note").props.onChangeText("note");
  tree = draw();
  assert.ok(byId(h, scrollOf(tree), "option-note"));
  assert.ok(byId(h, scrollOf(tree), "option-note-warning"));
  s.choose("a", 0, "B"); s.choose("a", 1, "A");
  tree = draw();
  assert.equal(byId(h, tree, "option-send").props.disabled, false);
  let reject;
  s.setOptionSender(() => new Promise((_, fail) => { reject = fail; }));
  byId(h, tree, "option-send").props.onPress();
  assert.equal(byId(h, draw(), "option-send").props.disabled, true);
  reject(new Error("Unavailable"));
  await flush();
  tree = draw();
  assert.ok(byId(h, scrollOf(tree), "option-send-error"));
  assert.equal(byId(h, tree, "option-send").props.disabled, false);
  agents.a.status = "running";
  tree = draw(); scroll = scrollOf(tree);
  assert.ok(byId(h, tree, "option-running"));
  assert.equal(byId(h, scroll, "option-running"), undefined);
  assert.equal(byId(h, tree, "option-send").props.disabled, true);
  assert.equal(byId(h, tree, "option-send").props.accessibilityState.disabled, true);
  h.dimensions.height = 200;
  assert.equal(byId(h, draw(), "option-popover").props.style.maxHeight, 200);
});

test("card keeps its existing height and controls inside the scroll view", t => {
  const h = createToolHarness("ios", { dimensions: { height: 640 }, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  let tree = draw();
  const card = byId(h, tree, "option-card");
  const scroll = h.nodes(card, node => node.type === "ScrollView")[0];
  assert.equal(card.props.style.maxHeight, 640 * 0.4);
  assert.equal(scroll.props.style, undefined);
  for (const id of ["option-question-0", "option-question-1", "option-card-collapse", "option-row-A", "option-row-B", "option-note-toggle", "option-next", "option-dismiss", "option-send"]) assert.ok(byId(h, scroll, id), id);
  h.dimensions.height = 200;
  tree = draw();
  assert.equal(byId(h, tree, "option-card").props.style.maxHeight, 100);
});

test("a numbered question with no hint and no recommendation shows no card", async t => {
  const h = createToolHarness("ios", { agents: { a: { status: "idle" } }, preferences: { showAnswerCard: true } });
  t.after(() => { h.unmount(); h.dispose(); });
  const Renderer = h.load("client/live-renderers.tsx").LiveAssistantRenderer;
  const text = `1. Which database?\nA One\nB Two`;
  const tree = h.draw({ type: Renderer, props: { agentId: "a", host: { id: "host" }, item: { data: { text } }, timestamp: new Date(77), theme: { colors: {} } } }, "reply-77");
  assert.equal(byId(h, tree, "option-card"), undefined);
});
