const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function fixture(t) {
  const h = createToolHarness("web", { agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  let tree, active = "BODY";
  const card = { querySelector(selector) {
    const id = selector.match(/"([^"]+)"/)?.[1];
    return {
      focus() { active = id; byId(h, tree, id)?.props.onFocus?.({ stopPropagation() {} }); },
      blur() { if (active === id) active = "BODY"; byId(h, tree, id)?.props.onBlur?.({ stopPropagation() {} }); },
    };
  } };
  const draw = () => {
    tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
    byId(h, tree, "option-card").props.ref(card);
    return tree;
  };
  const press = id => byId(h, draw(), id).props.onPress();
  const clickSend = () => {
    const button = byId(h, draw(), "option-send");
    active = "option-send";
    button.props.onFocus();
    button.props.onPress();
  };
  return { h, s, draw, press, clickSend, active: () => active };
}

async function draft(f) {
  f.press("option-row-C");
  f.draw();
  await tick();
  byId(f.h, f.draw(), "option-custom-input").props.onChangeText("draft answer");
}

test("Send confirms a draft and focuses the saved cursor on the next unanswered question", async t => {
  const f = fixture(t);
  f.s.moveCursor("a", 1, 1);
  await draft(f);
  f.clickSend();
  const tree = f.draw();
  await tick();
  assert.equal(f.s.getOptionSession("a").activeQuestion, 1);
  assert.equal(byId(f.h, tree, "option-send").props.accessibilityState.disabled, true);
  assert.equal(f.active(), "option-row-B");
  assert.notEqual(f.active(), "option-send");
  assert.equal(byId(f.h, f.draw(), "option-send").props.style[1].outlineStyle, "none");
});

test("Send confirming the last draft leaves disabled Send and focuses the first read-only tab", async t => {
  const f = fixture(t);
  f.press("option-question-1");
  f.press("option-row-A");
  f.press("option-question-0");
  await draft(f);
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
  assert.equal(byId(f.h, tree, "option-question-0").props.focusable, true);
  assert.equal(f.active(), "option-question-0");
});
