const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "hermes-cc-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = new Map();
  function load(filename) {
    filename = resolve(__dirname, "..", filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const realRequire = createRequire(filename);
    function localRequire(id) {
      return id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : overrides[id] ?? realRequire(id);
    }
    runInThisContext(`(function(require,module,exports,console){${code}\n})`, { filename })(
      localRequire, mod, mod.exports, { debug() {} },
    );
    return mod.exports;
  }
  const history = load("server/hermes-cc/history-store.ts");
  const images = load("server/hermes-cc/store.ts");
  const storeRoot = join(root, "history");
  return {
    root, storeRoot, load, ...history, ...images,
    create: (dir, options) => history.createHermesCcHistoryStore(dir, options),
    store: history.createHermesCcHistoryStore(storeRoot),
  };
}
function compileHistory(h) {
  const compiledDir = join(h.root, "compiled");
  fs.mkdirSync(compiledDir);
  for (const name of ["store.ts", "history-store.ts"]) {
    fs.writeFileSync(join(compiledDir, name.replace(/\.ts$/, ".js")), ts.transpileModule(
      fs.readFileSync(resolve(__dirname, "../server/hermes-cc", name), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText);
  }
  return join(compiledDir, "history-store.js");
}
const key = (nativeSessionId = "native-1", providerId = "hermes-cc") => ({ providerId, nativeSessionId });
const digest = (providerId, nativeSessionId) => createHash("sha256").update(`${providerId}\0${nativeSessionId}`).digest("hex");
const sessionDir = (h, k = key()) => join(h.storeRoot, digest(k.providerId, k.nativeSessionId));
const manifestPath = (h, k = key()) => join(sessionDir(h, k), "manifest.json");
const eventsPath = (h, k = key()) => join(sessionDir(h, k), "events.jsonl");
const readManifest = (h, k = key()) => JSON.parse(fs.readFileSync(manifestPath(h, k), "utf8"));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function editManifest(h, k, change, resign = false) {
  const value = { ...readManifest(h, k), ...change };
  if (resign) {
    const { manifestHash, ...fields } = value;
    value.manifestHash = createHash("sha256").update(digest(k.providerId, k.nativeSessionId) + canonical(fields)).digest("hex");
  }
  fs.writeFileSync(manifestPath(h, k), JSON.stringify(value));
}
function diskBytes(path) {
  if (!fs.existsSync(path)) return 0;
  return fs.readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const file = join(path, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return sum + stat.size;
    return sum + (stat.isDirectory() ? diskBytes(file) : stat.size);
  }, 0);
}
function assertUnusable(state, reason) {
  assert.equal(state.status, "unusable");
  assert.equal(state.reason, reason);
  assert.equal(Object.hasOwn(state, "events"), false);
}

test("Hermes CC history journal round-trips events recorded from creation", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  assert.deepEqual(await h.store.read(k), { status: "complete", events: [] });
  await h.store.append(k, { type: "user", text: "héllo" });
  await h.store.turnStarted(k);
  await h.store.append(k, { type: "agent", n: 2, nested: { ok: true } });
  await h.store.append(k, ["chunk", null]);
  await h.store.turnSettled(k);
  await h.store.append(k, null);
  const events = [{ type: "user", text: "héllo" }, { type: "agent", n: 2, nested: { ok: true } }, ["chunk", null], null];
  assert.deepEqual(await h.store.read(k), { status: "complete", events });
  assert.deepEqual(await h.create(h.storeRoot).read(k), { status: "complete", events });
  const manifest = readManifest(h, k);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.providerId, k.providerId);
  assert.equal(manifest.nativeSessionId, k.nativeSessionId);
  assert.equal(manifest.startedFromCreation, true);
  assert.equal(manifest.openTurns, 0);
  assert.equal(manifest.records, events.length);
  assert.equal(manifest.bytes, fs.statSync(eventsPath(h, k)).size);
  assert.equal(fs.readFileSync(eventsPath(h, k), "utf8").trim().split("\n").length, events.length);
  assert.equal(fs.statSync(h.storeRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sessionDir(h, k)).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(sessionDir(h, k))) {
    assert.equal(fs.statSync(join(sessionDir(h, k), name)).mode & 0o777, 0o600);
    assert.equal(name.endsWith(".tmp"), false);
  }
  assert.equal(fs.readdirSync(h.storeRoot).includes(".journal.lock"), false);
  const before = fs.statSync(manifestPath(h, k), { bigint: true });
  await h.store.read(k);
  const after = fs.statSync(manifestPath(h, k), { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  const other = key("other-native");
  await h.store.start(other);
  await h.store.append(other, { side: "right" });
  assert.deepEqual((await h.store.read(k)).events, events);
  assert.deepEqual((await h.store.read(other)).events, [{ side: "right" }]);
  assert.notEqual(sessionDir(h, k), sessionDir(h, { providerId: "a", nativeSessionId: "bc" }));
  await h.store.start({ providerId: "ab", nativeSessionId: "c" });
  await h.store.start({ providerId: "a", nativeSessionId: "bc" });
  await h.store.append({ providerId: "ab", nativeSessionId: "c" }, { side: "left" });
  assert.deepEqual((await h.store.read({ providerId: "a", nativeSessionId: "bc" })).events, []);
});

test("Hermes CC history append without start is a no-op and does not create a root", async t => {
  const h = harness(t), k = key();
  assert.equal(fs.existsSync(h.storeRoot), false);
  await h.store.append(k, { a: 1 });
  await h.store.append(k, undefined);
  await h.store.turnStarted(k);
  await h.store.turnSettled(k);
  await h.store.invalidate(k, "history_mutated");
  assert.equal(fs.existsSync(h.storeRoot), false);
  assertUnusable(await h.store.read(k), "missing");
  assert.equal(fs.existsSync(h.storeRoot), false);
});

test("Hermes CC history treats an unsettled turn as unusable until it settles", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  await h.store.turnStarted(k);
  await h.store.append(k, { n: 2 });
  assertUnusable(await h.store.read(k), "unsettled_turn");
  await h.store.turnStarted(k);
  await h.store.turnSettled(k);
  assertUnusable(await h.store.read(k), "unsettled_turn");
  await h.store.turnSettled(k);
  assert.deepEqual(await h.store.read(k), { status: "complete", events: [{ n: 1 }, { n: 2 }] });
  await h.store.turnSettled(k);
  assert.equal((await h.store.read(k)).status, "complete");
});

test("Hermes CC history invalidation is permanent and does not echo raw errors", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  const before = fs.readFileSync(eventsPath(h, k));
  await h.store.invalidate(k, "history_mutated");
  await h.store.append(k, { n: 2 });
  await h.store.turnStarted(k);
  await h.store.turnSettled(k);
  await h.store.invalidate(k, "other_reason");
  assertUnusable(await h.store.read(k), "history_mutated");
  assert.deepEqual(fs.readFileSync(eventsPath(h, k)), before);
  assertUnusable(await h.create(h.storeRoot).read(k), "history_mutated");
  await assert.rejects(h.store.start(k), /journal_exists/);
  await h.store.invalidate(k, "Error: ENOENT: no such file '/tmp/secret-path'");
  const state = await h.store.read(k);
  assertUnusable(state, "history_mutated");
  assert.equal(JSON.stringify(state).includes("ENOENT"), false);
  assert.equal(JSON.stringify(state).includes("secret-path"), false);
  const raw = key("raw");
  await h.store.start(raw);
  await h.store.invalidate(raw, "ENOENT: no such file '/tmp/secret-path'");
  const coerced = await h.store.read(raw);
  assertUnusable(coerced, "invalidated");
  assert.equal(JSON.stringify(coerced).includes("ENOENT"), false);
  assert.equal(JSON.stringify(readManifest(h, raw)).includes("ENOENT"), false);
});

