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
const nativeModels = (count, description) => ({
  currentModelId: `provider-${Math.floor((count - 1) / 200)}/model-${count - 1}`,
  availableModels: Array.from({ length: count }, (_, index) => ({
    modelId: `provider-${Math.floor(index / 200)}/model-${index}`, name: `Model ${index}`, description,
  })),
});
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
    modes: catalog.modes, defaultModel: "native",
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
    modes: [{ id: "raw-id", label: "Raw label", description: "Mode description" }], defaultModel: "second",
    models: [{ id: "first", label: "First", description: "Description", isDefault: false },
      { id: "second", label: "Second", isDefault: true, metadata: { group: "Vendor" } }],
  });
  assert.deepEqual(wire(derive({ configOptions: [] })), { models: [], modes: [] });
  for (const invalid of [undefined, null, {}, { modes: { availableModes: [{}] } }]) {
    assert.equal(derive(invalid), undefined);
  }
});

test("large native and config model lists are complete, even when the raw ACP body exceeds the document limit", () => {
  const models = nativeModels(400, "Description ".repeat(20));
  const actual = wire(derive({ modes: response.modes, models, extra: "x".repeat(1024 * 1024) }));
  assert.deepEqual(actual.modes, catalog.modes);
  assert.equal(actual.defaultModel, models.currentModelId);
  assert.deepEqual(actual.models, models.availableModels.map(model => ({
    id: model.modelId, label: model.name, description: model.description,
    isDefault: model.modelId === models.currentModelId,
  })));
  const choices = models.availableModels.map(model => ({ value: model.modelId, name: model.name, description: model.description }));
  for (const options of [choices, [{ group: "Providers", options: choices }]]) {
    const fromSelect = wire(derive({ modes: response.modes, configOptions: [option("model", models.currentModelId, options)] }));
    assert.deepEqual(fromSelect.models.map(({ metadata, ...model }) => model), actual.models);
    assert.deepEqual(fromSelect.modes, actual.modes);
  }
});

test("doubtful model lists are discarded as a whole while valid modes survive", () => {
  const models = nativeModels(400);
  for (const invalid of [
    { ...models, availableModels: [...models.availableModels, { modelId: 7, name: "Invalid" }] },
    { ...models, currentModelId: null },
    { ...models, availableModels: "invalid" },
  ]) {
    // A config select must not supply a partial replacement for the native list.
    assert.deepEqual(wire(derive({ ...response, models: invalid })), { modes: catalog.modes, models: [] });
  }
});

test("null select categories are accepted and failed selects do not erase valid native lists or other selects", () => {
  const native = { modes: response.modes, models: nativeModels(2) };
  const expected = wire(derive(native));
  for (const select of [
    option(null, "unused", [{ value: "unused", name: "Unused" }]),
    { type: "select", category: "model", options: "invalid" },
    option("thought_level", "deep", [{ value: "deep", name: 7 }]),
    option("thought_level", "deep", [{ group: "Too many", options: Array.from({ length: 257 }, (_, index) =>
      ({ value: `level-${index}`, name: `Level ${index}` })) }]),
  ]) assert.deepEqual(wire(derive({ ...native, configOptions: [select] })), expected);
  assert.deepEqual(wire(derive({ ...response,
    configOptions: [{ type: "select", options: "invalid" }, ...response.configOptions],
  })), catalog);
  assert.deepEqual(wire(derive({ configOptions: [{ type: "select", options: "invalid" }] })), { modes: [], models: [] });
});

test("remembered native and select current modes never become the catalog default", () => {
  const modes = { currentModeId: "second", availableModes: [{ id: "first", name: "First" }, { id: "second", name: "Second" }] };
  for (const state of [
    { modes },
    { configOptions: [option("mode", "second", modes.availableModes.map(mode => ({ value: mode.id, name: mode.name })))] },
  ]) {
    const actual = wire(derive(state));
    assert.deepEqual(actual.modes.map(mode => mode.id), ["first", "second"]);
    assert.equal(Object.hasOwn(actual, "defaultMode"), false);
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
  assert.ok(Buffer.byteLength(stored) <= 1024 * 1024);
  const stat = fs.statSync(pathFor(root, "custom-cc"));
  current.capture("custom-cc", changed); await current.flush();
  assert.equal(fs.statSync(pathFor(root, "custom-cc")).mtimeMs, stat.mtimeMs);
  assert.deepEqual(wire(store(root).read("custom-cc")), wire(derive(changed)));
  assert.deepEqual(wire(store(root).read("another-cc")), catalog);
  assert.equal(store(root).read("unknown-cc"), undefined);
  current.capture("custom-cc", {});
  assert.deepEqual(current.read("custom-cc").modes, [{ id: "other", label: "Other", description: undefined }]);
});

test("persists all 400 native models above 64 KiB and reloads them without truncation", async t => {
  const root = temporary(t), current = store(root);
  const state = { modes: response.modes, models: nativeModels(400, "Description ".repeat(20)) };
  const expected = wire(derive(state));
  current.capture("provider-cc", state);
  assert.deepEqual(wire(current.read("provider-cc")), expected);
  await current.flush();
  const bytes = fs.readFileSync(pathFor(root, "provider-cc"));
  assert.ok(bytes.length > 64 * 1024 && bytes.length <= 1024 * 1024);
  assert.deepEqual(wire(store(root).read("provider-cc")), expected);
  assert.equal(fs.readdirSync(root).length, 1);
});

test("an envelope over 1 MiB replaces the whole model list with modes only, in memory and after restart", async t => {
  const root = temporary(t), current = store(root);
  current.capture("provider-cc", response);
  await current.flush();
  const state = { modes: response.modes, models: nativeModels(400, "x".repeat(4096)) };
  assert.equal(derive(state).models.length, 400);
  const expected = { modes: catalog.modes, models: [] };
  current.capture("provider-cc", state);
  assert.deepEqual(wire(current.read("provider-cc")), expected);
  await current.flush();
  assert.deepEqual(wire(store(root).read("provider-cc")), expected);
  const envelope = JSON.parse(fs.readFileSync(pathFor(root, "provider-cc"), "utf8"));
  assert.deepEqual(envelope.catalog, expected);
  assert.equal(fs.readdirSync(root).length, 1);
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
    } else fs.writeFileSync(file, invalid === "json" ? "{" : invalid === "oversize" ? " ".repeat(1024 * 1024 + 1) : JSON.stringify(envelope));
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
