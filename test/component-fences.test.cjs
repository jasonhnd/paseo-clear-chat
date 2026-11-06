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

test("configured code blocks and formulas determine assistant ownership", t => {
  const h = createToolHarness("ios", { preferences: { delegatedCodeBlocks: " , MERMAID, , math , " } });
  t.after(() => h.dispose());
  const detect = h.load("client/component-fences.ts").containsComponentFence;
  const transform = text => h.transformers.get("assistant_message").transform({ item: { type: "assistant_message", text }, phase: "complete" });
  const samples = [
    ["```mermaid\ngraph\n```", true],
    ["~~~Mermaid title=x\ngraph\n~~~", true],
    ["````python\n```mermaid\ngraph\n```\n````", false],
    ["plain reply", false],
    ["$$ a $$", true], ["$x^2$", true], ["\\(x\\)", true], ["\\[x\\]", true],
    ["```math\nx\n```", true],
    ["costs $5 and $10", false], ["$5-$10", false], ["$ x $", false],
    ["```python\n$x$\n```", false], ["`$x$`", false], ["`` $x$ ` ``", false],
    ["~~~python\n\\(x\\)\n$$ a $$\n~~~", false],
    ["\\$x$", false], ["\\\\(x\\)", false],
    ["`code` and $x$", true],
  ];
  for (const [text, expected] of samples) {
    assert.equal(detect(text, " , MERMAID, , math , "), expected, text);
    assert.equal(transform(text) === undefined, expected, `transform: ${text}`);
  }
  const defaults = createToolHarness();
  t.after(() => defaults.dispose());
  for (const text of ["```mermaid\nfoo\n```", "$$ a $$", "$x$"]) {
    assert.equal(detect(text, ""), false, `empty: ${text}`);
    assert.equal(defaults.transformers.get("assistant_message").transform({ item: { type: "assistant_message", text }, phase: "complete" }).items[0].kind, "omp-assistant");
  }
  for (const text of ["```ui\n", "~~~APP\n"]) assert.equal(detect(text, ""), true);
});
