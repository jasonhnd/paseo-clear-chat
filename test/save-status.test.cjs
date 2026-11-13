const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function load(relative) {
  const filename = resolve(__dirname, "..", relative);
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const realRequire = createRequire(filename);
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(
    id => id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : realRequire(id), mod, mod.exports,
  );
  return mod.exports;
}

const { createHermesCcSaveStatusStore, PENDING_TIMEOUT_MS } = load("server/hermes-cc/save-status.ts");
const key = { sessionKey: "session", messageId: "message" };
const root = () => fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "save-status-"));
const rewrite = (dir, value) => {
  const name = fs.readdirSync(dir).find(entry => entry.endsWith(".json"));
  fs.writeFileSync(join(dir, name), JSON.stringify(value));
};

test("save status: pending and saveFailed survive a restart", async () => {
  const dir = root();
  const first = createHermesCcSaveStatusStore(dir);
  await first.begin(key);
  const reopened = createHermesCcSaveStatusStore(dir);
  assert.deepEqual((await reopened.read(key)).state, "pending");
  await reopened.fail(key, "image_lock_timeout", 4);
  const later = createHermesCcSaveStatusStore(dir);
  assert.deepEqual(await later.read(key), { state: "saveFailed", at: (await later.read(key)).at, reason: "image_lock_timeout", attempts: 4 });
});

test("save status: a later success clears the marker", async () => {
  const dir = root();
  const store = createHermesCcSaveStatusStore(dir);
  await store.fail(key, "EAGAIN", 1);
  assert.equal((await store.read(key)).state, "saveFailed");
  await store.clear(key);
  assert.equal(await store.read(key), null);
});

test("save status: an expired pending marker reads as saveFailed", async () => {
  const dir = root();
  const store = createHermesCcSaveStatusStore(dir);
  await store.begin(key);
  rewrite(dir, { state: "pending", at: Date.now() - PENDING_TIMEOUT_MS - 1000 });
  const status = await store.read(key);
  assert.equal(status.state, "saveFailed");
  assert.equal(status.reason, "pending_timeout");
});

test("save status: markers older than 30 days are swept", async () => {
  const dir = root();
  const store = createHermesCcSaveStatusStore(dir);
  await store.fail(key, "EAGAIN", 2);
  rewrite(dir, { state: "saveFailed", at: Date.now() - 31 * 24 * 60 * 60_000, reason: "EAGAIN", attempts: 2 });
  await store.sweep();
  assert.equal(await store.read(key), null);
});

test("save status: the sweep keeps the 1024 newest markers", async () => {
  const dir = root();
  const store = createHermesCcSaveStatusStore(dir);
  const base = Date.now() - 1000 * 60 * 60;
  for (let index = 0; index < 1026; index += 1) {
    await store.fail({ sessionKey: "session", messageId: `message-${index}` }, "EAGAIN", 1);
  }
  const names = fs.readdirSync(dir).filter(name => name.endsWith(".json"));
  assert.equal(names.length, 1026);
  // Re-stamp each marker so "oldest" is deterministic.
  for (const [index, name] of names.entries()) {
    const value = JSON.parse(fs.readFileSync(join(dir, name), "utf8"));
    fs.writeFileSync(join(dir, name), JSON.stringify({ ...value, at: base + index }));
  }
  await store.sweep();
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith(".json")).length, 1024, "only the 1024 newest remain");
});
