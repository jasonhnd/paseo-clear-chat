const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const call = (name, detail, extra = {}) => ({ type: "tool_call", callId: "demo-call", name, status: "completed", error: null, detail, ...extra });
const bodyText = tree => h.text(h.nodes(tree, node => node.props.testID === "tool-card-body"));
const cards = tree => h.nodes(tree, node => /^tool-card-(?!body)/.test(node.props.testID ?? ""));

const examples = [
  ["shell", call("terminal", { type: "shell", command: "npm test", output: "All checks passed", exitCode: 0 }), /npm test[\s\S]*All checks passed/],
  ["read", call("Read", { type: "read", filePath: "src/config.ts", content: "export const enabled = true;" }), /src\/config.ts[\s\S]*enabled = true/],
  ["edit", call("Edit", { type: "edit", filePath: "src/config.ts", unifiedDiff: "-false\n+true" }), /-false[\s\S]*\+true/],
  ["write", call("Write", { type: "write", filePath: "notes.md", content: "# Release notes" }), /Release notes/],
  ["search", call("Grep", { type: "search", query: "enabled", input: { path: "src", glob: "*.ts" }, numMatches: 2, content: "src/config.ts:1:enabled = true\nsrc/app.ts:9:enabled" }), /Query: enabled[\s\S]*Scope: src \(\*\.ts\)[\s\S]*Matches: 2/],
  ["fetch", call("WebFetch", { type: "fetch", url: "https://example.org/guide", result: "# Guide\nFirst\nSecond\nThird\nFourth\nHidden sixth line" }), /https:\/\/example.org\/guide[\s\S]*Guide[\s\S]*Fourth/],
  ["web_search", call("WebSearch", { type: "search", toolName: "web_search", query: "plugin guide", webResults: [{ title: "Plugin guide", url: "https://example.org/plugins", snippet: "A short introduction" }] }), /Query: plugin guide[\s\S]*Plugin guide[\s\S]*A short introduction/],
  ["sub_agent", call("Task", { type: "sub_agent", subAgentType: "research", description: "Check the configuration", input: { name: "Scout" }, log: "Started" }, { metadata: { model: "demo-model" } }), /Scout[\s\S]*Check the configuration[\s\S]*Model: demo-model/],
  ["plan", call("update_plan", { type: "plan", text: "# Release plan\n- [x] Read the guide\n- [ ] Update the example" }), /Read the guide[\s\S]*Update the example/],
  ["todo", { type: "todo", items: [{ text: "Run checks", completed: false, status: "in_progress" }] }, /Run checks/],
  ["plain_text", call("report_stats", { type: "plain_text", label: "Other label", text: "  Original text\nSecond line\n  " }), /  Original text\nSecond line\n  /],
  ["unknown", call("inspect_widget", { type: "unknown", input: { target: "demo" }, output: "Widget is ready" }), /target:[\s\S]*demo[\s\S]*Widget is ready/],
];

for (const [kind, item, expected] of examples) {
  test(`${kind}: registered renderer draws a nonempty card with its own body`, () => {
    const { tree } = h.mount(item);
    assert.equal(cards(tree).length, 1);
    assert.equal(cards(tree)[0].props.testID, `tool-card-${kind}`);
    assert.match(bodyText(tree), expected);
    assert.ok(bodyText(tree).trim());
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-generic-content").length, kind === "unknown" ? 1 : 0);
  });
}

test("search results are one clickable row per match and reveal the actual files", async () => {
  const { tree } = h.mount(examples.find(([kind]) => kind === "search")[1]);
  const rows = h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityRole === "link");
  assert.equal(rows.length, 2);
  rows.forEach(row => row.props.onPress());
  assert.deepEqual(h.reveals, [
    { cwd: "/workspace/demo", path: "src/config.ts" },
    { cwd: "/workspace/demo", path: "src/app.ts" },
  ]);
  assert.equal(h.nodes(rows, node => node.type === "Text" && node.props.numberOfLines === 1).length, 2);
});

test("fetch shows five preview lines and opens its URL through the host link helper", () => {
  const { tree } = h.mount(examples.find(([kind]) => kind === "fetch")[1]);
  assert.doesNotMatch(bodyText(tree), /Hidden sixth/);
  h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityRole === "link")[0].props.onPress();
  assert.deepEqual(h.links, ["https://example.org/guide"]);
});

test("web search results open their URLs and preserve SDK search aliases", () => {
  const { tree } = h.mount(examples.find(([kind]) => kind === "web_search")[1]);
  h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityRole === "link")[0].props.onPress();
  assert.deepEqual(h.links, ["https://example.org/plugins"]);
});