test("Hermes CC history refuses torn, mismatched, unreadable and wrong-version journals", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  await h.store.append(k, { n: 2 });
  const file = eventsPath(h, k);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, original.subarray(0, original.length - 3));
  assertUnusable(await h.store.read(k), "corrupt");
  fs.writeFileSync(file, original);
  editManifest(h, k, { records: readManifest(h, k).records + 5 });
  assertUnusable(await h.store.read(k), "corrupt");
  editManifest(h, k, { records: 2, bytes: original.length + 4 });
  assertUnusable(await h.store.read(k), "corrupt");
  const broken = Buffer.from("{nope}\n");
  fs.writeFileSync(file, broken);
  editManifest(h, k, { records: 1, bytes: broken.length, version: 1 });
  assertUnusable(await h.store.read(k), "corrupt");
  fs.writeFileSync(file, original);
  editManifest(h, k, { records: 2, bytes: original.length, version: 2, startedFromCreation: true, providerId: k.providerId });
  assertUnusable(await h.store.read(k), "schema_mismatch");
  editManifest(h, k, { version: 1, startedFromCreation: false });
  assertUnusable(await h.store.read(k), "corrupt");
  editManifest(h, k, { startedFromCreation: true, providerId: "other-provider" });
  assertUnusable(await h.store.read(k), "schema_mismatch");
  fs.writeFileSync(manifestPath(h, k), "{");
  assertUnusable(await h.store.read(k), "schema_mismatch");
  fs.appendFileSync(file, `${JSON.stringify({ injected: true })}\n`);
  fs.writeFileSync(manifestPath(h, k), JSON.stringify({
    version: 1, providerId: k.providerId, nativeSessionId: k.nativeSessionId, startedFromCreation: true,
    openTurns: 0, records: 2, bytes: original.length, createdAt: 1,
  }));
  await h.store.append(k, { n: 3 });
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes('"n":3'), false);
  assert.equal(text.includes("injected"), true);
  assertUnusable(await h.store.read(k), "corrupt");
  await h.store.append(k, { n: 4 });
  assert.equal(fs.readFileSync(file, "utf8").includes('"n":4'), false);
});

test("Hermes CC history caps invalidate a session and evict the oldest sessions", async t => {
  const h = harness(t), k = key();
  const line = `${canonical({ event: { pad: "x".repeat(20) }, hash: "0".repeat(64) })}\n`;
  const exact = h.create(h.storeRoot, { maxBytesPerSession: Buffer.byteLength(line), maxBytesTotal: 5_000_000 });
  await exact.start(k);
  await exact.append(k, { pad: "x".repeat(20) });
  assert.equal((await exact.read(k)).status, "complete");
  assert.ok(diskBytes(sessionDir(h, k)) > Buffer.byteLength(line));
  await exact.append(k, { pad: "y" });
  assertUnusable(await exact.read(k), "over_cap");
  assert.equal(readManifest(h, k).invalid, "over_cap");
  assert.equal(fs.existsSync(sessionDir(h, k)), true);
  const kept = fs.readFileSync(eventsPath(h, k));
  await exact.append(k, { pad: "z" });
  assert.deepEqual(fs.readFileSync(eventsPath(h, k)), kept);
  await assert.rejects(exact.start(k), /journal_exists/);
  assertUnusable(await h.store.read(k), "over_cap");

  const fresh = key("fresh");
  const small = h.create(h.storeRoot, { maxBytesPerSession: 80, maxBytesTotal: 5_000_000 });
  await small.start(fresh);
  await small.append(fresh, { pad: "z".repeat(200) });
  assertUnusable(await small.read(fresh), "over_cap");
  assert.equal(readManifest(h, fresh).records, 0);
  assert.equal(readManifest(h, fresh).bytes, 0);
  assert.equal(fs.readFileSync(eventsPath(h, fresh)).length, 0);

  const a = key("old"), b = key("new");
  await h.store.start(a);
  await h.store.append(a, { who: "a", pad: "a".repeat(4000) });
  await h.store.start(b);
  await h.store.append(b, { who: "b", pad: "b".repeat(4000) });
  editManifest(h, a, { createdAt: 10 }, true);
  editManifest(h, b, { createdAt: 20 }, true);
  const future = new Date(Date.now() + 120_000);
  fs.utimesSync(sessionDir(h, a), future, future);
  const outside = join(h.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "keep"), "outside bytes");
  const stale = join(h.storeRoot, ".old.tmp");
  fs.mkdirSync(stale);
  fs.writeFileSync(join(stale, "data"), Buffer.alloc(100));
  fs.symlinkSync(outside, join(stale, "link"));
  const oldTime = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(stale, oldTime, oldTime);
  const junk = join(h.storeRoot, "recent-junk");
  fs.writeFileSync(junk, Buffer.alloc(8000));
  const sizeB = diskBytes(sessionDir(h, b));
  const capped = h.create(h.storeRoot, { maxBytesTotal: sizeB + 2000, maxBytesPerSession: 64 * 1024 * 1024 });
  const gotB = await capped.read(b);
  assert.equal(gotB.status, "complete");
  assert.equal(gotB.events[0].who, "b");
  assertUnusable(await capped.read(a), "evicted");
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(junk), false);
  assert.equal(fs.readFileSync(join(outside, "keep"), "utf8"), "outside bytes");
  assert.ok(diskBytes(h.storeRoot) <= sizeB + 2000);
});

test("Hermes CC history keeps one process and two processes ordered on the same key", async t => {
  const h = harness(t), k = key("shared");
  await h.store.start(k);
  const other = h.create(h.storeRoot);
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? h.store : other).append(k, { i })));
  const state = await h.store.read(k);
  assert.equal(state.status, "complete");
  assert.deepEqual(state.events, Array.from({ length: 30 }, (_, i) => ({ i })));
  const left = key("left"), right = key("right");
  await h.store.start(left);
  await h.store.start(right);
  await Promise.all([
    (async () => { for (let i = 0; i < 15; i++) await h.store.append(left, { left: i }); })(),
    (async () => { for (let i = 0; i < 15; i++) await other.append(right, { right: i }); })(),
  ]);
  assert.deepEqual((await h.store.read(left)).events, Array.from({ length: 15 }, (_, i) => ({ left: i })));
  assert.deepEqual((await h.store.read(right)).events, Array.from({ length: 15 }, (_, i) => ({ right: i })));
});

