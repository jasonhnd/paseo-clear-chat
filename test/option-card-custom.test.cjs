const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
function fixture(t, reply, platform = "web") {
  const h = createToolHarness(platform, { width: 390, agents: { a: { status: "idle" } } });
  t.after(() => { h.unmount(); h.dispose(); });
  const s = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  s.publishAssistantReply("a", { at: 10, text: reply });
  return { h, s, draw: () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } }) };
}

test("the extra row follows every set of original letters, including gaps and H", t => {
  for (const [letters, extra] of [["ABCD", "E"], ["ABC", "D"], ["ACE", "F"], ["ABH", "I"]]) {
    const { h, s, draw } = fixture(t, `Pick?\n${[...letters].map(c => `${c} Option ${c}`).join("\n")}\n\nReply: A`);
    let tree = draw();
    for (const letter of letters) assert.ok(byId(h, tree, `option-row-${letter}`));
    const row = byId(h, tree, `option-row-${extra}`);
    assert.ok(row);
    assert.match(h.text(row), /Other\s+Write your own answer/);
    assert.equal(byId(h, tree, "option-custom-input"), undefined);
    row.props.onPress();
    tree = draw();
    const input = byId(h, tree, "option-custom-input");
    assert.ok(input);
    assert.equal(input.props.multiline, true);
    input.props.onChangeText("own\nanswer");
    assert.equal(s.getOptionSession("a").customDrafts[0], "own\nanswer");
    assert.equal(byId(h, draw(), "option-custom-input").props.value, "own\nanswer");
    byId(h, draw(), `option-row-${letters[0]}`).props.onPress();
    assert.equal(byId(h, draw(), "option-custom-input"), undefined);
    s.publishUserMessage("a", 11, letters[0]);
    assert.ok(byId(h, draw(), `option-row-${extra}`));
  }
});

test("confirmed custom tab labels use nine Unicode code points and preserve ordinary tabs", t => {
  const reply = "1) First?\nA One\nB Two\n\n2) Second?\nA Yes\nB No\n\nReply: A";
  const { h, s, draw } = fixture(t, reply);
  assert.equal(h.text(byId(h, draw(), "option-question-0")), "Q1 · First");
  for (const [value, expected] of [["😀一二三四五六七八", "✓ 😀一二三四五六七八"], ["😀一二三四五六七八九", "✓ 😀一二三四五六七八…"], ["a\nb", "✓ a b"]]) {
    s.setActiveQuestion("a", 0);
    s.openCustom("a", 0);
    s.setCustomDraft("a", 0, value);
    assert.equal(s.confirmCustom("a", 0), "confirmed");
    s.setActiveQuestion("a", 0);
    assert.equal(h.text(byId(h, draw(), "option-question-0")), expected);
    s.setActiveQuestion("a", 1);
    assert.equal(h.text(byId(h, draw(), "option-question-0")), expected);
    assert.equal(h.text(byId(h, draw(), "option-question-1")), "Q2 · Second");
  }
  s.choose("a", 0, "B");
  assert.equal(h.text(byId(h, draw(), "option-question-0")), "✓ Two");
});

test("all three locales contain the approved labels", () => {
  for (const [locale, expected] of Object.entries({ en: ["Other", "Write your own answer", "Write your answer first"], "zh-CN": ["自己写", "写下你自己的回答", "请先写下你的回答"], ja: ["自分で書く", "自分の回答を書く", "先に回答を書いてください"] })) {
    const card = JSON.parse(readFileSync(`client/locales/${locale}.json`, "utf8")).answerCard;
    assert.deepEqual([card.other, card.otherHint, card.otherEmpty], expected);
  }
});
