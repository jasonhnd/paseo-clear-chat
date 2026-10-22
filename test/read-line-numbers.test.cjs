const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const hermes = require("./fixtures/real-hermes-hover.json").items.find(item => item.detail?.type === "read");
const hermesPlain = require("./fixtures/real-hermes-session.json").items.find(item => item.detail?.type === "read");
const offset = require("./fixtures/hermes-offset-read.json").item;
const claude = require("./fixtures/real-claude-turn-timing.json").find(entry => entry.item.detail?.type === "read").item;
const codex = require("./fixtures/codex-session.json").items.find(item => item.detail?.type === "read");
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

for (const platform of ["web", "ios", "android"]) {
  for (const [source, item, first] of [["Hermes offset", offset, 50], ["Hermes whole", hermes, 1], ["Hermes plain", hermesPlain, 1], ["Claude", claude, 1], ["Codex", codex, 1]]) {
    test(`${platform}: ${source} projected item keeps file numbers outside selectable content and Copy output`, async t => {
      const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
      t.after(() => h.unmount());
      const { tree } = h.mount(item);
      const list = byId(h, tree, "step-detail-scroll");
      const rows = list.props.data.filter(row => row.section === "output" && row.kind === "text");
      assert.equal(rows[0].lineNumber, first);
      assert.deepEqual(rows.map(row => row.lineNumber), rows.map((_, index) => first + index));
      const content = rows.map(row => row.text).join("");
      assert.doesNotMatch(content, /^Read |^```|^\d+\|/m);
      for (const row of rows) {
        const rendered = h.draw(list.props.renderItem({ item: row }));
        const gutter = byId(h, rendered, "step-detail-line-number");
        assert.equal(gutter.props.selectable, false);
        if (platform === "web") assert.equal(gutter.props.style.userSelect, "none");
        assert.equal(h.text(gutter), String(row.lineNumber));
        const text = byId(h, rendered, "step-detail-output");
        assert.equal(text.props.selectable, true);
        assert.equal(h.text(text), row.text.replace(/\r?\n$/, ""));
      }
      await byId(h, tree, "step-detail-copy-output").props.onPress();
      assert.equal(h.copies.at(-1), content);
    });
  }
  test(`${platform}: ten thousand numbered file lines retain middle, tail and wrapped line alignment`, t => {
    const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
    t.after(() => h.unmount());
    const source = Array.from({ length: 10000 }, (_, index) => `${index + 50}|${index === 5000 ? "long ".repeat(1000) : `sample ${index}`}\r\n`).join("");
    const item = { ...offset, detail: { ...offset.detail, content: `Read ${offset.detail.filePath} — 12000 total lines\n\n\x60\x60\x60\n${source}\n\x60\x60\x60` } };
    const { tree } = h.mount(item);
    const list = byId(h, tree, "step-detail-scroll");
    const rows = list.props.data.filter(row => row.section === "output" && row.kind === "text");
    assert.equal(rows.length, 10000);
    assert.equal(rows.map(row => row.text).join(""), source.replace(/^\d+\|/gm, ""));
    for (const index of [0, 4999, 5000, 9999]) {
      const row = rows[index];
      const rendered = h.draw(list.props.renderItem({ item: row }));
      assert.equal(h.text(byId(h, rendered, "step-detail-line-number")), String(index + 50));
      assert.equal(h.text(byId(h, rendered, "step-detail-output")), row.text.replace(/\r?\n$/, ""));
    }
    assert.ok(h.text(tree).length < 20000);
  });
}

test("unwrapped file content keeps numeric pipe text and trailing newlines verbatim", t => {
  const h = createToolHarness("web");
  t.after(() => h.unmount());
  const { readOutputLines } = h.load("client/read-output.ts");
  const text = "50|literal\r\n\r\nlast\n";
  const parsed = readOutputLines({ tool: "read", filePath: "sample.txt" }, text);
  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.lines.map(line => line.lineNumber), [1, 2, 3]);
  assert.equal(parsed.lines.map(line => line.text).join(""), text);
});


test("source numbers are retained per line rather than inferred from the first prefix", t => {
  const h = createToolHarness("web");
  t.after(() => h.unmount());
  const { readOutputLines } = h.load("client/read-output.ts");
  const parsed = readOutputLines({ tool: "read", filePath: "sample.txt" }, "Read sample.txt — 80 total lines\n\n```\n50|first\n72|middle\n80|last\n```");
  assert.deepEqual(parsed.lines.map(line => line.lineNumber), [50, 72, 80]);
  assert.equal(parsed.text, "first\nmiddle\nlast");
});
