const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "hermes-cc-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = new Map();
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
      return id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : overrides[id] ?? realRequire(id);
    }
    runInThisContext(`(function(require,module,exports,console){${code}\n})`, { filename })(
      localRequire, mod, mod.exports, { debug() {} },
    );
    return mod.exports;
  }
  const storeModule = load("server/hermes-cc/store.ts");
  const { hermesCcPromptImageResolver: resolver } = load("server/prompt-images/hermes-cc.ts");
  const registry = load("server/prompt-images/registry.ts");
  const { nativeSessionKeyFromPersistence } = load("server/hermes-cc/session-key.ts");
  const storeRoot = join(root, "images");
  return { root, storeRoot, ...storeModule, resolver, registry, nativeSessionKeyFromPersistence,
    store: storeModule.createHermesCcImageStore(storeRoot) };
}
const key = (messageId = "client-1", sessionKey = "acp-session") => ({ sessionKey, messageId });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const keyDirectory = (h, k = key()) => join(h.storeRoot, hash(`${k.sessionKey}\0${k.messageId}`));
const metaFile = (h, k) => join(keyDirectory(h, k), "meta.json");
const readMeta = (h, k) => JSON.parse(fs.readFileSync(metaFile(h, k), "utf8"));
const imageFile = (h, index = 0, k = key()) => join(keyDirectory(h, k), readMeta(h, k).images[index].file);
function png(width = 2, height = 1, size = 24) {
  const data = Buffer.alloc(size);
  data.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return { mime: "image/png", data };
}
function context(h, changes = {}) {
  return { agentId: "agent", provider: "hermes-cc", cwd: "/unused", sessionId: handle(), nativeHandle: null,
    messageId: "client-1", clientMessageId: null, text: "same text", hermesCcImageStore: h.store,
    signal: new AbortController().signal, ...changes };
}
function handle(id = "acp-session") { return `plugin:${JSON.stringify({ version: 1, data: { sessionId: id } })}`; }
function host(sessionId = handle(), provider = "hermes-cc") {
  const agent = { provider, cwd: "/unused", persistence: { provider, sessionId } };
  return { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent }), current: () => agent }) } } };
}
const input = changes => ({ agentId: "agent", messageId: "client-1", clientMessageId: null, text: "same text", ...changes });
async function resultBytes(found) { return Promise.all(found.images.map(image => image.readBytes())); }
function diskBytes(path) {
  return fs.readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const file = join(path, entry.name);
    return sum + (entry.isDirectory() ? diskBytes(file) : fs.lstatSync(file).size);
  }, 0);
}

