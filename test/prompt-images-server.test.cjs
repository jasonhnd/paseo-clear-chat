const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

// Load the real server TypeScript, while collecting its daemon debug output.
function harness(overrides = {}) {
  const cache = new Map();
  const logs = [];
  function load(relative) {
    const filename = resolve(__dirname, "..", relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    const localRequire = id => id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : (overrides[id] ?? realRequire(id));
    runInThisContext(`(function(require,module,exports,console){${compiled}\n})`, { filename })(
      localRequire, mod, mod.exports, { debug: (...args) => logs.push(args) },
    );
    return mod.exports;
  }
  const registry = load("server/prompt-images/registry.ts");
  const helpers = load("server/prompt-images/read-only.ts");
  const contracts = load("shared/prompt-images-rpc.ts");
  return { ...registry, ...helpers, ...contracts, logs, load };
}

function fixture(t) {
  const base = resolve(__dirname, "..", ".tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(join(base, "prompt-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const input = { agentId: "sample-agent", messageId: "message-1", clientMessageId: "client-1", text: "Look at this." };
const empty = reason => ({ images: [], total: 0, reason });
const emptyFull = error => ({ dataUri: null, mime: null, width: null, height: null, bytes: null, error });
const resolver = find => ({ matches: provider => provider === "sample", async find(ctx) {
  const result = await find(ctx);
  return Array.isArray(result) ? { matchedMessages: 1, images: result } : result;
} });
const picture = (id, bytes, mime = "image/png") => ({ id, mime, readBytes: async () => bytes });
const context = (snapshot = { provider: "sample", cwd: ".", persistence: { provider: "sample", sessionId: "session-1", nativeHandle: "native-1" } }) => ({
  paseo: { agents: { ref: id => {
    assert.equal(id, input.agentId);
    return { refresh: async () => ({ agent: snapshot }), current: () => snapshot };
  } } },
});
function png(width = 4, height = 2) {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
function jpeg(width = 4, height = 2) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x11, 0x00]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}
function gif(width = 4, height = 2) {
  const bytes = Buffer.alloc(23);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[13] = 0x2c;
  bytes.writeUInt16LE(width, 18);
  bytes.writeUInt16LE(height, 20);
  return bytes;
}
function webp(width = 4, height = 2) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(Math.max(0, width - 1), 24, 3);
  bytes.writeUIntLE(Math.max(0, height - 1), 27, 3);
  return bytes;
}
function webpLossless(width = 8, height = 3) {
  const bytes = Buffer.alloc(25);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(17, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8L", 12, "latin1");
  bytes.writeUInt32LE(5, 16);
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return bytes;
}

test("prompt RPC contracts keep their exact names, optional nullable IDs and nullable output fields", () => {
  const h = harness();
  assert.equal(h.promptImagesRpc.name, "prompt.images");
  assert.equal(h.promptImageRpc.name, "prompt.image");
  for (const ids of [{}, { messageId: null, clientMessageId: null }, { messageId: "m", clientMessageId: "c" }]) {
    const request = { agentId: "a", text: "", ...ids };
    assert.deepEqual(h.promptImagesRpc.input.parse(request), request);
    assert.deepEqual(h.promptImageRpc.input.parse({ ...request, id: "image-1" }), { ...request, id: "image-1" });
  }
  assert.deepEqual(h.promptImagesRpc.output.parse(empty(null)), empty(null));
  assert.deepEqual(h.promptImageRpc.output.parse(emptyFull(null)), emptyFull(null));
  assert.equal(h.promptImageRpc.input.safeParse(input).success, false);
});

test("the production registry starts empty and unknown providers return no images for both RPCs", async () => {
  const h = harness();
  assert.deepEqual(h.promptImageResolvers, []);
  const handlers = h.createPromptImageHandlers();
  assert.deepEqual(await handlers.images(input, context()), empty("unknown_provider"));
  assert.deepEqual(await handlers.image({ ...input, id: "anything" }, context()), emptyFull("unknown_provider"));
  assert.deepEqual(h.logs, [
    ["[clear-chat] prompt.images: unknown_provider"],
    ["[clear-chat] prompt.image: unknown_provider"],
  ]);
});

test("an unmatched registered resolver never runs", async () => {
  const h = harness();
  const handlers = h.createPromptImageHandlers({ resolvers: [{ matches: () => false, find: () => assert.fail("must not resolve") }] });
  assert.deepEqual(await handlers.images(input, context()), empty("unknown_provider"));
});

test("snapshot refresh and current fallback pass only lookup fields to the matching resolver", async () => {
  const h = harness();
  const snapshot = { provider: "sample", cwd: ".", persistence: { provider: "sample", sessionId: "s", nativeHandle: "n" } };
  for (const target of [snapshot, snapshot.persistence]) {
    for (const field of ["auth", "headers", "authHeaders", "mcpServers", "metadata", "config"]) {
      Object.defineProperty(target, field, { get() { assert.fail(`read forbidden field ${field}`); } });
    }
  }
  let refreshed = false;
  const ctx = { paseo: { agents: { ref(id) {
    assert.equal(id, input.agentId);
    return {
      async refresh() { refreshed = true; return null; },
      current() { assert.equal(refreshed, true); return snapshot; },
    };
  } } } };
  let received;
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async ctx => { received = ctx; return []; })] });
  assert.deepEqual(await handlers.images(input, ctx), empty(null));
  const { signal, ...fields } = received;
  assert.equal(signal.aborted, false);
  assert.deepEqual(fields, { ...input, provider: "sample", cwd: ".", sessionId: "s", nativeHandle: "n" });
  assert.deepEqual(h.logs, []);
});