test("explicit web_search details show titles, queries and previews", () => {
  const { tree } = h.mount(call("lookup", { type: "web_search", query: "release guide", output: { title: "Release guide", url: "https://example.org/release", content: "Release safely" } }));
  assert.equal(cards(tree)[0].props.testID, "tool-card-web_search");
  assert.match(bodyText(tree), /release guide[\s\S]*Release guide[\s\S]*Release safely/);
});

test("skill_view shows Skill: name and never treats the skill as a file path", () => {
  const { tree } = h.mount(call("skill_view", { type: "read", filePath: "skills/release/SKILL.md", content: "Prepare the release notes." }));
  assert.match(h.text(tree), /Skill: release/);
  assert.match(bodyText(tree), /Prepare the release notes/);
  assert.doesNotMatch(h.text(tree), /skills\/release|SKILL\.md|Read file/);
  assert.equal(h.nodes(tree, node => node.props.accessibilityLabel?.startsWith("Reveal ")).length, 0);
  assert.deepEqual(h.reveals, []);
});

test("memory · add appears on the collapsed summary row", () => {
  const { tree } = h.mount(call("memory", { type: "unknown", input: { content: "Use the sample configuration", action: "add" }, output: "Saved" }), false);
  assert.match(h.text(tree), /memory · add/);
  assert.match(h.text(tree), /completed/);
  assert.equal(h.nodes(tree, node => node.props.testID === "tool-card-body").length, 0);
});

for (const [name, input, title] of [
  ["tool_call", { tool_name: "catalog_lookup", arguments: { topic: "plugins" } }, "tool_call · catalog_lookup"],
  ["tool_search", { query: "catalog" }, "tool_search · catalog"],
  ["manage_connections", { action: "list" }, "manage_connections · list"],
]) {
  test(`${name}: summary keeps the tool name and key parameter`, () => {
    assert.ok(h.text(h.mount(call(name, { type: "unknown", input, output: "Ready" }), false).tree).includes(title));
  });
}

test("plain_text keeps whitespace and markdown verbatim under the actual tool name", () => {
  const item = examples.find(([kind]) => kind === "plain_text")[1];
  const { tree } = h.mount(item);
  assert.ok(h.nodes(tree, node => node.type === "Text" && node.props.children === item.detail.text).length);
  assert.match(h.text(tree), /report_stats/);
  assert.doesNotMatch(h.text(tree), /Other label/);
});

test("unknown inputs keep false, zero, nested objects and all output text blocks", () => {
  const { tree } = h.mount(call("inspect", { type: "unknown", input: { enabled: false, count: 0, options: { mode: "brief" } }, output: { content: [{ type: "text", text: "First block" }, { type: "text", text: "Second block" }] } }));
  const text = bodyText(tree);
  assert.match(text, /enabled:[\s\S]*false[\s\S]*count:[\s\S]*0[\s\S]*options:[\s\S]*\{"mode":"brief"\}/);
  assert.match(text, /First block\nSecond block/);
});

test("unknown output is limited to the first 15 lines with an explicit truncation note", () => {
  const output = Array.from({ length: 22 }, (_, i) => `Output line ${i + 1}`).join("\n");
  const text = bodyText(h.mount(call("inspect", { type: "unknown", input: {}, output })).tree);
  assert.match(text, /Output line 15/);
  assert.doesNotMatch(text, /Output line 16|Output line 22/);
  assert.match(text, /Showing the first 15 lines/);
});

for (const input of ["literal argument", ["one", "two"], false, 0]) {
  test(`unknown accepts ${Array.isArray(input) ? "array" : typeof input} input without losing it`, () => {
    const text = bodyText(h.mount(call("inspect", { type: "unknown", input, output: null })).tree);
    assert.match(text, /input:/);
    assert.ok(text.includes(typeof input === "string" ? input : JSON.stringify(input)));
  });
}

for (const kind of examples.map(([kind]) => kind)) {
  for (const status of ["running", "completed", "failed", "canceled"]) {
    test(`${kind}: missing input and output still render content while ${status}`, () => {
      const item = kind === "todo" ? { type: "todo", items: [] } : call("empty_tool", { type: kind }, { status });
      const { tree } = h.mount(item);
      assert.equal(cards(tree).length, 1);
      assert.ok(bodyText(tree).trim(), "expanded body contains visible text");
      if (kind === "unknown") {
        assert.match(h.text(tree), /empty_tool/);
        assert.ok(h.text(tree).includes(status));
      }
    });
  }
}

