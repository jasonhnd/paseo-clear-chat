const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");
const { Image, Frame, GIF } = require("imagescript");

// Load the real server TypeScript, while collecting its daemon debug output.
function harness() {
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
    const localRequire = id => id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : realRequire(id);
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
const resolver = find => ({ matches: provider => provider === "sample", find });
const picture = (id, bytes, mime = "image/png") => ({ id, mime, readBytes: async () => bytes });
const context = (snapshot = { provider: "sample", cwd: ".", persistence: { provider: "sample", sessionId: "session-1", nativeHandle: "native-1" } }) => ({
  paseo: { agents: { ref: id => {
    assert.equal(id, input.agentId);
    return { refresh: async () => ({ agent: snapshot }), current: () => snapshot };
  } } },
});
const png = (width = 4, height = 2) => new Image(width, height).fill(0x4488ccff).encode().then(Buffer.from);

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

test("thumbnail dimensions preserve aspect ratio, stay within 512px and never upscale", async () => {
  const h = harness();
  for (const [width, height, expected] of [[1024, 256, [512, 128]], [256, 1024, [128, 512]], [4, 2, [4, 2]]]) {
    const bytes = await png(width, height);
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("sample", bytes)])] });
    const result = await handlers.images(input, context());
    assert.equal(result.images.length, 1);
    const image = result.images[0];
    assert.deepEqual([image.width, image.height], expected);
    assert.equal(image.mime, "image/png");
    const decoded = await Image.decode(Buffer.from(image.thumbDataUri.split(",")[1], "base64"));
    assert.deepEqual([decoded.width, decoded.height], expected);
  }
});

test("JPEG, WebP and animated GIF thumbnails are PNGs while full images retain their original bytes", async () => {
  const h = harness();
  const source = new Image(4, 2).fill(0x4488ccff);
  const gif = new GIF([Frame.from(source, 100), Frame.from(source.clone(), 100)]);
  for (const [mime, bytes] of [
    ["image/jpeg", Buffer.from(await source.encodeJPEG())],
    ["image/webp", Buffer.from(await source.encodeWebP())],
    ["image/gif", Buffer.from(await gif.encode())],
  ]) {
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("sample", bytes, mime)])] });
    const result = await handlers.images(input, context());
    assert.equal(result.images[0].mime, "image/png");
    assert.match(result.images[0].thumbDataUri, /^data:image\/png;base64,/);
    const full = await handlers.image({ ...input, id: "sample" }, context());
    assert.equal(full.error, null);
    assert.equal(full.mime, mime);
    assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), bytes);
  }
});

test("oversized images are skipped but retained in total, and later thumbnails fill the cap", async () => {
  const h = harness();
  const bytes = await png();
  const oversized = Buffer.alloc(h.MAX_IMAGE_BYTES + 1);
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [
    picture("too-large", oversized), picture("one", bytes), picture("two", bytes), picture("three", bytes),
  ])] });
  const result = await handlers.images(input, context());
  assert.equal(result.total, 4);
  assert.deepEqual(result.images.map(image => image.id), ["one", "two", "three"]);
  assert.equal(result.reason, "image_too_large");
  assert.deepEqual(await handlers.image({ ...input, id: "too-large" }, context()), emptyFull("image_too_large"));
  assert.equal(h.logs.length, 2);
});

test("the raw size cap includes its boundary; full image IDs are resolved within the message", async () => {
  const h = harness();
  const bytes = await png(1024, 256);
  const atCap = Buffer.concat([bytes, Buffer.alloc(h.MAX_IMAGE_BYTES - bytes.length)]);
  const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async ctx => ctx.messageId === input.messageId ? [picture("one", atCap)] : [])] });
  const result = await handlers.image({ ...input, id: "one" }, context());
  h.promptImageRpc.output.parse(result);
  assert.equal(result.error, null);
  assert.equal(result.bytes, h.MAX_IMAGE_BYTES);
  assert.deepEqual([result.width, result.height], [1024, 256]);
  assert.deepEqual(await handlers.image({ ...input, messageId: "other", id: "one" }, context()), emptyFull("not_found"));
  assert.deepEqual(await handlers.image({ ...input, id: "../secret.png" }, context()), emptyFull("not_found"));
});

test("invalid data and MIME mismatches return only a short error code", async () => {
  const h = harness();
  for (const [bytes, mime] of [[Buffer.from("invalid"), "image/png"], [await png(), "image/jpeg"]]) {
    const handlers = h.createPromptImageHandlers({ resolvers: [resolver(async () => [picture("bad", bytes, mime)])] });
    assert.deepEqual(await handlers.images(input, context()), empty("invalid_image"));
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
      find: phase === "resolver" ? fail : async () => [{ id: "one", mime: "image/png", readBytes: fail }],
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

test("safeLocalImagePath allows regular bounded image files and canonical allowed roots", async t => {
  const h = harness();
  const root = fixture(t);
  const allowed = join(root, "allowed");
  fs.mkdirSync(allowed);
  fs.symlinkSync(allowed, join(root, "root-link"));
  for (const extension of ["png", "jpg", "jpeg", "webp", "gif", "PNG"]) {
    const path = join(allowed, `image.${extension}`);
    fs.writeFileSync(path, "image");
    assert.equal(await h.safeLocalImagePath(path, [join(root, "root-link")]), path);
  }
  const max = join(allowed, "at-cap.png");
  fs.writeFileSync(max, Buffer.alloc(h.MAX_IMAGE_BYTES));
  assert.equal(await h.safeLocalImagePath(max, [allowed]), max);
});

test("safeLocalImagePath rejects traversal, symlink escapes, prefix siblings, invalid extensions and missing/nonregular/oversized files", async t => {
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
  ]) assert.equal(await h.safeLocalImagePath(path, [allowed]), null, path);
  assert.equal(await h.safeLocalImagePath(join(allowed, "valid.png"), []), null);
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

test("openSqliteReadOnly refuses live WAL data rather than reading a stale immutable snapshot", async t => {
  const h = harness();
  const root = fixture(t);
  const path = join(root, "live.sqlite");
  const source = new DatabaseSync(path);
  try {
    source.exec("PRAGMA journal_mode = WAL; CREATE TABLE images (id TEXT); INSERT INTO images VALUES ('one')");
    const before = fs.readdirSync(root).sort().map(name => [name, fs.readFileSync(join(root, name))]);
    await assert.rejects(h.openSqliteReadOnly(path), /sqlite_wal_unsupported/);
    assert.deepEqual(fs.readdirSync(root).sort().map(name => [name, fs.readFileSync(join(root, name))]), before);
  } finally { source.close(); }
});