test("missing persistence and optional IDs stay nullable without inventing handles", async () => {
  const h = harness();
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async ctx => {
    assert.equal(ctx.sessionId, null);
    assert.equal(ctx.nativeHandle, null);
    assert.equal(ctx.messageId, undefined);
    assert.equal(ctx.clientMessageId, undefined);
    return [];
  })] });
  assert.deepEqual(await handlers.images({ agentId: input.agentId, text: "" }, context({ provider: "sample", cwd: ".", persistence: null })), empty(null));
});

test("missing agents and persistence provider mismatches fail closed", async () => {
  const h = harness();
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(() => assert.fail("must not resolve"))] });
  assert.deepEqual(await handlers.images(input, context(null)), empty("agent_not_found"));
  assert.deepEqual(await handlers.images(input, context({ provider: "sample", persistence: { provider: "other" } })), empty("provider_mismatch"));
  assert.equal(h.logs.length, 2);
});

for (const phase of ["snapshot", "resolver", "bytes"]) {
  test(`the deadline covers ${phase} and logs one fixed code`, async () => {
    const h = harness();
    const forever = () => new Promise(() => {});
    let signal;
    const handlers = h.createPromptImageHandlers({ timeoutMs: 20, resolvers: [resolver(async ctx => {
      signal = ctx.signal;
      return phase === "resolver" ? forever() : [{ id: "image-1", mime: "image/png", readBytes: forever }];
    })] });
    const ctx = phase === "snapshot" ? { paseo: { agents: { ref: () => ({ refresh: forever }) } } } : context();
    assert.deepEqual(await handlers.images(input, ctx), empty("timeout"));
    if (signal) assert.equal(signal.aborted, true);
    assert.deepEqual(h.logs, [["[clear-chat] prompt.images: timeout"]]);
  });
}

test("a timed-out resolver cannot start a later image read or produce another log", async () => {
  const h = harness();
  let finish;
  const handlers = h.createPromptImageHandlers({ timeoutMs: 20, resolvers: [resolver(() => new Promise(resolve => { finish = resolve; }))] });
  assert.deepEqual(await handlers.images(input, context()), empty("timeout"));
  finish([{ id: "late", mime: "image/png", readBytes: () => assert.fail("read after timeout") }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.logs.length, 1);
});

test("full-image lookups also time out with nullable fields and one debug line", async () => {
  const h = harness();
  const handlers = h.createPromptImageHandlers({ timeoutMs: 20, resolvers: [resolver(async () => [{
    id: "one", mime: "image/png", readBytes: () => new Promise(() => {}),
  }])] });
  assert.deepEqual(await handlers.image({ ...input, id: "one" }, context()), emptyFull("timeout"));
  assert.deepEqual(h.logs, [["[clear-chat] prompt.image: timeout"]]);
});

test("thumbnail count is capped at three while total includes all found images", async () => {
  const h = harness();
  const bytes = await png();
  const found = Array.from({ length: 5 }, (_, i) => picture(String(i), bytes));
  found[3].readBytes = () => assert.fail("must not read beyond count cap");
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => found)] });
  const result = await handlers.images(input, context());
  h.promptImagesRpc.output.parse(result);
  assert.equal(result.total, 5);
  assert.deepEqual(result.images.map(image => image.id), ["0", "1", "2"]);
  assert.equal(result.reason, null);
  assert.deepEqual(h.logs, []);
});

