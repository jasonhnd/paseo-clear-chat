const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const CWD = "/work/sample project.v1";
const TEXT = "Inspect this synthetic image.";
const empty = { matchedMessages: 0, images: [] };

// Only synthetic files under a temporary directory are used; even fallback HOME/env
// lookup is isolated from the machine's actual Claude configuration.
function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "claude-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = new Map(), logs = [];
  const environment = {};
  const reads = [];
  function load(filename) {
    filename = resolve(__dirname, "..", filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    const localRequire = id => {
      if (id.startsWith(".")) return load(resolve(dirname(filename), `${id}.ts`));
      if (id === "node:os") return { homedir: () => root };
      if (id === "node:fs/promises") return { ...require(id), async open(path, flags) {
        reads.push({ path, flags });
        return require(id).open(path, flags);
      }, ...overrides };
      return realRequire(id);
    };
    runInThisContext(`(function(require,module,exports,process,console){${code}\n})`, { filename })(
      localRequire, mod, mod.exports, { env: environment }, { debug: (...args) => logs.push(args) },
    );
    return mod.exports;
  }
  const { claudePromptImageResolver: resolver } = load("server/prompt-images/claude.ts");
  const registry = load("server/prompt-images/registry.ts");
  const helpers = load("server/prompt-images/read-only.ts");
  const dir = join(root, "config");
  function store(lines, { configDir = dir, project = "-work-sample-project-v1", session = SESSION } = {}) {
    const folder = join(configDir, "projects", project);
    fs.mkdirSync(folder, { recursive: true });
    const path = join(folder, `${session}.jsonl`);
    fs.writeFileSync(path, lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
    return path;
  }
  const context = (changes = {}) => ({
    agentId: "synthetic-agent", provider: "claude", cwd: CWD, sessionId: SESSION,
    nativeHandle: null, text: TEXT, providerEnv: { CLAUDE_CONFIG_DIR: dir },
    signal: new AbortController().signal, ...changes,
  });
  return { root, dir, store, context, resolver, registry, helpers, environment, logs, reads };
}

async function picture(mime = "image/png", width = 2) {
  // The server reads headers only; synthetic fixtures need no image decoder.
  let bytes;
  if (mime === "image/jpeg") {
    bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00]);
  } else if (mime === "image/webp") {
    bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(22, 4);
    bytes.write("WEBPVP8X", 8);
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(width - 1, 24, 3);
  } else {
    bytes = Buffer.alloc(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(1, 20);
  }
  return { bytes, block: { type: "image", source: { type: "base64", media_type: mime, data: bytes.toString("base64") } } };
}

const user = (content, extra = {}) => ({ type: "user", uuid: "synthetic-message", sessionId: SESSION,
  message: { role: "user", content }, ...extra });
const text = (value = TEXT) => ({ type: "text", text: value });
async function foundBytes(h, lookup) {
  const found = await h.resolver.find(h.context(lookup));
  assert.equal(found.matchedMessages, 1);
  return Promise.all(found.images.map(image => image.readBytes()));
}
// Confirmed in the installed Claude Code: queued commands store the content
// blocks on attachment.prompt and use source_uuid for the resulting user turn.
const queued = (prompt, extra = {}, attachmentExtra = {}) => ({
  type: "attachment", uuid: "queued-message", sessionId: SESSION,
  attachment: { type: "queued_command", prompt, source_uuid: "source-message", ...attachmentExtra }, ...extra,
});

function rpc(h) {
  const handlers = h.registry.createPromptImageHandlers();
  const snapshot = { provider: "claude", cwd: CWD, persistence: { provider: "claude", sessionId: SESSION } };
  const ctx = { paseo: {
    config: { get: async () => ({ config: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: h.dir } } } } }) },
    agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) },
  } };
  return { handlers, ctx, input: { agentId: "synthetic-agent", text: TEXT } };
}

