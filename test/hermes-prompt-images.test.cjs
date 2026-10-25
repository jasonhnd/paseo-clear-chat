const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");
const { Image } = require("imagescript");

function harness(overrides = {}) {
  const cache = new Map(), logs = [];
  function load(filename) {
    filename = resolve(__dirname, "..", filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    runInThisContext(`(function(require,module,exports,console,process){${compiled}\n})`, { filename })(
      id => id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : overrides[id] ?? realRequire(id),
      mod, mod.exports, { debug: (...args) => logs.push(args) }, overrides.process ?? process,
    );
    return mod.exports;
  }
  return { ...load("server/prompt-images/registry.ts"), ...load("server/prompt-images/hermes.ts"), logs };
}

const ID = "0123456789abcdef0123456789abcdef";
const UID = "fedcba9876543210fedcba9876543210";
const dashed = id => id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5").toUpperCase();
const block = path => `[The user sent an image~ Here's what I can see: A synthetic blue square. ${path} ~]`;
const annotated = (paths, text = "Synthetic question") => `${paths.map(block).join("\n")}\n${text}`;
const empty = matchedMessages => ({ matchedMessages, images: [] });

async function fixture(t, relativeHome = ".hermes") {
  const base = resolve(__dirname, "..", ".tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(join(base, "hermes-images-"));
  const home = join(root, relativeHome), paseoHome = join(root, "paseo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(paseoHome);
  const path = join(home, "state.db"), writer = new DatabaseSync(path);
  t.after(() => { writer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  writer.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content, platform_message_id TEXT, message_uid TEXT, timestamp REAL);
    INSERT INTO sessions VALUES ('session-one'), ('session-two');
    PRAGMA wal_checkpoint(TRUNCATE);`);
  const png = Buffer.from(await new Image(2, 2).fill(0x4488ccff).encode());
  const jpg = Buffer.from(await new Image(2, 2).fill(0x4488ccff).encodeJPEG());
  const h = harness();
  const resolver = h.createHermesPromptImageResolver({ userHome: root, paseoHome });
  const context = overrides => ({ agentId: "fake-agent", provider: "custom-provider", cwd: root,
    sessionId: "session-one", nativeHandle: "unused-handle", text: "Synthetic question",
    messageId: "paseo-message", clientMessageId: "paseo-client",
    signal: new AbortController().signal, providerCommand: ["hermes", "acp"], providerEnv: { HERMES_HOME: home }, ...overrides });
  let nextImage = 0;
  function image(kind = "native", bytes = png) {
    const name = (++nextImage).toString(16).padStart(12, "0");
    const path = kind === "native"
      ? join(home, "cache", "documents", "native-inputs", "a".repeat(64), `img_${name}.png`)
      : join(home, "cache", "images", `img_${name}.${kind === "jpg" ? "jpg" : "png"}`);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, bytes);
    return path;
  }
  function add(content, overrides = {}) {
    const row = { session: "session-one", role: "user", platformId: null, uid: null, ...overrides };
    writer.prepare("INSERT INTO messages (session_id, role, content, platform_message_id, message_uid, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.session, row.role, content, row.platformId, row.uid, 1234567890);
  }
  function config(command, env) {
    fs.writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ agents: { providers: { "custom-provider": { command, env } } } }));
  }
  async function find(overrides) {
    const before = [path, `${path}-wal`].map(file => fs.readFileSync(file));
    const entries = fs.readdirSync(home);
    const result = await resolver.find(context(overrides));
    for (const [index, file] of [path, `${path}-wal`].entries()) assert.deepEqual(fs.readFileSync(file), before[index]);
    assert.deepEqual(fs.readdirSync(home), entries);
    assert.deepEqual(h.logs, []);
    return result;
  }
  return { root, home, paseoHome, path, writer, png, jpg, h, resolver, context, image, add, config, find };
}

test("Hermes exact stripped text matches only the same session and reads committed live WAL images", async t => {
  const f = await fixture(t);
  const main = fs.readFileSync(f.path);
  const native = f.image(), cached = f.image("jpg", f.jpg);
  const other = f.image("png");
  f.add(annotated([native, cached]));
  f.add(annotated([other]), { session: "session-two" });
  f.add(annotated([other]), { role: "assistant" });
  assert.deepEqual(fs.readFileSync(f.path), main, "message rows exist only in WAL");
  const found = await f.find();
  assert.equal(found.matchedMessages, 1);
  assert.deepEqual(found.images.map(image => image.mime), ["image/png", "image/jpeg"]);
  assert.deepEqual(await found.images[0].readBytes(), f.png);
  assert.deepEqual(await found.images[1].readBytes(), f.jpg);
});

test("Hermes compares full content and trimmed stripped text without altering internal whitespace", async t => {
  const f = await fixture(t), content = annotated([f.image()], "  Synthetic  question\nnext line  ");
  f.add(content);
  for (const text of [content, `\n${content}\n`, "Synthetic  question\nnext line"]) {
    const result = await f.find({ text });
    assert.equal(result.matchedMessages, 1);
    assert.equal(result.images.length, 1);
  }
  assert.deepEqual(await f.find({ text: "Synthetic question next line" }), empty(0));
});

for (const field of ["platformId", "uid"]) {
  for (const requestField of ["messageId", "clientMessageId"]) {
    test(`Hermes matches ${requestField} against ${field} with case and dash normalization`, async t => {
      const f = await fixture(t);
      f.add(annotated([f.image()], "Different text"), { [field]: dashed(ID) });
      f.add(annotated([f.image()]), { session: "session-two", [field]: ID });
      const result = await f.find({ [requestField]: ID });
      assert.equal(result.matchedMessages, 1);
      assert.equal(result.images.length, 1);
      assert.equal((await f.find({ [requestField]: dashed(ID) })).images.length, 1);
    });
  }
}

test("Hermes ID precedence disambiguates repeated text; matching both IDs on one row counts once", async t => {
  const f = await fixture(t);
  const first = f.image(), second = f.image("jpg", f.jpg);
  f.add(annotated([first]), { platformId: ID, uid: UID });
  f.add(annotated([second]));
  const result = await f.find({ messageId: dashed(ID), clientMessageId: dashed(UID) });
  assert.equal(result.matchedMessages, 1);
  assert.deepEqual(await result.images[0].readBytes(), f.png);
});

test("Hermes duplicate text, including image-free messages, returns its exact count and no images", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image()]));
  f.add("Synthetic question");
  f.add(annotated([f.image()]));
  assert.deepEqual(await f.find(), empty(3));
  assert.deepEqual(await f.find({ messageId: undefined, clientMessageId: undefined }), empty(3));
});

test("Hermes duplicate IDs and conflicting request IDs never fall back to a unique text match", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image()]), { platformId: ID });
  f.add(annotated([f.image()], "Other text"), { uid: UID });
  assert.deepEqual(await f.find({ messageId: ID, clientMessageId: UID }), empty(2));
  f.add("Unrelated", { platformId: ID });
  assert.deepEqual(await f.find({ messageId: ID }), empty(2));
});

test("Hermes unmatched IDs fall back to exact text, including an empty image-only prompt", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image()], ""));
  assert.equal((await f.find({ text: "", messageId: ID })).images.length, 1);
  assert.deepEqual(await f.find({ text: "not present" }), empty(0));
});

test("Hermes never uses another session or nativeHandle, including orphaned rows", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image()]), { session: "session-two", platformId: ID });
  assert.deepEqual(await f.find({ messageId: ID }), empty(0));
  assert.deepEqual(await f.find({ sessionId: null, nativeHandle: "session-two" }), empty(0));
  f.add(annotated([f.image()]), { session: "missing-session", platformId: ID });
  assert.deepEqual(await f.find({ sessionId: "missing-session", messageId: ID }), empty(0));
});

test("Hermes skips missing files, unknown formats and byte/pixel oversize while retaining valid images", async t => {
  const f = await fixture(t);
  const missing = f.image(); fs.unlinkSync(missing);
  const hugePixels = Buffer.from(f.png); hugePixels.writeUInt32BE(24_000_001, 16);
  const paths = [missing, f.image("png", Buffer.from("unknown format")), f.image("png", Buffer.alloc(8 * 1024 * 1024 + 1)), f.image("png", hugePixels), f.image()];
  f.add(annotated(paths));
  const found = await f.find();
  assert.equal(found.matchedMessages, 1);
  assert.equal(found.images.length, 1);
  assert.equal(found.images[0].id, "hermes-4");
  fs.unlinkSync(paths[4]);
  assert.deepEqual(await f.find(), empty(1));
  await assert.rejects(found.images[0].readBytes(), /^Error: invalid_image$/);
});

test("Hermes works when only one of the two cache roots exists", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image("png")]));
  assert.equal((await f.find()).images.length, 1);
});

test("Hermes rejects traversal, external paths, symlink leaves/ancestors, prefix siblings and undocumented names", async t => {
  const f = await fixture(t);
  const valid = f.image("png"), native = f.image();
  const outside = join(f.root, "outside"); fs.mkdirSync(outside);
  const external = join(outside, "img_aaaaaaaaaaaa.png"); fs.writeFileSync(external, f.png);
  const leaf = join(dirname(valid), "img_bbbbbbbbbbbb.png"); fs.symlinkSync(external, leaf);
  const ancestor = join(f.home, "cache", "documents", "native-inputs", "b".repeat(64)); fs.symlinkSync(outside, ancestor);
  const sibling = join(f.home, "cache", "images-other", "img_aaaaaaaaaaaa.png"); fs.mkdirSync(dirname(sibling)); fs.writeFileSync(sibling, f.png);
  const undocumented = join(dirname(valid), "arbitrary.png"); fs.writeFileSync(undocumented, f.png);
  const traversal = `${dirname(valid)}/nested/../${valid.split("/").at(-1)}`;
  const escape = `${dirname(valid)}/../../../outside/img_aaaaaaaaaaaa.png`;
  f.add(annotated([external, leaf, join(ancestor, "img_aaaaaaaaaaaa.png"), sibling, undocumented, traversal, escape, native]));
  const result = await f.find();
  assert.equal(result.matchedMessages, 1);
  assert.deepEqual(result.images.map(image => image.id), ["hermes-7"]);
});

test("Hermes malformed records and annotation format changes return no images", async t => {
  const f = await fixture(t), path = f.image();
  for (const content of [null, Buffer.from("bad record"), JSON.stringify({ text: "Synthetic question", images: [path] }),
    `[The user sent an image~ Changed prefix ${path} ~]\nSynthetic question`,
    `[The user sent an image~ Here's what I can see: missing end ${path}`,
    `[The user sent an image~ Here's what I can see: relative/path.png ~]\nSynthetic question`]) {
    f.writer.exec("DELETE FROM messages");
    f.add(content, { platformId: ID });
    assert.deepEqual(await f.find({ messageId: ID }), empty(1));
  }
  f.writer.exec("DROP TABLE messages; CREATE TABLE messages (new_format TEXT)");
  assert.deepEqual(await f.find(), empty(0));
});

test("Hermes caps valid images per message independently of the registry thumbnail cap", async t => {
  const f = await fixture(t);
  f.add(annotated(Array.from({ length: 18 }, () => f.image())));
  assert.equal((await f.find()).images.length, 16);
  const handlers = f.h.createPromptImageHandlers({ resolvers: [f.resolver] });
  const snapshot = { provider: "custom-provider", command: ["hermes", "acp"], env: { HERMES_HOME: f.home },
    cwd: f.root, persistence: { provider: "custom-provider", sessionId: "session-one" } };
  const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
  const input = { agentId: "fake-agent", text: "Synthetic question" };
  const result = await handlers.images(input, context);
  assert.equal(result.total, 16);
  assert.equal(result.images.length, 3);
  const full = await handlers.image({ ...input, id: result.images[0].id }, context);
  assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), f.png);
  assert.equal((await handlers.image({ ...input, id: "../outside.png" }, context)).error, "not_found");
  assert.equal((await handlers.images({ ...input, text: "other message" }, context)).total, 0);
  assert.deepEqual(f.h.logs, [["[clear-chat] prompt.image: not_found"], ["[clear-chat] prompt.images: no_match"]]);
});

