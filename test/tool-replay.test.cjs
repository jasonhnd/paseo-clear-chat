const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const renderedKinds = new Set();

for (const [style, expectedCalls, expectedGeneric] of [["hermes", 20, 1], ["claude", 12, 0], ["codex", 12, 0]]) {
  test(`${style} replay: no empty cards and at most five percent generic calls`, context => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", `${style}-session.json`), "utf8"));
    assert.match(fixture.provenance, /Handwritten synthetic/);
    let toolCalls = 0, cardCount = 0, emptyCards = 0, genericCalls = 0;
    for (const item of fixture.items) {
      if (item.type !== "tool_call" && item.type !== "todo") continue;
      const collapsed = h.mount(item, false).tree;
      assert.ok(h.text(collapsed).trim(), `${item.id}: visible summary`);
      const { tree } = h.mount(item);
      const cards = h.nodes(tree, node => /^tool-card-(?!body)/.test(node.props.testID ?? ""));
      const bodies = h.nodes(tree, node => node.props.testID === "tool-card-body");
      assert.equal(cards.length, 1, `${item.id}: exactly one card`);
      assert.equal(bodies.length, 1, `${item.id}: exactly one expanded body`);
      cardCount += cards.length;
      emptyCards += cards.filter(card => !h.text(card).trim()).length;
      emptyCards += bodies.filter(body => !h.text(body).trim()).length;
      cards.forEach(card => renderedKinds.add(card.props.testID.replace("tool-card-", "")));
      if (item.type === "tool_call") {
        toolCalls++;
        // Count the actual generic body, including named Hermes Other calls.
        // Giving an unknown call a useful summary does not exempt it.
        genericCalls += h.nodes(tree, node => node.props.testID === "tool-generic-content").length;
      }
    }
    const rate = genericCalls / toolCalls;
    assert.equal(toolCalls, expectedCalls);
    assert.equal(cardCount, expectedCalls + 1, "includes the independent todo timeline item");
    assert.equal(emptyCards, 0);
    assert.equal(genericCalls, expectedGeneric);
    assert.ok(rate <= 0.05, `${style}: generic rate ${rate * 100}%`);
    context.diagnostic(`${style}: calls=${toolCalls}, cards=${cardCount}, empty=${emptyCards}, generic=${genericCalls}, genericRate=${(rate * 100).toFixed(1)}%`);
  });
}

test("the three replays exercise all twelve rendered tool kinds", () => {
  for (const kind of ["shell", "read", "edit", "write", "search", "fetch", "web_search", "sub_agent", "plan", "todo", "plain_text", "unknown"]) {
    assert.ok(renderedKinds.has(kind), `${kind} is covered by a replay`);
  }
});
