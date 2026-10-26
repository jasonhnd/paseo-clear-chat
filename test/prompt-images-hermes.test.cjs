const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

const EMPTY = { matchedMessages: 0, images: [] };
const ID = "paseo-client-id";
const SESSION = "native/session one";
const TEXT = "Inspect this synthetic image.";
const hint = path => `[Image attached at: ${path}]`;
const vision = path => `[The user sent an image~ Here's what I can see:\nA synthetic picture.]\n[If you need a closer look, use vision_analyze with image_url: ${path} ~]`;
const native = paths => `${TEXT}\n\n${paths.map(hint).join("\n")}`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function png(width = 2, height = 1, size = 24) {
  const bytes = Buffer.alloc(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

// All storage, HOME and environment fallbacks are synthetic and isolated under /tmp.
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "hermes-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, ".hermes");
  const environment = {};
  const cache = new Map(), logs = [], reads = [];
  function load(filename) {
    filename = resolve(__dirname, "..", filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    function localRequire(id) {
      if (id.startsWith(".")) return load(resolve(dirname(filename), `${id}.ts`));
      if (id === "node:os") return { homedir: () => root };
      if (id === "node:fs/promises") return { ...require(id), async open(path, flags) {
        reads.push({ path, flags });
        return require(id).open(path, flags);
      } };
      return realRequire(id);
    }
    runInThisContext(`(function(require,module,exports,process,console){${code}\n})`, { filename })(
      localRequire, mod, mod.exports, { env: environment }, { debug: (...args) => logs.push(args) },
    );
    return mod.exports;
  }
  const resolver = load("server/prompt-images/hermes.ts").hermesPromptImageResolver;
  const registry = load("server/prompt-images/registry.ts");
  fs.mkdirSync(home);
  const dbPath = join(home, "state.db");
  function write(callback) {
    const database = new DatabaseSync(dbPath);
    try { return callback(database); } finally { database.close(); }
  }
  write(database => {
    database.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'cli', model TEXT, started_at REAL NOT NULL DEFAULT 1);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT, active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0, display_metadata TEXT, message_uid TEXT,
      absorbed_message_uids TEXT, timestamp REAL NOT NULL DEFAULT 1)`);
    database.prepare("INSERT INTO sessions (id) VALUES (?)").run(SESSION);
  });
  let next = 0;
  function add(content, changes = {}) {
    const row = { session_id: SESSION, role: "user", content, active: 1, compacted: 0,
      display_metadata: JSON.stringify({ paseo: { clientMessageId: ID } }),
      message_uid: `uid-${++next}`, absorbed_message_uids: null, ...changes };
    write(database => database.prepare(`INSERT INTO messages (${Object.keys(row).join(",")})
      VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)));
    return row;
  }
  function session(id, parent = null) {
    write(database => database.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run(id, parent));
  }
  function image(bytes = png(), name = "paste.png", digest = hash(bytes)) {
    const path = join(home, "cache", "documents", "native-inputs", digest, name);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, bytes);
    return path;
  }
  const context = changes => ({ agentId: "synthetic-agent", provider: "hermes-zk", cwd: root,
    messageId: ID, clientMessageId: null, text: TEXT, sessionId: SESSION, nativeHandle: null,
    providerEnv: { HERMES_HOME: home }, providerCommand: ["hermes", "acp"],
    signal: new AbortController().signal, ...changes });
  const find = changes => resolver.find(context(changes));
  function rpc(changes = {}) {
    const provider = changes.provider ?? "hermes-zk";
    const launch = { command: ["hermes", "acp"], env: { HERMES_HOME: home }, ...changes.launch };
    Object.defineProperty(launch.env, "API_KEY", { get() { assert.fail("must not read credentials"); } });
    const snapshot = { provider, cwd: root, persistence: { provider,
      sessionId: encodeURIComponent(SESSION), nativeHandle: SESSION } };
    const host = { paseo: { config: { get: async () => ({ config: { providers: { [provider]: launch } } }) },
      agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
    return { handlers: registry.createPromptImageHandlers(), host,
      input: { agentId: "synthetic-agent", messageId: ID, text: TEXT } };
  }
  return { root, home, dbPath, resolver, registry, context, find, image, add, session, write, environment, logs, reads, rpc };
}
async function bytesOf(found) {
  assert.equal(found.matchedMessages, 1);
  return Promise.all(found.images.map(image => image.readBytes()));
}

for (const field of ["messageId", "clientMessageId"]) {
  test(`Hermes finds the exact ${field}, never another row with the same text`, async t => {
    const f = fixture(t), wanted = png(), decoy = png(3);
    f.add(native([f.image(decoy)]), { display_metadata: null });
    f.add(native([f.image(wanted)]));
    assert.deepEqual(await bytesOf(await f.find({ messageId: null, [field]: ID, text: "Different text" })), [wanted]);
    assert.deepEqual(await f.find({ messageId: null, clientMessageId: null }), EMPTY);
    assert.deepEqual(await f.find({ messageId: "", clientMessageId: "" }), EMPTY);
    assert.deepEqual(await f.find({ messageId: "missing" }), EMPTY);
  });
}

test("Hermes origin ids are exact strings, with no uuid normalization or legacy id fallback", async t => {
  const f = fixture(t), path = f.image();
  const id = "ABCD-1234";
  f.add(native([path]), { display_metadata: JSON.stringify({ paseo: { clientMessageId: id } }), message_uid: ID });
  assert.deepEqual(await f.find({ messageId: "abcd1234" }), EMPTY);
  assert.deepEqual(await f.find(), EMPTY);
  assert.deepEqual(await bytesOf(await f.find({ messageId: id })), [png()]);
});

test("two distinct message uids carrying either lookup id are ambiguous", async t => {
  const f = fixture(t);
  f.add(native([f.image()]));
  f.add(native([f.image(png(3))]), { display_metadata: JSON.stringify({ paseo: { clientMessageId: "second-id" } }) });
  assert.deepEqual(await f.find({ clientMessageId: "second-id" }), EMPTY);
  f.add(native([f.image()]), { message_uid: "third-uid" });
  assert.deepEqual(await f.find(), EMPTY);
});

for (const mode of ["same paths", "different paths", "missing origin", "empty copy", "absorbed copy"]) {
  test(`compaction copies: ${mode}`, async t => {
    const f = fixture(t), path = f.image();
    f.add(native([path]), { message_uid: "copied-uid", active: 0, compacted: 1 });
    const content = mode === "different paths" ? native([f.image(png(3))]) : mode === "empty copy" ? TEXT : native([path]);
    f.add(content, { message_uid: "copied-uid", ...(mode === "missing origin" ? { display_metadata: null } : {}),
      ...(mode === "absorbed copy" ? { absorbed_message_uids: '["another-uid"]' } : {}) });
    if (["same paths", "missing origin"].includes(mode)) assert.deepEqual(await bytesOf(await f.find()), [png()]);
    else assert.deepEqual(await f.find(), EMPTY);
  });
}

test("compaction compares path sets independent of order and repetition", async t => {
  const f = fixture(t), a = f.image(), b = f.image(png(3));
  f.add(native([a, b]), { message_uid: "copy" });
  f.add(`${vision(b)}\n\n${vision(a)}\n\n${vision(a)}`, { message_uid: "copy" });
  const found = await f.find();
  assert.equal(found.images.length, 2);
  assert.deepEqual((await bytesOf(found)).map(hash).sort(), [hash(png()), hash(png(3))].sort());
});

for (const absorbed of ['["previous-message"]', "invalid", "{}", "null"]) {
  test(`absorbed or uncertain message provenance is rejected: ${absorbed}`, async t => {
    const f = fixture(t);
    f.add(native([f.image()]), { absorbed_message_uids: absorbed });
    assert.deepEqual(await f.find(), EMPTY);
  });
}

for (const metadata of ["{invalid", '"not an object"', "[]"]) {
  test(`invalid display metadata poisons an otherwise unique lookup: ${metadata}`, async t => {
    const f = fixture(t), path = f.image();
    f.add(native([path]));
    f.add(TEXT, { display_metadata: metadata });
    assert.deepEqual(await f.find(), EMPTY);
  });
}

test("inactive, model_only and assistant rows are ignored; compacted rows remain displayed", async t => {
  const f = fixture(t), good = f.image(), decoy = f.image(png(3));
  f.add(native([decoy]), { active: 0, compacted: 0, display_metadata: "invalid" });
  f.add(native([decoy]), { display_metadata: JSON.stringify({ model_only: true, paseo: { clientMessageId: ID } }) });
  f.add(native([decoy]), { role: "assistant", display_metadata: "invalid" });
  f.add(native([good]), { active: 0, compacted: 1, absorbed_message_uids: "[]" });
  assert.deepEqual(await bytesOf(await f.find()), [png()]);
});

for (const field of ["message_uid", "display_metadata", "active", "compacted", "absorbed_message_uids"]) {
  test(`missing Hermes messages schema column fails closed: ${field}`, async t => {
    const f = fixture(t);
    f.add(native([f.image()]));
    f.write(database => database.exec(`ALTER TABLE messages DROP COLUMN ${field}`));
    assert.deepEqual(await f.find(), EMPTY);
  });
}

test("missing parent lineage schema fails closed", async t => {
  const f = fixture(t);
  f.add(native([f.image()]));
  f.write(database => database.exec("ALTER TABLE sessions DROP COLUMN parent_session_id"));
  assert.deepEqual(await f.find(), EMPTY);
});

test("ids in parent and rotated child sessions are found through decoded persistence handles", async t => {
  const f = fixture(t), path = f.image();
  f.session("rotated", SESSION);
  f.session("latest", "rotated");
  f.add(native([path]));
  assert.deepEqual(await bytesOf(await f.find({ sessionId: "latest" })), [png()]);
  assert.deepEqual(await bytesOf(await f.find({ sessionId: encodeURIComponent(SESSION) })), [png()]);
  assert.deepEqual(await bytesOf(await f.find({ sessionId: null, nativeHandle: encodeURIComponent(SESSION) })), [png()]);
  f.write(database => database.exec("DELETE FROM messages"));
  f.add(native([path]), { session_id: "latest" });
  assert.deepEqual(await bytesOf(await f.find()), [png()]);
});

test("unrelated, orphaned, unresolvable and conflicting session scopes yield no images", async t => {
  const f = fixture(t), path = f.image();
  f.session("unrelated");
  f.add(native([path]), { session_id: "unrelated" });
  f.add(native([path]), { session_id: "missing-session" });
  for (const changes of [{}, { sessionId: "missing-session" }, { sessionId: null, nativeHandle: null },
    { sessionId: "%invalid" }, { nativeHandle: "unrelated" }]) {
    assert.deepEqual(await f.find(changes), EMPTY);
  }
  assert.deepEqual(await bytesOf(await f.find({ sessionId: "absent", nativeHandle: "unrelated" })), [png()]);
});

test("cycles in lineage terminate and copies across sessions still count once", async t => {
  const f = fixture(t), path = f.image();
  f.session("child", SESSION);
  f.write(database => database.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run("child", SESSION));
  f.add(native([path]), { message_uid: "copy" });
  f.add(native([path]), { session_id: "child", message_uid: "copy" });
  assert.deepEqual(await bytesOf(await f.find()), [png()]);
});

test("sha256 mismatch skips only the damaged image and every later read rechecks the digest", async t => {
  const f = fixture(t), path = f.image(), broken = f.image(png(3), "bad.png", "0".repeat(64));
  f.add(native([path, broken]));
  const found = await f.find();
  assert.deepEqual(await bytesOf(found), [png()]);
  fs.writeFileSync(path, png(4));
  await assert.rejects(found.images[0].readBytes(), /invalid_image/);
});

for (const kind of ["outside", "space", "brackets", "split hint name", "closer", "split vision name", "traversal", "backslash", "nested leaf", "truncated hint", "extra hint", "truncated vision", "extra vision", "standalone closer", "screenshot"]) {
  test(`unsafe or incomplete image marker fails the whole message: ${kind}`, async t => {
    const f = fixture(t), good = f.image();
    let bad;
    if (kind === "outside") bad = hint(join(f.root, "outside.png"));
    if (kind === "space") bad = hint(f.image(png(3), "my picture.png"));
    if (kind === "brackets") bad = hint(`${good}]extra.png`);
    if (kind === "split hint name") bad = hint(`${good}]\nextra.png`);
    if (kind === "closer") bad = vision(`${good} ~]extra.png`);
    if (kind === "split vision name") bad = vision(`${good} ~]\n\nextra.png`);
    if (kind === "traversal") bad = hint(`${dirname(good)}/../${hash(png())}/paste.png`);
    if (kind === "backslash") bad = hint(`${dirname(good)}/bad\\file.png`);
    if (kind === "nested leaf") bad = hint(`${dirname(good)}/sub/paste.png`);
    if (kind === "truncated hint") bad = hint(good).slice(0, -1);
    if (kind === "extra hint") bad = `${hint(good)}\n[Image attached at: invalid]`;
    if (kind === "truncated vision") bad = vision(good).slice(0, -2);
    if (kind === "extra vision") bad = `${vision(good)}\n[The user sent an image~ incomplete`;
    if (kind === "standalone closer") bad = `[If you need a closer look, use vision_analyze with image_url: ${good} ~]`;
    if (kind === "screenshot") bad = "[screenshot]\n[screenshot]";
    f.add(`${native([good])}\n\n${bad}`);
    assert.deepEqual(await f.find(), EMPTY);
  });
}

for (const failure of ["[Image omitted due to size]", "[Image omitted", "[The user sent an image but I couldn't quite see it this time (>_<)]",
  "[The user sent an image but something went wrong when I tried to look at it~]", "[Couldn’t quite see the image]", "[Could not quite see the image]"]) {
  test(`failure or omission note suppresses every image: ${failure}`, async t => {
    const f = fixture(t);
    f.add(`${native([f.image()])}\n\n${failure}`);
    assert.deepEqual(await f.find(), EMPTY);
  });
}

test("native screenshot placeholders and mixed vision notes are fully parsed", async t => {
  const f = fixture(t), a = f.image(), b = f.image(png(3));
  f.add(`[screenshot detail=high]\n${native([a])}\n\n${vision(b)}`);
  assert.equal((await f.find()).images.length, 2);
});

test("image symlinks and digest directories escaping native-inputs cannot be read", async t => {
  const f = fixture(t), bytes = png();
  const outside = join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "outside.png"), bytes);
  const inside = f.image(bytes, "leaf.png");
  fs.unlinkSync(inside);
  fs.symlinkSync(join(outside, "outside.png"), inside);
  f.add(native([inside]));
  assert.deepEqual(await bytesOf(await f.find()), []);
  fs.unlinkSync(inside);
  fs.rmdirSync(dirname(inside));
  fs.symlinkSync(outside, dirname(inside));
  f.write(database => database.exec("DELETE FROM messages"));
  f.add(native([join(dirname(inside), "outside.png")]));
  assert.deepEqual(await bytesOf(await f.find()), []);
});