test("Hermes CC store persists ordered allowlisted images with hashed paths and private permissions", async t => {
  const h = harness(t);
  const images = [png(), { mime: "image/jpeg", data: Buffer.from("jpeg") },
    { mime: "image/svg+xml", data: Buffer.from("excluded") },
    { mime: "image/webp", data: Buffer.from("webp") }, { mime: "image/gif", data: Buffer.from("gif") }];
  await h.store.save(key(), images);
  const found = await h.store.load(key());
  assert.deepEqual(found.map(image => image.bytes), images.filter(image => image.mime !== "image/svg+xml").map(image => image.data));
  assert.deepEqual(found.map(image => image.sha256), found.map(image => hash(image.bytes)));
  const meta = readMeta(h);
  assert.equal(meta.sessionKey, "acp-session");
  assert.equal(meta.messageId, "client-1");
  assert.equal(typeof meta.createdAt, "number");
  assert.deepEqual(meta.images.map(image => image.size), [24, 4, 4, 3]);
  assert.equal(fs.statSync(h.storeRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(keyDirectory(h)).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(keyDirectory(h))) {
    assert.equal(fs.statSync(join(keyDirectory(h), name)).mode & 0o777, 0o600);
    assert.equal(name.endsWith(".tmp"), false);
  }
});

test("Hermes CC store treats equal SHA lists as a no-op and snapshots mutable inputs", async t => {
  const h = harness(t), image = png(), original = Buffer.from(image.data), k = key();
  const saving = h.store.save(k, [image]);
  image.data.fill(0); k.messageId = "mutated";
  await saving;
  const before = fs.statSync(metaFile(h), { bigint: true });
  await h.store.save(key(), [{ mime: "image/png", data: original }]);
  const after = fs.statSync(metaFile(h), { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual((await h.store.load(key()))[0].bytes, original);
  assert.equal(await h.store.load(k), null);
});

test("Hermes CC store misses without creating directories and isolates sessions and exact IDs", async t => {
  const h = harness(t);
  assert.equal(await h.store.load(key()), null);
  assert.equal(fs.existsSync(h.storeRoot), false);
  await h.store.save(key(), [png()]);
  for (const k of [key("other"), key("client-1", "other-session"), key(" client-1")]) {
    assert.equal(await h.store.load(k), null);
  }
  await h.store.save(key("empty"), []);
  assert.equal(await h.store.load(key("empty")), null);
});

test("Hermes CC store conflicts permanently on changed images, order, or an empty retry", async t => {
  const h = harness(t);
  for (const [id, first, second] of [
    ["changed", [png()], [png(3)]],
    ["order", [png(), png(3)], [png(3), png()]],
    ["removed", [png()], []],
    ["added", [], [png()]],
  ]) {
    const k = key(id);
    await h.store.save(k, first);
    await h.store.save(k, second);
    assert.equal(readMeta(h, k).conflict, true);
    assert.equal(await h.store.load(k), null);
    await h.store.save(k, first);
    assert.equal(await h.createHermesCcImageStore(h.storeRoot).load(k), null);
  }
});

test("Hermes CC store detects SHA and size tampering without partially returning images", async t => {
  const h = harness(t);
  await h.store.save(key(), [png(), png(3)]);
  const file = imageFile(h, 1), data = fs.readFileSync(file);
  data[23] ^= 1;
  fs.writeFileSync(file, data);
  assert.equal(await h.store.load(key()), null);
  await h.store.save(key(), [png(), png(3)]);
  assert.equal(await h.store.load(key()), null);
  fs.writeFileSync(file, Buffer.from("short"));
  assert.equal(await h.store.load(key()), null);
  fs.unlinkSync(file);
  assert.equal(await h.store.load(key()), null);
});

test("Hermes CC store rejects invalid keys and caps, including delimiter collisions", async t => {
  const h = harness(t);
  for (const value of ["", " ", "a".repeat(513), "a\0b", null, 42]) {
    for (const k of [key(value), key("client-1", value)]) {
      await assert.rejects(h.store.save(k, [png()]), /invalid_image_key/);
      await assert.rejects(h.store.load(k), /invalid_image_key/);
    }
  }
  const boundary = key("m".repeat(512), "s".repeat(512));
  await h.store.save(boundary, [png()]);
  assert.equal((await h.store.load(boundary)).length, 1);
  for (const maxBytes of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => h.createHermesCcImageStore(h.storeRoot, { maxBytes }), /invalid_image_cap/);
  }
});

test("Hermes CC cap counts metadata and evicts whole keys by createdAt, not access or save order", async t => {
  const h = harness(t);
  const a = key("old"), b = key("new");
  await h.store.save(a, [png()]);
  await h.store.save(b, [png(3)]);
  for (const [k, createdAt] of [[a, 20], [b, 10]]) {
    const meta = readMeta(h, k);
    fs.writeFileSync(metaFile(h, k), JSON.stringify({ ...meta, createdAt }));
  }
  const bytesA = diskBytes(keyDirectory(h, a));
  const capped = h.createHermesCcImageStore(h.storeRoot, { maxBytes: bytesA });
  await capped.save(a, [png()]);
  assert.equal(fs.existsSync(keyDirectory(h, b)), false);
  assert.deepEqual((await capped.load(a))[0].bytes, png().data);
  assert.ok(diskBytes(h.storeRoot) <= bytesA);
  const zero = h.createHermesCcImageStore(h.storeRoot, { maxBytes: 0 });
  await zero.save(a, [png()]);
  assert.equal(fs.existsSync(keyDirectory(h, a)), false);
  assert.equal(diskBytes(h.storeRoot), 0);
});

test("Hermes CC conflict survives whole-key eviction and reopening the store", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  await h.store.save(key(), [png(3)]);
  const capped = h.createHermesCcImageStore(h.storeRoot, { maxBytes: 0 });
  await capped.save(key(), [png()]);
  assert.equal(fs.existsSync(keyDirectory(h)), false);
  assert.equal(diskBytes(h.storeRoot), 0);
  const reopened = h.createHermesCcImageStore(h.storeRoot);
  await reopened.save(key(), [png()]);
  assert.equal(await reopened.load(key()), null);
  assert.equal(fs.existsSync(keyDirectory(h)), false);
});

test("Hermes CC store refuses symlinked roots and ancestor directories", async t => {
  const h = harness(t), outside = join(h.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, h.storeRoot);
  assert.equal(await h.store.load(key()), null);
  await assert.rejects(h.store.save(key(), [png()]));
  assert.deepEqual(fs.readdirSync(outside), []);
  const nested = h.createHermesCcImageStore(join(h.storeRoot, "nested"));
  await assert.rejects(nested.save(key(), [png()]));
  assert.equal(await nested.load(key()), null);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("Hermes CC store refuses linked keys, metadata, files and hard links without touching targets", async t => {
  for (const kind of ["directory", "meta", "image", "hardlink"]) {
    const h = harness(t);
    await h.store.save(key(), [png()]);
    const target = kind === "directory" ? keyDirectory(h) : kind === "meta" ? metaFile(h) : imageFile(h);
    const outside = join(h.root, `outside-${kind}`);
    fs.renameSync(target, outside);
    if (kind === "hardlink") fs.linkSync(outside, target); else fs.symlinkSync(outside, target);
    const original = kind === "directory" ? fs.readdirSync(outside) : fs.readFileSync(outside);
    assert.equal(await h.store.load(key()), null);
    await assert.rejects(h.store.save(key(), [png()]));
    assert.deepEqual(kind === "directory" ? fs.readdirSync(outside) : fs.readFileSync(outside), original);
  }
});

test("Hermes CC metadata cannot redirect image reads or claim a different key", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  const original = readMeta(h);
  for (const meta of [
    { ...original, sessionKey: "another" },
    { ...original, images: [{ ...original.images[0], file: "../outside.png" }] },
    { ...original, images: [{ ...original.images[0], mime: "image/svg+xml" }] },
    { ...original, images: [{ ...original.images[0], size: -1 }] },
    { ...original, images: [{ ...original.images[0], sha256: "bad" }] },
  ]) {
    fs.writeFileSync(metaFile(h), JSON.stringify(meta));
    assert.equal(await h.store.load(key()), null);
  }
  fs.writeFileSync(metaFile(h), "unreadable JSON");
  assert.equal(await h.store.load(key()), null);
  await assert.rejects(h.store.save(key(), [png()]));
});

test("Hermes CC saves serialize across instances, including simultaneous conflicting input", async t => {
  const h = harness(t), other = h.createHermesCcImageStore(h.storeRoot);
  await Promise.all([h.store.save(key(), [png()]), other.save(key(), [png(3)])]);
  assert.equal(await h.store.load(key()), null);
  assert.ok(fs.existsSync(join(h.storeRoot, `.conflict-${require("node:path").basename(keyDirectory(h))}`)));
  const k = key("identical");
  await Promise.all(Array.from({ length: 8 }, () => other.save(k, [png()])));
  assert.deepEqual((await other.load(k))[0].bytes, png().data);
});

test("Hermes CC session helper decodes only supported plugin ACP persistence handles", t => {
  const h = harness(t);
  assert.equal(h.nativeSessionKeyFromPersistence(handle()), "acp-session");
  for (const invalid of [null, {}, "acp-session", "plugin:no-json", "plugin:null", "plugin:[]", handle(""),
    handle("a".repeat(513)), handle("a\0b"),
    'plugin:{"version":1,"data":[]}', 'plugin:{"version":1,"data":{"sessionId":5}}',
    'plugin:{"version":2,"data":{"sessionId":"s"}}',
    'plugin:{"version":1,"data":{"sessionId":"s"},"extra":true}']) {
    assert.equal(h.nativeSessionKeyFromPersistence(invalid), null);
  }
});

test("Hermes CC root canonicalizes a symlinked daemon home and only writes below its real Clear Chat subtree", async t => {
  const h = harness(t), previous = process.env.PASEO_HOME;
  t.after(() => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; });
  const alias = join(h.root, "alias"), real = join(h.root, "real");
  fs.mkdirSync(real); fs.symlinkSync(real, alias);
  process.env.PASEO_HOME = alias;
  assert.equal(h.hermesCcPaseoHome(), real);
  const root = h.hermesCcImageRoot({});
  assert.equal(root, join(real, "plugin-data", "clear-chat", "hermes-cc-images"));
  const store = h.createHermesCcImageStore(root, { trustedRoot: real });
  await store.save(key(), [png()]);
  assert.deepEqual((await store.load(key()))[0].bytes, png().data);
  assert.deepEqual(fs.readdirSync(real), ["plugin-data"]);
  fs.renameSync(join(real, "plugin-data"), join(real, "moved"));
  const outside = join(h.root, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(real, "plugin-data"));
  await assert.rejects(store.save(key(), [png(3)]), /^Error: image_store_failed$/);
  assert.equal(await store.load(key()), null);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("Hermes CC resolver matches only enhanced Hermes provider IDs", t => {
  const h = harness(t);
  for (const id of ["hermes-cc", "hermes-zk-cc", "hermes-pp-cc"]) assert.equal(h.resolver.matches(id), true);
  for (const id of ["hermes", "hermes-zk", "hermes-pp", "claude-cc", "codex", "xhermes-cc"]) assert.equal(h.resolver.matches(id), false);
});

test("Hermes CC resolver hits by either exact ID, deduplicates equal IDs and misses other sessions", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  for (const ids of [{ messageId: "client-1" }, { messageId: null, clientMessageId: "client-1" },
    { messageId: "server-id", clientMessageId: "client-1" }, { messageId: "client-1", clientMessageId: "client-1" }]) {
    const found = await h.resolver.find(context(h, ids));
    assert.equal(found.matchedMessages, 1);
    assert.deepEqual(await resultBytes(found), [png().data]);
  }
  assert.deepEqual(await h.resolver.find(context(h, { sessionId: handle("other-session") })), { matchedMessages: 0, images: [] });
});

test("Hermes CC resolver never reads text and same text with another ID yields nothing", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  for (const messageId of [null, "", "missing", " client-1", "x".repeat(513)]) {
    const ctx = context(h, { messageId });
    Object.defineProperty(ctx, "text", { get() { throw new Error("text must never be read"); } });
    assert.deepEqual(await h.resolver.find(ctx), { matchedMessages: 0, images: [] });
  }
  const found = await h.resolver.find(context(h, { text: "different text" }));
  assert.deepEqual(await resultBytes(found), [png().data]);
});

test("Hermes CC resolver rejects conflicting IDs, accepts identical content and omits conflicted keys", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  await h.store.save(key("second"), [png(3)]);
  assert.deepEqual(await h.resolver.find(context(h, { clientMessageId: "second" })), { matchedMessages: 2, images: [] });
  await h.store.save(key("identical"), [png()]);
  assert.deepEqual(await resultBytes(await h.resolver.find(context(h, { clientMessageId: "identical" }))), [png().data]);
  await h.store.save(key(), [png(4)]);
  assert.deepEqual(await h.resolver.find(context(h)), { matchedMessages: 0, images: [] });
});

