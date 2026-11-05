const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const cases = [
  ["ui", "```ui\n<card />\n```", true],
  ["app", "```app\n<app />\n```", true],
  ["uppercase", "```UI\n<card />\n```", true],
  ["title", '```ui title="x"\n<card />\n```', true],
  ["three spaces", "   ```ui\n<card />\n   ```", true],
  ["four spaces", "    ```ui\n<card />\n    ```", false],
  ["tilde", "~~~ui\n<card />\n~~~", true],
  ["quoted in three backticks", "```python\n```ui\n<card />\n```\n```", false],
  ["quoted in four backticks", "````python\n```ui\n<card />\n```\n````", false],
  ["unclosed", "```ui\n<card", true],
  ["inline", "Use `ui` or ` ```ui ` inline.", false],
  ["no fence", "A normal reply about ui and app.", false],
  ["after another fence", "```python\nprint('hi')\n```\n~~~app\n<app />", true],
  ["short closing fence", "````python\n```\n```ui\n<card />\n```\n````", false],
  ["different closing marker", "~~~python\n```\n```ui\n<card />\n```\n~~~", false],
  ["closing fence with text", "```python\n``` trailing\n```ui\n<card />\n```", false],
  ["language prefix", "```ui-extra\n<card />\n```", false],
  ["CRLF lines", "```python\r\nprint(1)\r\n```\r\n```UI\r\n", true],
];

test("component fence recognition and assistant ownership", t => {
  const h = createToolHarness();
  t.after(() => h.dispose());
  const containsComponentFence = h.load("client/component-fences.ts").containsComponentFence;
  const transformer = h.transformers.get("assistant_message");
  for (const [name, text, expected] of cases) {
    assert.equal(containsComponentFence(text), expected, `${name}: recognition`);
    const result = transformer.transform({ item: { type: "assistant_message", text }, phase: "complete" });
    if (expected) assert.equal(result, undefined, `${name}: ownership`);
    else {
      assert.equal(result.items[0].kind, "omp-assistant", `${name}: ownership`);
      assert.equal(result.items[0].data.text, text, `${name}: unchanged text`);
    }
  }
});