test("Hermes CC history serializes two processes appending the same key", { timeout: 30_000 }, async t => {
  const h = harness(t), k = key("shared-native");
  await h.store.start(k);
  const compiledModule = compileHistory(h);
  const worker = join(h.root, "writer.cjs");
  fs.writeFileSync(worker, `
    const { createHermesCcHistoryStore } = require(process.argv[2]);
    const store = createHermesCcHistoryStore(process.argv[3]);
    const id = process.argv[4];
    const count = Number(process.argv[5]);
    const key = { providerId: "hermes-cc", nativeSessionId: "shared-native" };
    (async () => {
      for (let i = 0; i < count; i++) await store.append(key, { id, i });
      process.send({ ok: true });
    })().catch(error => {
      process.send({ error: String(error && error.stack || error) });
      process.exitCode = 1;
    });
  `);
  const count = 25;
  const children = ["a", "b"].map(id => {
    const child = fork(worker, [compiledModule, h.storeRoot, id, String(count)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => { if (child.connected) child.kill(); });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on("message", message => message.ok ? resolve() : reject(new Error(message.error || "writer failed")));
      child.once("error", reject);
      child.once("exit", code => { if (code !== 0) reject(new Error(`writer ${id} exited ${code}: ${stderr}`)); });
    });
    return done;
  });
  await Promise.all(children);
  const state = await h.create(h.storeRoot).read(k);
  assert.equal(state.status, "complete");
  assert.equal(state.events.length, count * 2);
  for (const id of ["a", "b"]) {
    const indexes = state.events.filter(event => event.id === id).map(event => event.i);
    assert.deepEqual(indexes, Array.from({ length: count }, (_, i) => i));
  }
  const manifest = readManifest(h, k);
  assert.equal(manifest.records, state.events.length);
  assert.equal(manifest.bytes, fs.statSync(eventsPath(h, k)).size);
  assert.equal(fs.readdirSync(h.storeRoot).includes(".journal.lock"), false);
});

test("Hermes CC history recovers an abandoned on-disk lock", async t => {
  const h = harness(t), k = key();
  fs.mkdirSync(h.storeRoot);
  const lock = join(h.storeRoot, ".journal.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "abandoned" }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  assert.deepEqual(await h.store.read(k), { status: "complete", events: [{ n: 1 }] });
  assert.equal(fs.existsSync(lock), false);
});

test("Hermes CC history fsyncs the journal line before the directory", async t => {
  const fsp = require("node:fs/promises");
  const syncs = [];
  const wrapped = { ...fsp, async open(path, flags, mode) {
    const handle = await fsp.open(path, flags, mode);
    const openedPath = fs.realpathSync(path);
    const original = handle.sync.bind(handle);
    handle.sync = async () => {
      syncs.push({ directory: (await handle.stat()).isDirectory(), path: openedPath });
      return original();
    };
    return handle;
  } };
  const h = harness(t, { "node:fs/promises": wrapped }), k = key();
  await h.store.start(k);
  syncs.length = 0;
  await h.store.append(k, { n: 1 });
  const fileSync = syncs.findIndex(entry => entry.path === eventsPath(h, k));
  const manifestSync = syncs.findIndex(entry => entry.path.startsWith(sessionDir(h, k)) && entry.path.endsWith(".tmp"));
  const dirSync = syncs.findIndex(entry => entry.path === sessionDir(h, k) && entry.directory);
  assert.ok(fileSync >= 0);
  assert.ok(manifestSync > fileSync);
  assert.ok(dirSync > manifestSync);
  assert.deepEqual(await h.store.read(k), { status: "complete", events: [{ n: 1 }] });
});

test("Hermes CC history refuses a symlinked root and never writes outside it", async t => {
  const h = harness(t), outside = join(h.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "keep"), "outside bytes");
  fs.symlinkSync(outside, h.storeRoot);
  await assert.rejects(h.store.start(key()), /unsafe_history_directory/);
  await assert.rejects(h.store.append(key(), { a: 1 }), /unsafe_history_directory/);
  await assert.rejects(h.store.turnStarted(key()), /unsafe_history_directory/);
  await assert.rejects(h.store.invalidate(key(), "history_mutated"), /unsafe_history_directory/);
  assertUnusable(await h.store.read(key()), "unsafe_path");
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
  const nested = h.create(join(h.storeRoot, "nested"));
  await assert.rejects(nested.start(key()), /unsafe_history_directory/);
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
});

test("Hermes CC history does not follow linked journals or write outside the root", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  const outside = join(h.root, "outside");
  fs.mkdirSync(outside);
  const moved = join(h.root, "moved-events");
  fs.renameSync(eventsPath(h, k), moved);
  fs.symlinkSync(moved, eventsPath(h, k));
  const before = fs.readFileSync(moved);
  await assert.rejects(h.store.append(k, { n: 2 }), /unsafe_history_file/);
  assert.deepEqual(fs.readFileSync(moved), before);
  assertUnusable(await h.store.read(k), "unsafe_path");
  fs.unlinkSync(eventsPath(h, k));
  fs.renameSync(moved, eventsPath(h, k));
  const outsideFile = join(outside, "events.jsonl");
  fs.renameSync(eventsPath(h, k), outsideFile);
  fs.linkSync(outsideFile, eventsPath(h, k));
  const linked = fs.readFileSync(outsideFile);
  await assert.rejects(h.store.append(k, { n: 3 }), /unsafe_history_file/);
  assert.deepEqual(fs.readFileSync(outsideFile), linked);
  assertUnusable(await h.store.read(k), "unsafe_path");

  const dirKey = key("dir");
  await h.store.start(dirKey);
  await h.store.append(dirKey, { n: 1 });
  const movedDir = join(h.root, "moved-dir");
  fs.renameSync(sessionDir(h, dirKey), movedDir);
  fs.symlinkSync(movedDir, sessionDir(h, dirKey));
  const listing = fs.readdirSync(movedDir);
  await assert.rejects(h.store.append(dirKey, { n: 2 }), /unsafe_history_directory/);
  assert.deepEqual(fs.readdirSync(movedDir), listing);
  assertUnusable(await h.store.read(dirKey), "unsafe_path");
});

test("Hermes CC history root follows the real Paseo home and refuses a swapped symlink", async t => {
  const h = harness(t), previous = process.env.PASEO_HOME;
  t.after(() => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; });
  const alias = join(h.root, "alias"), real = join(h.root, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  process.env.PASEO_HOME = alias;
  assert.equal(h.hermesCcPaseoHome(), real);
  const root = h.hermesCcHistoryRoot({});
  assert.equal(root, join(real, "plugin-data", "clear-chat", "hermes-cc-history"));
  const store = h.create(root, { trustedRoot: real });
  await store.start(key());
  await store.append(key(), { ok: true });
  assert.deepEqual(await store.read(key()), { status: "complete", events: [{ ok: true }] });
  assert.deepEqual(fs.readdirSync(real), ["plugin-data"]);
  fs.renameSync(join(real, "plugin-data"), join(real, "moved"));
  const outside = join(h.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "keep"), "outside bytes");
  fs.symlinkSync(outside, join(real, "plugin-data"));
  await assert.rejects(store.append(key(), { no: true }), /unsafe_history_directory/);
  assertUnusable(await store.read(key()), "unsafe_path");
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
  assert.equal(fs.existsSync(join(real, "moved", "clear-chat", "hermes-cc-history")), true);
});