for (const [relativeHome, command] of [[".hermes", "hermes acp"], [".hermes/profiles/test-profile", ["hermes", "-p", "test-profile", "acp"]]]) {
  test(`Hermes maps a configured arbitrary provider ID to ${relativeHome}`, async t => {
    const f = await fixture(t, relativeHome);
    f.config(command);
    f.add(annotated([f.image()]));
    const context = f.context({ providerCommand: undefined, providerEnv: undefined });
    assert.equal(await f.resolver.matches(context.provider, context), true);
    assert.equal((await f.resolver.find(context)).images.length, 1);
  });
}

test("Hermes honors config HERMES_HOME and snapshot launch hints take precedence", async t => {
  const f = await fixture(t, "custom-home");
  f.config("hermes -p ignored acp", { HERMES_HOME: "~/custom-home" });
  f.add(annotated([f.image()]));
  assert.equal((await f.find({ providerCommand: undefined, providerEnv: undefined })).images.length, 1);
  f.config("other-provider acp", { HERMES_HOME: join(f.root, "wrong-home") });
  assert.equal((await f.find()).images.length, 1);
  assert.deepEqual(await f.find({ providerCommand: "other-provider acp" }), empty(0));
});

test("Hermes uses config env when snapshot supplies only the command, and holds the matched profile for one lookup", async t => {
  const f = await fixture(t, "custom-home");
  f.config("other-provider acp", { HERMES_HOME: f.home });
  f.add(annotated([f.image()]));
  const context = f.context({ providerEnv: undefined });
  assert.equal(await f.resolver.matches(context.provider, context), true);
  f.config("hermes acp", { HERMES_HOME: join(f.root, "missing") });
  assert.equal((await f.resolver.find(context)).images.length, 1);
});

