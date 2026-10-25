const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

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
// Hermes d05095663342: gateway/run_inbound.py::_enrich_message_with_vision.
const block = path => `[The user sent an image~ Here's what I can see:\nA synthetic blue square.]\n[If you need a closer look, use vision_analyze with image_url: ${path} ~]`;
const annotated = (paths, text = "Synthetic question") => paths.map(block).join("\n\n") + (text ? `\n\n${text}` : "");
// agent/image_routing.py::build_native_content_parts, projected by
// agent/session_persistence.py::_durable_content (as consumed by image_replay.py).
const nativeAnnotated = (paths, text = "Synthetic question", durable = true) =>
  `${text.trim() || "What do you see in this image?"}\n\n${paths.map(path => `[Image attached at: ${path}]`).join("\n")}` +
  (durable ? "\n[screenshot]".repeat(paths.length) : "");
const empty = matchedMessages => ({ matchedMessages, images: [] });

async function fixture(t, relativeHome = ".hermes") {
  const root = fs.mkdtempSync(join(tmpdir(), "hermes-images-"));
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
  // Synthetic headers suffice because the server reads originals without decoding.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00]);
  const h = harness();
  const resolver = h.createHermesPromptImageResolver({ userHome: root, paseoHome });
  const context = overrides => ({ agentId: "fake-agent", provider: "custom-provider", cwd: root,
    sessionId: "session-one", nativeHandle: "unused-handle", text: "Synthetic question",
    messageId: "paseo-message", clientMessageId: "paseo-client",
    signal: new AbortController().signal, providerCommand: ["hermes", "acp"], providerEnv: { HERMES_HOME: home }, ...overrides });
  let nextImage = 0;
  function retainedImage(name, bytes = png, digest = createHash("sha256").update(bytes).digest("hex")) {
    const path = join(home, "cache", "documents", "native-inputs", digest, name);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, bytes);
    return path;
  }
  function image(kind = "native", bytes = png) {
    const name = (++nextImage).toString(16).padStart(12, "0");
    const path = kind === "native"
      ? join(home, "cache", "documents", "native-inputs", createHash("sha256").update(bytes).digest("hex"), `img_${name}.png`)
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
  return { root, home, paseoHome, path, writer, png, jpg, h, resolver, context, image, retainedImage, add, config, find };
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

for (const count of [1, 3]) {
  for (const durable of [false, true]) {
    test(`Hermes reads ${count} native hints in ${durable ? "persisted" : "combined"} content as one message`, async t => {
      const f = await fixture(t), paths = Array.from({ length: count }, () => f.image());
      const content = nativeAnnotated(paths, "Synthetic question", durable);
      f.add(content);
      for (const text of ["Synthetic question", content]) {
        const found = await f.find({ text });
        assert.equal(found.matchedMessages, 1);
        assert.equal(found.images.length, count);
      }
    });
  }
}

test("Hermes native image-only prompts use the exact default caption and detail markers", async t => {
  const f = await fixture(t);
  const content = nativeAnnotated([f.image()], "").replace("[screenshot]", "[screenshot detail=low]");
  f.add(content, { platformId: ID });
  assert.equal((await f.find({ text: "What do you see in this image?" })).images.length, 1);
  assert.equal((await f.find({ messageId: ID, text: "" })).images.length, 1);
});

test("Hermes rejects the exact vision failure notes even beside a successful image", async t => {
  const f = await fixture(t), path = f.image();
  const failures = [
    `[The user sent an image but I couldn't quite see it this time (>_<) You can try looking at it yourself with vision_analyze using image_url: ${path}]`,
    `[The user sent an image but something went wrong when I tried to look at it~ You can try examining it yourself with vision_analyze using image_url: ${path}]`,
  ];
  for (const failure of failures) {
    for (const notes of [[failure], [block(path), failure], [failure, block(path)]]) {
      f.writer.exec("DELETE FROM messages");
      f.add(`${notes.join("\n\n")}\n\nSynthetic question`, { platformId: ID });
      assert.deepEqual(await f.find({ messageId: ID }), empty(1));
    }
  }
});

test("Hermes counts a vision failure note so the same caption on a later row stays ambiguous", async t => {
  const f = await fixture(t), path = f.image();
  // gateway/run_inbound.py::_enrich_message_with_vision failure branches, then "\\n\\n" + user text.
  const failures = [
    `[The user sent an image but I couldn't quite see it this time (>_<) You can try looking at it yourself with vision_analyze using image_url: ${path}]`,
    `[The user sent an image but something went wrong when I tried to look at it~ You can try examining it yourself with vision_analyze using image_url: ${path}]`,
  ];
  for (const failure of failures) {
    f.writer.exec("DELETE FROM messages");
    f.add(`${failure}\n\nSynthetic question`);
    assert.deepEqual(await f.find(), empty(1));
    f.add(annotated([f.image("jpg", f.jpg)]));
    assert.deepEqual(await f.find(), empty(2));
  }
});

test("Hermes counts an unparsed image row so the same caption on a later row stays ambiguous", async t => {
  const f = await fixture(t), path = f.image();
  // Two markers and one hint: image_replay refuses the row, and it still occupies the caption.
  f.add(`[screenshot]\n[screenshot]\nSynthetic question\n\n[Image attached at: ${path}]`);
  assert.deepEqual(await f.find(), empty(1));
  f.add(annotated([f.image("jpg", f.jpg)]));
  assert.deepEqual(await f.find(), empty(2));
});

test("Hermes reads an image-first durable row as its own images and will not lend them to another row", async t => {
  const f = await fixture(t);
  const first = f.image(), second = f.image("jpg", f.jpg);
  // session_persistence._durable_content of an API part list that puts both images before the text
  // (image_replay._split_rebuilt_row, "image-first"): markers, caption, blank line, hints.
  const content = `[screenshot]\n[screenshot]\nSynthetic question\n\n[Image attached at: ${first}]\n[Image attached at: ${second}]`;
  f.add(content);
  const alone = await f.find();
  assert.equal(alone.matchedMessages, 1);
  assert.deepEqual(alone.images.map(image => image.mime), ["image/png", "image/jpeg"]);
  assert.deepEqual(await alone.images[0].readBytes(), f.png);
  assert.deepEqual(await alone.images[1].readBytes(), f.jpg);
  f.add(annotated([f.image()]));
  assert.deepEqual(await f.find(), empty(2));
});

test("Hermes rejects ambiguous or incomplete image annotations", async t => {
  const f = await fixture(t), path = f.image();
  for (const content of [
    block(path).replace(`image_url: ${path}`, "image_url: "),
    block(path).replace(`image_url: ${path}`, `image_url: ${path}\nimage_url: ${path}`),
    block(path).replace(`image_url: ${path}`, `image_url: ${path} ${path}`),
    block(path).replace(" ~]", "]"),
    block(path).replace("see:\n", "see: "),
    nativeAnnotated([path]).replace("[screenshot]", "[screenshot]\n[screenshot]"),
    nativeAnnotated([path]).replace(`[Image attached at: ${path}]`, `[Image attached at: ${path}\n${path}]`),
    nativeAnnotated([path]).replace(`[Image attached at: ${path}]`, "[Image attached: https://example.test/image.png]"),
  ]) {
    f.writer.exec("DELETE FROM messages");
    f.add(content, { platformId: ID });
    assert.deepEqual(await f.find({ messageId: ID }), empty(1));
  }
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
  assert.equal(await found.images[0].readBytes(), null);
});

test("Hermes works when only one of the two cache roots exists", async t => {
  const f = await fixture(t);
  f.add(annotated([f.image("png")]));
  assert.equal((await f.find()).images.length, 1);
});

test("Hermes accepts retained original basenames and the actual API names in all four formats", async t => {
  const f = await fixture(t);
  const gif = Buffer.alloc(23);
  gif.write("GIF89a"); gif.writeUInt16LE(2, 6); gif.writeUInt16LE(2, 8);
  gif[13] = 0x2c; gif.writeUInt16LE(2, 18); gif.writeUInt16LE(2, 20);
  const webp = Buffer.alloc(30);
  webp.write("RIFF"); webp.writeUInt32LE(22, 4); webp.write("WEBP", 8);
  webp.write("VP8X", 12); webp.writeUInt32LE(10, 16); webp.writeUIntLE(1, 24, 3); webp.writeUIntLE(1, 27, 3);
  const paths = [f.retainedImage("Holiday photo 01.png"), f.retainedImage("original.jpeg", f.jpg)];
  const mimes = ["image/png", "image/jpeg"];
  // gateway/session_api_media.py::commit_api_images, then capture_native_media.
  for (const [ext, bytes, mime] of [["png", f.png, "image/png"], ["jpg", f.jpg, "image/jpeg"], ["gif", gif, "image/gif"], ["webp", webp, "image/webp"]]) {
    const name = `api_${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
    const retained = f.retainedImage(name, bytes);
    const staged = join(f.home, "cache", "images", name);
    fs.mkdirSync(dirname(staged), { recursive: true }); fs.writeFileSync(staged, bytes);
    paths.push(retained, staged);
    mimes.push(mime, mime);
  }
  f.add(nativeAnnotated(paths));
  const found = await f.find();
  assert.equal(found.matchedMessages, 1);
  assert.deepEqual(found.images.map(image => image.mime), mimes);
  for (const image of found.images) assert.ok((await image.readBytes()).length);
});

test("Hermes refuses retained bytes whose digest differs from the parent or API basename", async t => {
  const f = await fixture(t);
  const wrongParent = f.retainedImage("original.png", f.png, "a".repeat(64));
  const api = join(f.home, "cache", "images", `api_${"b".repeat(32)}.png`);
  fs.mkdirSync(dirname(api), { recursive: true }); fs.writeFileSync(api, f.png);
  f.add(annotated([wrongParent, api, f.retainedImage("valid.png")]));
  assert.deepEqual((await f.find()).images.map(image => image.id), ["hermes-2"]);
});

test("Hermes confines original and API names even when escaped files have matching digests", async t => {
  const f = await fixture(t), native = f.retainedImage("original.png");
  const outside = join(f.root, "outside"); fs.mkdirSync(outside);
  const external = join(outside, "original.png"); fs.writeFileSync(external, f.png);
  const leaf = join(dirname(native), "linked photo.png"); fs.symlinkSync(external, leaf);
  const otherBytes = Buffer.concat([f.png, Buffer.from([1])]);
  const digest = createHash("sha256").update(otherBytes).digest("hex");
  fs.writeFileSync(join(outside, "other.png"), otherBytes);
  const ancestor = join(f.home, "cache", "documents", "native-inputs", digest);
  fs.symlinkSync(outside, ancestor);
  const api = join(f.home, "cache", "images", `api_${createHash("sha256").update(f.png).digest("hex").slice(0, 32)}.png`);
  fs.mkdirSync(dirname(api), { recursive: true }); fs.symlinkSync(external, api);
  const unnormalized = `${dirname(native)}/./original.png`;
  f.add(annotated([leaf, join(ancestor, "other.png"), api, unnormalized, native]));
  assert.deepEqual((await f.find()).images.map(image => image.id), ["hermes-4"]);
});

for (const failure of ["removed", "symlink", "changed digest"]) {
  test(`Hermes skips only a ${failure} image on reread and retains the other image`, async t => {
    const f = await fixture(t), first = f.retainedImage("first.png"), second = f.retainedImage("second.png");
    const outside = join(f.root, "external.png"); fs.writeFileSync(outside, f.png);
    f.add(annotated([first, second]));
    const resolver = { ...f.resolver, async find(context) {
      const found = await f.resolver.find(context);
      fs.unlinkSync(first);
      if (failure === "symlink") fs.symlinkSync(outside, first);
      if (failure === "changed digest") fs.writeFileSync(first, Buffer.concat([f.png, Buffer.from([1])]));
      return found;
    } };
    const snapshot = { provider: "custom-provider", command: "hermes acp", env: { HERMES_HOME: f.home },
      cwd: f.root, persistence: { provider: "custom-provider", sessionId: "session-one" } };
    const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
    const handlers = f.h.createPromptImageHandlers({ resolvers: [resolver] });
    const input = { agentId: "fake-agent", text: "Synthetic question" };
    const result = await handlers.images(input, context);
    assert.equal(result.total, 2);
    assert.equal(result.reason, "invalid_image");
    assert.deepEqual(result.images.map(image => image.id), ["hermes-1"]);
    assert.deepEqual(Buffer.from(result.images[0].thumbDataUri.split(",")[1], "base64"), f.png);
    fs.rmSync(first, { force: true }); fs.writeFileSync(first, f.png);
    assert.equal((await handlers.image({ ...input, id: "hermes-0" }, context)).error, "invalid_image");
    // Unexpected read failures must still fail the lookup.
    const broken = f.h.createPromptImageHandlers({ resolvers: [{ matches: () => true, find: async () => ({ matchedMessages: 1,
      images: [{ id: "broken", mime: "image/png", readBytes: async () => { throw new Error("unexpected"); } }] }) }] });
    assert.equal((await broken.images(input, context)).reason, "lookup_failed");
  });
}

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

test("Hermes counts every valid image while the registry limits thumbnails", async t => {
  const f = await fixture(t);
  f.add(annotated(Array.from({ length: 18 }, () => f.image())));
  assert.equal((await f.find()).images.length, 18);
  const handlers = f.h.createPromptImageHandlers({ resolvers: [f.resolver] });
  const snapshot = { provider: "custom-provider", command: ["hermes", "acp"], env: { HERMES_HOME: f.home },
    cwd: f.root, persistence: { provider: "custom-provider", sessionId: "session-one" } };
  const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
  const input = { agentId: "fake-agent", text: "Synthetic question" };
  const result = await handlers.images(input, context);
  assert.equal(result.total, 18);
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
  for (const HERMES_HOME of ["relative-home", "", 123, `${f.home}/../escape`, "~/../escape", "~/nested/../../escape"]) {
    const context = f.context({ providerEnv: { HERMES_HOME } });
    assert.equal(await f.resolver.matches(context.provider, context), false);
    assert.deepEqual(await f.find({ providerEnv: { HERMES_HOME } }), empty(0));
  }
});

test("Hermes bounds config reads at 64 KiB, including growth after stat", async t => {
  const f = await fixture(t), path = join(f.paseoHome, "config.json");
  f.config("hermes acp", { HERMES_HOME: f.home });
  const config = fs.readFileSync(path, "utf8");
  const unconfigured = { providerCommand: undefined, providerEnv: undefined };
  f.add(annotated([f.image()]));
  fs.writeFileSync(path, config.padEnd(64 * 1024, " "));
  assert.equal((await f.find(unconfigured)).images.length, 1);
  fs.appendFileSync(path, " ");
  assert.deepEqual(await f.find(unconfigured), empty(0));
  const promises = require("node:fs/promises");
  let bytesRead = 0, closed = 0;
  const h = harness({ "node:fs/promises": { ...promises, open: async (candidate, flags) => {
    const file = await promises.open(candidate, flags);
    if (candidate !== path) return file;
    return {
      stat: async () => ({ isFile: () => true, size: 1 }),
      read: async (...args) => { const result = await file.read(...args); bytesRead += result.bytesRead; return result; },
      close: async () => { closed++; await file.close(); },
    };
  } } });
  const resolver = h.createHermesPromptImageResolver({ userHome: f.root, paseoHome: f.paseoHome });
  assert.deepEqual(await resolver.find(f.context(unconfigured)), empty(0));
  assert.equal(bytesRead, 64 * 1024 + 1);
  assert.equal(closed, 1);
});

test("Hermes config reads honor cancellation and close the descriptor", async t => {
  const f = await fixture(t), path = join(f.paseoHome, "config.json");
  f.config("hermes acp", { HERMES_HOME: f.home });
  const promises = require("node:fs/promises"), controller = new AbortController();
  let reads = 0, closed = 0;
  const h = harness({ "node:fs/promises": { ...promises, open: async (candidate, flags) => {
    const file = await promises.open(candidate, flags);
    if (candidate !== path) return file;
    assert.ok(flags & fs.constants.O_NONBLOCK);
    return {
      stat: () => file.stat(),
      read: async (...args) => { reads++; const result = await file.read(...args); controller.abort(); return result; },
      close: async () => { closed++; await file.close(); },
    };
  } } });
  const resolver = h.createHermesPromptImageResolver({ userHome: f.root, paseoHome: f.paseoHome });
  const context = f.context({ providerCommand: undefined, providerEnv: undefined, signal: controller.signal });
  assert.equal(await resolver.matches(context.provider, context), false);
  assert.equal(reads, 1);
  assert.equal(closed, 1);
});

test("Hermes config FIFOs never block the lookup", async t => {
  const f = await fixture(t), path = join(f.paseoHome, "config.json");
  const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  // A child timeout makes a blocking-open regression fail without hanging the suite.
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const test = fs.readFileSync(process.argv[1], 'utf8');
    const prefix = test.slice(0, test.indexOf('const ID ='));
    const { createHermesPromptImageResolver } = new Function('require', '__dirname', prefix + '\\nreturn harness();')(require, process.argv[2]);
    createHermesPromptImageResolver({ paseoHome: process.argv[3] }).matches('custom-provider', {
      provider: 'custom-provider', signal: new AbortController().signal,
    }).then(result => { if (result) process.exitCode = 1; });
  `, __filename, __dirname, f.paseoHome], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
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