test("Claude exact text match returns only that session's PNG/JPEG bytes and leaves the store unchanged", async t => {
  const h = harness(t), png = await picture(), jpeg = await picture("image/jpeg");
  const path = h.store([user([text(), png.block, jpeg.block])]);
  h.store([user([text(), (await picture()).block], { sessionId: OTHER_SESSION })], { session: OTHER_SESSION });
  const before = fs.readFileSync(path), entries = fs.readdirSync(dirname(path));
  const found = await h.resolver.find(h.context());
  assert.equal(found.matchedMessages, 1);
  assert.equal(found.images.length, 2);
  assert.deepEqual(await found.images[0].readBytes(), png.bytes);
  assert.deepEqual(await found.images[1].readBytes(), jpeg.bytes);
  assert.deepEqual(fs.readFileSync(path), before);
  assert.deepEqual(fs.readdirSync(dirname(path)), entries);
  assert.equal(h.reads.length, 1);
  assert.ok(h.reads.every(({ flags }) => (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0 &&
    (flags & fs.constants.O_NOFOLLOW) !== 0 && (flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0));
  assert.deepEqual(h.logs, []);
});

for (const inputId of ["messageId", "clientMessageId"]) {
  for (const storedId of ["uuid", "promptId"]) {
    test(`Claude ${inputId} matches ${storedId} before text, even when text has duplicates`, async t => {
      const h = harness(t), png = await picture();
      h.store([user([text("different text"), png.block], { [storedId]: "chosen-id" }),
        user([text()], { uuid: "duplicate-1" }), user([text()], { uuid: "duplicate-2" })]);
      const found = await h.resolver.find(h.context({ [inputId]: "chosen-id" }));
      assert.equal(found.matchedMessages, 1);
      assert.equal(found.images.length, 1);
      assert.deepEqual(await found.images[0].readBytes(), png.bytes);
    });
  }
}

test("Claude IDs that do not match fall back to exact text", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), png.block])]);
  const found = await h.resolver.find(h.context({ messageId: "paseo-only-id", clientMessageId: "other-id" }));
  assert.equal(found.matchedMessages, 1);
  assert.equal(found.images.length, 1);
});

test("Claude duplicate text counts all matching messages, including text-only messages", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), png.block]), user(TEXT), user([text()], { uuid: "third" })]);
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 3, images: [] });
});

test("Claude conflicting or duplicate IDs are ambiguous and never fall back to text", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), png.block], { uuid: "id-1" }), user([text("other")], { promptId: "id-2" })]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "id-1", clientMessageId: "id-2" })),
    { matchedMessages: 2, images: [] });
  h.store([user([text(), png.block]), user([text("other"), png.block])]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "synthetic-message" })), { matchedMessages: 2, images: [] });
});

test("Claude joins text blocks with newlines and preserves whitespace, case and Unicode", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(" First é "), png.block, text("Second\r\n")])]);
  assert.equal((await h.resolver.find(h.context({ text: " First é \nSecond\r\n" }))).images.length, 1);
  for (const value of ["First é\nSecond", " First é Second\r\n", " First e\u0301 \nSecond\r\n", " first é \nSecond\r\n"]) {
    assert.deepEqual(await h.resolver.find(h.context({ text: value })), empty);
  }
});

test("Claude no match cannot return an image from another message or session", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text("other message"), png.block])]);
  h.store([user([text(), png.block], { sessionId: OTHER_SESSION })], { session: OTHER_SESSION });
  assert.deepEqual(await h.resolver.find(h.context()), empty);
  h.store([user([text(), png.block], { sessionId: OTHER_SESSION })]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "synthetic-message" })), { matchedMessages: 1, images: [] });
});

test("Claude missing persistence session never uses nativeHandle as a fallback", async t => {
  const h = harness(t);
  h.store([user([text(), (await picture()).block])]);
  assert.deepEqual(await h.resolver.find(h.context({ sessionId: null, nativeHandle: SESSION })), empty);
  assert.equal(h.reads.length, 0);
});

test("Claude missing/cleaned session and config directory return no images and create nothing", async t => {
  const h = harness(t);
  assert.deepEqual(await h.resolver.find(h.context()), empty);
  assert.equal(fs.existsSync(h.dir), false);
  const path = h.store([user([text(), (await picture()).block])]);
  fs.unlinkSync(path);
  assert.deepEqual(await h.resolver.find(h.context()), empty);
  assert.deepEqual(fs.readdirSync(dirname(path)), []);
});

