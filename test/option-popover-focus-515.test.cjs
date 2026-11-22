const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) Which rollout?
A Blue-green
B Canary

2) Which database?
A Postgres
B SQLite

Reply with a letter for each.`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function fixture(t) {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } }, globals: { matchMedia: () => ({ matches: true }) } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  return { h, s, draw: () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface: "popover" } }) };
}

test("focusing an option below the popover viewport scrolls only the question body", async t => {
  const { h, s, draw } = fixture(t);
  const row = {
    focus() {},
    closest: selector => selector === '[data-testid="option-question-scroll"]' ? scroller : null,
    getBoundingClientRect: () => ({ top: 250, bottom: 300, left: 0, right: 100 }),
  };
  const scroller = {
    style: {}, scrollTop: 0, clientHeight: 200, scrollHeight: 600,
    getBoundingClientRect: () => ({ top: 0, bottom: 200, left: 0, right: 320 }),
  };
  const card = {
    style: {}, clientTop: 0, clientLeft: 0,
    querySelector: selector => selector === '[data-testid="option-row-B"]' ? row : null,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: 300 }),
    appendChild() {}, animate() {},
  };
  const tree = draw();
  byId(h, tree, "option-card").props.ref(card);
  // Drive with the keyboard: ArrowDown from A moves the cursor to B.
  byId(h, tree, "option-card").props.onKeyDown({
    key: "ArrowDown", target: { getAttribute: () => "option-row-A", closest: () => true },
    nativeEvent: {}, preventDefault() {}, stopPropagation() {},
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(scroller.scrollTop > 0, `the focused row must be revealed, scrollTop=${scroller.scrollTop}`);
  assert.equal(s.getOptionSession("a").activeQuestion, 0, "precondition: the arrow only moves within Q1");
});

test("choosing an option that advances to the next question resets the popover scroll", async t => {
  const { h, draw } = fixture(t);
  const row = {
    focus() {},
    closest: () => null,
    getBoundingClientRect: () => ({ top: 20, bottom: 70, left: 0, right: 100 }),
  };
  const scroller = {
    style: {}, scrollTop: 180, clientHeight: 200, scrollHeight: 600,
    getBoundingClientRect: () => ({ top: 0, bottom: 200, left: 0, right: 320 }),
  };
  const card = {
    style: {}, clientTop: 0, clientLeft: 0,
    querySelector: selector => selector === '[data-testid="option-question-scroll"]' ? scroller : selector === '[data-testid="option-row-A"]' ? row : null,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: 300 }),
    appendChild() {}, animate() {},
  };
  const tree = draw();
  byId(h, tree, "option-card").props.ref(card);
  byId(h, tree, "option-row-A").props.onPress();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(scroller.scrollTop, 0, `a new question starts at the top, scrollTop=${scroller.scrollTop}`);
});
