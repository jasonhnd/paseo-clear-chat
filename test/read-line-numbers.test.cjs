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

const capturedReads = require("./fixtures/hermes-captured-reads.json").items;
for (const filePath of ["line-offset-sample.txt", "/workspace/demo/line-offset-sample.txt"]) {
  test(`offset header accepts a relative display path with ${filePath}`, t => {
    const h = createToolHarness("web", { preferences: { collapsedStepAction: "details" } });
    t.after(() => h.unmount());
    const source = capturedReads.find(item => item.detail.content.includes("from line 150,"));
    const content = Array.from({ length: 111 }, (_, index) => `${index + 150}|sample ${index + 150}`).join("\n");
    const item = { ...source, detail: { ...source.detail, filePath,
      content: `Read line-offset-sample.txt (from line 150, limit 111) \u2014 400 total lines\n\n\x60\x60\x60\n${content}\n\x60\x60\x60` } };
    const { tree } = h.mount(item);
    const rows = byId(h, tree, "step-detail-scroll").props.data.filter(row => row.section === "output" && row.kind === "text");
    assert.equal(rows[0].lineNumber, 150);
    assert.equal(rows.at(-1).lineNumber, 260);
    assert.equal(rows.map(row => row.text).join(""), content.replace(/^\d+\|/gm, ""));
  });
}

test("absolute offset header and nested literal fences and numeric pipes survive one unwrap", t => {
  const h = createToolHarness("web");
  t.after(() => h.unmount());
  const { readOutputLines } = h.load("client/read-output.ts");
  const filePath = "/workspace/demo/sample.md";
  const parsed = readOutputLines({ tool: "read", filePath },
    `Read ${filePath} (from line 150, limit 3) \u2014 400 total lines\n\n\x60\x60\x60markdown\n150|\x60\x60\x60\n151|72|literal\n152|\x60\x60\x60\n\x60\x60\x60`);
  assert.equal(parsed.text, "\x60\x60\x60\n72|literal\n\x60\x60\x60");
  assert.deepEqual(parsed.lines.map(line => line.lineNumber), [150, 151, 152]);
});

test("unrecognized paths, malformed wrappers and unnumbered file prose stay literal", t => {
  const h = createToolHarness("web");
  t.after(() => h.unmount());
  const { readOutputText } = h.load("client/read-output.ts");
  for (const content of ["150|first\nnot numbered", "\x60\x60\x60\n150|literal\n\x60\x60\x60"]) {
    const text = `Read sample.txt (from line 150, limit 2) \u2014 400 total lines\n\n\x60\x60\x60\n${content}\n\x60\x60\x60`;
    assert.equal(readOutputText({ tool: "read", filePath: "sample.txt" }, text), text);
  }
  const text = "Read other.txt \u2014 1 total line\n\n```\n1|literal\n```";
  assert.equal(readOutputText({ tool: "read", filePath: "/workspace/sample.txt" }, text), text);
});

test("captured upstream truncation remains visible and never fabricates missing file lines", t => {
  const h = createToolHarness("web");
  t.after(() => h.unmount());
  const { readOutputLines } = h.load("client/read-output.ts");
  for (const item of capturedReads) {
    assert.match(item.detail.content, /chars total, truncated\)$/);
    const parsed = readOutputLines({ tool: "read", filePath: item.detail.filePath }, item.detail.content);
    const first = item.detail.content.includes("from line 150,") ? 150 : 1;
    assert.equal(parsed.lines[0].lineNumber, first);
    assert.equal(parsed.lines.at(-2).lineNumber, first === 150 ? 244 : 102);
    assert.equal(parsed.lines.at(-1).lineNumber, undefined);
    assert.match(parsed.lines.at(-1).text, /^\.\.\. \(\d+ chars total, truncated\)$/);
    assert.doesNotMatch(parsed.text, /^Read |^```|^\d+\|/m);
  }
});

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: captured truncation notice has no file gutter and Copy output retains the notice`, async t => {
    const h = createToolHarness(platform, { preferences: { collapsedStepAction: "details" } });
    t.after(() => h.unmount());
    const source = capturedReads.find(item => item.detail.content.includes("from line 150,"));
    const { tree } = h.mount(source);
    const list = byId(h, tree, "step-detail-scroll");
    const rows = list.props.data.filter(row => row.section === "output" && row.kind === "text");
    assert.equal(rows[0].lineNumber, 150);
    const notice = rows.at(-1);
    assert.equal(notice.lineNumber, undefined);
    assert.equal(byId(h, h.draw(list.props.renderItem({ item: notice })), "step-detail-line-number"), undefined);
    await byId(h, tree, "step-detail-copy-output").props.onPress();
    assert.match(h.copies.at(-1), /^line 0150 fictional offset sample payload 0150\n/);
    assert.match(h.copies.at(-1), /chars total, truncated\)$/);
    assert.doesNotMatch(h.copies.at(-1), /^Read |^```|^\d+\|/m);
  });
}

test("complete 1200-line result preserves every row through the virtual list data and Copy output", async t => {
  const h = createToolHarness("web", { preferences: { collapsedStepAction: "details" } });
  t.after(() => h.unmount());
  const source = capturedReads.find(item => item.detail.filePath === "line-full-sample.txt");
  const plain = Array.from({ length: 1200 }, (_, index) => `sample ${index + 1}`).join("\n");
  const numbered = plain.split("\n").map((line, index) => `${index + 1}|${line}`).join("\n");
  const { tree } = h.mount({ ...source, detail: { ...source.detail,
    content: `Read line-full-sample.txt \u2014 1200 total lines\n\n\x60\x60\x60\n${numbered}\n\x60\x60\x60` } });
  const rows = byId(h, tree, "step-detail-scroll").props.data.filter(row => row.section === "output" && row.kind === "text");
  assert.equal(rows.length, 1200);
  assert.equal(rows[0].lineNumber, 1);
  assert.equal(rows.at(-1).lineNumber, 1200);
  await byId(h, tree, "step-detail-copy-output").props.onPress();
  assert.equal(h.copies.at(-1), plain);
});