test("small originals are inlined with their header dimensions, mime and bytes", async () => {
  const h = harness();
  const lossyWebp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  for (const [mime, bytes, width, height] of [
    ["image/png", png(1024, 256), 1024, 256],
    ["image/jpeg", jpeg(256, 1024), 256, 1024],
    ["image/gif", gif(4, 2), 4, 2],
    ["image/webp", webp(8, 3), 8, 3],
    ["image/webp", webpLossless(8, 3), 8, 3],
    ["image/webp", lossyWebp, 1, 1],
  ]) {
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("sample", bytes, mime)])] });
    const result = await handlers.images(input, context());
    assert.equal(result.reason, null, mime);
    assert.equal(result.images.length, 1, mime);
    const image = result.images[0];
    assert.equal(image.mime, mime);
    assert.deepEqual([image.width, image.height], [width, height]);
    assert.match(image.thumbDataUri, new RegExp(`^data:${mime};base64,`));
    assert.deepEqual(Buffer.from(image.thumbDataUri.split(",")[1], "base64"), bytes);
    const full = await handlers.image({ ...input, id: "sample" }, context());
    assert.equal(full.error, null);
    assert.equal(full.mime, mime);
    assert.equal(full.bytes, bytes.length);
    assert.deepEqual([full.width, full.height], [width, height]);
    assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), bytes);
  }
});

test("images over the inline cap are skipped with no error while later images fill the cap and total still counts them", async () => {
  const h = harness();
  const bytes = png();
  const oversized = Buffer.alloc(h.MAX_INLINE_IMAGE_BYTES + 1);
  const found = [
    picture("too-large", oversized), picture("one", bytes), picture("two", bytes), picture("three", bytes), picture("four", bytes),
  ];
  found[4].readBytes = () => assert.fail("must not read beyond the thumbnail cap");
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => found)] });
  const result = await handlers.images(input, context());
  assert.equal(result.total, 5);
  assert.deepEqual(result.images.map(image => image.id), ["one", "two", "three"]);
  assert.equal(result.reason, null);
  assert.deepEqual(h.logs, []);
  assert.deepEqual(await handlers.image({ ...input, id: "too-large" }, context()), emptyFull("image_too_large"));
  assert.deepEqual(h.logs, [["[clear-chat] prompt.image: image_too_large"]]);
});

test("the inline cap includes its boundary and one extra byte is refused; full image IDs stay within the message", async () => {
  const h = harness();
  assert.equal(h.MAX_INLINE_IMAGE_BYTES, 1_572_864);
  const atCap = Buffer.concat([png(1024, 256), Buffer.alloc(h.MAX_INLINE_IMAGE_BYTES - 24)]);
  const over = Buffer.concat([atCap, Buffer.from([1])]);
  assert.equal(atCap.length, h.MAX_INLINE_IMAGE_BYTES);
  assert.equal(over.length, h.MAX_INLINE_IMAGE_BYTES + 1);
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async ctx => ctx.messageId === input.messageId ? [picture("one", atCap), picture("over", over)] : [])] });
  const listed = await handlers.images(input, context());
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.images.map(image => image.id), ["one"]);
  assert.equal(listed.reason, null);
  assert.equal(listed.images[0].mime, "image/png");
  assert.deepEqual([listed.images[0].width, listed.images[0].height], [1024, 256]);
  assert.equal(Buffer.from(listed.images[0].thumbDataUri.split(",")[1], "base64").length, h.MAX_INLINE_IMAGE_BYTES);
  const result = await handlers.image({ ...input, id: "one" }, context());
  h.promptImageRpc.output.parse(result);
  assert.equal(result.error, null);
  assert.equal(result.bytes, h.MAX_INLINE_IMAGE_BYTES);
  assert.deepEqual([result.width, result.height], [1024, 256]);
  assert.deepEqual(Buffer.from(result.dataUri.split(",")[1], "base64"), atCap);
  assert.deepEqual(await handlers.image({ ...input, id: "over" }, context()), emptyFull("image_too_large"));
  assert.deepEqual(await handlers.image({ ...input, messageId: "other", id: "one" }, context()), emptyFull("not_found"));
  assert.deepEqual(await handlers.image({ ...input, id: "../secret.png" }, context()), emptyFull("not_found"));
});