test("Hermes CC resolver does not load the store for invalid sessions or aborted lookups", async t => {
  const h = harness(t);
  const neverLoad = { async load() { assert.fail("must not load"); } };
  for (const sessionId of [null, "acp-session", "plugin:{}", "plugin:broken"]) {
    assert.deepEqual(await h.resolver.find(context(h, { sessionId, hermesCcImageStore: neverLoad })), { matchedMessages: 0, images: [] });
  }
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await h.resolver.find(context(h, { signal: controller.signal, hermesCcImageStore: neverLoad })), { matchedMessages: 0, images: [] });
  assert.deepEqual(await h.resolver.find(context(h, { hermesCcImageStore: undefined })), { matchedMessages: 0, images: [] });
});

test("Hermes CC registry uses its existing three-thumbnail and full-image path", async t => {
  const h = harness(t);
  await h.store.save(key(), [png(), png(3), png(4), png(5)]);
  const handlers = h.registry.createPromptImageHandlers({ hermesCcImageStore: h.store });
  const listed = await handlers.images(input(), host());
  assert.equal(listed.total, 4);
  assert.equal(listed.reason, null);
  assert.deepEqual(listed.images.map(image => image.id), ["0", "1", "2"]);
  const full = await handlers.image({ ...input(), id: "3" }, host());
  assert.equal(full.error, null);
  assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), png(5).data);
  assert.equal((await handlers.image({ ...input(), id: "../meta.json" }, host())).error, "not_found");
  const byClient = await handlers.images(input({ messageId: "server-id", clientMessageId: "client-1" }), host());
  assert.equal(byClient.total, 4);
});