test("Claude fallback scans project directories only for the exact session filename", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), png.block])], { project: "different-project-hash" });
  h.store([user([text(), png.block], { sessionId: OTHER_SESSION })], { session: OTHER_SESSION });
  assert.equal((await h.resolver.find(h.context())).images.length, 1);
  assert.equal((await h.resolver.find(h.context({ cwd: "/" + "a".repeat(300) }))).images.length, 1);
  h.store([user([text(), png.block])], { project: "another-copy" });
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 2, images: [] });
});

test("Claude checks other project copies even when the encoded-cwd transcript exists", async t => {
  const h = harness(t), first = await picture(), second = await picture("image/png", 3);
  h.store([user([text(), first.block], { uuid: "chosen-id" })]);
  h.store([user([text("different text"), second.block], { uuid: "other-id" })], { project: "other-copy" });
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 2, images: [] });
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "chosen-id" })), { matchedMessages: 2, images: [] });
});

test("Claude a non-file at the encoded path does not skip other projects", async t => {
  const h = harness(t), png = await picture();
  const path = h.store([]);
  fs.unlinkSync(path);
  fs.mkdirSync(path);
  h.store([user([text(), png.block])], { project: "other-project" });
  const found = await h.resolver.find(h.context());
  assert.equal(found.images.length, 1);
  assert.deepEqual(await found.images[0].readBytes(), png.bytes);
});

for (const lookup of [{}, { messageId: "queued-message" }, { clientMessageId: "source-message" }]) {
  test(`Claude queued-command attachment images match ${JSON.stringify(lookup)} as one message`, async t => {
    const h = harness(t), png = await picture(), jpeg = await picture("image/jpeg");
    const path = h.store([queued([text(), png.block, jpeg.block])]);
    const before = fs.readFileSync(path);
    const found = await h.resolver.find(h.context(lookup));
    assert.equal(found.matchedMessages, 1);
    assert.equal(found.images.length, 2);
    assert.deepEqual(await found.images[0].readBytes(), png.bytes);
    assert.deepEqual(await found.images[1].readBytes(), jpeg.bytes);
    assert.deepEqual(fs.readFileSync(path), before);
  });
}

test("Claude queued command and the user turn it points at are one message", async t => {
  const h = harness(t), png = await picture(), jpeg = await picture("image/jpeg");
  // Same bytes, separate object: identical images from the two lines dedupe.
  const pngCopy = { type: "image", source: { ...png.block.source } };
  const lines = [
    user([text(), png.block], { uuid: "source-message" }),
    queued([text(), pngCopy, jpeg.block]),
  ];
  h.store(lines);
  for (const lookup of [
    { messageId: "queued-message" }, { clientMessageId: "queued-message" },
    { messageId: "source-message" }, { clientMessageId: "source-message" }, {},
  ]) {
    assert.deepEqual(await foundBytes(h, lookup), [png.bytes, jpeg.bytes]);
  }
  const sibling = await picture("image/png", 3);
  h.store([...lines, user([text(), sibling.block], { uuid: "sibling" })]);
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 2, images: [] });
  assert.deepEqual(await foundBytes(h, { messageId: "queued-message" }), [png.bytes, jpeg.bytes]);
  // A discarded or unreadable user turn still blocks; a meta attachment does not hide the turn.
  h.store([user([text(), png.block], { uuid: "source-message", isSidechain: true }), queued([text(), jpeg.block])]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "source-message" })), { matchedMessages: 1, images: [] });
  assert.deepEqual((await h.resolver.find(h.context())).images, []);
  h.store([user({ future: "content" }, { uuid: "source-message" }), queued([text(), png.block])]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "queued-message" })), { matchedMessages: 1, images: [] });
  assert.deepEqual((await h.resolver.find(h.context())).images, []);
  h.store([user([text(), png.block], { uuid: "source-message" }), queued([text(), jpeg.block], {}, { isMeta: true })]);
  assert.deepEqual(await foundBytes(h, { messageId: "source-message" }), [png.bytes]);
  assert.deepEqual(await foundBytes(h, {}), [png.bytes]);
});

