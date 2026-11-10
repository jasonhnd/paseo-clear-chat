const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const QUESTION = '[data-testid="option-question-0"]';

function fixture(t, { reducedMotion = false, hideQuestionTab = false, stickAfter = 1 } = {}) {
  const globals = Object.create(globalThis);
  globals.matchMedia = () => ({ matches: reducedMotion });
  globals.requestAnimationFrame = callback => setTimeout(callback, 0);
  globals.cancelAnimationFrame = clearTimeout;
  const h = createToolHarness("web", { agents: { a: { status: "idle" } }, globals });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  let tree, active = "BODY", questionTries = 0;
  const focusedSelectors = [];
  const docCalls = [];
  const body = { tagName: "BODY" };
  globals.document = {
    body,
    activeElement: body,
    querySelectorAll(selector) {
      docCalls.push(selector);
      return [{
        isConnected: true,
        tagName: "DIV",
        getClientRects: () => [{}],
        focus() { active = "other-card"; globals.document.activeElement = this; },
      }];
    },
  };
  const card = { querySelector(selector) {
    const id = selector.match(/"([^"]+)"/)?.[1];
    if (hideQuestionTab && id === "option-question-0") return null;
    return {
      get disabled() { return !!byId(h, tree, id)?.props.disabled; },
      getAttribute(name) { return name === "data-testid" ? id : null; },
      focus() {
        focusedSelectors.push(selector);
        const node = byId(h, tree, id);
        if (id === "option-question-0") {
          questionTries += 1;
          if (questionTries < stickAfter) {
            globals.document.activeElement = { tagName: "BUTTON", getAttribute: (name) => name === "data-testid" ? "option-send" : null };
            return;
          }
        }
        active = id;
        globals.document.activeElement = this;
        node?.props.onFocus?.({ stopPropagation() {} });
      },
      blur() { if (active === id) active = "BODY"; byId(h, tree, id)?.props.onBlur?.({ stopPropagation() {} }); },
    };
  } };
  const draw = (props = {}) => {
    const agentId = props.agentId ?? "a";
    tree = h.draw({ type: Card, props: { agentId, at: 10, tokens: h.tokens } });
    const node = byId(h, tree, "option-card");
    if (node) node.props.ref(card);
    return tree;
  };
  const press = id => byId(h, draw(), id).props.onPress();
  const clickSend = () => {
    const button = byId(h, draw(), "option-send");
    const sendNode = card.querySelector('[data-testid="option-send"]');
    active = "option-send";
    globals.document.activeElement = sendNode;
    button.props.onFocus();
    button.props.onPress();
  };
  return {
    h, s, draw, press, clickSend, focusedSelectors, docCalls,
    focusElsewhere: () => {
      active = "outside";
      globals.document.activeElement = { tagName: "BUTTON", getAttribute: () => null };
    },
    active: () => active,
    Card,
  };
}

async function draft(f) {
  f.press("option-row-C");
  f.draw();
  await tick();
  byId(f.h, f.draw(), "option-custom-input").props.onChangeText("draft answer");
}

async function answerLast(f) {
  f.press("option-question-1");
  f.press("option-row-A");
  f.press("option-question-0");
  await draft(f);
}

test("Send confirms a draft and focuses the first control on the next unanswered question", async t => {
  const f = fixture(t);
  // The cursor (including its recommended-option initial value) must not choose the target.
  f.s.moveCursor("a", 1, 1);
  await draft(f);
  f.clickSend();
  const tree = f.draw();
  await tick();
  assert.equal(f.s.getOptionSession("a").activeQuestion, 1);
  assert.equal(byId(f.h, tree, "option-send").props.accessibilityState.disabled, true);
  assert.equal(f.active(), "option-row-A");
  assert.notEqual(f.active(), "option-send");
  assert.notEqual(f.active(), "BODY");
  assert.equal(byId(f.h, f.draw(), "option-send").props.style[1].outlineStyle, "none");
});

test("Send confirming the last draft leaves disabled Send and focuses the first read-only tab", async t => {
  const f = fixture(t);
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  let tree = f.draw();
  assert.equal(byId(f.h, tree, "option-send").props.accessibilityState.disabled, true);
  assert.notEqual(f.active(), "option-send");
  assert.equal(byId(f.h, tree, "option-send").props.style[1].outlineStyle, "none");
  resolveSend();
  await tick();
  tree = f.draw();
  await tick();
  assert.equal(f.s.getOptionSession("a", 10).readOnly, true);
  const tab = byId(f.h, tree, "option-question-0");
  assert.ok(tab);
  assert.equal(tab.props.focusable, true);
  assert.equal(tab.props.tabIndex, 0);
  assert.ok(f.focusedSelectors.includes(QUESTION));
  assert.equal(f.active(), "option-question-0");
  assert.notEqual(f.active(), "BODY");
});