test("Hermes CC history rejects invalid keys and caps", async t => {
  const h = harness(t);
  for (const value of ["", " ", "a".repeat(513), "a\0b", null, 1]) {
    for (const k of [key(value), key("native-1", value)]) {
      await assert.rejects(h.store.start(k), /invalid_journal_key/);
      await assert.rejects(h.store.append(k, { a: 1 }), /invalid_journal_key/);
      await assert.rejects(h.store.turnStarted(k), /invalid_journal_key/);
      await assert.rejects(h.store.turnSettled(k), /invalid_journal_key/);
      await assert.rejects(h.store.invalidate(k, "history_mutated"), /invalid_journal_key/);
      await assert.rejects(h.store.read(k), /invalid_journal_key/);
    }
  }
  const boundary = key("s".repeat(512), "p".repeat(512));
  await h.store.start(boundary);
  await h.store.append(boundary, { ok: true });
  assert.deepEqual(await h.store.read(boundary), { status: "complete", events: [{ ok: true }] });
  for (const value of [-1, Number.NaN, Infinity, 1.5]) {
    assert.throws(() => h.create(h.storeRoot, { maxBytesPerSession: value }), /invalid_history_cap/);
    assert.throws(() => h.create(h.storeRoot, { maxBytesTotal: value }), /invalid_history_cap/);
  }
});

test("Hermes CC history invalidates a journal that cannot record an event", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  await assert.rejects(h.store.append(k, 1n), /invalid_event/);
  assertUnusable(await h.store.read(k), "invalid_event");
  await h.store.append(k, { n: 2 });
  assertUnusable(await h.create(h.storeRoot).read(k), "invalid_event");
  assert.equal(fs.readFileSync(eventsPath(h, k), "utf8").includes('"n":2'), false);
});

test("Hermes CC history binds the canonical hash chain to the exact key and journal", async t => {
  const h = harness(t), a = key("session-a"), b = key("session-b");
  const event = { text: "Image A", clientMessageId: "message-A", nested: { z: 1, a: 2 } };
  for (const k of [a, b]) {
    await h.store.start(k);
    await h.store.append(k, event);
    await h.store.append(k, { text: "second" });
  }
  const original = fs.readFileSync(eventsPath(h, a));
  const manifest = readManifest(h, a);
  let head = createHash("sha256").update(canonical({ ...a, journalId: manifest.journalId })).digest("hex");
  const records = original.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  for (const record of records) {
    head = createHash("sha256").update(head + canonical(record.event)).digest("hex");
    assert.equal(record.hash, head);
  }
  assert.equal(manifest.headHash, head);
  const { manifestHash, ...fields } = manifest;
  assert.equal(manifestHash, createHash("sha256").update(digest(a.providerId, a.nativeSessionId) + canonical(fields)).digest("hex"));
  const edits = [
    Buffer.from(original.toString().replaceAll("message-A", "message-B").replaceAll("Image A", "Image B")),
    fs.readFileSync(eventsPath(h, b)),
    Buffer.from(`${original.toString().trimEnd().split("\n").reverse().join("\n")}\n`),
  ];
  // Even a second journal for the same key has a different random chain seed.
  const secondRoot = join(h.root, "second-history"), other = h.create(secondRoot);
  await other.start(a);
  await other.append(a, event);
  await other.append(a, { text: "second" });
  edits.push(fs.readFileSync(join(secondRoot, digest(a.providerId, a.nativeSessionId), "events.jsonl")));
  for (const edited of edits) {
    assert.equal(edited.length, original.length);
    fs.writeFileSync(eventsPath(h, a), edited);
    assertUnusable(await h.create(h.storeRoot).read(a), "corrupt");
    assertUnusable(await h.store.read(a), "corrupt");
  }
  fs.writeFileSync(eventsPath(h, a), original);
  assert.deepEqual((await h.store.read(a)).events, [event, { text: "second" }]);
  // A warm writer must notice an equal-size edit too, rather than blessing it on append.
  fs.writeFileSync(eventsPath(h, a), edits[0]);
  await h.store.append(a, { text: "third" });
  assertUnusable(await h.create(h.storeRoot).read(a), "corrupt");
  assert.equal(readManifest(h, a).records, 2);
});

test("Hermes CC history refuses checksum edits to turn and completeness metadata", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.turnStarted(k);
  const original = fs.readFileSync(manifestPath(h, k));
  for (const change of [{ openTurns: 0 }, { startedFromCreation: false }, { headHash: "0".repeat(64) }, { journalId: "0".repeat(36) }]) {
    fs.writeFileSync(manifestPath(h, k), original);
    editManifest(h, k, change);
    assertUnusable(await h.create(h.storeRoot).read(k), "corrupt");
    await h.store.turnSettled(k);
    assertUnusable(await h.store.read(k), "corrupt");
  }
  fs.writeFileSync(manifestPath(h, k), original);
  assertUnusable(await h.store.read(k), "unsettled_turn");
  await h.store.turnSettled(k);
  assert.equal((await h.store.read(k)).status, "complete");
});

test("Hermes CC history snapshots both key strings before queueing every public operation", async t => {
  const h = harness(t);
  for (const method of ["start", "append", "turnStarted", "turnSettled", "invalidate", "read", "claimWriter"]) {
    const a = key(`a-${method}`), b = key(`b-${method}`, "other-provider");
    await h.store.start(b);
    if (method !== "start") await h.store.start(a);
    if (method === "turnSettled") await h.store.turnStarted(a);
    const mutable = { ...a };
    // Queue behind another operation on A, then mutate the caller's object synchronously.
    const preceding = h.store.append(a, { preceding: true });
    const pending = method === "append" ? h.store.append(mutable, { from: "a" }) :
      method === "invalidate" ? h.store.invalidate(mutable, "history_mutated") : h.store[method](mutable);
    Object.assign(mutable, b);
    await preceding;
    const result = await pending;
    assert.deepEqual(await h.store.read(b), { status: "complete", events: [] });
    if (method === "turnStarted") assertUnusable(await h.store.read(a), "unsettled_turn");
    else if (method === "invalidate") assertUnusable(await h.store.read(a), "history_mutated");
    else if (method === "append") assert.deepEqual((await h.store.read(a)).events, [{ preceding: true }, { from: "a" }]);
    else if (method === "read") assert.deepEqual(result, { status: "complete", events: [{ preceding: true }] });
    else assert.equal((await h.store.read(a)).status, "complete");
    if (method === "claimWriter") {
      assert.ok(result);
      assert.equal(await h.store.claimWriter(a), null);
      const leaseB = await h.store.claimWriter(b);
      assert.ok(leaseB);
      await leaseB.release();
      await result.release();
    }
  }
});

test("Hermes CC history syncs every newly created directory's parent including the history root", async t => {
  const fsp = require("node:fs/promises"), operations = [];
  const wrapped = { ...fsp,
    async mkdir(path, options) {
      const result = await fsp.mkdir(path, options);
      operations.push({ mkdir: true, parent: fs.realpathSync(dirname(path)) });
      return result;
    },
    async open(path, flags, mode) {
      const handle = await fsp.open(path, flags, mode), sync = handle.sync.bind(handle);
      const openedPath = fs.realpathSync(path);
      handle.sync = async () => {
        if ((await handle.stat()).isDirectory()) operations.push({ sync: openedPath });
        return sync();
      };
      return handle;
    },
  };
  const h = harness(t, { "node:fs/promises": wrapped });
  const root = join(h.root, "new-parent", "nested", "history"), store = h.create(root);
  await store.start(key());
  await store.append(key(), { n: 1 });
  const parents = operations.filter(op => op.mkdir).map(op => op.parent);
  assert.deepEqual(parents, [h.root, join(h.root, "new-parent"), join(h.root, "new-parent", "nested"), root]);
  for (const [index, op] of operations.entries()) {
    if (op.mkdir) assert.equal(operations[index + 1].sync, op.parent);
  }
});