test("invalid data and MIME mismatches return only a short error code", async () => {
  const h = harness();
  for (const [bytes, mime] of [[Buffer.from("invalid"), "image/png"], [await png(), "image/jpeg"]]) {
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("bad", bytes, mime)])] });
    assert.deepEqual(await handlers.images(input, context()), { images: [], total: 1, reason: "invalid_image" });
    assert.deepEqual(await handlers.image({ ...input, id: "bad" }, context()), emptyFull("invalid_image"));
  }
});

test("snapshot, matcher, resolver and read exceptions never leak auth, headers, inputs or stack traces", async () => {
  const h = harness();
  const secret = "Authorization: Bearer sample-private-token; headers mcpServers private-path";
  const fail = () => { throw new Error(secret); };
  for (const phase of ["snapshot", "matcher", "resolver", "bytes"]) {
    const handlers = h.createPromptImageHandlers({ resolvers: [{
      matches: phase === "matcher" ? fail : () => true,
      find: phase === "resolver" ? fail : async () => ({ matchedMessages: 1, images: [{ id: "one", mime: "image/png", readBytes: fail }] }),
    }] });
    const ctx = phase === "snapshot" ? { paseo: { agents: { ref: () => ({ refresh: fail }) } } } : context();
    assert.deepEqual(await handlers.images({ ...input, text: secret }, ctx), empty("lookup_failed"));
    assert.deepEqual(await handlers.image({ ...input, text: secret, id: "one" }, ctx), emptyFull("lookup_failed"));
  }
  assert.equal(h.logs.length, 8);
  for (const args of h.logs) {
    assert.equal(args.length, 1);
    assert.match(args[0], /^\[clear-chat\] prompt\.images?: (lookup_failed|not_found)$/);
    assert.doesNotMatch(args[0], /Authorization|Bearer|token|headers|mcpServers|private-path|Error/);
  }
});

test("readLocalImageReadOnly allows regular bounded image files and canonical allowed roots", async t => {
  const h = harness();
  const root = fixture(t);
  const allowed = join(root, "allowed");
  fs.mkdirSync(allowed);
  fs.symlinkSync(allowed, join(root, "root-link"));
  for (const extension of ["png", "jpg", "jpeg", "webp", "gif", "PNG"]) {
    const path = join(allowed, `image.${extension}`);
    fs.writeFileSync(path, "image");
    assert.deepEqual(await h.readLocalImageReadOnly(path, [join(root, "root-link")]), Buffer.from("image"));
  }
  const max = join(allowed, "at-cap.png");
  fs.writeFileSync(max, Buffer.alloc(h.MAX_IMAGE_BYTES));
  assert.deepEqual(await h.readLocalImageReadOnly(max, [allowed]), Buffer.alloc(h.MAX_IMAGE_BYTES));
});

test("readLocalImageReadOnly rejects traversal, symlink escapes, prefix siblings, invalid extensions and missing/nonregular/oversized files", async t => {
  const h = harness();
  const root = fixture(t);
  const allowed = join(root, "allowed");
  const sibling = join(root, "allowed-other");
  fs.mkdirSync(allowed);
  fs.mkdirSync(sibling);
  fs.writeFileSync(join(root, "outside.png"), "image");
  fs.writeFileSync(join(sibling, "outside.png"), "image");
  fs.writeFileSync(join(allowed, "valid.png"), "image");
  fs.writeFileSync(join(allowed, "wrong.svg"), "image");
  fs.symlinkSync(join(root, "outside.png"), join(allowed, "escape.png"));
  fs.symlinkSync(join(allowed, "wrong.svg"), join(allowed, "disguised.png"));
  fs.mkdirSync(join(allowed, "directory.png"));
  fs.writeFileSync(join(allowed, "large.png"), Buffer.alloc(h.MAX_IMAGE_BYTES + 1));
  for (const path of [
    `${allowed}/../outside.png`, `${allowed}/nested/../valid.png`, join(allowed, "escape.png"),
    join(allowed, "disguised.png"), join(sibling, "outside.png"), join(allowed, "wrong.svg"),
    join(allowed, "missing.png"), join(allowed, "directory.png"), join(allowed, "large.png"),
  ]) assert.equal(await h.readLocalImageReadOnly(path, [allowed]), null, path);
  assert.equal(await h.readLocalImageReadOnly(join(allowed, "valid.png"), []), null);
});