test("Claude queued commands share message ambiguity and image caps/checks with user messages", async t => {
  const h = harness(t), png = await picture(), sibling = await picture("image/png", 3);
  h.store([queued([text(), png.block]), user([text(), sibling.block])]);
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 2, images: [] });
  const invalid = { ...png.block, source: { ...png.block.source, media_type: "image/jpeg" } };
  h.store([queued([text(), invalid, ...Array(25).fill(png.block)])]);
  const found = await h.resolver.find(h.context({ messageId: "source-message" }));
  assert.equal(found.matchedMessages, 1);
  assert.equal(found.images.length, 20);
  assert.equal(new Set(found.images.map(image => image.id)).size, 20);
  assert.deepEqual(await found.images[0].readBytes(), png.bytes);
});

test("Claude rejected or unreadable queued commands cannot select a same-text sibling", async t => {
  const h = harness(t), bad = await picture(), sibling = await picture("image/png", 3);
  for (const line of [queued([text(), bad.block], { isSidechain: true }),
    queued([text(), bad.block], { isMeta: true }), queued([text(), bad.block], {}, { isMeta: true }),
    queued([text(), bad.block], { sessionId: OTHER_SESSION }), queued([text(), bad.block], { uuid: 42 }),
    queued([text(), bad.block, { type: "future_block" }])]) {
    h.store([line, user([text(), sibling.block], { uuid: "sibling" })]);
    assert.deepEqual(await h.resolver.find(h.context({ messageId: "source-message" })), { matchedMessages: 1, images: [] });
    assert.deepEqual((await h.resolver.find(h.context())).images, []);
  }
  h.store([queued(TEXT), user([text(), sibling.block])]);
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 2, images: [] });
});

test("Claude accepts WebP headers with matching MIME", async t => {
  const h = harness(t), webp = await picture("image/webp");
  h.store([user([text(), webp.block])]);
  const found = await h.resolver.find(h.context());
  assert.equal(found.images.length, 1);
  assert.equal(found.images[0].mime, "image/webp");
  assert.deepEqual(await found.images[0].readBytes(), webp.bytes);
});

for (const change of ["uuid", "dev", "ino", "size", "mtime"]) {
  test(`Claude prompt.image rejects a listed ID after transcript ${change} changes`, async t => {
    let originalFingerprint;
    const h = harness(t, { async lstat(path, options) {
      const entry = await require("node:fs/promises").lstat(path, options);
      if (!options?.bigint || !originalFingerprint) return entry;
      // Isolate each identity field so another changed field cannot hide a
      // missing check. Descriptor validation still uses real filesystem stats.
      const field = { dev: "dev", ino: "ino", size: "size", mtime: "mtimeNs" }[change];
      return { ...originalFingerprint,
        ...(field ? { [field]: change === "dev" ? entry.dev + 1n : entry[field] } : {}),
        isFile: () => true,
      };
    } });
    const png = await picture(), replacement = await picture("image/png", 3);
    const path = h.store([user([text(), png.block])]);
    const { handlers, ctx, input } = rpc(h);
    const listed = await handlers.images(input, ctx);
    assert.equal(listed.images.length, 1);
    assert.equal((await handlers.image({ ...input, id: listed.images[0].id }, ctx)).error, null);
    const before = fs.statSync(path);
    originalFingerprint = await require("node:fs/promises").lstat(path, { bigint: true });
    if (change === "uuid") {
      // Keep the file fingerprint identical to isolate the message UUID check.
      fs.writeFileSync(path, JSON.stringify(user([text(), replacement.block], { uuid: "different-message" })) + "\n");
    } else if (change === "ino") {
      fs.renameSync(path, join(h.root, "original.jsonl"));
      h.store([user([text(), replacement.block])]);
    } else if (change === "size") fs.appendFileSync(path, "\n");
    else if (change === "mtime") fs.utimesSync(path, before.atime, new Date(before.mtimeMs + 1000));
    const full = await handlers.image({ ...input, id: listed.images[0].id }, ctx);
    assert.equal(full.error, "not_found");
    assert.equal(full.dataUri, null);
    assert.deepEqual(h.logs, [["[clear-chat] prompt.image: not_found"]]);
  });
}