test("Hermes CC history appends incrementally and re-verifies when another writer changes the manifest", async t => {
  const fsp = require("node:fs/promises");
  let fullReads = 0, rootScans = 0, rootInode;
  const wrapped = { ...fsp,
    async open(path, flags, mode) {
      if (String(path).endsWith("/events.jsonl") && (flags & 3) === fs.constants.O_RDONLY) fullReads++;
      return fsp.open(path, flags, mode);
    },
    async readdir(path, ...args) {
      if (rootInode && fs.statSync(path).ino === rootInode) rootScans++;
      return fsp.readdir(path, ...args);
    },
  };
  const h = harness(t, { "node:fs/promises": wrapped }), k = key();
  await h.store.start(k);
  rootInode = fs.statSync(h.storeRoot).ino;
  fullReads = rootScans = 0;
  for (let i = 0; i < 40; i++) {
    await h.store.append(k, { i });
    await h.store.turnStarted(k);
    await h.store.turnSettled(k);
  }
  assert.equal(fullReads, 0);
  assert.equal(rootScans, 0);
  const other = h.create(h.storeRoot);
  await other.append(k, { writer: "other" });
  assert.equal(fullReads, 1);
  await h.store.append(k, { writer: "original" });
  assert.equal(fullReads, 2);
  assert.equal(rootScans, 0);
  await h.store.append(k, { final: true });
  assert.equal(fullReads, 2);
  const state = await h.create(h.storeRoot).read(k);
  assert.equal(state.status, "complete");
  assert.equal(state.events.length, 43);
  assert.equal(fullReads, 3);
  const usage = JSON.parse(fs.readFileSync(join(h.storeRoot, ".usage.json"), "utf8"));
  assert.equal(usage.total + 256, diskBytes(h.storeRoot));
});

test("Hermes CC history recovers dirty cap accounting and counts manifest growth", async t => {
  const h = harness(t), k = key();
  await h.store.start(k);
  await h.store.append(k, { n: 1 });
  const before = diskBytes(h.storeRoot);
  const store = h.create(h.storeRoot, { maxBytesTotal: before, maxBytesPerSession: 10_000 });
  await store.invalidate(k, "history_mutated");
  assert.ok(diskBytes(h.storeRoot) <= before);
  const recovered = key("recovered");
  await h.store.start(recovered);
  fs.writeFileSync(join(h.storeRoot, ".usage.json"), JSON.stringify({ version: 1, total: null }));
  fs.writeFileSync(join(h.storeRoot, "junk"), Buffer.alloc(5000));
  const capped = h.create(h.storeRoot, { maxBytesTotal: 3000 });
  await capped.append(recovered, { kept: true });
  assert.ok(diskBytes(h.storeRoot) <= 3000);
  assert.equal(fs.existsSync(join(h.storeRoot, "junk")), false);
  assert.deepEqual(await capped.read(recovered), { status: "complete", events: [{ kept: true }] });
});

for (const failedWrite of [false, true]) test(`Hermes CC history preserves a foreign fence before session creation${failedWrite ? " after a failed marker write" : ""}`, async t => {
  const fsp = require("node:fs/promises");
  let unavailable = failedWrite;
  const h = harness(t, { "node:fs/promises": { ...fsp, async open(path, ...args) {
    if (unavailable && String(path).includes("/.foreign-")) throw new Error("disk unavailable");
    return fsp.open(path, ...args);
  } } }), k = key();
  assert.equal(fs.existsSync(h.storeRoot), false);
  if (failedWrite) await assert.rejects(h.store.invalidate(k, "foreign_writer"), /history_store_failed/);
  else await h.store.invalidate(k, "foreign_writer");
  assert.equal(fs.existsSync(sessionDir(h)), false);
  unavailable = false;
  await h.create(h.storeRoot).start(k);
  assert.equal(readManifest(h).invalid, "foreign_writer");
  await assert.rejects(h.store.append(k, { omitted: true }), /^Error: writer_changed$/);
  assert.equal(readManifest(h).records, 0);
  assertUnusable(await h.create(h.storeRoot).read(k), "foreign_writer");
  const marker = join(h.storeRoot, `.foreign-${digest(k.providerId, k.nativeSessionId)}`);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(marker, old, old);
  // Neither age-based cleanup nor cap eviction may resurrect the journal.
  assertUnusable(await h.create(h.storeRoot, { maxBytesTotal: 0 }).read(k), "foreign_writer");
  assert.equal(fs.statSync(marker).size, 0);
});

for (const contents of ["{not-json", "", "{}", JSON.stringify({ pid: 2147483647, token: "unknown" })]) {
  test(`Hermes CC history refuses an unrecognized lease ${JSON.stringify(contents)} without changing the journal`, async t => {
    const h = harness(t), k = key();
    await h.store.start(k);
    const before = fs.readFileSync(manifestPath(h), "utf8");
    const path = join(h.storeRoot, `.writer-${digest(k.providerId, k.nativeSessionId)}`);
    fs.writeFileSync(path, contents);
    assert.equal(await h.store.claimWriter(k), null);
    assert.equal(await h.create(h.storeRoot).claimWriter(k), null);
    assert.equal(fs.readFileSync(path, "utf8"), contents, "unknown ownership must not be taken over");
    assert.equal(fs.readFileSync(manifestPath(h), "utf8"), before);
  });
}

test("Hermes CC history refuses live leases while utimes overlaps every lease read", async t => {
  const fsp = require("node:fs/promises");
  let overlaps = 0;
  const h = harness(t, { "node:fs/promises": { ...fsp, async open(path, flags, mode) {
    const handle = await fsp.open(path, flags, mode);
    if (String(path).includes("/.writer-") && flags & fs.constants.O_NONBLOCK) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        // Force the heartbeat between the reader's initial and final stat.
        const now = new Date(Date.now() + ++overlaps);
        fs.utimesSync(path, now, now);
        return result;
      };
    }
    return handle;
  } } }), k = key();
  const lease = await h.store.claimWriter(k);
  t.after(() => lease.release());
  for (let i = 0; i < 50; i++) assert.equal(await h.create(h.storeRoot).claimWriter(k), null);
  assert.ok(overlaps >= 50);
});

test("Hermes CC history writer leases refuse live owners even with expired heartbeats", async t => {
  const h = harness(t), k = key(), other = h.create(h.storeRoot);
  const lease = await h.store.claimWriter(k);
  assert.ok(lease);
  const path = join(h.storeRoot, `.writer-${digest(k.providerId, k.nativeSessionId)}`);
  const owner = JSON.parse(fs.readFileSync(path, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.token, /^[a-f0-9-]{36}$/);
  assert.equal(await other.claimWriter(k), null);
  const otherKey = await other.claimWriter(key("other"));
  assert.ok(otherKey);
  await otherKey.release();
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(path, old, old);
  assert.equal(await other.claimWriter(k), null);
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).token, owner.token);
  await lease.release();
  await lease.release();
  const replacement = await other.claimWriter(k);
  assert.ok(replacement);
  assert.notEqual(replacement.token, owner.token);
  assert.equal(await h.store.claimWriter(k), null);
  await replacement.release();
  assert.equal(fs.existsSync(path), false);
  const final = await h.store.claimWriter(k);
  assert.ok(final);
  await final.release();
});