for (const customPaseoHome of [true, false]) {
  test(`Hermes reads ${customPaseoHome ? "PASEO_HOME" : "default Paseo home"} config in the production registry`, async t => {
    const f = await fixture(t);
    const paseoHome = customPaseoHome ? f.paseoHome : join(f.root, ".paseo");
    fs.mkdirSync(paseoHome, { recursive: true });
    fs.writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ agents: { providers: {
      "custom-provider": { command: ["hermes", "acp"], env: { HERMES_HOME: f.home } },
    } } }));
    f.add(annotated([f.image()]));
    const h = harness({ "node:os": { homedir: () => f.root }, process: { env: customPaseoHome ? { PASEO_HOME: paseoHome } : {} } });
    const snapshot = { provider: "custom-provider", cwd: f.root, persistence: { provider: "custom-provider", sessionId: "session-one" } };
    const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
    const result = await h.createPromptImageHandlers().images({ agentId: "fake-agent", text: "Synthetic question" }, context);
    assert.equal(result.images.length, 1);
    assert.deepEqual(h.logs, []);
  });
}

test("Hermes fails closed on malformed/missing config, unknown providers and unsafe launch shapes", async t => {
  const f = await fixture(t);
  const unconfigured = { providerCommand: undefined, providerEnv: undefined };
  assert.deepEqual(await f.find(unconfigured), empty(0));
  fs.writeFileSync(join(f.paseoHome, "config.json"), "malformed");
  assert.deepEqual(await f.find(unconfigured), empty(0));
  f.config("hermes acp");
  assert.deepEqual(await f.find({ ...unconfigured, provider: "unknown" }), empty(0));
  for (const command of ["codex acp", "hermes -p ../escape acp", "hermes -p /absolute acp", "hermes acp --extra", "hermes acp; true", [], {}, ["hermes", null, "acp"]]) {
    const context = f.context({ providerCommand: command });
    assert.equal(await f.resolver.matches(context.provider, context), false);
    assert.deepEqual(await f.resolver.find(context), empty(0));
  }
  for (const HERMES_HOME of ["relative-home", "", 123, `${f.home}/../escape`]) {
    assert.deepEqual(await f.find({ providerEnv: { HERMES_HOME } }), empty(0));
  }
});

test("Hermes missing databases and cancelled lookups create no files and never read image bytes", async t => {
  const f = await fixture(t);
  const missingHome = join(f.root, "absent");
  assert.deepEqual(await f.resolver.find(f.context({ providerEnv: { HERMES_HOME: missingHome } })), empty(0));
  assert.equal(fs.existsSync(missingHome), false);
  const signal = AbortSignal.abort();
  assert.deepEqual(await f.find({ signal }), empty(0));
  assert.equal(await f.resolver.matches("custom-provider", f.context({ signal })), false);
});

test("the production registry resolves Hermes from snapshot command without relying on its provider ID", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image()]));
  const handlers = f.h.createPromptImageHandlers();
  const snapshot = { provider: "renamed-hermes", command: "hermes acp", env: { HERMES_HOME: f.home },
    cwd: f.root, persistence: { provider: "renamed-hermes", sessionId: "session-one" } };
  const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
  assert.equal((await handlers.images({ agentId: "fake-agent", text: "Synthetic question" }, context)).images.length, 1);
});
