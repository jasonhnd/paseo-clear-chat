const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const one = "1) Pick?\nA One\nB Two\n\nI recommend B";
const two = "1) Pick?\nA One\nB Two\n\n2) Next?\nA Yes\nB No\n\nReply: A";

function fixture(t, options) {
  const h = createToolHarness("web", options);
  const store = h.load("client/option-session.ts");
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, s: store };
}

test("orders observations independently, retires stale replies and resets state", t => {
  const { s } = fixture(t);
  s.publishAssistantReply("a", { at: 10, text: one });
  s.choose("a", 0, "A");
  s.setNote("a", 0, "note");
  s.moveCursor("a", 0, -1);
  const initial = s.getOptionSession("a");
  s.publishAssistantReply("a", { at: 9, text: two });
  s.publishAssistantReply("a", { at: 10, text: two });
  s.publishUserMessage("a", 9);
  s.publishUserMessage("a", 9);
  assert.equal(s.getOptionSession("a"), initial);
  s.publishUserMessage("a", 10);
  assert.equal(s.getOptionSession("a"), null);
  s.publishAssistantReply("a", { at: 10, text: one });
  assert.equal(s.getOptionSession("a"), null);
  s.publishAssistantReply("a", { at: 11, text: two });
  assert.deepEqual(s.getOptionSession("a").choices, {});
  assert.deepEqual(s.getOptionSession("a").notes, {});
  assert.deepEqual(s.getOptionSession("a").cursor, [0, 0]);
  assert.equal(s.getOptionSession("a").activeQuestion, 0);
  s.publishAssistantReply("a", { at: 12, text: "plain reply" });
  assert.equal(s.getOptionSession("a"), null);
  s.publishAssistantReply("a", { at: 11, text: one });
  assert.equal(s.getOptionSession("a"), null);
  s.publishUserMessage("b", 20);
  s.publishAssistantReply("b", { at: 20, text: one });
  assert.equal(s.getOptionSession("b"), null);
  s.publishAssistantReply("b", { at: 21, text: one });
  s.publishUserMessage("b", 19);
  assert.ok(s.getOptionSession("b"));
  s.publishUserMessage("b", 22);
  assert.equal(s.getOptionSession("b"), null);
});

test("choices, notes, cursor, dismissal and formatted answers", t => {
  const { s } = fixture(t);
  s.publishAssistantReply("a", { at: 1, text: one });
  assert.deepEqual(s.getOptionSession("a").cursor, [1]);
  assert.equal(s.missingQuestion("a"), 0);
  assert.equal(s.answerText("a"), null);
  s.choose("a", 0, "C");
  assert.equal(s.missingQuestion("a"), 0);
  s.moveCursor("a", 0, 10);
  assert.equal(s.getOptionSession("a").cursor[0], 1);
  s.moveCursor("a", 0, -10);
  s.moveCursor("a", 0, -1);
  assert.equal(s.getOptionSession("a").cursor[0], 0);
  s.choose("a", 0, "B");
  assert.equal(s.answerText("a"), "1B");
  s.setNote("a", 0, "first\nsecond\r\nthird");
  assert.equal(s.answerText("a"), "1B (first second third)");
  s.clearChoice("a", 0);
  assert.equal(s.answerText("a"), null);
  s.publishAssistantReply("a", { at: 2, text: two });
  s.setActiveQuestion("a", 1);
  assert.equal(s.getOptionSession("a").activeQuestion, 1);
  s.setNote("a", 1, "not chosen");
  s.choose("a", 0, "B");
  assert.equal(s.missingQuestion("a"), 1);
  assert.equal(s.answerText("a"), null);
  s.choose("a", 1, "A");
  assert.equal(s.answerText("a"), "1B 2A (not chosen)");
  assert.equal(s.missingQuestion("a"), null);
  s.dismiss("a");
  assert.equal(s.getOptionSession("a"), null);
  s.publishAssistantReply("a", { at: 2, text: two });
  assert.equal(s.getOptionSession("a"), null);
  s.publishAssistantReply("a", { at: 3, text: one });
  assert.ok(s.getOptionSession("a"));
});