test("a rejected send does not steal focus on a later read-only transition", async t => {
  const f = fixture(t);
  await answerLast(f);
  // The real sendAnswer absorbs sender errors, so inject a rejected sendAnswer.
  // Handle its derived promise too, allowing the base implementation to be tested.
  const rejected = Promise.reject(new Error("Send failed"));
  const then = rejected.then.bind(rejected);
  rejected.then = (...args) => {
    const result = then(...args);
    result.catch(() => {});
    return result;
  };
  f.s.sendAnswer = () => rejected;
  f.clickSend();
  await tick();
  assert.equal(f.s.getOptionSession("a").readOnly, false);
  f.focusElsewhere();
  f.s.publishUserMessage("a", 20, "1A 2A");
  f.draw();
  await tick();
  assert.equal(f.s.getOptionSession("a", 10).readOnly, true);
  assert.equal(f.active(), "outside");
});

test("an absorbed sender failure restores focus to the enabled Send button", async t => {
  const f = fixture(t);
  await answerLast(f);
  f.s.setOptionSender(async () => { throw new Error("Sender failed"); });
  f.clickSend();
  await Promise.resolve();
  await Promise.resolve();
  f.draw();
  await tick();
  const session = f.s.getOptionSession("a");
  assert.equal(session.error, "Sender failed");
  assert.equal(session.sending, false);
  assert.equal(session.readOnly, false);
  assert.equal(byId(f.h, f.draw(), "option-send").props.disabled, false);
  assert.notEqual(f.active(), "BODY");
  assert.equal(f.active(), "option-send");
});

test("a successful tab focus is not taken back from another control", async t => {
  const f = fixture(t);
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  resolveSend();
  await tick();
  f.draw();
  await tick();
  assert.equal(f.active(), "option-question-0");
  const calls = f.focusedSelectors.length;
  f.focusElsewhere();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.active(), "outside");
  assert.equal(f.focusedSelectors.length, calls);
  assert.equal(f.docCalls.length, 0);
});

test("a missing tab never looks up another card in the document", async t => {
  const f = fixture(t, { hideQuestionTab: true });
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  resolveSend();
  await tick();
  f.draw();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.docCalls.length, 0);
  assert.notEqual(f.active(), "other-card");
});

test("unmount and an agent change drop the pending focus entry", async t => {
  const f = fixture(t);
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  f.focusedSelectors.length = 0;
  f.draw({ agentId: "b" });
  f.h.unmount();
  resolveSend();
  await tick();
  f.draw();
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.docCalls.length, 0);
  assert.ok(!f.focusedSelectors.includes(QUESTION));
  assert.notEqual(f.active(), "option-question-0");
});

test("does not move focus when the user is already on another control", async t => {
  const f = fixture(t);
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  f.focusedSelectors.length = 0;
  f.focusElsewhere();
  resolveSend();
  await tick();
  f.draw();
  await tick();
  assert.ok(!f.focusedSelectors.includes(QUESTION));
  assert.equal(f.active(), "outside");
});

test("retries when focus stays on Send", async t => {
  const f = fixture(t, { stickAfter: 2 });
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  resolveSend();
  await tick();
  f.draw();
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(f.focusedSelectors.filter(selector => selector === QUESTION).length >= 2);
  assert.equal(f.active(), "option-question-0");
});

test("another card leaving does not clear this card's pending focus", async t => {
  const f = fixture(t);
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  f.focusedSelectors.length = 0;
  const Pair = ({ other }) => [
    { type: f.Card, props: { agentId: "a", at: 10, tokens: f.h.tokens } },
    { type: f.Card, props: { agentId: other, at: 20, tokens: f.h.tokens } },
  ];
  f.h.draw({ type: Pair, props: { other: "a" } });
  f.h.draw({ type: Pair, props: { other: "b" } });
  resolveSend();
  await tick();
  f.draw();
  await tick();
  assert.ok(f.focusedSelectors.includes(QUESTION));
});

function assertNoSendRing(f) {
  const send = byId(f.h, f.draw(), "option-send");
  assert.equal(send.props.accessibilityState.disabled, true);
  assert.equal(send.props.style[1].outlineStyle, "none");
  assert.ok(!send.props.style.some(style => style?.boxShadow && style.boxShadow !== "none"));
}

test("reduced motion leaves no Send focus ring after a non-last draft", async t => {
  const f = fixture(t, { reducedMotion: true });
  await draft(f);
  f.clickSend();
  assertNoSendRing(f);
  await tick();
});

test("reduced motion leaves no Send focus ring while the last send is pending", async t => {
  const f = fixture(t, { reducedMotion: true });
  await answerLast(f);
  let resolveSend;
  f.s.setOptionSender(() => new Promise(resolve => { resolveSend = resolve; }));
  f.clickSend();
  assertNoSendRing(f);
  resolveSend();
  await tick();
});
