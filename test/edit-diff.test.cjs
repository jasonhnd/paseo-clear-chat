const assert = require("node:assert/strict");
const test = require("node:test");
const realHermesPatch = require("./fixtures/real-hermes-patch.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Use the real diff painter as well as the registered timeline/card pipeline.
const h = createToolHarness("ios", { syntax: true, preferences: { foldLongOutputAfter: "never" } });
Object.assign(h.tokens.syntax, {
  diffAddBg: "#003300", diffAddMarker: "#00cc00",
  diffRemoveBg: "#330000", diffRemoveMarker: "#cc0000",
});
const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
const call = detail => ({ type: "tool_call", callId: "sample-edit", name: "Edit", status: "completed", detail: { type: "edit", filePath: "src/config.ts", ...detail } });
const rows = (tree, kind) => h.nodes(tree, node => node.type === "View" && [node.props.style].flat().some(style => style?.backgroundColor === h.tokens.syntax[kind === "+" ? "diffAddBg" : "diffRemoveBg"]));
const summary = tree => h.text(h.nodes(tree, node => node.props.testID === "tool-summary-text"));
function check(detail, added, removed) {
  const item = call(detail);
  const data = build(item);
  assert.deepEqual(data.changes, { added, removed });
  const { tree } = h.mount(item);
  assert.equal(summary(tree), `config.ts · +${added} −${removed}`);
  assert.equal(rows(tree, "+").length, added, "added rows have the green background");
  assert.equal(rows(tree, "-").length, removed, "deleted rows have the red background");
  for (const [kind, color] of [["+", "diffAddMarker"], ["-", "diffRemoveMarker"]]) {
    for (const row of rows(tree, kind)) {
      assert.ok(h.nodes(row, node => node.type === "Text" && node.props.style?.color === h.tokens.syntax[color] && node.props.children === kind).length, "diff marker has its semantic color");
    }
  }
  return { data, tree };
}

for (const [index, item] of realHermesPatch.items.entries()) {
  test(`real Hermes patch ${index + 1}: a success-only projection preserves its text without invented counts`, () => {
    const original = structuredClone(item);
    const data = build(item);
    assert.equal(data.changes, undefined, "the captured item has no patch or replacement text to count");
    assert.equal(data.diff, item.detail.unifiedDiff);
    for (const expanded of [false, true]) {
      const { tree } = h.mount(item, expanded);
      assert.equal(summary(tree), "example.txt");
      assert.doesNotMatch(summary(tree), /[+−]0/);
      if (expanded) {
        const visible = h.text(tree).replace(/\n/g, "");
        for (const line of item.detail.unifiedDiff.split("\n")) assert.ok(visible.includes(line));
      }
      assert.equal(rows(tree, "+").length, 0);
      assert.equal(rows(tree, "-").length, 0);
    }
    assert.deepEqual(item, original);
  });
}

test("unrecognized edit output preserves the original text without diff counts or colors", () => {
  const diff = "Patch report\n- Changed the sample file\n+ Operation succeeded";
  const item = call({ unifiedDiff: diff });
  const data = build(item);
  assert.equal(data.changes, undefined);
  assert.equal(data.diff, diff);
  const { tree } = h.mount(item);
  assert.equal(summary(tree), "config.ts");
  assert.equal(rows(tree, "+").length, 0);
  assert.equal(rows(tree, "-").length, 0);
});

test("replacement text is used when a projected diff field contains only a success message", () => {
  const { data } = check({ unifiedDiff: "Patch completed.", input: { old_text: "before\n", new_text: "after\n" } }, 1, 1);
  assert.match(data.diff, /^-before$/m);
  assert.match(data.diff, /^\+after$/m);
  assert.doesNotMatch(data.diff, /Patch completed/);
});

for (const [oldKey, newKey] of [["old_string", "new_string"], ["oldText", "newText"], ["oldString", "newString"], ["old_text", "new_text"]]) {
  for (const source of ["detail", "input"]) {
    test(`upstream #8: single replacement from ${source} ${oldKey}/${newKey} renders red and green`, () => {
      const pair = { [oldKey]: "before\n", [newKey]: "after\n" };
      const { data } = check(source === "input" ? { input: pair } : pair, 1, 1);
      assert.match(data.diff, /^-before$/m);
      assert.match(data.diff, /^\+after$/m);
    });
  }
}

for (const source of ["detail", "input"]) {
  test(`upstream #14: multiple replacements in ${source}.edits render every change and aggregate counts`, () => {
    const edits = [
      { old_string: "first\n", new_string: "updated first\n" },
      { oldText: "second\n", newText: "updated second\nextra\n" },
      { oldString: "unchanged\n", newString: "unchanged\n" },
    ];
    const { data } = check(source === "input" ? { input: { edits } } : { edits }, 3, 2);
    assert.match(data.diff, /^-first$/m);
    assert.match(data.diff, /^-second$/m);
    assert.match(data.diff, /^\+extra$/m);
    assert.doesNotMatch(data.diff, /^[-+]unchanged$/m);
  });
}

for (const old of [undefined, ""]) {
  test(`upstream #8: new text with ${old === undefined ? "no" : "empty"} old text renders a new file including blank lines`, () => {
    const { data } = check({ input: { old_string: old, new_string: "first\n\nthird\n" } }, 3, 0);
    assert.match(data.diff, /^\+$/m);
    assert.match(data.diff, /^\+third$/m);
  });
}

for (const text of ["same\n", ""]) {
  test(`upstream #14: identical ${text ? "nonempty" : "empty"} old/new text reports zero changes without tinted rows`, () => {
    const { data, tree } = check({ input: { oldText: text, newText: text }, output: "Edit succeeded" }, 0, 0);
    assert.equal(data.diff, "No changes.");
    assert.match(h.text(tree), /No changes\./);
    assert.doesNotMatch(data.diff, /Edit succeeded/);
  });
}

test("upstream #14: shared lines between separate changes stay context and do not inflate counts", () => {
  const { data } = check({ oldText: "start\nbefore\nkeep\nold end\nfinish\n", newText: "start\nafter\nkeep\nnew end\nfinish\n" }, 2, 2);
  assert.match(data.diff, /^ keep$/m);
  assert.doesNotMatch(data.diff, /^[-+](start|keep|finish)$/m);
});

test("upstream #8: deleting text, CRLF and missing final newlines keep accurate rows and counts", () => {
  check({ input: { oldString: "first\r\nsecond\r\n", newString: "" } }, 0, 2);
  const { data } = check({ oldText: "before", newText: "after" }, 1, 1);
  assert.match(data.diff, /\\ No newline at end of file/);
});

test("upstream #8: an explicit unified diff takes precedence over replacement inputs", () => {
  const unifiedDiff = "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1 +1 @@\n-actual before\n+actual after\n";
  const item = call({ unifiedDiff, input: { old_string: "wrong\nextra\n", new_string: "wrong again\n" } });
  const data = build(item);
  assert.equal(data.diff, unifiedDiff);
  assert.deepEqual(data.changes, { added: 1, removed: 1 });
  assert.equal(summary(h.mount(item).tree), "config.ts · +1 −1");
});

test("upstream #14: malformed edits are ignored without mutating timeline data", () => {
  const item = call({ input: { edits: [null, "invalid", { oldText: 12, newText: false }, { oldText: "before\n", newText: "after\n" }] } });
  const before = structuredClone(item);
  const data = build(item);
  assert.deepEqual(data.changes, { added: 1, removed: 1 });
  h.mount(item);
  assert.deepEqual(item, before);
  assert.equal(build(call({ input: { edits: [null, {}, false] } })).diff, undefined);
  assert.equal(build(call({ input: { oldText: "still streaming" } })).changes, undefined);
});

test("upstream #14: MultiEdit without a canonical detail type uses the edit card", () => {
  const item = { type: "tool_call", name: "MultiEdit", status: "completed", detail: { input: { file_path: "src/config.ts", edits: [{ old_string: "before\n", new_string: "after\n" }] } } };
  const { tree } = h.mount(item);
  assert.equal(build(item).tool, "edit");
  assert.equal(summary(tree), "config.ts · +1 −1");
  assert.equal(rows(tree, "+").length, 1);
  assert.equal(rows(tree, "-").length, 1);
});

test("upstream #14: large replacements preserve both versions and shared outer context", () => {
  const before = Array.from({ length: 600 }, (_, i) => `before ${i}`).join("\n");
  const after = Array.from({ length: 600 }, (_, i) => `after ${i}`).join("\n");
  const oldText = `start\n${before}\nend\n`, newText = `start\n${after}\nend\n`;
  const data = build(call({ input: { oldText, newText } }));
  assert.deepEqual(data.changes, { added: 600, removed: 600 });
  const lines = data.diff.split("\n").slice(1);
  const version = marker => lines.filter(line => line[0] === " " || line[0] === marker).map(line => line.slice(1)).join("\n") + "\n";
  assert.equal(version("-"), oldText);
  assert.equal(version("+"), newText);
  assert.match(data.diff, /^ start$/m);
  assert.match(data.diff, /^ end$/m);
});

test("upstream #8: adding a final newline is a real change rather than an empty extra row", () => {
  const { data } = check({ oldText: "same", newText: "same\n" }, 1, 1);
  assert.match(data.diff, /-same\n\\ No newline at end of file\n\+same$/);
});