test("send handles pending, failures, retries, missing sender and replacement", async t => {
  const { s } = fixture(t);
  s.publishAssistantReply("a", { at: 1, text: one });
  s.choose("a", 0, "B");
  s.setNote("a", 0, "note\nline");
  let reject;
  const calls = [];
  s.setOptionSender((...args) => { calls.push(args); return new Promise((_, r) => { reject = r; }); });
  const first = s.sendAnswer("a");
  assert.equal(s.getOptionSession("a").sending, true);
  await s.sendAnswer("a");
  assert.deepEqual(calls, [["a", "1B (note line)"]]);
  reject(new Error("Unavailable"));
  await first;
  assert.equal(s.getOptionSession("a").error, "Unavailable");
  assert.equal(s.getOptionSession("a").choices[0], "B");
  s.setOptionSender(null);
  await s.sendAnswer("a");
  assert.equal(s.getOptionSession("a").error, "Sender unavailable");
  assert.equal(calls.length, 1);
  s.setOptionSender(async (...args) => { calls.push(args); });
  await s.sendAnswer("a");
  assert.equal(s.getOptionSession("a").error, null);
  assert.equal(s.getOptionSession("a").sending, false);
  let resolve;
  s.setOptionSender(() => new Promise(r => { resolve = r; }));
  const old = s.sendAnswer("a");
  s.publishAssistantReply("a", { at: 2, text: two });
  resolve();
  await old;
  assert.equal(s.getOptionSession("a").at, 2);
  assert.equal(s.getOptionSession("a").sending, false);
  assert.deepEqual(s.getOptionSession("a").choices, {});
});

test("notifies once per change and isolates throwing listeners", t => {
  const { s } = fixture(t);
  let count = 0;
  const stopThrow = s.subscribeOptionSession(() => { throw new Error("listener"); });
  const stop = s.subscribeOptionSession(() => { count++; });
  s.publishAssistantReply("a", { at: 1, text: one });
  s.publishAssistantReply("a", { at: 1, text: one });
  s.choose("a", 0, "A");
  s.choose("a", 0, "A");
  s.choose("a", 0, "Z");
  s.moveCursor("a", 0, 1);
  s.publishUserMessage("a", 1);
  s.publishUserMessage("a", 1);
  assert.equal(count, 3);
  stopThrow(); stop();
  s.publishAssistantReply("a", { at: 2, text: one });
  assert.equal(count, 3);
});

test("renderer effects publish only ordinary owned messages and cleanup removes sender", async t => {
  const calls = [];
  const paseo = { agents: { ref: agent => ({ refresh: async () => null, send: async text => { calls.push([agent, text]); } }) } };
  const { h, s } = fixture(t, { paseo, systemEnvelope: true, agents: { a: { status: "idle" } } });
  const { LiveAssistantRenderer, LiveUserMessageRenderer } = h.load("client/live-renderers.tsx");
  const observed = [];
  for (const name of ["publishAssistantReply", "publishUserMessage"]) {
    const publish = s[name];
    s[name] = (...args) => { observed.push([name, ...args]); publish(...args); };
  }
  let count = 0;
  const stop = s.subscribeOptionSession(() => { count++; });
  t.after(stop);
  function draw(Component, text, at, key) {
    h.draw({ type: Component, props: { agentId: "a", host: { id: "host" }, item: { data: { text } }, theme: { colors: {} }, timestamp: new Date(at) } }, key);
  }
  draw(LiveAssistantRenderer, one, 10, "reply");
  draw(LiveAssistantRenderer, one, 10, "reply");
  assert.equal(count, 1);
  assert.equal(observed.length, 1);
  draw(LiveAssistantRenderer, one + "\nExtra", 10, "reply");
  assert.equal(observed.length, 2);
  draw(LiveAssistantRenderer, "<system-notice>\n" + two + "\n</system-notice>", 11, "reply");
  assert.equal(s.getOptionSession("a").at, 10);
  draw(LiveUserMessageRenderer, "<system-notice>notice</system-notice>", 12, "user");
  assert.equal(s.getOptionSession("a").at, 10);
  draw(LiveUserMessageRenderer, "hello", 13, "user");
  draw(LiveUserMessageRenderer, "hello", 13, "user");
  assert.equal(observed.length, 3);
  assert.equal(s.getOptionSession("a"), null);
  assert.equal(count, 2);
  draw(LiveAssistantRenderer, two, 14, "reply");
  s.choose("a", 0, "A"); s.choose("a", 1, "B");
  await s.sendAnswer("a");
  assert.deepEqual(calls, [["a", "1A 2B"]]);
  h.dispose();
  await s.sendAnswer("a");
  assert.equal(calls.length, 1);
  assert.equal(s.getOptionSession("a").error, "Sender unavailable");
  const transform = h.transformers.get("assistant_message").transform;
  h.preferences.assistantMarkdown = false;
  assert.equal(transform({ item: { type: "assistant_message", text: one } }), undefined);
  h.preferences.assistantMarkdown = true;
  h.preferences.delegatedCodeBlocks = "chart";
  assert.equal(transform({ item: { type: "assistant_message", text: `${one}\n\`\`\`chart\ndata\n\`\`\`` } }), undefined);
});