test("Hermes CC registry enforces byte, pixel and header limits without bypassing exact ID lookup", async t => {
  const h = harness(t), cap = h.registry.MAX_INLINE_IMAGE_BYTES;
  await h.store.save(key(), [png(2, 1, cap + 1), png(6000, 4001), { mime: "image/png", data: Buffer.from("invalid") }, png()]);
  const handlers = h.registry.createPromptImageHandlers({ hermesCcImageStore: h.store });
  const listed = await handlers.images(input(), host());
  assert.equal(listed.total, 4);
  assert.deepEqual(listed.images.map(image => image.id), ["3"]);
  for (const [id, error] of [["0", "image_too_large"], ["1", "image_too_large"], ["2", "invalid_image"]]) {
    assert.equal((await handlers.image({ ...input(), id }, host())).error, error);
  }
  const missed = await handlers.images(input({ messageId: "missing" }), host());
  assert.deepEqual(missed, { images: [], total: 0, reason: "no_match" });
  await h.store.save(key("boundary"), [png(6000, 4000, cap)]);
  assert.equal((await handlers.images(input({ messageId: "boundary" }), host())).images.length, 1);
});

test("Hermes CC registry reports two ID hits with different images as ambiguous", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  await h.store.save(key("second"), [png(3)]);
  const handlers = h.registry.createPromptImageHandlers({ hermesCcImageStore: h.store });
  const request = input({ clientMessageId: "second" });
  assert.deepEqual(await handlers.images(request, host()), { images: [], total: 0, reason: "ambiguous" });
  assert.equal((await handlers.image({ ...request, id: "0" }, host())).error, "ambiguous");
  assert.equal((await handlers.images(input(), host("not-a-plugin-handle"))).reason, "no_match");
  assert.equal((await handlers.images(input(), host(handle(), "hermes"))).reason, "unknown_provider");
});

