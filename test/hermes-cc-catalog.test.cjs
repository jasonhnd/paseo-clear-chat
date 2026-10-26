const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { runInThisContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const filename = resolve(__dirname, "../server/hermes-cc/catalog.ts");
const moduleCode = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} }, logs = [];
runInThisContext(`(function(require,module,exports,console){${moduleCode}\n})`, { filename })(
  require, mod, mod.exports, { debug: (...args) => logs.push(args) },
);
const { deriveHermesCcCatalog: derive, createHermesCcCatalogStore: store, hermesCcCatalogObserver: observer } = mod.exports;
const wire = value => JSON.parse(JSON.stringify(value));
const option = (category, currentValue, options) => ({ type: "select", id: category, name: category, category, currentValue, options });
const response = {
  modes: { currentModeId: "custom", availableModes: [{ id: "custom", name: "Agent mode", description: "Exact description" }] },
  configOptions: [option("model", "agent-model", [{ value: "agent-model", name: "Agent model" }])],
};
const catalog = wire(derive(response));
const pathFor = (root, id) => join(root, `${createHash("sha256").update(id).digest("hex")}.json`);
const temporary = t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test("host ACP mapping prefers native lists, preserves descriptions/defaults and shares thinking choices", () => {
  const actual = wire(derive({
    ...response,
    models: { currentModelId: "native", availableModels: [{ modelId: "native", name: "Native", description: "Native description" },
      { modelId: "other", name: "Other", description: null }] },
    configOptions: [...response.configOptions, option("mode", "ignored", [{ value: "ignored", name: "Ignored" }]),
      option("thought_level", "deep", [{ group: "Reasoning", options: [{ value: "deep", name: "Deep", description: "Details" }] }])],
  }));
  assert.deepEqual(actual, {
    modes: catalog.modes, defaultMode: "custom", defaultModel: "native",
    models: [
      { id: "native", label: "Native", description: "Native description", isDefault: true },
      { id: "other", label: "Other", isDefault: false },
    ].map(model => ({ ...model, thinkingOptions: [{ id: "deep", label: "Deep", description: "Details", isDefault: true,
      metadata: { group: "Reasoning" } }], defaultThinkingOptionId: "deep" })),
  });
});

test("host ACP mapping flattens grouped mode/model config choices and uses the first select category", () => {
  assert.deepEqual(wire(derive({ modes: { availableModes: [] }, models: { currentModelId: "unused", availableModels: [] }, configOptions: [
    option("model", "second", [{ value: "first", name: "First", description: "Description" },
      { group: "Vendor", options: [{ value: "second", name: "Second" }] }]),
    option("model", "ignored", [{ value: "ignored", name: "Ignored" }]),
    option("mode", "raw-id", [{ group: "Modes", options: [{ value: "raw-id", name: "Raw label", description: "Mode description" }] }]),
  ] })), {
    modes: [{ id: "raw-id", label: "Raw label", description: "Mode description" }], defaultMode: "raw-id", defaultModel: "second",
    models: [{ id: "first", label: "First", description: "Description", isDefault: false },
      { id: "second", label: "Second", isDefault: true, metadata: { group: "Vendor" } }],
  });
  assert.deepEqual(wire(derive({ configOptions: [] })), { models: [], modes: [] });
  for (const invalid of [undefined, null, {}, { modes: { availableModes: [{}] } },
    { configOptions: [{ type: "select", options: "bad" }] }, { ...response, extra: "x".repeat(65536) }]) {
    assert.equal(derive(invalid), undefined);
  }
});

