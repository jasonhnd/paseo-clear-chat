const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness("ios", { markdown: true });
const renderedKinds = new Set();
const byId = (tree, id) => h.nodes(tree, node => node.props.testID === id);

function replay(file, context) {
  const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", file), "utf8"));
  let toolCalls = 0, cardCount = 0, emptyCards = 0, genericCalls = 0, replies = 0, replyTools = 0;
  for (const [index, item] of fixture.items.entries()) {
    const identity = item.callId ?? item.id ?? `item-${index}`;
    if (item.type === "assistant_message") {
      const { tree } = h.mount(item, false);
      assert.ok(item.text.trim(), `${identity}: reply fixture has content`);
      assert.ok(h.text(tree).includes(item.text), `${identity}: the reply remains visible`);
      assert.equal(byId(tree, "tool-summary-row").length, 0, "replies stay outside tool disclosures");
      replies++;
      continue;
    }
    if (item.type !== "tool_call" && item.type !== "todo") continue;
    const collapsed = h.mount(item, false).tree;
    const finalReplies = byId(collapsed, "tool-final-reply");
    if (item.type === "tool_call" && finalReplies.length) {
      assert.equal(finalReplies.length, 1, `${identity}: exactly one final reply`);
      assert.ok(h.text(finalReplies).trim(), `${identity}: visible final reply`);
      assert.equal(byId(collapsed, "tool-summary-row").length, 0, "wrap-up replies stay expanded");
      toolCalls++;
      replyTools++;
      replies++;
      continue;
    }
    if (item.type === "tool_call") assert.ok(h.text(byId(collapsed, "tool-summary-text")).trim(), `${identity}: visible summary`);
    const { tree } = h.mount(item);
    const cards = h.nodes(tree, node => /^tool-card-(?!body)/.test(node.props.testID ?? ""));
    const bodies = byId(tree, "tool-card-body");
    assert.equal(cards.length, 1, `${identity}: exactly one card`);
    assert.equal(bodies.length, 1, `${identity}: exactly one expanded body`);
    cardCount += cards.length;
    emptyCards += [...cards, ...bodies].filter(node => !h.text(node).trim()).length;
    cards.forEach(card => renderedKinds.add(card.props.testID.replace("tool-card-", "")));
    if (item.type === "tool_call") {
      toolCalls++;
      // Both untyped plain text and unknown/fallback bodies are generic.
      // A useful title does not turn an otherwise generic call into a typed one.
      genericCalls += Number(cards.some(card => ["tool-card-plain_text", "tool-card-unknown"].includes(card.props.testID))
        || byId(tree, "tool-generic-content").length > 0);
    }
  }
  const rate = genericCalls / toolCalls;
  assert.equal(emptyCards, 0);
  assert.ok(replies > 0, "the final reply is exercised");
  context.diagnostic(`${file}: calls=${toolCalls}, cards=${cardCount}, empty=${emptyCards}, generic=${genericCalls}, genericRate=${(rate * 100).toFixed(1)}%, replies=${replies}, replyTools=${replyTools}`);
  return { fixture, toolCalls, cardCount, genericCalls, rate, replyTools };
}

for (const [style, expectedCalls] of [["hermes", 6], ["claude", 28]]) {
  test(`${style} real replay: no empty cards and at most five percent generic calls`, context => {
    const { fixture, toolCalls, cardCount, genericCalls, rate, replyTools } = replay(`real-${style}-session.json`, context);
    assert.match(fixture.provenance, /Sanitized real projected timeline/);
    assert.equal(toolCalls, expectedCalls);
    assert.equal(cardCount + replyTools, expectedCalls);
    assert.equal(genericCalls, 0);
    assert.ok(rate <= 0.05, `${style}: generic rate ${rate * 100}%`);
  });
}

for (const [style, expectedCalls, expectedGeneric] of [["hermes", 20, 3], ["claude", 12, 1], ["codex", 12, 1]]) {
  test(`${style} synthetic replay: no empty cards and expected fallback coverage`, context => {
    const { fixture, toolCalls, cardCount, genericCalls } = replay(`${style}-session.json`, context);
    assert.match(fixture.provenance, /Handwritten synthetic/);
    assert.equal(toolCalls, expectedCalls);
    assert.equal(cardCount, expectedCalls + 1, "includes the independent todo timeline item");
    assert.equal(genericCalls, expectedGeneric);
  });
}

test("real and synthetic replays exercise all thirteen rendered tool kinds", () => {
  for (const kind of ["shell", "read", "edit", "write", "search", "fetch", "web_search", "tool_search", "sub_agent", "plan", "todo", "plain_text", "unknown"]) {
    assert.ok(renderedKinds.has(kind), `${kind} is covered by a replay`);
  }
});