test("Claude discards images when the transcript changes during the scan", async t => {
  const h = harness(t, { async open(path, flags) {
    const file = await require("node:fs/promises").open(path, flags);
    const create = file.createReadStream.bind(file);
    file.createReadStream = options => {
      const stream = create(options);
      stream.once("end", () => fs.appendFileSync(path, "\n"));
      return stream;
    };
    return file;
  } });
  h.store([user([text(), (await picture()).block])]);
  assert.deepEqual(await h.resolver.find(h.context()), empty);
});

test("Claude requires a readable UUID to bind listed images to a message", async t => {
  const h = harness(t);
  h.store([user([text(), (await picture()).block], { uuid: undefined, promptId: "requested-id" })]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "requested-id" })), { matchedMessages: 1, images: [] });
});

test("Claude reserves rejected user IDs while ignoring malformed and non-user lines", async t => {
  const h = harness(t), png = await picture();
  h.store(["{malformed", null, [], { type: "assistant", message: { role: "user", content: [text(), png.block] } },
    user([{ type: "tool_result", content: [text(), png.block] }]),
    user([text(), png.block, { type: "tool_result", content: "synthetic result" }]),
    user([text(), png.block], { isSidechain: true }), user([text(), png.block], { isMeta: true })]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "synthetic-message" })), { matchedMessages: 4, images: [] });
  h.store(["bad JSON", user([text(), png.block]), '{"partial":']);
  assert.equal((await h.resolver.find(h.context())).images.length, 1);
});

test("Claude unknown or malformed message content fails closed", async t => {
  const h = harness(t), png = await picture();
  for (const line of [user({ text: TEXT, images: [png.block] }), user([text(), png.block, { type: "future_block" }]),
    user([text(), png.block, { type: "text", text: 123 }]), user([null]), user([]), user(42),
    user([text(), png.block], { uuid: 42 }), user([text(), png.block], { promptId: {} }),
    { type: "user", uuid: "synthetic-message", message: { role: "assistant", content: [text(), png.block] } }]) {
    h.store([line]);
    assert.deepEqual((await h.resolver.find(h.context())).images, []);
    assert.deepEqual((await h.resolver.find(h.context({ messageId: "synthetic-message" }))).images, []);
  }
});

for (const inputId of ["messageId", "clientMessageId"]) {
  for (const storedId of ["uuid", "promptId"]) {
    for (const reason of ["isSidechain", "isMeta", "sessionId", "uuid", "promptId", "tool_result", "role"]) {
      // A malformed ID needs the other readable ID to identify the rejected line.
      if (reason === storedId) continue;
      // Tool results copy the turn promptId; only their own uuid is reserved.
      if (reason === "tool_result" && storedId === "promptId") continue;
      test(`Claude rejected ${reason} reserves ${storedId} for ${inputId} instead of selecting a same-text sibling`, async t => {
        const h = harness(t), bad = await picture(), sibling = await picture("image/png", 3);
        const extra = { uuid: "bad-message", [storedId]: "requested-id" };
        let content = [text(), bad.block];
        if (reason === "isSidechain" || reason === "isMeta") extra[reason] = true;
        if (reason === "sessionId") extra.sessionId = OTHER_SESSION;
        if (reason === "uuid") extra.uuid = 42;
        if (reason === "promptId") extra.promptId = {};
        if (reason === "tool_result") content.push({ type: "tool_result", content: "synthetic result" });
        if (reason === "role") extra.message = { role: "assistant", content };
        h.store([user(content, extra), user([text(), sibling.block], { uuid: "sibling" })]);
        assert.deepEqual(await h.resolver.find(h.context({ [inputId]: "requested-id" })), { matchedMessages: 1, images: [] });
      });
    }
  }
}

