const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const content = "A deliberately long custom answer that begins with CUSTOMBODY and continues for a while so the preview has to shorten it without losing the start.";

function fixture(t) {
  const h = createToolHarness("web", { width: 1280, height: 900, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: "Pick?\nA One\nB Two\n\nReply: A" });
  s.openCustom("a", 0);
  s.setCustomDraft("a", 0, content);
  assert.equal(s.confirmCustom("a", 0), "confirmed");
  return { h, s, Card };
}

test("the popover preview shows the answer index and the start of the written answer", t => {
  const { h, Card } = fixture(t);
  const tree = h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface: "popover" } });
  const preview = h.nodes(tree, node => node.props.testID === "option-send-preview")[0];
  assert.ok(preview, "precondition: the preview renders");
  const lines = h.text(preview).split("\n").map(line => line.trim()).filter(Boolean);
  assert.equal(lines[0], "1C", "the first line is the answer index");
  assert.match(lines[1], /^1C：CUSTOMBODY/, `the second line starts the written answer, got ${lines[1]}`);
});

test("shortening the preview does not change the sent message", async t => {
  const { h, s, Card } = fixture(t);
  h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens, surface: "popover" } });
  let sent = null;
  s.setOptionSender(async (_agentId, message) => { sent = message; });
  await s.sendAnswer("a");
  assert.equal(sent, `1C\n\n1C：\n${content}`, "the sent message keeps the original custom-answer layout");
});