test("readJsonlReadOnly streams valid records around bad lines without changing the file", async t => {
  const h = harness();
  const root = fixture(t);
  const path = join(root, "records.jsonl");
  const original = '{"one":1}\r\ninvalid\n\n{"two":2}\n{"partial":';
  fs.writeFileSync(path, original);
  const records = [];
  for await (const record of h.readJsonlReadOnly(path)) records.push(record);
  assert.deepEqual(records, [{ one: 1 }, { two: 2 }]);
  assert.equal(fs.readFileSync(path, "utf8"), original);
  for await (const record of h.readJsonlReadOnly(path)) { assert.deepEqual(record, { one: 1 }); break; }
  await assert.rejects(async () => { for await (const _ of h.readJsonlReadOnly(join(root, "missing"))) {} }, /ENOENT/);
});

test("openSqliteReadOnly uses an escaped file URI and rejects writes without creating sidecars", async t => {
  const h = harness();
  const root = fixture(t);
  const path = join(root, "records #?.sqlite");
  const source = new DatabaseSync(path);
  source.exec("CREATE TABLE images (id TEXT); INSERT INTO images VALUES ('one')");
  source.close();
  const before = fs.readFileSync(path);
  const database = await h.openSqliteReadOnly(path);
  try {
    assert.equal(database.prepare("SELECT id FROM images").get().id, "one");
    assert.throws(() => database.exec("INSERT INTO images VALUES ('two')"), /readonly/);
    assert.throws(() => database.prepare("DELETE FROM images").run(), /readonly/);
    database.exec("PRAGMA query_only = OFF");
    assert.throws(() => database.exec("CREATE TABLE forbidden (id TEXT)"), /readonly/);
  } finally { database.close(); }
  assert.deepEqual(fs.readFileSync(path), before);
  assert.deepEqual(fs.readdirSync(root), ["records #?.sqlite"]);
  const missing = join(root, "missing.sqlite");
  await assert.rejects(h.openSqliteReadOnly(missing), /ENOENT/);
  assert.equal(fs.existsSync(missing), false);
});

test("openSqliteReadOnly sees live WAL commits while refusing writes and preserving main/WAL bytes", async t => {
  const h = harness();
  const root = fixture(t);
  const path = join(root, "live.sqlite");
  const source = new DatabaseSync(path);
  try {
    source.exec("PRAGMA journal_mode = WAL; CREATE TABLE images (id TEXT); PRAGMA wal_checkpoint(TRUNCATE)");
    const mainBeforeCommit = fs.readFileSync(path);
    source.exec("INSERT INTO images VALUES ('wal-only')");
    assert.deepEqual(fs.readFileSync(path), mainBeforeCommit);
    const main = fs.readFileSync(path), wal = fs.readFileSync(`${path}-wal`);
    assert.ok(wal.length > 0);
    const database = await h.openSqliteReadOnly(path);
    try {
      assert.equal(database.prepare("PRAGMA query_only").get().query_only, 1);
      assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 250);
      assert.equal(database.prepare("SELECT id FROM images").get().id, "wal-only");
      database.exec("PRAGMA query_only = OFF");
      assert.throws(() => database.exec("INSERT INTO images VALUES ('forbidden')"), /readonly/);
    } finally { database.close(); }
    assert.deepEqual(fs.readFileSync(path), main);
    assert.deepEqual(fs.readFileSync(`${path}-wal`), wal);
    assert.ok(fs.readdirSync(root).every(name => ["live.sqlite", "live.sqlite-wal", "live.sqlite-shm"].includes(name)));
  } finally { source.close(); }
});