test("home overrides are absolute, reject parent segments, and never fall back after a missing override", async t => {
  const f = fixture(t);
  f.add(native([f.image()]));
  for (const home of ["", "relative-home", `${f.home}/../.hermes`, `${f.home}/..\\.hermes`, join(f.root, "missing")]) {
    assert.deepEqual(await f.find({ providerEnv: { HERMES_HOME: home } }), EMPTY);
  }
  assert.deepEqual(await bytesOf(await f.find({ providerEnv: { HERMES_HOME: "~/.hermes" } })), [png()]);
  assert.deepEqual(await bytesOf(await f.find({ providerEnv: {} })), [png()]);
  f.environment.HERMES_HOME = f.home;
  assert.deepEqual(await bytesOf(await f.find({ providerEnv: undefined })), [png()]);
});

test("profile commands use only their own Hermes home", async t => {
  const f = fixture(t);
  const profileHome = join(f.home, "profiles", "work");
  const bytes = png(), path = join(profileHome, "cache", "documents", "native-inputs", hash(bytes), "paste.png");
  f.add(native([path]));
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
  fs.mkdirSync(profileHome, { recursive: true });
  // Move only synthetic fixture data, never repository files.
  fs.renameSync(f.dbPath, join(profileHome, "state.db"));
  assert.deepEqual(await bytesOf(await f.find({ providerEnv: {}, providerCommand: ["hermes", "-p", "work", "acp"] })), [bytes]);
  assert.deepEqual(await f.find({ providerEnv: {} }), EMPTY);
});

