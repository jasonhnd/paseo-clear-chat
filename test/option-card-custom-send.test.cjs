const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reply = `1) First?
A One
B Two (recommended)
C Three
D Four

2) Second?
A One
B Two
C Three
D Four

3) Third?
A One
B Two
C Three
D Four

Reply: A`;
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function fixture(t, locale = "en") {
  const h = createToolHarness("web", { locale, width: 390, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const custom = (index, value) => { s.openCustom("a", index); s.setCustomDraft("a", index, value); assert.equal(s.confirmCustom("a", index), "confirmed"); };
  return { h, s, draw, custom };
}

test("the complete custom answer appears as selectable plain text and the button shows only the index", t => {
  const { h, s, draw, custom } = fixture(t);
  s.choose("a", 0, "B"); custom(1, "line one\nline two"); s.choose("a", 2, "A");
  const tree = draw();
  const preview = byId(h, tree, "option-send-preview");
  assert.equal(preview.type, "Text");
  assert.equal(preview.props.selectable, true);
  assert.equal(h.text(preview), "1B 2E 3A\n\n2E：\nline one\nline two");
  assert.equal(preview.props.style.fontSize, 13);
  assert.equal(h.text(byId(h, tree, "option-send")), "Send 1B 2E 3A");
});

test("multiple custom answers have separate blocks; ordinary answers have no preview", t => {
  const { h, s, draw, custom } = fixture(t);
  s.choose("a", 0, "B"); s.choose("a", 1, "A"); s.choose("a", 2, "A");
  assert.equal(byId(h, draw(), "option-send-preview"), undefined);
  custom(1, "first <b>plain</b>"); custom(2, "second\nline");
  assert.equal(h.text(byId(h, draw(), "option-send-preview")), "1B 2E 3E\n\n2E：\nfirst <b>plain</b>\n\n3E：\nsecond\nline");
});

test("two-question send label uses the index in English and Chinese", t => {
  for (const [locale, expected] of [["en", "Send 1B 2E"], ["zh-CN", "发送 1B 2E"]]) {
    const { h, s, draw, custom } = fixture(t, locale);
    s.getOptionSession("a").set.questions.pop();
    s.choose("a", 0, "B"); custom(1, "line one\nline two");
    assert.equal(h.text(byId(h, draw(), "option-send")), expected);
  }
});

test("sent custom text is read-only with a check, muted badge, and final status", async t => {
  const { h, s, draw, custom } = fixture(t);
  custom(0, "line one\nline two"); s.choose("a", 1, "A"); s.choose("a", 2, "A");
  s.setActiveQuestion("a", 0);
  s.setOptionSender(async () => {});
  await s.sendAnswer("a");
  const tree = draw();
  const row = byId(h, tree, "option-row-E");
  const content = h.nodes(row, node => node.type === "Text" && h.text(node) === "line one\nline two")[0];
  assert.ok(content);
  assert.equal(content.props.selectable, true);
  assert.match(h.text(row), /✓/);
  assert.equal(row.props.onPress, undefined);
  assert.equal(byId(h, tree, "option-custom-input"), undefined);
  assert.equal(byId(h, tree, "option-send"), undefined);
  assert.ok(byId(h, tree, "option-answered"));
  const status = byId(h, tree, "option-read-only-status");
  assert.equal(status.type, "Text");
  assert.equal(status.props.onPress, undefined);
  assert.equal(h.text(status), "Answered · read-only");
  const tabs = byId(h, tree, "option-tabs");
  const tabNodes = h.nodes(tabs, node => node.props.testID?.startsWith("option-question-") || node.props.testID === "option-read-only-status");
  assert.equal(tabNodes.at(-1), status);
  const badge = h.nodes(byId(h, tree, "option-row-B"), node => node.type === "Text" && h.text(node) === "Recommended")[0];
  assert.equal(badge.props.style.backgroundColor, "transparent");
  assert.equal(badge.props.style.color, h.tokens.foregroundMuted);
  for (const letter of "ABCDE") assert.equal(byId(h, tree, `option-row-${letter}`).props.style.backgroundColor, h.tokens.surface2);
});

test("all locales contain the approved read-only status", () => {
  for (const [locale, value] of Object.entries({ en: "Answered · read-only", "zh-CN": "已答 · 只读", ja: "回答済み · 読み取り専用" })) {
    assert.equal(JSON.parse(readFileSync(`client/locales/${locale}.json`, "utf8")).answerCard.readOnlyStatus, value);
  }
});