test("both RPCs require exactly one matched message, including text fallback when IDs were supplied", async () => {
  const h = harness();
  const unread = { id: "one", mime: "image/png", readBytes: () => assert.fail("ambiguous or unmatched bytes must not be read") };
  for (const request of [input, { agentId: input.agentId, text: input.text }]) {
    for (const [matchedMessages, reason] of [[0, "no_match"], [2, "ambiguous"], [3, "ambiguous"]]) {
      const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => ({ matchedMessages, images: [unread] }))] });
      assert.deepEqual(await handlers.images(request, context()), empty(reason));
      assert.deepEqual(await handlers.image({ ...request, id: "one" }, context()), emptyFull(reason));
    }
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => ({ matchedMessages: 1, images: [picture("one", await png())] }))] });
    assert.equal((await handlers.images(request, context())).images.length, 1);
    assert.equal((await handlers.image({ ...request, id: "one" }, context())).error, null);
  }
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => ({ matchedMessages: 1, images: [] }))] });
  assert.deepEqual(await handlers.images(input, context()), empty(null));
});

test("headers above 24 megapixels are refused and an exact 24 megapixel header is inlined", async () => {
  const h = harness();
  assert.equal(6000 * 4000, 24_000_000);
  for (const [mime, exact, over] of [
    ["image/png", png(6000, 4000), png(6000, 4001)],
    ["image/jpeg", jpeg(6000, 4000), jpeg(6000, 4001)],
    ["image/gif", gif(6000, 4000), gif(6000, 4001)],
    ["image/webp", webp(6000, 4000), webp(6000, 4001)],
  ]) {
    const allowed = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("exact", exact, mime)])] });
    const shown = await allowed.images(input, context());
    assert.equal(shown.reason, null, mime);
    assert.deepEqual([shown.images[0].width, shown.images[0].height], [6000, 4000], mime);
    const refused = h.createPromptImageHandlers({ resolvers: [resolver(async () => [
      picture("one", png()), picture("over", over, mime), picture("two", png()),
    ])] });
    const result = await refused.images(input, context());
    assert.equal(result.total, 3, mime);
    assert.equal(result.reason, "image_too_large", mime);
    assert.deepEqual(result.images.map(image => image.id), ["one", "two"], mime);
    assert.deepEqual(await refused.image({ ...input, id: "over" }, context()), emptyFull("image_too_large"));
  }
});

test("a valid header with a truncated payload is inlined, and an invalid image keeps earlier results", async () => {
  const h = harness();
  const bytes = png();
  const truncated = bytes.subarray(0, 24);
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [
    picture("one", bytes), picture("truncated", truncated), picture("bad", Buffer.from("nope")),
  ])] });
  const result = await handlers.images(input, context());
  assert.equal(result.total, 3);
  assert.equal(result.reason, "invalid_image");
  assert.deepEqual(result.images.map(image => image.id), ["one", "truncated"]);
  assert.deepEqual(Buffer.from(result.images[1].thumbDataUri.split(",")[1], "base64"), truncated);
});

test("unsupported formats and invalid dimensions are refused from the header", async () => {
  const h = harness();
  const zeroPng = png(); zeroPng.writeUInt32BE(0, 16);
  const hugeGif = gif(6000, 4001);
  const badFrameGif = Buffer.from(hugeGif); badFrameGif.writeUInt16LE(65535, 18);
  const truncatedWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  for (const [mime, bytes, reason] of [
    ["image/png", zeroPng, "invalid_image"],
    ["image/gif", badFrameGif, "invalid_image"],
    ["image/webp", truncatedWebp, "invalid_image"],
    ["image/tiff", Buffer.from([73, 73, 42, 0, 0, 0, 0, 0]), "invalid_image"],
    ["image/png", Buffer.from("invalid"), "invalid_image"],
  ]) {
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("one", bytes, mime)])] });
    assert.deepEqual(await handlers.images(input, context()), { images: [], total: 1, reason }, mime);
    assert.deepEqual(await handlers.image({ ...input, id: "one" }, context()), emptyFull(reason));
  }
});

test("lookups run with no imagescript dependency", async () => {
  const pkg = require("../package.json");
  assert.equal(pkg.dependencies.imagescript, undefined);
  assert.equal(pkg.devDependencies.imagescript, undefined);
  assert.throws(() => require.resolve("imagescript"), /Cannot find module 'imagescript'/);
  const source = fs.readFileSync(resolve(__dirname, "../server/prompt-images/registry.ts"), "utf8");
  assert.doesNotMatch(source, /imagescript/);
  const h = harness();
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("one", png())])] });
  const result = await handlers.images(input, context());
  assert.equal(result.reason, null);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, "image/png");
  assert.deepEqual(Buffer.from(result.images[0].thumbDataUri.split(",")[1], "base64"), png());
});