test("Hermes CC history never repairs an interrupted append or settlement into complete", async t => {
  const fsp = require("node:fs/promises");
  let failManifest = false;
  const wrapped = { ...fsp, async rename(from, to) {
    if (failManifest && String(to).endsWith("/manifest.json")) throw new Error("injected publication failure");
    return fsp.rename(from, to);
  } };
  const h = harness(t, { "node:fs/promises": wrapped }), appended = key("appended"), unsettled = key("unsettled");
  await h.store.start(appended);
  await h.store.start(unsettled);
  await h.store.turnStarted(unsettled);
  failManifest = true;
  await assert.rejects(h.store.append(appended, { durable: true }), /history_store_failed/);
  assert.equal(JSON.parse(fs.readFileSync(join(h.storeRoot, ".usage.json"))).total, null);
  await assert.rejects(h.store.turnSettled(unsettled), /history_store_failed/);
  failManifest = false;
  const reopened = h.create(h.storeRoot);
  assertUnusable(await reopened.read(appended), "corrupt");
  assertUnusable(await reopened.read(unsettled), "unsettled_turn");
  await reopened.append(appended, { extra: true });
  assertUnusable(await reopened.read(appended), "corrupt");
  assert.equal(readManifest(h, appended).records, 0);
});

for (const recovery of ["read", "owner mutation"]) test(`Hermes CC history retries a failed foreign fence before the next ${recovery}`, async t => {
  const fsp = require("node:fs/promises");
  let unavailable = false;
  const wrapped = { ...fsp, async rename(from, to) {
    if (unavailable && String(to).endsWith("/manifest.json")) throw new Error("disk unavailable");
    return fsp.rename(from, to);
  } };
  const h = harness(t, { "node:fs/promises": wrapped }), k = key();
  const lease = await h.store.claimWriter(k);
  t.after(() => lease.release());
  await h.store.start(k, lease); await h.store.append(k, { text: "original" }, lease);
  unavailable = true;
  await assert.rejects(h.store.invalidate(k, "foreign_writer"), /history_store_failed/);
  assert.equal(readManifest(h, k).invalid, undefined, "failed persistence leaves the original disk rows");
  assertUnusable(await h.create(h.storeRoot).read(k), "unavailable");
  unavailable = false;
  const other = h.create(h.storeRoot);
  if (recovery === "read") assertUnusable(await other.read(k), "foreign_writer");
  else await assert.rejects(other.turnStarted(k, lease), /^Error: writer_changed$/);
  assert.equal(readManifest(h, k).invalid, "foreign_writer", "the next access persists the fence across store instances");
  await assert.rejects(h.store.append(k, { text: "must not append" }, lease), /^Error: writer_changed$/);
  assertUnusable(await other.read(k), "foreign_writer");
  assert.equal(readManifest(h, k).records, 1);
});

test("Hermes CC history keeps a foreign fence across a contender process's live-lock timeout", { timeout: 10_000 }, async t => {
  const h = harness(t), k = key(), compiled = compileHistory(h);
  const lease = await h.store.claimWriter(k);
  t.after(() => lease.release());
  await h.store.start(k, lease);
  await h.store.append(k, { text: "original" }, lease);
  const lock = join(h.storeRoot, ".journal.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held-by-owner" }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);
  t.after(() => fs.rmSync(lock, { force: true }));
  const worker = join(h.root, "foreign-contender.cjs");
  fs.writeFileSync(worker, `
    const { createHermesCcHistoryStore } = require(process.argv[2]);
    // Exercise the real timeout and live-pid check without a 15-second sleep.
    const now = Date.now(); let ticks = 0;
    Date.now = () => now + 16_000 * ticks++;
    createHermesCcHistoryStore(process.argv[3]).invalidate({ providerId: "hermes-cc", nativeSessionId: "native-1" }, "foreign_writer")
      .then(() => process.send({ error: null }), error => process.send({ error: error.message }))
      .finally(() => process.disconnect());
  `);
  const child = fork(worker, [compiled, h.storeRoot], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (child.connected) child.kill(); });
  const result = await new Promise((resolve, reject) => {
    let result;
    child.once("message", message => { result = message; });
    child.once("error", reject);
    child.once("exit", code => code === 0 && result ? resolve(result) : reject(new Error(`contender exited ${code}`)));
  });
  assert.equal(result.error, "history_lock_timeout");
  assert.equal(fs.existsSync(lock), true, "the live owner's journal lock is never reaped");
  assert.equal(readManifest(h).invalid, undefined, "the contender could not publish the manifest");
  assert.equal(fs.statSync(join(h.storeRoot, `.foreign-${digest(k.providerId, k.nativeSessionId)}`)).size, 0);
  fs.unlinkSync(lock);
  // The contender has exited: only its synced marker can inform this owner.
  await assert.rejects(h.store.append(k, { text: "must not append" }, lease), /^Error: writer_changed$/);
  assert.equal(readManifest(h).records, 1);
  assert.equal(readManifest(h).invalid, "foreign_writer");
  assertUnusable(await h.create(h.storeRoot).read(k), "foreign_writer");
});

test("Hermes CC history writer lease heartbeats renew the on-disk mtime", async t => {
  const fsp = require("node:fs/promises");
  let beat;
  const heartbeat = new Promise(resolve => { beat = resolve; });
  const wrapped = { ...fsp, async open(path, flags, mode) {
    const handle = await fsp.open(path, flags, mode);
    if (String(path).includes("/.writer-")) {
      const utimes = handle.utimes.bind(handle);
      handle.utimes = async (...args) => { await utimes(...args); beat(); };
    }
    return handle;
  } };
  const h = harness(t, { "node:fs/promises": wrapped }), k = key();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const lease = await h.store.claimWriter(k);
  assert.ok(lease);
  const path = join(h.storeRoot, `.writer-${digest(k.providerId, k.nativeSessionId)}`);
  const old = new Date(Date.now() - 29_000);
  fs.utimesSync(path, old, old);
  t.mock.timers.tick(10_000);
  await heartbeat;
  assert.ok(fs.statSync(path).mtimeMs > old.getTime() + 20_000);
  assert.equal(await h.create(h.storeRoot).claimWriter(k), null);
  await lease.release();
});

test("Hermes CC history writer leases refuse a second process", async t => {
  const h = harness(t), k = key(), compiled = compileHistory(h);
  const worker = join(h.root, "claimant.cjs");
  fs.writeFileSync(worker, `
    const { createHermesCcHistoryStore } = require(process.argv[2]);
    (async () => {
      const lease = await createHermesCcHistoryStore(process.argv[3]).claimWriter({ providerId: "hermes-cc", nativeSessionId: "native-1" });
      if (lease) await lease.release();
      process.send({ acquired: !!lease });
      process.disconnect();
    })().catch(error => { process.send({ error: String(error) }); process.exitCode = 1; process.disconnect(); });
  `);
  async function claimInChild() {
    const child = fork(worker, [compiled, h.storeRoot], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (child.connected) child.kill(); });
    return new Promise((resolve, reject) => {
      let result;
      child.on("message", message => { result = message; });
      child.once("error", reject);
      child.once("exit", code => {
        if (code !== 0 || !result || result.error) reject(new Error(result?.error || `claimant exited ${code}`));
        else resolve(result.acquired);
      });
    });
  }
  const lease = await h.store.claimWriter(k);
  assert.ok(lease);
  assert.equal(await claimInChild(), false);
  await lease.release();
  assert.equal(await claimInChild(), true);
});