test("provider recognition requires a Hermes id and a supported Hermes ACP command", t => {
  const f = fixture(t);
  for (const provider of ["hermes", "hermes-zk", "hermes-pp"]) {
    for (const command of [["hermes", "acp"], ["/opt/bin/hermes", "acp"], ["hermes", "-p", "work", "acp"]]) {
      assert.equal(f.resolver.matches(provider, command), true);
    }
  }
  for (const command of [undefined, [], ["hermes"], ["other", "acp"], ["node", "hermes", "acp"], ["hermes", "-p", "..", "acp"]]) {
    assert.equal(f.resolver.matches("hermes-zk", command), false);
  }
  assert.equal(f.resolver.matches("other-hermes", ["hermes", "acp"]), false);
});

test("registry honors Hermes provider home and existing thumbnail, byte and pixel caps", async t => {
  const f = fixture(t);
  const pictures = [png(), png(3), png(4), png(5), png(6000, 5000), png(6, 1, 1_572_865)];
  f.add(native(pictures.map((bytes, index) => f.image(bytes, `image-${index}.png`))));
  const { handlers, host, input } = f.rpc();
  const listed = await handlers.images(input, host);
  assert.equal(listed.images.length, 3);
  assert.equal(listed.total, 6);
  const found = await f.find();
  for (const index of [4, 5]) {
    let image;
    for (const candidate of found.images) {
      if (hash(await candidate.readBytes()) === hash(pictures[index])) image = candidate;
    }
    assert.ok(image);
    assert.equal((await handlers.image({ ...input, id: image.id }, host)).error, "image_too_large");
  }
  const full = await handlers.image({ ...input, id: listed.images[0].id }, host);
  assert.equal(full.error, null);
  assert.equal(full.mime, "image/png");
  const dumped = JSON.stringify(f.logs);
  for (const value of [f.home, TEXT, ID, SESSION, "base64"]) assert.equal(dumped.includes(value), false);
});

