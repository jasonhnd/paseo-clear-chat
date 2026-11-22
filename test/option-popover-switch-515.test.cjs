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

test("switching questions returns the popover body to its top", t => {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } }, globals: { matchMedia: () => ({ matches: true }) } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const scroller = {
    style: {}, scrollTop: 180, clientHeight: 200, scrollHeight: 600,
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }), addEventListener() {}, removeEventListener() {},
  };
  const content = {
    style: {}, getBoundingClientRect: () => ({ top: 120, left: 10, width: 380, height: 500 }),
    cloneNode: () => ({ style: {}, setAttribute() {}, querySelectorAll: () => [], remove() {}, animate: () => ({ cancel() {}, finished: Promise.resolve() }) }),
    animate: () => ({ cancel() {}, finished: Promise.resolve() }),
  };
  const card = {
    style: {}, clientTop: 0, clientLeft: 0,
    querySelector: selector => selector === '[data-testid="option-question-scroll"]' ? scroller : selector === '[data-testid="option-question-content"]' ? content : null,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 380, height: 400 }),
    appendChild() {}, animate() {},
  };
  const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface: "popover" } });
  byId(h, tree, "option-card").props.ref(card);
  byId(h, tree, "option-question-1").props.onPress();
  assert.equal(s.getOptionSession("a").activeQuestion, 1, "precondition: the card moved to Q2");
  assert.equal(scroller.scrollTop, 0, `a new question starts at the top, scrollTop=${scroller.scrollTop}`);
});