test("Claude tool results reserve only their own uuid and not the copied promptId", async t => {
  const h = harness(t), pngA = await picture(), pngB = await picture("image/png", 3);
  const tool = uuid => user([{ type: "tool_result", tool_use_id: uuid, content: "synthetic result" }],
    { uuid, promptId: "shared-prompt" });
  const prompt = user([text(), pngA.block], { uuid: "prompt-uuid", promptId: "shared-prompt" });
  // A tool-result uuid must not fall through to the prompt when that text is unique.
  h.store([prompt, tool("tool-1"), tool("tool-2")]);
  assert.deepEqual(await foundBytes(h, {}), [pngA.bytes]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "tool-1" })), { matchedMessages: 1, images: [] });
  h.store([prompt, tool("tool-1"), tool("tool-2"), user([text(), pngB.block], { uuid: "sibling" })]);
  assert.deepEqual(await foundBytes(h, { messageId: "shared-prompt" }), [pngA.bytes]);
  assert.deepEqual(await foundBytes(h, { messageId: "prompt-uuid", clientMessageId: "shared-prompt" }), [pngA.bytes]);
  assert.deepEqual(await foundBytes(h, { messageId: "prompt-uuid" }), [pngA.bytes]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "tool-1" })), { matchedMessages: 1, images: [] });
  assert.deepEqual(await foundBytes(h, { messageId: "sibling" }), [pngB.bytes]);
});

for (const reason of ["object", "unknown block", "malformed text", "null block", "empty", "number", "missing"]) {
  test(`Claude unreadable ${reason} blocks text fallback to a same-text sibling with a different PNG`, async t => {
    const h = harness(t), bad = await picture(), sibling = await picture("image/png", 3);
    const contents = {
      object: { text: TEXT, images: [bad.block] },
      "unknown block": [text(), bad.block, { type: "future_block" }],
      "malformed text": [text(), bad.block, { type: "text", text: 123 }],
      "null block": [text(), bad.block, null], empty: [], number: 42, missing: undefined,
    };
    h.store([user(contents[reason], { uuid: "unreadable" }), user([text(), sibling.block], { uuid: "sibling" })]);
    for (const ids of [{}, { messageId: "paseo-only-id" }]) {
      assert.deepEqual(await h.resolver.find(h.context(ids)), { matchedMessages: 1, images: [] });
    }
    // An exact readable ID still selects its own message independently of text.
    assert.equal((await h.resolver.find(h.context({ messageId: "sibling" }))).images.length, 1);
  });
}

for (const flag of ["isSidechain", "isMeta"]) {
  test(`Claude same-text ${flag} blocks text fallback with a different PNG`, async t => {
    const h = harness(t), bad = await picture(), sibling = await picture("image/png", 3);
    h.store([user([text(), bad.block], { uuid: "rejected", [flag]: true }),
      user([text(), sibling.block], { uuid: "sibling" })]);
    for (const ids of [{}, { messageId: "paseo-only-id" }]) {
      assert.deepEqual(await h.resolver.find(h.context(ids)), { matchedMessages: 2, images: [] });
    }
    assert.equal((await h.resolver.find(h.context({ messageId: "sibling" }))).images.length, 1);
  });
}

test("Claude unknown content with a matching ID blocks text fallback to another message", async t => {
  const h = harness(t), png = await picture();
  h.store([user({ future: "content" }, { uuid: "requested-id" }),
    user([text(), png.block], { uuid: "other-message" })]);
  assert.deepEqual(await h.resolver.find(h.context({ messageId: "requested-id" })), { matchedMessages: 1, images: [] });
});

test("Claude image-only prompts match empty text uniquely", async t => {
  const h = harness(t), png = await picture();
  h.store([user([png.block])]);
  assert.equal((await h.resolver.find(h.context({ text: "" }))).images.length, 1);
  h.store([user([png.block]), user("")]);
  assert.deepEqual(await h.resolver.find(h.context({ text: "" })), { matchedMessages: 2, images: [] });
});

test("Claude skips non-base64, unknown formats, mismatched MIME and invalid base64", async t => {
  const h = harness(t), png = await picture();
  for (const source of [undefined, { type: "url", url: "https://example.invalid/test.png" },
    { type: "file", path: "../../outside.png" },
    { ...png.block.source, media_type: "image/svg+xml" }, { ...png.block.source, media_type: "image/webp" },
    { ...png.block.source, media_type: "image/jpeg" }, { ...png.block.source, data: "not base64!!" },
    { ...png.block.source, data: png.block.source.data + "\n" }, { ...png.block.source, data: "AB==" },
    { ...png.block.source, data: Buffer.from("unknown format").toString("base64") },
    { ...png.block.source, data: "" }, { ...png.block.source, data: 42 }]) {
    h.store([user([text(), { type: "image", source }])]);
    assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 1, images: [] });
  }
});