test("Hermes CC file reads refuse a symlink substituted between lstat and open", async t => {
  const fsp = require("node:fs/promises");
  let attack = false, attacked = false, outside;
  const wrapped = { ...fsp, async open(path, flags, mode) {
    if (attack && String(path).endsWith(".bin")) {
      assert.equal(flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
      attacked = true;
      fs.unlinkSync(path);
      fs.symlinkSync(outside, path);
    }
    return fsp.open(path, flags, mode);
  } };
  const h = harness(t, { "node:fs/promises": wrapped });
  await h.store.save(key(), [png()]);
  outside = join(h.root, "outside.png");
  const decoy = png(7).data;
  fs.writeFileSync(outside, decoy);
  attack = true;
  assert.equal(await h.store.load(key()), null);
  assert.equal(attacked, true);
  assert.deepEqual(fs.readFileSync(outside), decoy);
});

test("Hermes CC failed atomic publication cleans up and never publishes a partial key", async t => {
  const fsp = require("node:fs/promises");
  let failing = true;
  const wrapped = { ...fsp, async rename(source, target) {
    if (failing && String(target).endsWith(".bin")) throw Object.assign(new Error("synthetic failure"), { code: "EIO" });
    return fsp.rename(source, target);
  } };
  const h = harness(t, { "node:fs/promises": wrapped });
  await assert.rejects(h.store.save(key(), [png()]));
  assert.equal(await h.store.load(key()), null);
  assert.ok(fs.readdirSync(h.storeRoot).every(name => name.startsWith(".seen-")));
  assert.equal(diskBytes(h.storeRoot), 0);
  failing = false;
  await h.store.save(key(), [png()]);
  assert.deepEqual((await h.store.load(key()))[0].bytes, png().data);
});

test("Hermes CC descriptor-based eviction cannot follow a substituted key directory", { skip: process.platform !== "linux" }, async t => {
  const fsp = require("node:fs/promises");
  let attack = false, attacked = false, h, outside, moved;
  const wrapped = { ...fsp, async unlink(path) {
    if (attack && !attacked && String(path).endsWith(".bin")) {
      attacked = true;
      fs.renameSync(keyDirectory(h), moved);
      fs.symlinkSync(outside, keyDirectory(h));
    }
    return fsp.unlink(path);
  } };
  h = harness(t, { "node:fs/promises": wrapped });
  await h.store.save(key(), [png()]);
  outside = join(h.root, "outside"); moved = join(h.root, "moved");
  fs.mkdirSync(outside);
  // An outside file has the same name as the victim; path-based deletion would remove it.
  const file = readMeta(h).images[0].file;
  fs.writeFileSync(join(outside, file), "keep outside");
  attack = true;
  const capped = h.createHermesCcImageStore(h.storeRoot, { maxBytes: 0 });
  await assert.rejects(capped.save(key(), [png()]));
  assert.equal(attacked, true);
  assert.equal(fs.readFileSync(join(outside, file), "utf8"), "keep outside");
  assert.equal(await h.store.load(key()), null);
});

test("Hermes CC cross-process saves always poison different payloads for the same key", { timeout: 30_000 }, async t => {
  const { fork } = require("node:child_process");
  const h = harness(t), compiledFile = join(h.root, "store.cjs"), worker = join(h.root, "writer.cjs");
  fs.writeFileSync(compiledFile, ts.transpileModule(fs.readFileSync(resolve(__dirname, "../server/hermes-cc/store.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText);
  fs.writeFileSync(worker, `
    const { createHermesCcImageStore } = require(process.argv[2]);
    process.send({ ready: true });
    process.once("message", async () => {
      try {
        const result = await createHermesCcImageStore(process.argv[3]).save(
          { sessionKey: "shared-native", messageId: process.argv[4] },
          [{ mime: "image/png", data: Buffer.from(process.argv[5]) }]);
        process.send({ result }); process.disconnect();
      } catch { process.send({ error: true }); process.exitCode = 1; process.disconnect(); }
    });
  `);
  fs.mkdirSync(h.storeRoot);
  const staleLock = join(h.storeRoot, ".save.lock");
  fs.writeFileSync(staleLock, JSON.stringify({ pid: 2147483647, token: "abandoned" }));
  const staleTime = new Date(Date.now() - 10 * 60_000); fs.utimesSync(staleLock, staleTime, staleTime);
  for (let round = 0; round < 20; round++) {
    const children = ["first-bytes", "other-bytes"].map(bytes => {
      const child = fork(worker, [compiledFile, h.storeRoot, String(round), bytes], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      t.after(() => { if (child.connected) child.kill(); });
      const ready = new Promise((resolve, reject) => { child.once("message", message => message.ready ? resolve() : reject(new Error("writer not ready"))); child.once("error", reject); });
      const result = new Promise((resolve, reject) => {
        child.on("message", message => { if (message.result) resolve(message.result); if (message.error) reject(new Error("writer failed")); });
        child.once("error", reject);
        child.once("exit", code => { if (code !== 0) reject(new Error("writer exited")); });
      });
      return { child, ready, result };
    });
    await Promise.all(children.map(child => child.ready));
    for (const { child } of children) child.send("save");
    const results = await Promise.all(children.map(child => child.result));
    assert.ok(results.includes("conflict"), `round ${round} must report a conflict`);
    assert.equal(await h.createHermesCcImageStore(h.storeRoot).load({ sessionKey: "shared-native", messageId: String(round) }), null);
  }
});

test("Hermes CC expires abandoned on-disk locks without allowing a stale reaper to remove a new lock", async t => {
  const h = harness(t);
  fs.mkdirSync(h.storeRoot);
  const lock = join(h.storeRoot, ".save.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "abandoned" }));
  const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lock, old, old);
  await h.store.save(key(), [png()]);
  assert.deepEqual((await h.store.load(key()))[0].bytes, png().data);
  assert.equal(fs.existsSync(lock), false);
});

test("Hermes CC eviction counts recent orphan trees/files and removes stale orphans without following links", async t => {
  const h = harness(t);
  fs.mkdirSync(h.storeRoot);
  const outside = join(h.root, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "keep"), "outside bytes");
  const temp = join(h.storeRoot, ".orphan.tmp"); fs.mkdirSync(temp);
  fs.mkdirSync(join(temp, "nested")); fs.writeFileSync(join(temp, "nested", "data"), Buffer.alloc(2048));
  fs.symlinkSync(outside, join(temp, "link"));
  const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(temp, old, old);
  const oldFile = join(h.storeRoot, ".abandoned.tmp"); fs.writeFileSync(oldFile, Buffer.alloc(100)); fs.utimesSync(oldFile, old, old);
  await h.store.save(key(), [png()]);
  assert.equal(fs.existsSync(temp), false); assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.readFileSync(join(outside, "keep"), "utf8"), "outside bytes");
  const recent = join(h.storeRoot, ".recent.tmp"); fs.mkdirSync(recent); fs.writeFileSync(join(recent, "data"), Buffer.alloc(4096));
  const freshFile = join(h.storeRoot, ".recent-file.tmp"); fs.writeFileSync(freshFile, Buffer.alloc(4096));
  const cap = diskBytes(keyDirectory(h));
  const capped = h.createHermesCcImageStore(h.storeRoot, { maxBytes: cap });
  await capped.save(key(), [png()]);
  assert.ok(diskBytes(h.storeRoot) <= cap);
  assert.equal(fs.existsSync(recent), false); assert.equal(fs.existsSync(freshFile), false);
  assert.equal(fs.readFileSync(join(outside, "keep"), "utf8"), "outside bytes");
});

test("Hermes CC eviction tolerates malformed or unreadable metadata of other keys and fails closed", async t => {
  const fsp = require("node:fs/promises");
  let deny = false, deniedHash;
  const h = harness(t, { "node:fs/promises": { ...fsp, async open(path, flags, mode) {
    if (deny && String(path).endsWith("meta.json")) {
      // Identify the directory through the pinned descriptor used for this read.
      const parent = fs.realpathSync(require("node:path").dirname(path));
      if (parent.endsWith(deniedHash)) throw Object.assign(new Error("private file path"), { code: "EACCES" });
    }
    return fsp.open(path, flags, mode);
  } } });
  const broken = key("broken"), unreadable = key("unreadable");
  await h.store.save(broken, [png()]); await h.store.save(unreadable, [png()]);
  fs.writeFileSync(metaFile(h, broken), "{");
  deniedHash = require("node:path").basename(keyDirectory(h, unreadable)); deny = true;
  await h.store.save(key(), [png()]);
  assert.deepEqual((await h.store.load(key()))[0].bytes, png().data);
  assert.equal(await h.store.load(broken), null); assert.equal(await h.store.load(unreadable), null);
  const zero = h.createHermesCcImageStore(h.storeRoot, { maxBytes: 0 });
  await zero.save(key(), [png()]);
  deny = false;
  await h.store.save(broken, [png()]); await h.store.save(unreadable, [png()]);
  assert.equal(await h.store.load(broken), null); assert.equal(await h.store.load(unreadable), null);
  assert.equal(diskBytes(h.storeRoot), 0);
});

test("Hermes CC treats changed MIME for identical bytes as conflicting payloads", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  assert.equal(await h.store.save(key(), [{ ...png(), mime: "image/jpeg" }]), "conflict");
  assert.equal(await h.store.load(key()), null);
});

test("Hermes CC resolver rejects differing persisted and native handles", async t => {
  const h = harness(t);
  await h.store.save(key(), [png()]);
  const found = await h.resolver.find(context(h, { nativeHandle: handle("different-session") }));
  assert.deepEqual(found, { matchedMessages: 0, images: [] });
});


test("Hermes CC never forgets a payload identity when its images are evicted", async t => {
  const h = harness(t);
  const zero = h.createHermesCcImageStore(h.storeRoot, { maxBytes: 0 });
  await zero.save(key(), [png()]);
  assert.equal(await h.store.load(key()), null);
  assert.equal(await h.store.save(key(), [png(9)]), "conflict");
  assert.equal(await h.store.load(key()), null);
  await h.store.save(key(), [png()]);
  assert.equal(await h.store.load(key()), null);
});


test("Hermes CC supports default symlinked ~/.paseo and expands an explicit ~/ home", async t => {
  let home;
  const h = harness(t, { "node:os": { homedir: () => home } }); home = h.root;
  const previous = process.env.PASEO_HOME;
  t.after(() => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; });
  const real = join(h.root, "real-home"); fs.mkdirSync(real);
  fs.symlinkSync(real, join(h.root, ".paseo"));
  delete process.env.PASEO_HOME;
  assert.equal(h.hermesCcPaseoHome(), real);
  const root = h.hermesCcImageRoot({});
  await h.createHermesCcImageStore(root, { trustedRoot: real }).save(key(), [png()]);
  assert.deepEqual((await h.createHermesCcImageStore(root, { trustedRoot: real }).load(key()))[0].bytes, png().data);
  process.env.PASEO_HOME = "~/.paseo";
  assert.equal(h.hermesCcPaseoHome(), real);
});