test("registry omits oversized originals while preserving valid siblings", async t => {
  const f = fixture(t), small = png(), large = png(3, 1, 1_572_865), huge = png(6000, 5000);
  f.add(native([f.image(small), f.image(large), f.image(huge)]));
  const { handlers, host, input } = f.rpc();
  const listed = await handlers.images(input, host);
  assert.equal(listed.total, 3);
  assert.equal(listed.images.length, 1);
  assert.deepEqual(Buffer.from(listed.images[0].thumbDataUri.split(",")[1], "base64"), small);
});

test("database and its directory gain no files during or after successful and failed lookups", async t => {
  const f = fixture(t), path = f.image();
  f.add(native([path]));
  const before = fs.readFileSync(f.dbPath), entries = fs.readdirSync(f.home).sort(), events = [];
  const watcher = fs.watch(f.home, (event, filename) => events.push({ event, filename }));
  try {
    await bytesOf(await f.find());
    await f.find({ messageId: "absent" });
    await f.find({ sessionId: "absent" });
    const { handlers, host, input } = f.rpc();
    await handlers.images(input, host);
    await handlers.image({ ...input, id: "hermes-0" }, host);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []);
    assert.deepEqual(fs.readdirSync(f.home).sort(), entries);
    assert.deepEqual(fs.readFileSync(f.dbPath), before);
    assert.ok(f.reads.every(({ flags }) => (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0));
  } finally { watcher.close(); }
});