for (const method of ["start", "append", "turnStarted", "turnSettled"]) {
  for (const credential of ["old lease", "wrong generation", "missing token"]) {
    test(`Hermes CC history fences ${method} with ${credential} and invalidates replay`, async t => {
      const h = harness(t), k = key();
      const original = await h.store.claimWriter(k);
      t.after(() => original.release());
      await h.store.start(k, original);
      await h.store.turnStarted(k, original);
      await h.store.append(k, { clientMessageId: "A" }, original);
      await original.release();
      const replacement = await h.create(h.storeRoot).claimWriter(k);
      t.after(() => replacement.release());
      assert.ok(replacement.generation > original.generation);
      assert.deepEqual(readManifest(h).writer, { token: replacement.token, generation: replacement.generation });
      const before = readManifest(h), events = fs.readFileSync(eventsPath(h), "utf8");
      const owner = credential === "old lease" ? original : credential === "missing token" ? undefined
        : { token: replacement.token, generation: replacement.generation - 1 };
      await assert.rejects(method === "append" ? h.store.append(k, { clientMessageId: "A" }, owner)
        : h.store[method](k, owner), /^Error: writer_changed$/);
      const after = readManifest(h);
      for (const field of ["writer", "records", "bytes", "headHash", "openTurns"]) assert.deepEqual(after[field], before[field]);
      assert.equal(fs.readFileSync(eventsPath(h), "utf8"), events);
      assertUnusable(await h.create(h.storeRoot).read(k), "writer_changed");
      await h.store.turnSettled(k, replacement);
      assertUnusable(await h.create(h.storeRoot).read(k), "writer_changed");
    });
  }
}

test("Hermes CC history fences a stale start before the journal exists", async t => {
  const h = harness(t), k = key();
  const original = await h.store.claimWriter(k);
  await original.release();
  const current = await h.store.claimWriter(k);
  t.after(() => current.release());
  await assert.rejects(h.store.start(k, original), /^Error: writer_changed$/);
  assert.deepEqual(readManifest(h).writer, { token: current.token, generation: current.generation });
  assertUnusable(await h.create(h.storeRoot).read(k), "writer_changed");
});

// Real processes exercise OS liveness and paused heartbeat descriptors. Commands
// use the connection wrapper so a refused recorder follows the production path.
function processRecorder(t, h) {
  const compiled = compileHistory(h);
  const compiledDir = dirname(compiled);
  for (const name of ["history-connection.ts", "session-key.ts"]) {
    fs.writeFileSync(join(compiledDir, name.replace(/\.ts$/, ".js")), ts.transpileModule(
      fs.readFileSync(resolve(__dirname, "../server/hermes-cc", name), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText);
  }
  const worker = join(h.root, "recorder.cjs");
  fs.writeFileSync(worker, `
    const { createHermesCcHistoryStore } = require(process.argv[2]);
    const { journalHermesCcConnection } = require(require("node:path").join(require("node:path").dirname(process.argv[2]), "history-connection.js"));
    const store = createHermesCcHistoryStore(process.argv[3]);
    let listener;
    const connection = journalHermesCcConnection({ version: 1, capabilities: [],
      async send() {}, async close() {}, onEvent(fn) { listener = fn; return () => {}; },
    }, "hermes-cc", store);
    let fence;
    connection.onEvent(event => { if (event.type === "session.config") { fence(); fence = null; } });
    async function drain() {
      const done = new Promise(resolve => { fence = resolve; });
      listener({ type: "session.config", sessionId: "live", config: { models: [], modes: [], thinkingOptions: [], settings: [] } });
      await done;
    }
    process.on("message", async message => {
      try {
        if (message.type === "open") {
          await connection.send({ type: "session.open", sessionId: "live", requestId: "open-live", history: "skip",
            config: { cwd: "/unused", env: {}, settings: {}, mcpServers: {}, persist: true } });
          listener({ type: "session.opened", sessionId: "live", requestId: "open-live",
            persistence: { version: 1, data: { sessionId: "native-1" } }, capabilities: [], restoration: "core", cwd: "/unused" });
          listener({ type: "session.ready", sessionId: "live", requestId: "open-live" });
        } else if (message.type === "prompt") {
          await connection.send({ type: "session.prompt", sessionId: "live", requestId: "prompt-A",
            prompt: { clientMessageId: "A", input: { type: "text", content: [{ type: "text", text: "A" }] } } });
        } else if (message.type === "append") {
          for (const id of message.ids) listener({ type: "timeline.item", sessionId: "live",
            item: { type: "user_message", id, clientMessageId: id, text: id } });
        } else if (message.type === "settle") {
          listener({ type: "session.prompt_result", sessionId: "live", clientMessageId: "A", result: { type: "turn", turnId: "turn" } });
          listener({ type: "session.turn", sessionId: "live", turnId: "turn", state: "completed" });
        }
        await drain();
        process.send({ ok: true });
      } catch (error) { process.send({ error: String(error.stack || error) }); }
    });
    process.send({ ready: true });
  `);
  function spawn() {
    const child = fork(worker, [compiled, h.storeRoot], { stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, NODE_PATH: resolve(__dirname, "../node_modules") } });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const ready = new Promise((resolve, reject) => {
      child.once("message", message => message.ready ? resolve() : reject(new Error(JSON.stringify(message))));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("recorder exited before ready")));
    });
    return { child, ready, async command(message) {
      await ready;
      return new Promise((resolve, reject) => {
        const onExit = (code, signal) => reject(new Error(`recorder exited: ${code} ${signal}`));
        child.once("exit", onExit);
        child.once("message", reply => {
          child.off("exit", onExit);
          reply.ok ? resolve() : reject(new Error(reply.error || "recorder failed"));
        });
        child.send(message);
      });
    } };
  }
  return spawn;
}

test("Hermes CC history refuses takeover after SIGSTOP for 31 seconds and never replays A,B,A", { timeout: 45_000 }, async t => {
  const h = harness(t), spawn = processRecorder(t, h);
  const original = spawn(), contender = spawn();
  await original.command({ type: "open" });
  const path = join(h.storeRoot, `.writer-${digest(key().providerId, key().nativeSessionId)}`);
  const owner = JSON.parse(fs.readFileSync(path, "utf8"));
  await original.command({ type: "prompt" });
  original.child.kill("SIGSTOP");
  try {
    await new Promise(resolve => setTimeout(resolve, 31_100));
    assert.ok(Date.now() - fs.statSync(path).mtimeMs > 30_000);
    await contender.command({ type: "open" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), owner, "a stopped process is still alive and owns its lease");
    await contender.command({ type: "append", ids: ["A", "B"] });
    assertUnusable(await h.create(h.storeRoot).read(key()), "writer_changed");
  } finally { original.child.kill("SIGCONT"); }
  await original.command({ type: "append", ids: ["A"] });
  await original.command({ type: "settle" });
  const fresh = await h.create(h.storeRoot).read(key());
  assert.equal(fresh.status, "unusable");
  assert.equal(Object.hasOwn(fresh, "events"), false);
  assert.deepEqual(fs.readFileSync(eventsPath(h), "utf8"), "", "neither recorder can append a duplicate prompt");
});

