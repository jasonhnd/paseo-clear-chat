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
