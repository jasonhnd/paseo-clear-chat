const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness();
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/real-hermes-session.json"), "utf8"));
const call = source => {
  const item = fixture.items.find(item => item.metadata?.title.startsWith(`${source}:`));
  assert.ok(item, `captured ${source} call exists`);
  return item;
};
const byId = (tree, id) => h.nodes(tree, node => node.props.testID === id);
const summary = tree => h.text(byId(tree, "tool-summary-text"));

test("captured skill_view restores the skill identity without a read prefix or line range", () => {
  const item = call("skill_view");
  assert.equal(item.name, "read");
  assert.equal(item.detail.type, "read");
  const collapsed = h.mount(item, false).tree;
  assert.equal(summary(collapsed), "Skill: sample-skill");
  const tree = h.mount(item).tree;
  assert.equal(summary(tree), "Skill: sample-skill");
  assert.match(h.text(byId(tree, "tool-card-body")), /Sample skill instruction 1/);
  assert.equal(h.nodes(tree, node => node.props.accessibilityLabel?.startsWith("Reveal ")).length, 0);
});

test("captured tool_search gets a discovery card with the real name and key parameter", () => {
  const item = call("tool_search");
  assert.equal(item.name, "other");
  assert.equal(item.detail.type, "plain_text");
  for (const expand of [false, true]) {
    const mounted = h.mount(item, expand);
    const { tree } = mounted;
    assert.equal(summary(tree), "tool_search · browser");
    assert.equal(byId(tree, "tool-card-tool_search").length, 1);
    assert.equal(byId(tree, "tool-card-plain_text").length, 0);
    assert.equal(byId(tree, "tool-generic-content").length, 0);
    if (expand) {
      assert.match(h.text(byId(tree, "tool-card-body")), /Query: browser[\s\S]*Sample browser tool description 1/);
      const showAll = h.nodes(tree, node => node.props.accessibilityLabel === "Show all 24 lines")[0];
      assert.ok(showAll, "discovery results retain the long-output control");
      assert.doesNotMatch(h.text(byId(tree, "tool-card-body")), /description 24/);
      showAll.props.onPress();
      assert.match(h.text(byId(mounted.render(), "tool-card-body")), /description 24/);
    }
  }
});

test("captured web_search keeps its query on the row instead of the page heading", () => {
  const item = call("web_search");
  assert.equal(item.name, "fetch");
  assert.equal(item.detail.type, "fetch");
  for (const expand of [false, true]) {
    const { tree } = h.mount(item, expand);
    assert.equal(summary(tree), "web_search: sample plugin guide");
    assert.equal(byId(tree, "tool-card-web_search").length, 1);
    assert.equal(h.nodes(tree, node => node.props.accessibilityLabel?.startsWith("Open web_search:")).length, 0);
    if (expand) assert.match(h.text(byId(tree, "tool-card-body")), /Query: sample plugin guide[\s\S]*Sample reference/);
  }
});

test("captured terminal commands omit the provider tool prefix in the row and body", () => {
  const item = call("terminal");
  assert.equal(item.name, "execute");
  const collapsed = h.mount(item, false).tree;
  assert.equal(summary(collapsed), "$ git log");
  const { tree } = h.mount(item);
  assert.equal(summary(tree), "$ git log");
  assert.match(h.text(byId(tree, "tool-card-body")), /\$ git log/);
  assert.doesNotMatch(h.text(tree), /terminal:/);
});

test("captured file searches omit the provider tool prefix in the row and query", () => {
  const item = call("search_files");
  assert.equal(item.name, "search");
  for (const expand of [false, true]) {
    const { tree } = h.mount(item, expand);
    assert.equal(summary(tree), "Search: sampleSetting");
    assert.doesNotMatch(h.text(tree), /search_files:/);
    if (expand) {
      assert.match(h.text(byId(tree, "tool-card-body")), /Query: sampleSetting/);
      const link = h.nodes(tree, node => node.props.accessibilityRole === "link")[0];
      link.props.onPress();
      assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path: "/workspace/sample/src/config.ts" }]);
    }
  }
});