test("Claude rejects oversized image bytes before decoding and skips oversized JSONL lines", async t => {
  const h = harness(t), png = await picture();
  const source = { ...png.block.source, data: Buffer.alloc(h.helpers.MAX_IMAGE_BYTES + 1).toString("base64") };
  h.store([user([text(), { type: "image", source }])]);
  assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 1, images: [] });
  const path = h.store([]);
  fs.writeFileSync(path, " ".repeat(h.helpers.MAX_JSONL_LINE_BYTES + 1) + "\n" + JSON.stringify(user([text(), png.block])) + "\n");
  assert.equal((await h.resolver.find(h.context())).images.length, 1);
});

test("Claude rejects zero and oversized pixel dimensions", async t => {
  const h = harness(t), png = await picture();
  for (const width of [0, 24_000_001]) {
    const bytes = Buffer.from(png.bytes);
    bytes.writeUInt32BE(width, 16);
    h.store([user([text(), { type: "image", source: { ...png.block.source, data: bytes.toString("base64") } }])]);
    assert.deepEqual(await h.resolver.find(h.context()), { matchedMessages: 1, images: [] });
  }
});

test("Claude caps images per message independently of the registry thumbnail cap", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), ...Array(25).fill(png.block)])]);
  const found = await h.resolver.find(h.context());
  assert.equal(found.images.length, 20);
  assert.equal(new Set(found.images.map(image => image.id)).size, 20);
  const first = await found.images[0].readBytes();
  first.fill(0);
  assert.deepEqual(await found.images[0].readBytes(), png.bytes);
});

test("Claude rejects path traversal and invalid session IDs before opening a file", async t => {
  const h = harness(t);
  for (const sessionId of ["../escape", "../../escape", "..\\escape", "/absolute", `${SESSION}/../${OTHER_SESSION}`,
    `${SESSION}\0`, `${SESSION}%2f..`, "not-a-session", ""]) {
    assert.deepEqual(await h.resolver.find(h.context({ sessionId })), empty);
  }
  assert.equal(h.reads.length, 0);
});

test("Claude refuses symlink transcript and project escapes", async t => {
  const h = harness(t), png = await picture();
  const outside = h.store([user([text(), png.block])], { configDir: join(h.root, "outside") });
  const target = h.store([]);
  fs.unlinkSync(target);
  fs.symlinkSync(outside, target);
  assert.deepEqual(await h.resolver.find(h.context()), empty);
  fs.rmSync(dirname(target), { recursive: true });
  fs.symlinkSync(dirname(outside), dirname(target));
  assert.deepEqual(await h.resolver.find(h.context()), empty);
  assert.deepEqual(await h.resolver.find(h.context({ cwd: "/unrelated" })), empty);
});

test("Claude JSONL descriptor validation rejects an ancestor swapped during open", async t => {
  let swap;
  const h = harness(t, { async open(path, flags) {
    const file = await require("node:fs/promises").open(path, flags);
    swap();
    return file;
  } });
  const path = h.store([user([text(), (await picture()).block])]);
  swap = () => {
    fs.renameSync(path, join(h.root, "moved.jsonl"));
    fs.writeFileSync(path, JSON.stringify(user(TEXT)) + "\n");
  };
  assert.deepEqual(await h.resolver.find(h.context()), empty);
});

test("Claude denied reads and pre-aborted lookups return no images or private logs", async t => {
  const h = harness(t, { open: async () => { throw new Error("synthetic private error"); } });
  h.store([user([text(), (await picture()).block])]);
  assert.deepEqual(await h.resolver.find(h.context()), empty);
  assert.deepEqual(await h.resolver.find(h.context({ signal: AbortSignal.abort() })), empty);
  assert.deepEqual(h.logs, []);
});

test("Claude stops an active JSONL scan and closes the read-only descriptor on abort", async t => {
  const controller = new AbortController();
  let closed = false;
  const h = harness(t, { async open(path, flags) {
    const file = await require("node:fs/promises").open(path, flags);
    const close = file.close.bind(file), create = file.createReadStream.bind(file);
    file.close = async () => { closed = true; return close(); };
    file.createReadStream = options => {
      const stream = create(options);
      stream.once("data", () => controller.abort());
      return stream;
    };
    return file;
  } });
  h.store([user([text(), (await picture()).block])]);
  assert.deepEqual(await h.resolver.find(h.context({ signal: controller.signal })), empty);
  assert.equal(closed, true);
});