test("failed tools keep the provider's error visible", () => {
  assert.match(bodyText(h.mount(call("broken", { type: "unknown" }, { status: "failed", error: "Connection unavailable" })).tree), /Connection unavailable/);
});

test("an unrecognized future detail type uses the parameter table instead of a shell card", () => {
  const { tree } = h.mount(call("future_tool", { type: "future_kind", input: { mode: "inspect" }, output: { ready: true } }));
  assert.equal(cards(tree)[0].props.testID, "tool-card-unknown");
  assert.match(bodyText(tree), /mode:[\s\S]*inspect[\s\S]*"ready": true/);
});

test("canonical detail types take precedence over a misleading tool name", () => {
  const { tree } = h.mount(call("read", { type: "fetch", url: "https://example.org", result: "Home page" }));
  assert.equal(cards(tree)[0].props.testID, "tool-card-fetch");
});

test("legacy named tools retain their specialized adapters", () => {
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  for (const [name, input, expected] of [
    ["hub", { op: "jobs" }, "hub"], ["eval", { code: "1 + 1" }, "eval"],
    ["task", { tasks: [{ name: "Scout", task: "Inspect the guide", agent: "research" }] }, "task"],
    ["ask", { question: "Continue?", options: [] }, "ask"],
    ["mcp__catalog__lookup", { query: "guide" }, "mcp"],
  ]) assert.equal(build(call(name, { type: "unknown", input, output: "Ready" })).tool, expected);
});

test("empty eval and task payloads use a visible fallback", () => {
  for (const name of ["eval", "task"]) {
    const { tree } = h.mount(call(name, { type: "unknown", input: {}, output: "" }));
    assert.ok(bodyText(tree).trim());
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-generic-content").length, 1);
  }
});

test("plan and todo normalize checked, active and blocked steps", () => {
  const { buildChecklist } = h.load("client/tool-detail.ts");
  assert.deepEqual(buildChecklist({ text: "- [x] Done\n- [-] Active\n- [ ] Pending" }, {}, "plan").tasks.map(task => task.status), ["completed", "in_progress", "pending"]);
  assert.deepEqual(buildChecklist({}, { todos: [{ content: "Investigate", status: "blocked", reason: "Awaiting a sample" }] }, "todo").tasks[0], {
    id: "todo-0", title: "Investigate", phase: "Execution", status: "blocked", blockerReason: "Awaiting a sample",
  });
});

test("subagent model is marked as not reported when the provider omits it", () => {
  const { tree } = h.mount(call("Task", { type: "sub_agent", subAgentType: "research", description: "Inspect the guide", log: "" }));
  assert.match(bodyText(tree), /Model: Not reported/);
});

test("web search keeps a body preview alongside structured titles and URLs", () => {
  const { tree } = h.mount(call("WebSearch", { type: "search", toolName: "web_search", query: "sample", webResults: [{ title: "Guide", url: "https://example.org" }], content: "Overview\nFirst\nSecond\nThird\nFourth\nHidden" }));
  assert.match(bodyText(tree), /Guide[\s\S]*Overview[\s\S]*Fourth/);
  assert.doesNotMatch(bodyText(tree), /Hidden/);
});

test("count-mode search rows reveal the file without the match-count suffix", () => {
  const { tree } = h.mount(call("Grep", { type: "search", query: "enabled", mode: "count", content: "src/config.ts:2", numMatches: 2 }));
  h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityRole === "link")[0].props.onPress();
  assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path: "src/config.ts" }]);
});

test("blank tool names still have a visible name and status", () => {
  const { tree } = h.mount(call("  ", { type: "unknown", input: null, output: null }), false);
  assert.match(h.text(tree), /tool[\s\S]*completed/);
});

test("checklist content follows new timeline data while mounted", () => {
  const mounted = h.mount({ type: "todo", items: [{ text: "First task", completed: false }] });
  assert.match(bodyText(mounted.tree), /First task/);
  const update = { ...mounted.data, items: [{ text: "Updated task", completed: true }] };
  mounted.render(update);
  const tree = mounted.render(update);
  assert.match(bodyText(tree), /Updated task/);
  assert.doesNotMatch(bodyText(tree), /First task/);
  assert.match(bodyText(tree), /1\s*\/\s*1\s*\(\s*100\s*%\)/);
});

test("untrusted fetch schemes never reach the platform URL opener", () => {
  const { tree } = h.mount(call("fetch", { type: "fetch", url: "javascript:alert(1)", result: "Invalid link" }));
  h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityRole === "link")[0].props.onPress();
  assert.deepEqual(h.links, []);
});