test("recovering projected identities does not mutate captured detail or metadata objects", () => {
  const before = structuredClone(fixture);
  for (const item of fixture.items.filter(item => item.type === "tool_call")) h.mount(item);
  assert.deepEqual(fixture, before);
});

for (const metadata of [undefined, null, "invalid", { kind: "read", title: "terminal: git log" }]) {
  test(`terminal labels require corroborating projected metadata: ${JSON.stringify(metadata)}`, () => {
    const item = { ...call("terminal"), metadata };
    // The renderer schema rejects malformed metadata before the adapter runs.
    const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
    assert.equal(h.load("client/tool-summary.ts").toolSummary(build(item)), "$ terminal: git log");
  });
}

test("projected metadata preserves literal tool-like text inside real commands and queries", () => {
  const terminal = structuredClone(call("terminal"));
  terminal.detail.command = "printf 'terminal: keep this text'";
  assert.equal(summary(h.mount(terminal, false).tree), "$ printf 'terminal: keep this text'");
  const search = structuredClone(call("search_files"));
  search.detail.query = "sampleSetting: search_files: literal";
  assert.equal(summary(h.mount(search, false).tree), "Search: sampleSetting: search_files: literal");
});

test("a native query that resembles a provider label remains intact without projected metadata", () => {
  const item = { type: "tool_call", name: "search", status: "completed", detail: { type: "search", query: "search_files: literal" } };
  assert.equal(summary(h.mount(item, false).tree), "Search: search_files: literal");
});

test("misleading projected titles cannot override a canonical detail category", () => {
  const item = structuredClone(call("skill_view"));
  item.detail = { type: "fetch", url: "https://example.org/guide", result: "Sample guide" };
  const { tree } = h.mount(item);
  assert.equal(byId(tree, "tool-card-fetch").length, 1);
  assert.equal(summary(tree), "https://example.org/guide");
});

test("projected labels require an exact source tool prefix", () => {
  const item = structuredClone(call("terminal"));
  item.metadata.title = "terminal_extra: git log";
  assert.equal(summary(h.mount(item, false).tree), "$ terminal: git log");
});

for (const status of ["running", "completed", "failed", "canceled"]) {
  test(`tool discovery has a visible empty-result state while ${status}`, () => {
    const item = { type: "tool_call", name: "tool_search", status, detail: { type: "unknown", input: { query: "browser" } } };
    const { tree } = h.mount(item);
    assert.equal(summary(tree), "tool_search · browser");
    assert.equal(byId(tree, "tool-card-tool_search").length, 1);
    assert.match(h.text(byId(tree, "tool-card-body")), new RegExp(`Query: browser[\\s\\S]*No output. Status: ${status}`));
  });
}

test("explicit tool_search details retain structured output without falling back to plain text", () => {
  const item = { type: "tool_call", name: "lookup", status: "completed", detail: { type: "tool_search", input: { query: "browser" }, output: { tools: [{ name: "open_page" }] } } };
  const { tree } = h.mount(item);
  assert.equal(summary(tree), "tool_search · browser");
  assert.equal(byId(tree, "tool-card-tool_search").length, 1);
  assert.match(h.text(byId(tree, "tool-card-body")), /open_page/);
});

test("captured Claude wrap-up content remains visible outside finished tool disclosures", () => {
  const claude = JSON.parse(readFileSync(join(__dirname, "fixtures/real-claude-session.json"), "utf8"));
  const item = claude.items.find(item => item.name?.endsWith("__wrap_up"));
  assert.ok(item);
  const markdown = createToolHarness("ios", { markdown: true });
  const { tree } = markdown.mount(item, false);
  assert.equal(markdown.nodes(tree, node => node.props.testID === "tool-final-reply").length, 1);
  assert.equal(markdown.nodes(tree, node => node.props.testID === "tool-summary-row").length, 0);
  assert.ok(markdown.text(tree).includes(JSON.stringify(item.detail.input, null, 2)), "unfamiliar fields retain the complete reply");
});