test("Claude resolves a relative provider config directory against the snapshot cwd", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), png.block])], { project: "synthetic-project" });
  const found = await h.resolver.find(h.context({ cwd: h.root, providerEnv: { CLAUDE_CONFIG_DIR: "config" } }));
  assert.equal(found.images.length, 1);
});

test("Claude config directories honor provider env, daemon env and HOME in order", async t => {
  const h = harness(t), png = await picture();
  const dirs = [h.dir, join(h.root, "secure"), join(h.root, "daemon"), join(h.root, "daemon-secure"), join(h.root, ".claude")];
  for (const configDir of dirs) h.store([user([text(), png.block])], { configDir });
  h.environment.CLAUDE_CONFIG_DIR = dirs[2];
  h.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = dirs[3];
  for (const [providerEnv, expected] of [
    [{ CLAUDE_CONFIG_DIR: dirs[0], CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs[1] }, dirs[0]],
    [{ CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs[1] }, dirs[1]], [{}, dirs[2]],
  ]) {
    assert.equal((await h.resolver.find(h.context({ providerEnv }))).images.length, 1);
    assert.ok(h.reads.at(-1).path.startsWith(expected + "/"));
  }
  delete h.environment.CLAUDE_CONFIG_DIR;
  assert.equal((await h.resolver.find(h.context({ providerEnv: {} }))).images.length, 1);
  assert.ok(h.reads.at(-1).path.startsWith(dirs[3] + "/"));
  delete h.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  assert.equal((await h.resolver.find(h.context({ providerEnv: {} }))).images.length, 1);
  assert.ok(h.reads.at(-1).path.startsWith(dirs[4] + "/"));
  assert.deepEqual(await h.resolver.find(h.context({ providerEnv: { CLAUDE_CONFIG_DIR: join(h.root, "missing") } })), empty);
});

test("Claude registry handles configured CLI providers, thumbnails and message-scoped originals", async t => {
  const h = harness(t), png = await picture();
  h.store([user([text(), png.block])]);
  const handlers = h.registry.createPromptImageHandlers();
  const input = { agentId: "synthetic-agent", text: TEXT };
  const config = { providers: { "custom-claude": { command: ["/opt/bin/claude", "--flag"],
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: h.dir } } } };
  Object.defineProperty(config.providers["custom-claude"].env, "API_KEY", { get: () => assert.fail("must not read unrelated env") });
  const snapshot = { provider: "custom-claude", cwd: CWD,
    persistence: { provider: "custom-claude", sessionId: SESSION, nativeHandle: "unused" } };
  const ctx = { paseo: { config: { get: async () => ({ config }) }, agents: { ref: () => ({ refresh: async () => ({ agent: snapshot }) }) } } };
  const result = await handlers.images(input, ctx);
  assert.equal(result.total, 1);
  assert.equal(result.images.length, 1);
  const full = await handlers.image({ ...input, id: result.images[0].id }, ctx);
  assert.equal(full.error, null);
  assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), png.bytes);
  assert.equal((await handlers.image({ ...input, text: "different message", id: result.images[0].id }, ctx)).error, "no_match");
  config.providers["custom-claude"].command = ["other-cli", "claude"];
  assert.equal((await handlers.images(input, ctx)).reason, "unknown_provider");
});

test("Claude command recognition uses the executable, not provider-name substrings or arguments", t => {
  const h = harness(t);
  for (const command of [["claude"], ["/opt/tools/claude"], ["C:\\tools\\claude.exe"], ["claude.cmd"]]) {
    assert.equal(h.resolver.matches("custom", command), true);
  }
  for (const command of [undefined, [], ["not-claude"], ["node", "claude"], ["/opt/claude-wrapper"]]) {
    assert.equal(h.resolver.matches("custom-claude", command), false);
  }
  assert.equal(h.resolver.matches("claude"), true);
});