test("Hermes CC history preserves a settled dead owner's journal and images on takeover", { timeout: 10_000 }, async t => {
  const fsp = require("node:fs/promises");
  let onEventRead;
  const h = harness(t, { "node:fs/promises": { ...fsp, async open(path, flags, mode) {
    if (String(path).endsWith("/events.jsonl") && flags & fs.constants.O_NONBLOCK) onEventRead?.();
    return fsp.open(path, flags, mode);
  } } }), spawn = processRecorder(t, h), original = spawn();
  await original.command({ type: "open" });
  await original.command({ type: "prompt" });
  await original.command({ type: "append", ids: ["A"] });
  await original.command({ type: "settle" });
  const images = h.createHermesCcImageStore(join(h.root, "images"));
  const image = Buffer.from("saved image");
  await images.save({ sessionKey: key().nativeSessionId, messageId: "A" }, [{ mime: "image/png", data: image }]);
  const before = readManifest(h);
  const saved = await h.store.read(key());
  assert.equal(saved.status, "complete");
  const exited = new Promise(resolve => original.child.once("exit", resolve));
  original.child.kill("SIGKILL");
  await exited;
  let verifiedReads = 0;
  const leasePath = join(h.storeRoot, `.writer-${digest(key().providerId, key().nativeSessionId)}`);
  const deadLease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  onEventRead = () => {
    assert.equal(fs.existsSync(join(h.storeRoot, ".journal.lock")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(leasePath, "utf8")), deadLease);
    verifiedReads++;
  };
  const replacement = await h.store.claimWriter(key());
  onEventRead = undefined;
  assert.ok(verifiedReads > 0, "the full journal is verified under the lock before replacing the lease");
  assert.ok(replacement);
  t.after(() => replacement.release());
  assert.equal(replacement.generation, before.writer.generation + 1);
  assert.notEqual(replacement.token, before.writer.token);
  assert.deepEqual(readManifest(h).writer, { token: replacement.token, generation: replacement.generation });
  assert.equal(Object.hasOwn(readManifest(h), "invalid"), false);
  const replayed = await h.create(h.storeRoot).read(key());
  assert.deepEqual(replayed, saved);
  const message = replayed.events.find(event => event.type === "timeline.item").item;
  const resolver = h.load("server/prompt-images/hermes-cc.ts").hermesCcPromptImageResolver;
  const found = await resolver.find({
    sessionId: `plugin:${JSON.stringify({ version: 1, data: { sessionId: key().nativeSessionId } })}`,
    messageId: message.id, clientMessageId: message.clientMessageId,
    signal: new AbortController().signal, hermesCcImageStore: images,
  });
  assert.equal(found.matchedMessages, 1);
  assert.equal(found.images.length, 1);
  assert.deepEqual(await found.images[0].readBytes(), image);
  await h.store.append(key(), { clientMessageId: "B" }, replacement);
  await h.store.turnStarted(key(), replacement);
  await h.store.turnSettled(key(), replacement);
  assert.equal((await h.store.read(key())).status, "complete");
  const events = fs.readFileSync(eventsPath(h));
  await assert.rejects(h.store.append(key(), { clientMessageId: "stale" }, before.writer), /^Error: writer_changed$/);
  assert.deepEqual(fs.readFileSync(eventsPath(h)), events);
  assertUnusable(await h.create(h.storeRoot).read(key()), "writer_changed");
});

for (const failure of ["open turn", "corrupt byte", "record count", "size", "manifest checksum", "invalid",
  "started mid-session", "writer token", "writer generation", "foreign mark", "unreadable events"]) {
  test(`Hermes CC history invalidates a dead owner's journal with ${failure} on takeover`, { timeout: 10_000 }, async t => {
    const fsp = require("node:fs/promises");
    let unreadable = false;
    const h = harness(t, { "node:fs/promises": { ...fsp, async open(path, flags, mode) {
      if (unreadable && String(path).endsWith("/events.jsonl") && flags & fs.constants.O_NONBLOCK) {
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      }
      return fsp.open(path, flags, mode);
    } } }), k = key(), spawn = processRecorder(t, h), original = spawn();
    await original.command({ type: "open" });
    await original.command({ type: "prompt" });
    await original.command({ type: "append", ids: ["A"] });
    if (failure !== "open turn") await original.command({ type: "settle" });
    const before = readManifest(h);
    const exited = new Promise(resolve => original.child.once("exit", resolve));
    original.child.kill("SIGKILL");
    await exited;
    if (failure === "corrupt byte") {
      const bytes = fs.readFileSync(eventsPath(h));
      const index = bytes.indexOf(Buffer.from('"text":"A"'));
      assert.ok(index >= 0);
      bytes[index + 8] = "B".charCodeAt(0);
      fs.writeFileSync(eventsPath(h), bytes);
    } else if (failure === "record count") editManifest(h, k, { records: before.records + 1 }, true);
    else if (failure === "size") editManifest(h, k, { bytes: before.bytes + 1 }, true);
    else if (failure === "manifest checksum") editManifest(h, k, { records: before.records + 1 });
    else if (failure === "invalid") editManifest(h, k, { invalid: "history_mutated" }, true);
    else if (failure === "started mid-session") editManifest(h, k, { startedFromCreation: false }, true);
    else if (failure === "writer token") editManifest(h, k, { writer: { ...before.writer, token: "0".repeat(36) } }, true);
    else if (failure === "writer generation") editManifest(h, k, { writer: { ...before.writer, generation: before.writer.generation + 1 } }, true);
    else if (failure === "foreign mark") fs.writeFileSync(join(h.storeRoot, `.foreign-${digest(k.providerId, k.nativeSessionId)}`), "");
    else if (failure === "unreadable events") unreadable = true;
    const replacement = await h.store.claimWriter(k);
    assert.ok(replacement);
    t.after(() => replacement.release());
    unreadable = false;
    if (failure !== "manifest checksum") assert.equal(readManifest(h).invalid, "writer_changed");
    const state = await h.create(h.storeRoot).read(k);
    assertUnusable(state, failure === "foreign mark" ? "foreign_writer" : failure === "manifest checksum" ? "corrupt" : "writer_changed");
    if (failure === "foreign mark") {
      await assert.rejects(h.store.append(k, { clientMessageId: "B" }, replacement), /^Error: writer_changed$/);
      await assert.rejects(h.store.turnSettled(k, replacement), /^Error: writer_changed$/);
    } else {
      await h.store.append(k, { clientMessageId: "B" }, replacement);
      await h.store.turnSettled(k, replacement);
    }
    assert.equal(readManifest(h).records, failure === "record count" || failure === "manifest checksum" ? before.records + 1 : before.records);
    assert.equal((await h.create(h.storeRoot).read(k)).status, "unusable");
  });
}

test("Hermes CC history stays complete across two clean writer restarts", async t => {
  const h = harness(t), k = key();
  let store = h.store, owner = await store.claimWriter(k);
  t.after(() => owner.release());
  await store.start(k, owner);
  await store.turnStarted(k, owner);
  await store.append(k, { clientMessageId: "A" }, owner);
  await store.turnSettled(k, owner);
  const before = readManifest(h), saved = await store.read(k);
  for (let restart = 1; restart <= 2; restart++) {
    await owner.release();
    store = h.create(h.storeRoot);
    const previous = owner;
    owner = await store.claimWriter(k);
    assert.ok(owner);
    assert.notEqual(owner.token, previous.token);
    assert.equal(owner.generation, before.writer.generation + restart);
    assert.equal(Object.hasOwn(readManifest(h), "invalid"), false);
    assert.deepEqual(await store.read(k), saved);
  }
  assert.equal(readManifest(h).records, before.records);
});
