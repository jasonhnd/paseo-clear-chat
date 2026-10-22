const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const call = (name, detail, status = "completed") => ({ type: "tool_call", callId: "sample-call", name, status, error: null, detail });
const find = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const body = (h, tree) => h.text(find(h, tree, "tool-card-body"));
const lines = n => Array.from({ length: n }, (_, i) => `ROW ${i + 1}`).join("\n");

const summaries = [
  [call("exec", { type: "shell", command: "git status", output: "Ready" }), "$ git status", "Git"],
  [call("exec", { type: "shell", command: "npm test" }), "$ npm test", "Terminal"],
  [call("Read", { type: "read", filePath: "docs/notebook.md", offset: 1, limit: 40 }), "notebook.md:1-40", "Book"],
  [call("Write", { type: "write", filePath: "src/config.ts", content: "Ready" }), "config.ts", "Pencil"],
  [call("Edit", { type: "edit", filePath: "src/app.ts", unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,4 @@\n-old\n-value\n+new\n+value\n+one\n+two" }), "app.ts · +4 −2", "Pencil"],
  [call("Grep", { type: "search", query: "beautiful-chat" }), "Search: beautiful-chat", "Search"],
  [call("WebSearch", { type: "web_search", query: "plugin guide" }), "web_search: plugin guide", "Search"],
  [call("Fetch", { type: "fetch", url: "https://example.org/guide" }), "https://example.org/guide", "Globe"],
  [call("delegate", { type: "sub_agent", name: "Scout", log: "Started" }), "Scout", "Bot"],
  [call("update_plan", { type: "plan", text: "- [ ] Verify changes" }), "Plan", "ListChecks"],
  [call("todo", { type: "todo", items: [{ text: "Verify changes" }] }), "Checklist Progress", "ListChecks"],
  [call("report", { type: "plain_text", text: "Ready" }), "report", "FileText"],
  [call("memory", { type: "unknown", input: { content: "A sample", action: "add" } }), "memory · add", "Wrench"],
  [call("inspect", { type: "unknown", input: { enabled: false } }), "inspect · false", "Wrench"],
  [call("mcp__catalog__lookup", { type: "unknown", input: { topic: "guide" } }), "catalog / lookup", "Plug"],
  [call("eval", { type: "unknown", input: { code: "1 + 1", title: "Check value" } }), "Eval: Check value", "Play"],
  [call("skill_view", { type: "read", filePath: "skills/release/SKILL.md" }), "Skill: release", "Book"],
];
for (const [item, expected, icon] of summaries) {
  test(`one-line summary: ${expected}`, () => {
    const h = createToolHarness();
    const { tree } = h.mount(item, false);
    const row = find(h, tree, "tool-summary-row");
    assert.equal(h.text(find(h, row, "tool-summary-text")), expected);
    assert.equal(find(h, row, "tool-summary-text").props.numberOfLines, 1);
    assert.equal(h.nodes(row, node => node.type === "Glyph")[0].props.name, icon);
    assert.equal(find(h, tree, "tool-card-body"), undefined);
  });
}

test("read line selectors and edit replacement counts come only from reported content", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  assert.equal(build({ name: "read", status: "completed", detail: { type: "read", filePath: "notes.md", startLine: 5, endLine: 8 } }).lineRange, "5-8");
  assert.equal(build({ name: "read", status: "completed", detail: { type: "read", filePath: "notes.md" } }).lineRange, undefined);
  assert.deepEqual(build({ name: "edit", status: "completed", detail: { type: "edit", oldString: "one\ntwo\n", newString: "three\n" } }).changes, { added: 1, removed: 2 });
  assert.equal(build({ name: "edit", status: "completed", detail: { type: "edit" } }).changes, undefined);
});

for (const status of ["completed", "failed", "running", "canceled", "awaiting_approval", "awaiting_answer"]) {
  test(`status ${status} has its own indicator and expansion default`, () => {
    const h = createToolHarness();
    const { tree } = h.mount(call("shell", { type: "shell", command: "npm test" }, status), false);
    const expected = status.startsWith("awaiting") ? "waiting" : status;
    assert.ok(find(h, tree, `tool-status-${expected}`));
    assert.equal(find(h, tree, "tool-summary-row").props.accessibilityState.expanded, !["completed", "canceled"].includes(status));
    if (status === "running") assert.equal(h.nodes(tree, node => node.type === "Spinner").length, 1);
    if (status === "completed") assert.ok(h.text(tree).includes("✓"));
    if (status === "failed") assert.ok(h.text(tree).includes("✗"));
    if (status === "canceled") assert.ok(h.text(tree).includes("canceled"));
  });
}

for (const [duration, expected] of [[undefined, undefined], [NaN, undefined], [-1, undefined], [0, "0ms"], [420, "420ms"], [1530, "1.53s"]]) {
  test(`duration ${duration} renders only when reported and valid`, () => {
    const h = createToolHarness();
    const { tree } = h.mount(call("fetch", { type: "fetch", url: "https://example.org", ...(duration !== undefined ? { durationMs: duration } : {}) }), false);
    assert.equal(find(h, tree, "tool-duration") ? h.text(find(h, tree, "tool-duration")) : undefined, expected);
  });
}

test("search converts an explicitly reported duration in seconds", () => {
  const h = createToolHarness();
  const { tree } = h.mount(call("search", { type: "search", query: "guide", durationSeconds: 1.5 }), false);
  assert.equal(h.text(find(h, tree, "tool-duration")), "1.5s");
});

const outputCases = [
  ["shell", text => call("exec", { type: "shell", command: "npm test", output: text })],
  ["read", text => call("Read", { type: "read", filePath: "notes.md", content: text })],
  ["write", text => call("Write", { type: "write", filePath: "notes.md", content: text })],
  ["edit", text => call("Edit", { type: "edit", filePath: "notes.md", unifiedDiff: text })],
  ["eval", text => call("eval", { type: "unknown", input: { code: "1 + 1" }, output: text })],
  ["mcp", text => call("mcp__catalog__lookup", { type: "unknown", input: {}, output: { content: [{ type: "text", text }] } })],
  ["unknown", text => call("inspect", { type: "unknown", input: {}, output: text })],
  ["plain_text", text => call("report", { type: "plain_text", text })],
  ["skill", text => call("skill_view", { type: "read", filePath: "skills/release/SKILL.md", content: text })],
];
for (const limit of [10, 15, 30, "never"]) {
  for (const [kind, item] of outputCases) {
    test(`${kind} output respects ${limit} lines and reveals the full output on demand`, () => {
      const h = createToolHarness("ios", { preferences: { foldLongOutputAfter: limit } });
      const mounted = h.mount(item(lines(31)));
      assert.ok(body(h, mounted.tree).includes("ROW 1"));
      const button = h.nodes(mounted.tree, node => node.props.accessibilityLabel === "Show all 31 lines")[0];
      if (limit === "never") {
        assert.equal(button, undefined);
        assert.ok(body(h, mounted.tree).includes("ROW 31"));
      } else {
        assert.ok(button);
        assert.ok(body(h, mounted.tree).includes(`ROW ${limit}`));
        assert.equal(body(h, mounted.tree).includes(`ROW ${limit + 1}`), false);
        button.props.onPress();
        const expanded = mounted.render();
        assert.ok(body(h, expanded).includes("ROW 31"));
        h.nodes(expanded, node => node.props.accessibilityLabel === "Show fewer lines")[0].props.onPress();
        assert.equal(body(h, mounted.render()).includes("ROW 31"), false);
      }
    });
  }
}

test("output at the threshold stays whole and changing the setting updates a mounted call", () => {
  const h = createToolHarness();
  const mounted = h.mount(call("read", { type: "read", filePath: "notes.md", content: lines(15) }));
  assert.equal(h.nodes(mounted.tree, node => node.props.accessibilityLabel?.startsWith("Show all")).length, 0);
  h.preferences.foldLongOutputAfter = 10;
  assert.equal(body(h, mounted.render()).includes("ROW 15"), false);
  h.preferences.foldLongOutputAfter = "never";
  assert.equal(body(h, mounted.render()).includes("ROW 15"), true);
});

test("folded code sends the full original text to its copy control", () => {
  const h = createToolHarness();
  const source = `${lines(31)}\n  `;
  const { tree } = h.mount(call("read", { type: "read", filePath: "notes.md", content: source }));
  const code = find(h, tree, "syntax-block");
  assert.equal(code.props.copyText, source);
  assert.equal(code.props.code, lines(15));
});

test("both folding settings have live controls on the settings page", () => {
  const h = createToolHarness("ios", { settingsPage: true });
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  const render = () => h.draw({ type: Page, props: { theme: { colors: {} } } });
  let tree = render();
  const toggle = h.nodes(tree, node => node.props.accessibilityLabel === "Fold finished steps")[0];
  assert.equal(toggle.props.accessibilityState.checked, true);
  toggle.props.onPress();
  assert.equal(h.preferences.foldFinishedSteps, false);
  assert.ok(h.text(tree).includes("Fold long output after"));
  for (const label of ["10 lines", "15 lines", "30 lines", "Never"]) {
    tree = render();
    h.nodes(tree, node => node.type === "Pressable" && h.text(node) === label)[0].props.onPress();
    assert.equal(h.preferences.foldLongOutputAfter, label === "Never" ? "never" : Number(label.split(" ")[0]));
  }
});

test("ordinary assistant replies remain fully expanded regardless of fold preferences", () => {
  const h = createToolHarness("ios", { preferences: { foldLongOutputAfter: 10 } });
  const { tree } = h.mount({ type: "assistant_message", text: lines(40) }, false);
  assert.ok(h.text(tree).includes("ROW 40"));
  assert.equal(find(h, tree, "tool-summary-row"), undefined);
  assert.equal(h.nodes(tree, node => node.type === "Pressable").length, 0);
});

for (const scale of [0.85, 1, 1.3, 1.35]) {
  for (const status of ["completed", "running", "failed", "canceled", "awaiting_approval"]) {
    test(`collapsed ${status} row includes padding, borders and spacing within 26px at ${scale} text scale`, () => {
      const h = createToolHarness("ios", { preferences: { textScale: scale } });
      const item = call("shell", { type: "shell", command: "git status", durationMs: 1530, exitCode: 2 }, status);
      const mounted = h.mount(item, false);
      let tree = mounted.tree;
      if (find(h, tree, "tool-summary-row").props.accessibilityState.expanded) {
        find(h, tree, "tool-summary-row").props.onPress();
        tree = mounted.render();
      }
      const row = find(h, tree, "tool-summary-row"), card = find(h, tree, "tool-card-git");
      const { COLLAPSED_TOOL_HEIGHT, TOOL_ROW_LAYOUT } = h.load("client/components/tool-callout-styles.ts");
      const total = row.props.style.height + 2 * row.props.style.paddingVertical
        + 2 * card.props.style.marginVertical + 2 * card.props.style.borderWidth;
      assert.equal(total, COLLAPSED_TOOL_HEIGHT);
      assert.ok(total <= 26, `Total row footprint is ${total}px`);
      assert.equal(row.props.style.height, TOOL_ROW_LAYOUT.contentHeight);
      assert.equal(find(h, tree, "tool-card-body"), undefined);
      assert.equal(find(h, tree, "tool-summary-text").props.numberOfLines, 1);
      for (const text of h.nodes(row, node => node.type === "Text")) {
        const style = Object.assign({}, ...[text.props.style].flat());
        assert.ok(style.lineHeight <= row.props.style.height);
        assert.equal(style.includeFontPadding, false);
        assert.equal(text.props.numberOfLines, 1);
      }
    });
  }
}