test("observer correlates new/load replies, ignores probes/notifications/errors and isolates capture failure", () => {
  const captured = [], current = observer(result => captured.push(result));
  const request = (id, method) => ({ jsonrpc: "2.0", id, method });
  const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
  current.sent(request(1, "initialize")); current.received(reply(1, response));
  current.sent(request(2, "session/new")); current.received(reply(3, response));
  current.received({ ...request(2, "agent/request"), result: response });
  current.received(reply(2, response)); current.received(reply(2, response));
  current.sent(request("2", "session/load")); current.received(reply("2", { configOptions: [] }));
  current.sent(request(4, "session/new")); current.received({ jsonrpc: "2.0", id: 4, error: { code: -1, message: "private" } });
  current.received(reply(4, response));
  assert.deepEqual(captured, [response, { configOptions: [] }]);
  const failing = observer(() => { throw new Error("private agent response"); });
  failing.sent(request(1, "session/new"));
  assert.doesNotThrow(() => failing.received(reply(1, response)));
  assert.deepEqual(logs.pop(), ["[clear-chat] hermes_cc: catalog_capture_failed"]);
});

test("catalog is immediately available, atomically persisted per provider and schema-validated after restart", async t => {
  const root = temporary(t), current = store(root);
  assert.equal(current.read("custom-cc"), undefined);
  assert.equal(fs.readdirSync(root).length, 0);
  current.capture("custom-cc", response);
  assert.deepEqual(wire(current.read("custom-cc")), catalog);
  const modified = current.read("custom-cc"); modified.models.length = 0;
  assert.equal(current.read("custom-cc").models.length, 1);
  const changed = { ...response, modes: { currentModeId: "other", availableModes: [{ id: "other", name: "Other" }] } };
  current.capture("custom-cc", changed);
  current.capture("another-cc", response);
  await current.flush();
  assert.equal(fs.readdirSync(root).length, 2);
  const stored = fs.readFileSync(pathFor(root, "custom-cc"), "utf8");
  assert.ok(Buffer.byteLength(stored) <= 65536);
  const stat = fs.statSync(pathFor(root, "custom-cc"));
  current.capture("custom-cc", changed); await current.flush();
  assert.equal(fs.statSync(pathFor(root, "custom-cc")).mtimeMs, stat.mtimeMs);
  assert.deepEqual(wire(store(root).read("custom-cc")), wire(derive(changed)));
  assert.deepEqual(wire(store(root).read("another-cc")), catalog);
  assert.equal(store(root).read("unknown-cc"), undefined);
  current.capture("custom-cc", {}); current.capture("custom-cc", { ...response, extra: "x".repeat(65536) });
  assert.equal(current.read("custom-cc").defaultMode, "other");
});

for (const invalid of ["json", "version", "identity", "model", "mode", "extra", "oversize", "directory", "symlink"]) {
  test(`ignores doubtful stored catalog: ${invalid}`, t => {
    const root = temporary(t), file = pathFor(root, "provider-cc");
    const envelope = { version: 1, providerId: "provider-cc", catalog: structuredClone(catalog) };
    if (invalid === "version") envelope.version = 2;
    if (invalid === "identity") envelope.providerId = "another-cc";
    if (invalid === "model") envelope.catalog.models.push({ id: 1, label: "Invalid" });
    if (invalid === "mode") envelope.catalog.defaultMode = 1;
    if (invalid === "extra") envelope.secret = "not a catalog field";
    if (invalid === "directory") fs.mkdirSync(file);
    else if (invalid === "symlink") {
      const other = join(root, "other.json"); fs.writeFileSync(other, JSON.stringify(envelope)); fs.symlinkSync(other, file);
    } else fs.writeFileSync(file, invalid === "json" ? "{" : invalid === "oversize" ? " ".repeat(65537) : JSON.stringify(envelope));
    assert.equal(store(root).read("provider-cc"), undefined);
  });
}

test("disk failure never prevents learning or throws; a later real open still learns", async t => {
  const root = temporary(t), blocked = join(root, "file"); fs.writeFileSync(blocked, "blocked");
  const current = store(blocked);
  assert.doesNotThrow(() => current.capture("provider-cc", response));
  assert.deepEqual(wire(current.read("provider-cc")), catalog);
  await current.flush();
  assert.deepEqual(logs.pop(), ["[clear-chat] hermes_cc: catalog_save_failed"]);
  fs.unlinkSync(blocked);
  current.capture("provider-cc", { ...response, configOptions: [] });
  await current.flush();
  assert.deepEqual(store(blocked).read("provider-cc").models, []);
});