test("missing database and aborted lookups return no images without creating a store", async t => {
  const f = fixture(t);
  fs.unlinkSync(f.dbPath);
  assert.deepEqual(await f.find(), EMPTY);
  assert.deepEqual(fs.readdirSync(f.home), []);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.find({ signal: controller.signal }), EMPTY);
});

test("live WAL lookups see committed rows without adding files or changing main/WAL bytes", async t => {
  const f = fixture(t), path = f.image();
  const writer = new DatabaseSync(f.dbPath);
  try {
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE)");
    const main = fs.readFileSync(f.dbPath);
    writer.prepare(`INSERT INTO messages (session_id, role, content, display_metadata, message_uid)
      VALUES (?, 'user', ?, ?, 'live-message')`).run(SESSION, native([path]), JSON.stringify({ paseo: { clientMessageId: ID } }));
    assert.deepEqual(fs.readFileSync(f.dbPath), main);
    const wal = fs.readFileSync(`${f.dbPath}-wal`), entries = fs.readdirSync(f.home).sort(), events = [];
    const watcher = fs.watch(f.home, (event, filename) => events.push({ event, filename }));
    try {
      assert.deepEqual(await bytesOf(await f.find()), [png()]);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events.filter(({ event }) => event === "rename"), []);
      assert.deepEqual(fs.readdirSync(f.home).sort(), entries);
      assert.deepEqual(fs.readFileSync(f.dbPath), main);
      assert.deepEqual(fs.readFileSync(`${f.dbPath}-wal`), wal);
    } finally { watcher.close(); }
  } finally { writer.close(); }
});

test("a WAL without its shared-memory file is left untouched and yields no image", async t => {
  const f = fixture(t);
  f.add(native([f.image()]));
  // Persistent WAL mode with no live writer: only a synthetic empty WAL remains.
  f.write(database => database.exec("PRAGMA journal_mode = WAL"));
  fs.writeFileSync(`${f.dbPath}-wal`, Buffer.alloc(0));
  const entries = fs.readdirSync(f.home).sort(), events = [];
  const watcher = fs.watch(f.home, (event, filename) => events.push({ event, filename }));
  try {
    assert.deepEqual(await f.find(), EMPTY);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []);
    assert.deepEqual(fs.readdirSync(f.home).sort(), entries);
    assert.equal(fs.existsSync(`${f.dbPath}-shm`), false);
  } finally { watcher.close(); }
});
