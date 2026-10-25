const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, relative, resolve } = require("node:path");
const { describe, test } = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

// Synthetic Codex rollouts only. No real session ids, prompt text, or image bytes.
const THREAD = "00000000-0000-4000-8000-0000000000c3";
const OTHER_THREAD = "00000000-0000-4000-8000-0000000000c4";
const ABSENT_THREAD = "00000000-0000-4000-8000-0000000000ff";

function harness(overrides = {}) {
  const cache = new Map();
  const logs = [];
  function load(relativePath) {
    const filename = resolve(__dirname, "..", relativePath);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    const localRequire = id => {
      if (id.startsWith(".")) return load(resolve(dirname(filename), `${id}.ts`));
      if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
      return realRequire(id);
    };
    runInThisContext(`(function(require,module,exports,console){${compiled}\n})`, { filename })(
      localRequire, mod, mod.exports, { debug: (...args) => logs.push(args) },
    );
    return mod.exports;
  }
  const registry = load("server/prompt-images/registry.ts");
  const codex = load("server/prompt-images/codex.ts");
  const helpers = load("server/prompt-images/read-only.ts");
  return { ...registry, ...helpers, ...codex, logs };
}

function fixture(t) {
  const base = resolve(__dirname, "..", ".tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(join(base, "codex-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function dataUrl(bytes, mime = "image/png") {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function response(payload) {
  return { timestamp: "2026-01-02T03:04:05.000Z", type: "response_item", payload };
}

function userMessage(text, images, fields = {}) {
  const content = [{ type: "input_text", text }];
  for (const image of images) content.push({ type: "input_image", image_url: image, detail: "auto" });
  return response({ type: "message", role: "user", content, ...fields });
}

function writeRollout(home, threadId, records, options = {}) {
  const dir = join(home, options.archived ? "archived_sessions" : "sessions", ...(options.date ?? ["2026", "01", "02"]));
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${options.stamp ?? "2026-01-02T03-04-05"}-${threadId}.jsonl`);
  fs.writeFileSync(path, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
  return path;
}

function sessionMeta(id) {
  return {
    timestamp: "2026-01-02T03:04:05.000Z",
    type: "session_meta",
    payload: { id, session_id: "session-synthetic", cwd: "/tmp/synthetic-workspace", source: "synthetic", cli_version: "0.0.0" },
  };
}

function context(overrides = {}) {
  return {
    agentId: "agent-synthetic",
    text: "Exact text.",
    provider: "codex",
    cwd: "/tmp/synthetic-workspace",
    sessionId: THREAD,
    nativeHandle: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function findIn(h, home, overrides) {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await h.codexPromptImages.find(context(overrides));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

async function imageBytes(result) {
  const bytes = [];
  for (const image of result.images) bytes.push(await image.readBytes());
  return bytes;
}

function agentHost(sessionId = THREAD) {
  const snapshot = {
    provider: "codex",
    cwd: "/tmp/synthetic-workspace",
    persistence: { provider: "codex", sessionId, nativeHandle: null },
  };
  return {
    paseo: { agents: { ref(id) {
      assert.equal(id, "agent-synthetic");
      return { refresh: async () => ({ agent: snapshot }), current: () => snapshot };
    } } },
  };
}

async function askRegistry(h, home, text, extra = {}) {
  const handlers = h.createPromptImageHandlers();
  const input = {
    agentId: "agent-synthetic",
    messageId: extra.messageId ?? null,
    clientMessageId: extra.clientMessageId ?? null,
    text,
  };
  const host = agentHost(extra.sessionId ?? THREAD);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return {
      images: await handlers.images(input, host),
      image: await handlers.image({ ...input, id: extra.id ?? "0" }, host),
    };
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

function emptyList(reason) {
  return { images: [], total: 0, reason };
}

function pngHeader(width = 4, height = 2) {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegHeader(width = 4, height = 2) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x11, 0x00]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function gifHeader(width = 4, height = 2) {
  const bytes = Buffer.alloc(23);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[13] = 0x2c;
  bytes.writeUInt16LE(width, 18);
  bytes.writeUInt16LE(height, 20);
  return bytes;
}

function webpHeader(width = 4, height = 2) {
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

function snapshot(dir) {
  const out = [];
  const walk = current => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const path = join(current, name);
      const info = fs.lstatSync(path);
      if (info.isSymbolicLink()) out.push([relative(dir, path), "symlink", fs.readlinkSync(path)]);
      else if (info.isDirectory()) walk(path);
      else out.push([relative(dir, path), fs.readFileSync(path)]);
    }
  };
  walk(dir);
  return out.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

describe("codex pasted images", { concurrency: false }, () => {
  const png = pngHeader();
  const jpeg = jpegHeader();
  const gif = gifHeader();
  const webp = webpHeader();
  const decoy = pngHeader(3, 3);

  function richRecords(sentinel) {
    return [
      sessionMeta(THREAD),
      response({ type: "message", role: "developer", content: [
        { type: "input_text", text: "Exact text." },
        { type: "input_image", image_url: dataUrl(decoy) },
      ] }),
      response({ type: "message", role: "system", content: [
        { type: "input_text", text: "Developer only." },
        { type: "input_image", image_url: dataUrl(decoy) },
      ] }),
      { timestamp: "2026-01-02T03:04:05.000Z", type: "event_msg", payload: { type: "user_message", message: "Exact text.", image_url: dataUrl(decoy) } },
      userMessage("Unrelated note.", [dataUrl(decoy)]),
      userMessage("Exact text.", [dataUrl(png), dataUrl(jpeg, "image/jpeg")]),
      "{\"type\":\"response_item\"",
      userMessage("Same words.", [dataUrl(decoy)]),
      userMessage("Same words.", []),
      userMessage("By identifier.", [dataUrl(decoy)], { id: "msg-target" }),
      userMessage("Other identifier.", [dataUrl(png)], { id: "msg-other", client_message_id: "client-other" }),
      userMessage("First copy.", [dataUrl(png)], { id: "msg-dup" }),
      userMessage("Second copy.", [dataUrl(decoy)], { id: "msg-dup" }),
      { kind: "legacy", text: "Legacy only.", images: [{ image_url: dataUrl(decoy) }] },
      response({ type: "message", role: "user", content: [
        { type: "environment_context", text: "Environment only.", image_url: dataUrl(decoy) },
        { type: "input_text", text: "<environment_context><cwd>/tmp/synthetic-workspace</cwd></environment_context>" },
        { type: "input_text", text: "<image name=[Image #1] path=\"/tmp/synthetic.png\">" },
        { type: "input_image", image_url: dataUrl(decoy), detail: "high" },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "Wrapped text." },
      ] }),
      response({ type: "message", role: "user", content: "Exact text." }),
      response({ type: "message", role: "developer", content: [
        { type: "input_text", text: "Developer only." },
        { type: "input_image", image_url: dataUrl(decoy) },
      ] }),
      response({ type: "message", role: "user", content: [
        { type: "input_text", text: "<environment_context>one</environment_context>" },
        { type: "input_text", text: "Shared part" },
      ] }),
      response({ type: "message", role: "user", content: [
        { type: "input_text", text: "Shared part" },
        { type: "input_text", text: "tail" },
      ] }),
      response({ type: "message", role: "user", content: [
        { type: "input_text", text: "Path fields." },
        { type: "input_image", file_id: sentinel },
        { type: "input_image", image_url: sentinel },
        { type: "input_image", image_url: `file://${sentinel}` },
        { type: "input_image", image_url: { url: dataUrl(png) } },
        { type: "input_image", image_url: dataUrl(png) },
      ] }),
    ];
  }

  function installRich(t, h) {
    const root = fixture(t);
    const home = join(root, "codex-home");
    const sentinel = join(root, "sentinel-not-created.png");
    writeRollout(home, THREAD, richRecords(sentinel));
    writeRollout(home, OTHER_THREAD, [sessionMeta(OTHER_THREAD), userMessage("Exact text.", [dataUrl(decoy)])]);
    return { root, home, sentinel };
  }

  test("matches only the codex provider id", () => {
    const h = harness();
    assert.equal(h.codexPromptImages.matches("codex"), true);
    for (const provider of ["Codex", "codex ", "codex/gpt-5.5", "/usr/bin/codex", "wrapper", "claude"]) {
      assert.equal(h.codexPromptImages.matches(provider), false, provider);
    }
    assert.equal(h.promptImageResolvers.length, 1);
    assert.equal(h.promptImageResolvers[0].matches("codex"), true);
  });

  test("exact text match returns only that message's images from the same session", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const before = snapshot(home);
    const result = await findIn(h, home, { text: "Exact text." });
    assert.equal(result.matchedMessages, 1);
    assert.deepEqual(result.images.map(image => image.id), ["0", "1"]);
    assert.deepEqual(result.images.map(image => image.mime), ["image/png", "image/jpeg"]);
    assert.deepEqual(await imageBytes(result), [png, jpeg]);
    const other = await findIn(h, home, { sessionId: OTHER_THREAD, text: "Exact text." });
    assert.equal(other.matchedMessages, 1);
    assert.deepEqual(await imageBytes(other), [decoy]);
    assert.deepEqual(snapshot(home), before);
  });

  test("a wrapped user message matches one input_text part and ignores environment, developer, and system items", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const wrapped = await findIn(h, home, { text: "Wrapped text." });
    assert.equal(wrapped.matchedMessages, 1);
    assert.deepEqual(wrapped.images.map(image => image.id), ["0"]);
    assert.deepEqual(await imageBytes(wrapped), [decoy]);
    // Image-label input_text is still a part, so it can match. Environment, developer, and system items cannot.
    const label = await findIn(h, home, { text: "<image name=[Image #1] path=\"/tmp/synthetic.png\">" });
    assert.equal(label.matchedMessages, 1);
    assert.deepEqual(await imageBytes(label), [decoy]);
    for (const text of ["Environment only.", "Developer only."]) {
      const missed = await findIn(h, home, { text });
      assert.equal(missed.matchedMessages, 0, text);
      assert.deepEqual(missed.images, []);
    }
  });

  test("id match is unique, wins over text, and falls back to text only when no record stores that id", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const byId = await findIn(h, home, { messageId: "msg-target", text: "Exact text." });
    assert.equal(byId.matchedMessages, 1);
    assert.deepEqual(await imageBytes(byId), [decoy]);
    const byClient = await findIn(h, home, { messageId: null, clientMessageId: "client-other", text: "missing" });
    assert.equal(byClient.matchedMessages, 1);
    assert.deepEqual(byClient.images.map(image => image.mime), ["image/png"]);
    assert.deepEqual(await imageBytes(byClient), [png]);
    const both = await findIn(h, home, { messageId: "msg-target", clientMessageId: "client-other", text: "Exact text." });
    assert.equal(both.matchedMessages, 2);
    assert.deepEqual(both.images, []);
    const duplicated = await findIn(h, home, { messageId: "msg-dup", text: "Exact text." });
    assert.equal(duplicated.matchedMessages, 2);
    assert.deepEqual(duplicated.images, []);
    const fallback = await findIn(h, home, { messageId: "paseo-not-stored", clientMessageId: null, text: "Exact text." });
    assert.equal(fallback.matchedMessages, 1);
    assert.deepEqual(await imageBytes(fallback), [png, jpeg]);
  });

  test("duplicate text returns the match count and no images", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const duplicated = await findIn(h, home, { text: "Same words." });
    assert.equal(duplicated.matchedMessages, 2);
    assert.deepEqual(duplicated.images, []);
    const parts = await findIn(h, home, { text: "Shared part" });
    assert.equal(parts.matchedMessages, 2);
    assert.deepEqual(parts.images, []);
  });

  test("no matching text returns zero messages and no images", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const result = await findIn(h, home, { text: "Nothing in the rollout." });
    assert.equal(result.matchedMessages, 0);
    assert.deepEqual(result.images, []);
  });

  test("missing session ids, an unknown thread, a missing home, and a non-directory home return no images", async t => {
    const h = harness();
    const { root, home } = installRich(t, h);
    const absentIds = await findIn(h, home, { sessionId: null, nativeHandle: null, text: "Exact text." });
    assert.equal(absentIds.matchedMessages, 0);
    assert.deepEqual(absentIds.images, []);
    const unknown = await findIn(h, home, { sessionId: ABSENT_THREAD, nativeHandle: null, text: "Exact text." });
    assert.equal(unknown.matchedMessages, 0);
    const missingHome = join(root, "missing-home");
    const missing = await findIn(h, missingHome, { text: "Exact text." });
    assert.equal(missing.matchedMessages, 0);
    assert.equal(fs.existsSync(missingHome), false);
    const fileHome = join(root, "home-file");
    fs.writeFileSync(fileHome, "not a directory");
    const notDir = await findIn(h, fileHome, { text: "Exact text." });
    assert.equal(notDir.matchedMessages, 0);
    assert.equal(fs.readFileSync(fileHome, "utf8"), "not a directory");
  });

  test("a missing rollout and a deleted rollout return no images and do not recreate the file", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "codex-home");
    fs.mkdirSync(join(home, "sessions"), { recursive: true });
    const missing = await findIn(h, home, { text: "Exact text." });
    assert.equal(missing.matchedMessages, 0);
    assert.deepEqual(fs.readdirSync(join(home, "sessions")), []);
    const path = writeRollout(home, THREAD, [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(png)])]);
    fs.unlinkSync(path);
    const removed = await findIn(h, home, { text: "Exact text." });
    assert.equal(removed.matchedMessages, 0);
    assert.deepEqual(removed.images, []);
    assert.equal(fs.existsSync(path), false);
  });

  test("malformed lines and malformed records are skipped without dropping a unique valid message", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const result = await findIn(h, home, { text: "Exact text." });
    assert.equal(result.matchedMessages, 1);
    assert.deepEqual(await imageBytes(result), [png, jpeg]);
    const root = fixture(t);
    const brokenHome = join(root, "broken");
    writeRollout(brokenHome, THREAD, [
      "not json",
      "{",
      response({ type: "message", role: "user", content: { text: "Exact text.", image_url: dataUrl(decoy) } }),
      response({ type: "message", role: "user", image_url: dataUrl(decoy) }),
      userMessage("Exact text.", [dataUrl(png)]),
    ]);
    const broken = await findIn(h, brokenHome, { text: "Exact text." });
    assert.equal(broken.matchedMessages, 1);
    assert.deepEqual(await imageBytes(broken), [png]);
  });

  test("an unknown record shape returns no images", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const legacy = await findIn(h, home, { text: "Legacy only." });
    assert.equal(legacy.matchedMessages, 0);
    assert.deepEqual(legacy.images, []);
    const root = fixture(t);
    const changed = join(root, "changed");
    writeRollout(changed, THREAD, [
      { type: "turn", role: "user", text: "Exact text.", content: [{ type: "image", url: dataUrl(png) }] },
      { type: "message", text: "Exact text.", images: [dataUrl(decoy)] },
    ]);
    const result = await findIn(h, changed, { text: "Exact text." });
    assert.equal(result.matchedMessages, 0);
    assert.deepEqual(result.images, []);
  });

  test("path escape attempts do not leave the store or invent files", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "home");
    const outsideHome = join(root, "outside-home");
    const outsideRollout = writeRollout(outsideHome, THREAD, [
      sessionMeta(THREAD), userMessage("Secret text.", [dataUrl(decoy)]),
    ]);
    const outsideBytes = fs.readFileSync(outsideRollout);
    const dated = join(home, "sessions", "2026", "01", "02");
    fs.mkdirSync(dated, { recursive: true });
    fs.symlinkSync(outsideRollout, join(dated, `rollout-2026-01-02T03-04-05-${THREAD}.jsonl`));
    const linkedHome = join(root, "linked-home");
    fs.mkdirSync(linkedHome);
    // sessions -> the outside sessions tree. Following it would find the secret rollout.
    fs.symlinkSync(join(outsideHome, "sessions"), join(linkedHome, "sessions"));
    const sentinel = join(root, "sentinel-not-created.png");
    writeRollout(home, OTHER_THREAD, [
      sessionMeta(OTHER_THREAD),
      response({ type: "message", role: "user", content: [
        { type: "input_text", text: "Path fields." },
        { type: "input_image", file_id: sentinel },
        { type: "input_image", image_url: sentinel },
        { type: "input_image", image_url: `file://${sentinel}` },
        { type: "input_image", image_url: { url: dataUrl(decoy) } },
        { type: "input_image", image_url: dataUrl(png) },
      ] }),
    ]);
    const beforeOutside = fs.readFileSync(outsideRollout);
    for (const sessionId of ["../outside", "..", "/tmp/secret.jsonl", `..\\${THREAD}`, "sessions/../../outside"]) {
      const escaped = await findIn(h, home, { sessionId, nativeHandle: null, text: "Secret text." });
      assert.equal(escaped.matchedMessages, 0, sessionId);
      assert.deepEqual(escaped.images, []);
    }
    const symlinked = await findIn(h, home, { sessionId: THREAD, nativeHandle: null, text: "Secret text." });
    assert.equal(symlinked.matchedMessages, 0);
    assert.deepEqual(symlinked.images, []);
    const linked = await findIn(h, linkedHome, { sessionId: THREAD, text: "Secret text." });
    assert.equal(linked.matchedMessages, 0);
    assert.deepEqual(linked.images, []);
    const paths = await findIn(h, home, { sessionId: OTHER_THREAD, text: "Path fields." });
    assert.equal(paths.matchedMessages, 1);
    assert.deepEqual(paths.images.map(image => image.id), ["4"]);
    assert.deepEqual(await imageBytes(paths), [png]);
    assert.equal(fs.existsSync(sentinel), false);
    assert.deepEqual(fs.readFileSync(outsideRollout), beforeOutside);
    assert.equal(outsideBytes.length > 0, true);
  });

  test("an oversized data URL stays in the count and its payload is not returned", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "codex-home");
    const prefix = png.toString("base64");
    const encodedLength = (Math.floor(h.MAX_INLINE_IMAGE_BYTES / 3) + 1) * 4;
    const over = prefix + "A".repeat(encodedLength - prefix.length);
    const decodedLength = (over.length / 4) * 3;
    assert.ok(decodedLength > h.MAX_INLINE_IMAGE_BYTES);
    assert.ok(decodedLength <= h.MAX_IMAGE_BYTES);
    writeRollout(home, THREAD, [
      sessionMeta(THREAD),
      userMessage("Big picture.", [`data:image/png;base64,${over}`, dataUrl(png)]),
    ]);
    const result = await findIn(h, home, { text: "Big picture." });
    assert.equal(result.matchedMessages, 1);
    assert.deepEqual(result.images.map(image => [image.id, image.mime]), [["0", "image/png"], ["1", "image/png"]]);
    const oversized = await result.images[0].readBytes();
    assert.ok(oversized.length > h.MAX_INLINE_IMAGE_BYTES);
    assert.notEqual(oversized.length, decodedLength);
    assert.equal(oversized.subarray(0, 8).equals(png.subarray(0, 8)), false);
    const kept = await result.images[1].readBytes();
    assert.deepEqual(kept, png);
    const listed = await askRegistry(h, home, "Big picture.", { id: "0" });
    assert.equal(listed.images.total, 2);
    assert.equal(listed.images.reason, "too_large_bytes");
    assert.deepEqual(listed.images.images.map(image => image.id), ["1"]);
    assert.equal(listed.image.dataUri, null);
    assert.equal(listed.image.error, "image_too_large");
    const full = await askRegistry(h, home, "Big picture.", { id: "1" });
    assert.equal(full.image.error, null);
    assert.equal(full.image.mime, "image/png");
    assert.deepEqual(Buffer.from(full.image.dataUri.split(",")[1], "base64"), png);
  });

  test("a rollout is used only when it is unique across the live and archived trees", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "codex-home");
    writeRollout(home, THREAD, [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(png)])], { archived: true });
    const archived = await findIn(h, home, { text: "Exact text." });
    assert.equal(archived.matchedMessages, 1);
    assert.deepEqual(await imageBytes(archived), [png]);
    // Same thread and prompt, different image. Live must not win before archived is considered.
    writeRollout(home, THREAD, [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(jpeg, "image/jpeg")])]);
    const conflict = await findIn(h, home, { text: "Exact text." });
    assert.equal(conflict.matchedMessages, 2);
    assert.deepEqual(conflict.images, []);
    const listed = await askRegistry(h, home, "Exact text.");
    assert.deepEqual(listed.images, emptyList("ambiguous"));
    assert.equal(listed.image.dataUri, null);
    assert.equal(listed.image.error, "ambiguous");
  });

  test("concatenated text and a separate input_text part count as two messages", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "codex-home");
    writeRollout(home, THREAD, [
      sessionMeta(THREAD),
      response({ type: "message", role: "user", content: [
        { type: "input_text", text: "Exact " },
        { type: "input_text", text: "text." },
        { type: "input_image", image_url: dataUrl(png) },
      ] }),
      response({ type: "message", role: "user", content: [
        { type: "input_text", text: "Exact text." },
        { type: "input_text", text: " tail" },
        { type: "input_image", image_url: dataUrl(jpeg, "image/jpeg") },
      ] }),
    ]);
    // One message matches by concatenation, the other by a single part. A message that matches both forms is still one.
    writeRollout(home, OTHER_THREAD, [sessionMeta(OTHER_THREAD), userMessage("Exact text.", [dataUrl(gif, "image/gif")])]);
    const conflict = await findIn(h, home, { text: "Exact text." });
    assert.equal(conflict.matchedMessages, 2);
    assert.deepEqual(conflict.images, []);
    const listed = await askRegistry(h, home, "Exact text.");
    assert.deepEqual(listed.images, emptyList("ambiguous"));
    assert.equal(listed.image.dataUri, null);
    assert.equal(listed.image.error, "ambiguous");
    const unique = await findIn(h, home, { sessionId: OTHER_THREAD, text: "Exact text." });
    assert.equal(unique.matchedMessages, 1);
    assert.deepEqual(await imageBytes(unique), [gif]);
  });

  test("an EIO while opening a sibling directory returns no image", async t => {
    const fsp = require("node:fs/promises");
    const wrapped = Object.create(fsp);
    Object.defineProperty(wrapped, "opendir", {
      value: async (path, options) => {
        if (String(path).endsWith("/sibling-eio")) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
        return fsp.opendir(path, options);
      },
    });
    const h = harness({ "node:fs/promises": wrapped });
    const root = fixture(t);
    const home = join(root, "codex-home");
    writeRollout(home, THREAD, [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(png)])]);
    fs.mkdirSync(join(home, "sessions", "sibling-eio"));
    const listed = await askRegistry(h, home, "Exact text.");
    assert.deepEqual(listed.images, emptyList("lookup_failed"));
    assert.equal(listed.image.dataUri, null);
    assert.equal(listed.image.error, "lookup_failed");
  });

  test("a second matching rollout beyond the walk depth returns no image", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "codex-home");
    writeRollout(home, THREAD, [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(png)])]);
    // Walk depth starts at 0 on sessions and stops after 6. The parent of this file is not opened.
    const deep = join(home, "sessions", "l0", "l1", "l2", "l3", "l4", "l5", "l6");
    fs.mkdirSync(deep, { recursive: true });
    const records = [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(jpeg, "image/jpeg")])];
    fs.writeFileSync(join(deep, `rollout-2026-01-02T04-05-06-${THREAD}.jsonl`), `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
    const listed = await askRegistry(h, home, "Exact text.");
    assert.deepEqual(listed.images, emptyList("lookup_failed"));
    assert.equal(listed.image.dataUri, null);
    assert.equal(listed.image.error, "lookup_failed");
  });

  test("a same-text message appended between the rollout reads returns no image", async t => {
    const root = fixture(t);
    const home = join(root, "codex-home");
    const rollout = writeRollout(home, THREAD, [sessionMeta(THREAD), userMessage("Exact text.", [dataUrl(png)])]);
    const extra = `${JSON.stringify(userMessage("Exact text.", [dataUrl(jpeg, "image/jpeg")]))}\n`;
    const nodeFs = require("node:fs");
    let reads = 0;
    const wrapped = Object.create(nodeFs);
    Object.defineProperty(wrapped, "createReadStream", {
      value(...args) {
        reads += 1;
        if (reads === 2) nodeFs.appendFileSync(rollout, extra);
        return nodeFs.createReadStream(...args);
      },
    });
    const h = harness({ "node:fs": wrapped });
    const handlers = h.createPromptImageHandlers();
    const input = { agentId: "agent-synthetic", messageId: null, clientMessageId: null, text: "Exact text." };
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const listed = await handlers.images(input, agentHost());
      assert.equal(reads, 2);
      assert.deepEqual(listed, emptyList("lookup_failed"));
      assert.equal(nodeFs.readFileSync(rollout, "utf8").split("\n").filter(Boolean).length, 3);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  test("nativeHandle is used when sessionId misses, and two different files are not mixed", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const byHandle = await findIn(h, home, { sessionId: ABSENT_THREAD, nativeHandle: THREAD, text: "Exact text." });
    assert.equal(byHandle.matchedMessages, 1);
    assert.deepEqual(await imageBytes(byHandle), [png, jpeg]);
    const mixed = await findIn(h, home, { sessionId: THREAD, nativeHandle: OTHER_THREAD, text: "Exact text." });
    assert.equal(mixed.matchedMessages, 0);
    assert.deepEqual(mixed.images, []);
  });

  test("gif, webp, and image/jpg are accepted and svg, http, and non-base64 urls are not", async t => {
    const h = harness();
    const root = fixture(t);
    const home = join(root, "codex-home");
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>").toString("base64");
    writeRollout(home, THREAD, [sessionMeta(THREAD), response({ type: "message", role: "user", content: [
      { type: "input_text", text: "Formats." },
      { type: "input_image", image_url: dataUrl(gif, "image/gif") },
      { type: "input_image", image_url: dataUrl(webp, "image/webp") },
      { type: "input_image", image_url: dataUrl(jpeg, "image/jpg") },
      { type: "input_image", image_url: `data:image/svg+xml;base64,${svg}` },
      { type: "input_image", image_url: "https://example.invalid/synthetic.png" },
      { type: "input_image", image_url: "data:image/png,not-base64" },
      { type: "input_image", image_url: dataUrl(png) },
    ] })]);
    const result = await findIn(h, home, { text: "Formats." });
    assert.equal(result.matchedMessages, 1);
    assert.deepEqual(result.images.map(image => image.id), ["0", "1", "2", "6"]);
    assert.deepEqual(result.images.map(image => image.mime), ["image/gif", "image/webp", "image/jpeg", "image/png"]);
    assert.deepEqual(await imageBytes(result), [gif, webp, jpeg, png]);
  });

  test("an aborted lookup returns no images", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const controller = new AbortController();
    controller.abort();
    const result = await findIn(h, home, { signal: controller.signal, text: "Exact text." });
    assert.equal(result.matchedMessages, 0);
    assert.deepEqual(result.images, []);
  });

  test("the registry returns images only for a unique match and logs no prompt, path, or image data", async t => {
    const h = harness();
    const { home } = installRich(t, h);
    const handlers = h.createPromptImageHandlers();
    const host = sessionId => ({
      paseo: { agents: { ref(id) {
        assert.equal(id, "agent-synthetic");
        const snapshot = {
          provider: "codex",
          cwd: "/tmp/synthetic-workspace",
          persistence: { provider: "codex", sessionId, nativeHandle: null },
        };
        return { refresh: async () => ({ agent: snapshot }), current: () => snapshot };
      } } },
    });
    const input = { agentId: "agent-synthetic", messageId: null, clientMessageId: null, text: "Exact text." };
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const images = await handlers.images(input, host(THREAD));
      assert.equal(images.reason, null);
      assert.equal(images.total, 2);
      assert.deepEqual(images.images.map(image => image.id), ["0", "1"]);
      assert.equal(images.images[0].mime, "image/png");
      const full = await handlers.image({ ...input, id: "1" }, host(THREAD));
      assert.equal(full.error, null);
      assert.equal(full.mime, "image/jpeg");
      assert.deepEqual(Buffer.from(full.dataUri.split(",")[1], "base64"), jpeg);
      const duplicate = await handlers.images({ ...input, text: "Same words." }, host(THREAD));
      assert.deepEqual(duplicate, { images: [], total: 0, reason: "ambiguous" });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
    const dumped = JSON.stringify(h.logs);
    assert.equal(dumped.includes("Exact text."), false);
    assert.equal(dumped.includes("Same words."), false);
    assert.equal(dumped.includes(THREAD), false);
    assert.equal(dumped.includes("base64"), false);
    assert.equal(dumped.includes(home), false);
    assert.equal(dumped.includes("synthetic"), false);
  });
});
