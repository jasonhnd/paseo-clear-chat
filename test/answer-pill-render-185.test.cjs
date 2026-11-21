const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const TestRenderer = require("react-test-renderer");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The popover body is the only surface that reads the card through `useSyncExternalStore`.
// The hand-rolled harness replaces React with a stub, so it cannot see a store whose snapshot
// changes identity on every read; this file mounts the same read under real React, where that
// loop is React error #185 (Maximum update depth exceeded).

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fixture(t) {
  const h = createToolHarness("web", { locale: "en" });
  const session = h.load("client/option-session.ts");
  const pill = h.load("client/answer-pill.ts");
  const data = {};
  session.setAnswerDraftStore({ read: key => data[key], write: (key, value) => { data[key] = value; }, clear: key => { delete data[key]; } });
  t.after(() => { session.setAnswerDraftStore(null); h.unmount(); h.dispose(); });
  return { h, session, pill };
}

/** The data path `AnswerPillContent` uses: `useCurrentPillCard(agentId)` into a host node. */
function renderProbe(t, session, pill) {
  function Probe() {
    const read = React.useCallback(() => pill.currentPillCard("a"), [pill]);
    const card = React.useSyncExternalStore(session.subscribeOptionSession, read, read);
    return React.createElement("probe", { at: card ? card.at : null });
  }
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.map(value => String(value)).join(" ")); };
  let tree;
  try {
    React.act(() => { tree = TestRenderer.create(React.createElement(Probe)); });
  } finally {
    console.error = original;
  }
  t.after(() => { React.act(() => tree.unmount()); });
  return { tree, errors };
}

test("the pill body does not loop when React reads its snapshot", t => {
  const { session, pill } = fixture(t);
  session.publishAssistantReply("a", { at: 10, text: questions });
  const { tree, errors } = renderProbe(t, session, pill);
  assert.equal(errors.some(line => line.includes("getSnapshot")), false, `React warned that the snapshot is unstable: ${errors.join(" | ")}`);
  assert.equal(errors.some(line => line.includes("Maximum update depth")), false, `React looped: ${errors.join(" | ")}`);
  assert.equal(tree.root.findByType("probe").props.at, 10);
});

test("the same card state reads back as one object", t => {
  const { session, pill } = fixture(t);
  session.publishAssistantReply("a", { at: 10, text: questions });
  const first = pill.currentPillCard("a");
  assert.ok(first, "precondition: the card must exist");
  assert.equal(pill.currentPillCard("a"), first, "a snapshot handed to useSyncExternalStore must keep its identity");
  session.choose("a", 0, "B");
  const answered = pill.currentPillCard("a");
  assert.ok(answered, "precondition: the card is still open");
  assert.equal(answered, pill.currentPillCard("a"), "the answered count changes the snapshot once, then it holds");
  assert.notEqual(answered, first, "a changed answer count must produce a new snapshot");
  assert.equal(answered.answeredCount, 1);
});