test("local file candidates use the descriptor reader for thumbnails and originals", async t => {
  const h = harness();
  const root = fixture(t);
  const path = join(root, "local.png");
  const bytes = await png();
  fs.writeFileSync(path, bytes);
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [h.localFileImage("provider-id", "image/png", path, [root])])] });
  assert.equal((await handlers.images(input, context())).images[0].id, "provider-id");
  const full = await handlers.image({ ...input, id: "provider-id" }, context());
  assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), bytes);
  fs.unlinkSync(path);
  fs.symlinkSync(join(root, "outside.png"), path);
  assert.deepEqual(await handlers.image({ ...input, id: "provider-id" }, context()), emptyFull("invalid_image"));
});

test("descriptor validation rejects a file replaced after open and always closes it", async t => {
  const root = fixture(t);
  const allowed = join(root, "allowed"); fs.mkdirSync(allowed);
  const path = join(allowed, "local.png"); fs.writeFileSync(path, "original");
  let closed = false;
  const promises = require("node:fs/promises");
  const h = harness({ "node:fs/promises": { ...promises, async open(...args) {
    const file = await promises.open(...args);
    const close = file.close.bind(file);
    file.close = async () => { closed = true; await close(); };
    file.read = () => assert.fail("must reject changed identity before reading");
    fs.renameSync(path, join(root, "moved.png"));
    fs.writeFileSync(path, "substitute");
    return file;
  } } });
  assert.equal(await h.readLocalImageReadOnly(path, [allowed]), null);
  assert.equal(closed, true);
});

test("descriptor reads stay bounded when a file grows after fstat", async t => {
  const root = fixture(t);
  const path = join(root, "local.png"); fs.writeFileSync(path, "original");
  const promises = require("node:fs/promises");
  let readLimit = 0, closed = false;
  const h = harness({ "node:fs/promises": { ...promises, async open(...args) {
    const file = await promises.open(...args);
    const read = file.read.bind(file), close = file.close.bind(file);
    file.read = async (buffer, offset, length, position) => {
      readLimit += length;
      fs.appendFileSync(path, Buffer.alloc(1024));
      return read(buffer, offset, length, position);
    };
    file.close = async () => { closed = true; await close(); };
    return file;
  } } });
  assert.equal(await h.readLocalImageReadOnly(path, [root]), null);
  assert.equal(readLimit, 9);
  assert.equal(closed, true);
});

test("JSONL skips oversized valid lines, resumes at the next record and handles the exact cap", async t => {
  const h = harness();
  const root = fixture(t);
  const path = join(root, "bounded.jsonl");
  const file = fs.openSync(path, "w");
  try {
    fs.writeSync(file, '{"before":1}\n"');
    const block = Buffer.alloc(1024 * 1024, 0x61);
    let remaining = h.MAX_JSONL_LINE_BYTES + 100;
    while (remaining) { const length = Math.min(remaining, block.length); fs.writeSync(file, block, 0, length); remaining -= length; }
    fs.writeSync(file, '"\r\n{"after":"🎉"}\n');
    fs.writeSync(file, Buffer.concat([Buffer.from('"'), Buffer.alloc(h.MAX_JSONL_LINE_BYTES - 2, 0x62), Buffer.from('"\n')]));
    fs.writeSync(file, '"');
    remaining = h.MAX_JSONL_LINE_BYTES + 100;
    while (remaining) { const length = Math.min(remaining, block.length); fs.writeSync(file, block, 0, length); remaining -= length; }
    fs.writeSync(file, '"'); // Oversized EOF line, without newline.
  } finally { fs.closeSync(file); }
  const records = [];
  for await (const record of h.readJsonlReadOnly(path)) records.push(record);
  assert.equal(records.length, 3);
  assert.deepEqual(records.slice(0, 2), [{ before: 1 }, { after: "🎉" }]);
  assert.equal(records[2].length, h.MAX_JSONL_LINE_BYTES - 2);
});
