const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { createExpansionHost } = require("./helpers/expansion-host.cjs");

function setup(host = createExpansionHost()) {
  const h = createToolHarness("ios", { expansionHost: host });
  return { h, host, ...h.load("client/tool-expansion-store.ts") };
}
const call = (status = "completed") => ({ type: "tool_call", name: "shell", callId: "call-1", status, detail: { type: "shell", command: "git status", output: "Ready" } });
const header = (h, tree) => h.nodes(tree, node => node.type === "Pressable" && typeof node.props.accessibilityState?.expanded === "boolean")[0];
const tick = () => new Promise(resolve => setImmediate(resolve));

test("expansion identities distinguish hosts, agents, reused calls and sessions", () => {
  const { toolExpansionKey: key } = setup();
  const identity = { hostId: "host", agentId: "agent", callId: "call", name: "shell", timestamp: 100 };
  const keys = [identity, { ...identity, hostId: "other" }, { ...identity, agentId: "other" }, { ...identity, callId: "other" }, { ...identity, timestamp: 200 }, { ...identity, providerSessionId: "other" }].map(key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(key(identity), key({ ...identity }));
  assert.notEqual(key({ ...identity, hostId: "a|b", agentId: "c" }), key({ ...identity, hostId: "a", agentId: "b|c" }));
});

test("host store merges and debounces rapid edits into one revision-checked write", async () => {
  const { host, createToolExpansionStore } = setup();
  const store = createToolExpansionStore();
  await store.connect(host.read, host.write);
  store.set("one", true); store.set("two", true); store.set("one", false);
  assert.equal(host.calls.filter(call => call.name === "write").length, 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  await store.flush();
  assert.equal(host.calls.filter(call => call.name === "write").length, 1);
  assert.equal(host.values.entries.one.expanded, false);
  assert.equal(host.values.entries.two.expanded, true);
});

test("conflicts retry fresh revisions and retain another client's choices", async () => {
  const { host, createToolExpansionStore } = setup();
  const first = createToolExpansionStore(), second = createToolExpansionStore();
  await Promise.all([first.connect(host.read, host.write), second.connect(host.read, host.write)]);
  first.set("first", false); await first.flush();
  host.conflicts = 2;
  second.set("second", true); await second.flush();
  assert.equal(second.getError(), null);
  assert.equal(host.calls.filter(call => call.name === "write").length, 4);
  assert.equal(host.values.entries.first.expanded, false);
  assert.equal(host.values.entries.second.expanded, true);
});

test("bounded conflicts and failed reads or writes retain the unsaved choice for retry", async () => {
  for (const failure of ["conflicts", "failReads", "failWrites"]) {
    const { host, createToolExpansionStore } = setup();
    const store = createToolExpansionStore(); await store.connect(host.read, host.write);
    host[failure] = failure === "conflicts" ? 3 : true;
    store.set("choice", false); await store.flush();
    assert.ok(store.getError());
    assert.equal(store.get("choice"), false);
    assert.equal(host.calls.filter(call => call.name === "write").length <= 3, true);
    host[failure] = false;
    await store.flush();
    assert.equal(store.getError(), null);
    assert.equal(host.values.entries.choice.expanded, false);
  }
});

test("a click during an initial read or an in-flight write wins over the old response", async () => {
  const { host, createToolExpansionStore } = setup();
  let release;
  host.beforeRead = () => new Promise(resolve => { release = resolve; });
  const store = createToolExpansionStore();
  const connected = store.connect(host.read, host.write);
  await tick(); store.set("choice", false); release(); await connected;
  assert.equal(store.get("choice"), false);
  host.beforeRead = undefined;
  host.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const flushing = store.flush();
  await tick(); store.set("choice", true); release(); await flushing;
  assert.equal(store.get("choice"), true);
  host.beforeWrite = undefined;
  await store.flush();
  assert.equal(host.values.entries.choice.expanded, true);
});

test("host storage prunes the oldest keys and refreshes edited entries", async () => {
  const { h, host, createToolExpansionStore } = setup();
  const { MAX_EXPANSION_ENTRIES: limit } = h.load("shared/tool-expansion-settings.ts");
  host.edit(Object.fromEntries(Array.from({ length: limit }, (_, index) => [`call-${index}`, { expanded: false, updatedAt: index }])));
  const store = createToolExpansionStore(); await store.connect(host.read, host.write);
  store.set("call-0", true); store.set("new", false); await store.flush();
  assert.equal(Object.keys(host.values.entries).length, limit);
  assert.equal(host.values.entries["call-1"], undefined);
  assert.equal(host.values.entries["call-0"].expanded, true);
  assert.equal(host.values.entries.new.expanded, false);
});

for (const status of ["running", "failed"]) {
  test(`${status} defaults open and manual collapse survives fresh settings reads and status changes`, async () => {
    const host = createExpansionHost();
    const h = createToolHarness("ios", { expansionHost: host });
    const mounted = h.mount(call(status), false);
    assert.equal(header(h, mounted.tree).props.accessibilityState.expanded, true);
    header(h, mounted.tree).props.onPress();
    assert.equal(header(h, mounted.render()).props.accessibilityState.expanded, false);
    await new Promise(resolve => setTimeout(resolve, 250));
    const fresh = createToolHarness("ios", { expansionHost: host });
    const replay = fresh.mount(call("completed"), false);
    await tick();
    assert.equal(header(fresh, replay.render({ ...replay.data, status })).props.accessibilityState.expanded, false);
  });
}

test("manual expansion survives a fresh component and module reading host settings", async () => {
  const host = createExpansionHost();
  const h = createToolHarness("ios", { expansionHost: host });
  const first = h.mount(call(), false);
  assert.equal(header(h, first.tree).props.accessibilityState.expanded, false);
  header(h, first.tree).props.onPress();
  await new Promise(resolve => setTimeout(resolve, 250));
  const fresh = createToolHarness("ios", { expansionHost: host });
  const replay = fresh.mount(call(), false);
  assert.equal(header(fresh, replay.tree).props.accessibilityState.expanded, false);
  await tick();
  assert.equal(header(fresh, replay.render()).props.accessibilityState.expanded, true);
});

test("async saved choices update mounted rows and do not overwrite a newer manual click", async () => {
  const { host, toolExpansionKey: key } = setup();
  host.edit({ [key({ hostId: "demo-host", agentId: "demo-agent", callId: "call-1", name: "shell", timestamp: Date.parse("2026-01-01T12:00:00Z") })]: { expanded: true, updatedAt: 1 } });
  let release;
  host.beforeRead = () => new Promise(resolve => { release = resolve; });
  const h = createToolHarness("ios", { expansionHost: host });
  const mounted = h.mount(call("running"), false);
  await tick();
  header(h, mounted.tree).props.onPress();
  release(); host.beforeRead = undefined; await tick();
  assert.equal(header(h, mounted.render()).props.accessibilityState.expanded, false);
  await new Promise(resolve => setTimeout(resolve, 250));
});

test("fold finished steps changes defaults live while explicit choices take precedence", async () => {
  const h = createToolHarness();
  const mounted = h.mount(call(), false);
  assert.equal(header(h, mounted.tree).props.accessibilityState.expanded, false);
  h.preferences.foldFinishedSteps = false;
  let tree = mounted.render();
  assert.equal(header(h, tree).props.accessibilityState.expanded, true);
  header(h, tree).props.onPress();
  h.preferences.foldFinishedSteps = true;
  assert.equal(header(h, mounted.render()).props.accessibilityState.expanded, false);
  h.preferences.foldFinishedSteps = false;
  assert.equal(header(h, mounted.render()).props.accessibilityState.expanded, false);
  await new Promise(resolve => setTimeout(resolve, 250));
});
