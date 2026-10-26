const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function load(filename, cache = new Map()) {
  filename = resolve(__dirname, "..", filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = { exports: {} }; cache.set(filename, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const realRequire = createRequire(filename);
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(
    id => id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`), cache) : realRequire(id), mod, mod.exports,
  );
  return mod.exports;
}

/** Implements exactly the durable store contract, with controllable I/O barriers. */
class FakeHistoryStore {
  rows = new Map();
  calls = [];
  before = async () => {};
  id(key) { return JSON.stringify([key.providerId, key.nativeSessionId]); }
  async operation(method, key, event) {
    this.calls.push({ method, key: structuredClone(key), event: structuredClone(event) });
    await this.before(method, key, event);
  }
  async start(key) {
    await this.operation("start", key);
    if (this.rows.has(this.id(key))) throw new Error("journal exists");
    this.rows.set(this.id(key), { events: [], open: false });
  }
  async append(key, event) {
    await this.operation("append", key, event);
    const row = this.rows.get(this.id(key));
    if (row && !row.reason) row.events.push(structuredClone(event));
  }
  async turnStarted(key) {
    await this.operation("turnStarted", key);
    const row = this.rows.get(this.id(key));
    if (row && !row.reason) row.open = true;
  }
  async turnSettled(key) {
    await this.operation("turnSettled", key);
    const row = this.rows.get(this.id(key));
    if (row && !row.reason) row.open = false;
  }
  async invalidate(key, reason) {
    await this.operation("invalidate", key);
    const row = this.rows.get(this.id(key));
    if (row) row.reason = reason;
  }
  async read(key) {
    await this.operation("read", key);
    const row = this.rows.get(this.id(key));
    return !row ? { status: "unusable", reason: "missing" }
      : row.reason || row.open ? { status: "unusable", reason: row.reason ?? "unsettled turn" }
      : { status: "complete", events: structuredClone(row.events) };
  }
}
const key = { providerId: "hermes-cc", nativeSessionId: "native-session" };
const persistence = { version: 1, data: { sessionId: key.nativeSessionId } };
const historyOnly = events => events.filter(event => event.type === "timeline.item" || event.type === "session.turn");
const timeline = events => events.filter(event => event.type === "timeline.item");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function waitEvent(connection, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("provider event timed out")); }, 5000);
    const unsubscribe = connection.onEvent(event => {
      if (!predicate(event)) return;
      clearTimeout(timer); unsubscribe(); resolve(event);
    });
  });
}

function fixture(t, store = new FakeHistoryStore()) {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = join(root, "hermes"), log = join(root, "requests.jsonl");
  fs.writeFileSync(command, `#!/usr/bin/env node
    const fs = require("node:fs"), readline = require("node:readline");
    let held;
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
    const update = value => send({ method: "session/update", params: { sessionId: "native-session", update: value } });
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + "\\n");
      const reply = result => send({ id: request.id, result });
      if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
      else if (request.method === "session/new") reply({ sessionId: "native-session" });
      else if (request.method === "session/load") {
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hermes stored " } });
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "rewritten text" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hermes stored reply" } });
        if (process.env.FAIL_LOAD) send({ id: request.id, error: { code: -32603, message: "fixture load failed" } });
        else reply({});
      } else if (request.method === "session/prompt") {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
        update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read", status: "in_progress" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
        update({ sessionUpdate: "plan", entries: [{ content: "Done", priority: "medium", status: "completed" }] });
        update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" });
        if (request.params.prompt.some(part => part.text === "hold")) held = request.id;
        else reply({ stopReason: "end_turn" });
      } else if (request.method === "session/cancel") {
        if (held !== undefined) { send({ id: held, result: { stopReason: "cancelled" } }); held = undefined; }
        if (request.id !== undefined) reply({});
      } else if (request.id !== undefined) reply({});
    });
  `);
  fs.chmodSync(command, 0o700);
  const modules = new Map();
  const { createHermesCcImageStore } = load("server/hermes-cc/store.ts", modules);
  const images = createHermesCcImageStore(join(root, "images"));
  const { hermesCcPromptImageResolver: resolver } = load("server/prompt-images/hermes-cc.ts", modules);
  const requests = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  async function connect(options = {}) {
    // Reload the provider module for each simulated daemon: no runtime or counters survive.
    const { hermesCcProvidersFromConfig } = load("server/hermes-cc/provider.ts");
    const [provider] = hermesCcProvidersFromConfig({ hermes: {
      extends: "acp", command: [command, "acp"], env: options.failLoad ? { FAIL_LOAD: "1" } : {},
    } }, true, async info => {
      if (info.clientMessageId) await images.save({ sessionKey: info.sessionKey, messageId: info.clientMessageId }, info.images);
    }, store);
    const connection = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.command", "prompt.image", "session.persistence"] });
    t.after(() => connection.close());
    const events = [];
    connection.onEvent(event => events.push(structuredClone(event)));
    return { connection, events };
  }
  async function open(h, boundary = "first", persist, history = persist ? "replay" : "skip") {
    const ready = waitEvent(h.connection, event => event.type === "session.ready" || event.type === "request.failed");
    const input = { type: "session.open", sessionId: boundary, requestId: `open-${boundary}`, history,
      config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true, systemPrompt: "keep config" },
      ...(persist ? { persistence: persist } : {}),
    };
    const before = structuredClone(input);
    await h.connection.send(input);
    const result = await ready;
    assert.deepEqual(input, before);
    return result;
  }
  async function prompt(h, boundary = "first", clientMessageId = "original-client", text = "  Original\n🎉  ", content) {
    const input = { type: "session.prompt", sessionId: boundary, prompt: { clientMessageId, delivery: "auto",
      input: { type: "message", content: content ?? [{ type: "text", text }] } } };
    const before = structuredClone(input);
    const done = waitEvent(h.connection, event => event.type === "session.turn" && event.state !== "started"
      && (event.turnId === `acp:${clientMessageId}` || event.turnId.endsWith(`:acp:${clientMessageId}`)));
    await h.connection.send(input);
    await done;
    assert.deepEqual(input, before);
    assert.deepEqual(requests().filter(request => request.method === "session/prompt").at(-1).params, {
      sessionId: "native-session", prompt: before.prompt.input.content,
    });
  }
  return { root, store, images, resolver, requests, connect, open, prompt };
}

test("new sessions record final snapshots; a fresh ACP runtime loads once and replays exact IDs, text and images before ready", async t => {
  const f = fixture(t), first = await f.connect();
  assert.equal((await f.open(first)).type, "session.ready");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
  await f.prompt(first, "first", "original-client", undefined, [
    { type: "text", text: "  Original\n🎉  " }, { type: "image", mimeType: "image/png", data: png.toString("base64") },
  ]);
  const recorded = await f.store.read(key);
  assert.equal(recorded.status, "complete");
  assert.deepEqual(recorded.events, historyOnly(first.events));
  assert.deepEqual(timeline(recorded.events).filter(event => event.item.type === "assistant_message").map(event => event.item.text), ["Hello", "Hello world"]);
  assert.deepEqual(new Set(timeline(recorded.events).map(event => event.item.type)), new Set(["user_message", "reasoning", "assistant_message", "tool_call", "todo", "compaction"]));
  assert.deepEqual(timeline(recorded.events)[0].item, { type: "user_message", id: "original-client", clientMessageId: "original-client", text: "  Original\n🎉  " });
  assert.equal(f.store.calls.filter(call => call.method === "start").length, 1);
  await first.connection.close();

  const second = await f.connect();
  assert.equal((await f.open(second, "resumed", persistence)).type, "session.ready");
  assert.equal(f.requests().filter(request => request.method === "session/load").length, 1);
  assert.deepEqual(f.requests().find(request => request.method === "session/load").params, {
    sessionId: "native-session", cwd: f.root, mcpServers: [], _meta: { _paseo: { systemPrompt: "keep config", persist: true } },
  });
  assert.deepEqual(historyOnly(second.events), recorded.events.map(event => ({ ...event, sessionId: "resumed" })));
  assert.equal(second.events.at(-1).type, "session.ready");
  assert.deepEqual(await f.store.read(key), recorded, "replay must not append itself");
  const user = timeline(second.events)[0].item;
  const found = await f.resolver.find({ provider: "hermes-cc", sessionId: `plugin:${JSON.stringify(persistence)}`,
    messageId: user.id, clientMessageId: user.clientMessageId, text: "ignored", hermesCcImageStore: f.images, signal: new AbortController().signal });
  assert.equal(found.matchedMessages, 1);
  assert.deepEqual(await found.images[0].readBytes(), png);

  const oldIds = new Set(timeline(second.events).map(event => event.item.id));
  const oldTurns = new Set(second.events.filter(event => event.type === "session.turn").map(event => event.turnId));
  const offset = second.events.length;
  await f.prompt(second, "resumed", "next-client");
  for (const event of timeline(second.events.slice(offset))) assert.ok(!oldIds.has(event.item.id));
  for (const event of second.events.slice(offset).filter(event => event.type === "session.turn")) assert.ok(!oldTurns.has(event.turnId));
  assert.match(timeline(second.events.slice(offset)).find(event => event.item.type === "assistant_message").item.id, /^hermes-cc:1:/);
  await second.connection.close();
  const third = await f.connect();
  await f.open(third, "third", persistence);
  const thirdOffset = third.events.length;
  await f.prompt(third, "third", "third-client");
  assert.match(timeline(third.events.slice(thirdOffset)).find(event => event.item.type === "assistant_message").item.id, /^hermes-cc:2:/);
});

test("missing, invalidated and unsettled journals pass the anonymous Hermes replay through", async t => {
  const f = fixture(t);
  for (const reason of ["missing", "invalidated", "unsettled"]) {
    if (reason !== "missing") f.store.rows.set(f.store.id(key), { events: [], open: reason === "unsettled", ...(reason === "invalidated" ? { reason } : {}) });
    const h = await f.connect();
    await f.open(h, reason, persistence);
    const user = timeline(h.events)[0].item;
    assert.deepEqual(user, { type: "user_message", id: "user_message_chunk:1", text: "Hermes stored " });
    assert.equal(timeline(h.events)[1].item.text, "Hermes stored rewritten text");
    assert.equal(user.clientMessageId, undefined);
    assert.equal(f.store.calls.filter(call => call.method === "start").length, 0);
    await h.connection.close();
  }
  assert.equal(f.requests().filter(request => request.method === "session/load").length, 3);
});

test("slash commands invalidate before forwarding and force normal replay on the next runtime", async t => {
  const f = fixture(t), first = await f.connect();
  await f.open(first);
  await f.prompt(first);
  f.store.before = async method => {
    if (method === "invalidate") assert.equal(f.requests().filter(request => request.method === "session/prompt").length, 1);
  };
  await f.prompt(first, "first", "slash", "/undo");
  assert.equal((await f.store.read(key)).status, "unusable");
  await first.connection.close();
  const second = await f.connect();
  await f.open(second, "fallback", persistence);
  assert.equal(timeline(second.events)[0].item.id, "user_message_chunk:1");
  assert.ok(!timeline(second.events).some(event => event.item.clientMessageId === "original-client"));
});

test("load failures surface the SDK failure and never present cached history or ready", async t => {
  const f = fixture(t), first = await f.connect();
  await f.open(first); await f.prompt(first); await first.connection.close();
  const second = await f.connect({ failLoad: true });
  const failed = await f.open(second, "failed", persistence);
  assert.equal(failed.type, "request.failed");
  assert.match(failed.error.message, /fixture load failed/);
  assert.deepEqual(historyOnly(second.events), []);
  assert.ok(!second.events.some(event => event.type === "session.ready"));
  assert.equal((await f.store.read(key)).status, "unusable");
  assert.equal(f.requests().filter(request => request.method === "session/load").length, 1);
});

// A synchronous fake provider lets tests hold fsync precisely between events.
function rawConnection() {
  const listeners = new Set(), sent = [];
  return { version: 1, capabilities: [], sent,
    async send(input) { sent.push(input); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); }, async close() {},
  };
}
function queuedHarness(store = new FakeHistoryStore()) {
  const raw = rawConnection();
  const connection = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection(raw, "hermes-cc", store);
  const events = []; connection.onEvent(event => events.push(event));
  const open = (sessionId = "boundary", persist) => connection.send({ type: "session.open", requestId: `open-${sessionId}`, sessionId,
    history: persist ? "replay" : "skip", config: { cwd: "/unused", env: {}, settings: {}, mcpServers: {}, persist: true }, ...(persist ? { persistence: persist } : {}) });
  const opened = (sessionId = "boundary", persist = persistence) => raw.emit({ type: "session.opened", sessionId, requestId: `open-${sessionId}`,
    persistence: persist, capabilities: [], restoration: "core", cwd: "/unused" });
  const ready = (sessionId = "boundary") => raw.emit({ type: "session.ready", sessionId, requestId: `open-${sessionId}` });
  return { raw, connection, store, events, open, opened, ready };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("start and append durability gate every subsequent event; session queues stay independent", async () => {
  const h = queuedHarness(), start = deferred(), append = deferred();
  h.store.before = (method, k) => k.nativeSessionId === "native-session" && method === "start" ? start.promise
    : k.nativeSessionId === "native-session" && method === "append" ? append.promise : Promise.resolve();
  await h.open(); h.opened();
  const event = { type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "counter:1", text: "First snapshot" } };
  h.raw.emit(event); event.item.text = "mutated after emit"; h.ready();
  await tick(); assert.deepEqual(h.events, []);
  await h.open("independent");
  const independentReady = waitEvent(h.connection, event => event.type === "session.ready");
  h.opened("independent", { version: 1, data: { sessionId: "other-native" } }); h.ready("independent");
  await independentReady;
  assert.deepEqual(h.events.map(event => event.sessionId), ["independent", "independent"]);
  start.resolve(); await tick();
  assert.equal(h.events.at(-1).type, "session.opened");
  assert.ok(!h.events.some(event => event.type === "timeline.item"));
  const done = waitEvent(h.connection, event => event.type === "session.ready" && event.sessionId === "boundary");
  append.resolve(); await done;
  assert.deepEqual(h.events.slice(-2).map(event => event.type), ["timeline.item", "session.ready"]);
  assert.equal(h.events.at(-2).item.text, "First snapshot");
  assert.deepEqual((await h.store.read(key)).events, [h.events.at(-2)]);
  await h.connection.close();
});

test("a changed native ID fails the open and invalidates the original key", async () => {
  const h = queuedHarness();
  await h.store.start(key);
  await h.open("boundary", persistence);
  const failed = waitEvent(h.connection, event => event.type === "request.failed");
  h.opened("boundary", { version: 1, data: { sessionId: "wrong-native" } }); h.ready();
  await failed;
  assert.equal((await h.store.read(key)).status, "unusable");
  assert.deepEqual(h.events.map(event => event.type), ["request.failed"]);
  await h.connection.close();
});

test("unbalanced or malformed complete logs fall back; non-history events are excluded from projection", async () => {
  for (const events of [
    [{ type: "session.turn", sessionId: "old", turnId: "unfinished", state: "started" }],
    [{ type: "timeline.item", sessionId: "old", item: { type: "user_message", id: "bad" } }],
    [{ type: "session.turn", sessionId: "old", turnId: "unstarted", state: "completed" }],
  ]) {
    const h = queuedHarness();
    h.store.rows.set(h.store.id(key), { events, open: false });
    await h.open("boundary", persistence);
    assert.equal(h.raw.sent[0].history, "replay");
    assert.equal((await h.store.read(key)).status, "unusable");
    await h.connection.close();
  }
  const h = queuedHarness();
  h.store.rows.set(h.store.id(key), { events: [
    { type: "session.ready", sessionId: "old" },
    { type: "session.permission", sessionId: "old", request: { id: "permission", name: "tool", kind: "tool" } },
    { type: "timeline.item", sessionId: "old", item: { type: "error", id: "error", message: "old error" } },
    { type: "timeline.item", sessionId: "old", item: { type: "user_message", id: "original", clientMessageId: "original", text: "saved" } },
  ], open: false });
  await h.open("boundary", persistence);
  assert.equal(h.raw.sent[0].history, "skip");
  const ready = waitEvent(h.connection, event => event.type === "session.ready");
  h.opened(); h.ready(); await ready;
  assert.deepEqual(h.events.map(event => event.type), ["session.opened", "timeline.item", "session.ready"]);
  await h.connection.close();
});

test("the durable busy marker precedes SDK admission; admission ACKs cannot settle a live turn", async t => {
  const f = fixture(t), h = await f.connect(); await f.open(h);
  const barrier = deferred(), started = deferred();
  f.store.before = async method => { if (method === "turnStarted") { started.resolve(); await barrier.promise; } };
  const admitted = waitEvent(h.connection, event => event.type === "session.prompt_result");
  const send = h.connection.send({ type: "session.prompt", sessionId: "first", prompt: {
    clientMessageId: "held", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hold" }] },
  } });
  await started.promise;
  assert.equal(f.requests().filter(request => request.method === "session/prompt").length, 0);
  barrier.resolve(); await send; await admitted;
  assert.deepEqual(await f.store.read(key), { status: "unusable", reason: "unsettled turn" });
  const completed = waitEvent(h.connection, event => event.type === "session.turn" && event.state === "canceled");
  await h.connection.send({ type: "session.interrupt", sessionId: "first", requestId: "cancel" }); await completed;
  assert.equal((await f.store.read(key)).status, "complete");
});

test("append failures fail closed and invalidate instead of emitting a partial timeline", async () => {
  const h = queuedHarness(); await h.open();
  const ready = waitEvent(h.connection, event => event.type === "session.ready"); h.opened(); h.ready(); await ready;
  h.store.before = async method => { if (method === "append") throw new Error("fixture fsync failed"); };
  const failed = waitEvent(h.connection, event => event.type === "session.runtime_failed");
  h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "reply", text: "lost" } });
  h.raw.emit({ type: "session.config", sessionId: "boundary", config: { models: [], modes: [], thinkingOptions: [], settings: [] } });
  await failed; await tick();
  assert.deepEqual(h.events.map(event => event.type), ["session.opened", "session.ready", "session.runtime_failed"]);
  assert.equal((await h.store.read(key)).status, "unusable");
  await h.connection.close();
});

test("request replies, permissions and errors stay ordered behind appends and stay out of the journal", async () => {
  const h = queuedHarness(); await h.open();
  const ready = waitEvent(h.connection, event => event.type === "session.ready"); h.opened(); h.ready(); await ready;
  const append = deferred(), entered = deferred();
  h.store.before = async method => { if (method === "append") { entered.resolve(); await append.promise; } };
  await h.connection.send({ type: "session.configure", requestId: "configure", sessionId: "boundary", changes: {} });
  h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "answer", text: "saved" } });
  h.raw.emit({ type: "session.permission", sessionId: "boundary", request: { id: "permission", name: "tool", kind: "tool" } });
  h.raw.emit({ type: "request.completed", requestId: "configure" });
  h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "error", id: "error", message: "not saved" } });
  await entered.promise;
  assert.deepEqual(h.events.map(event => event.type), ["session.opened", "session.ready"]);
  const error = waitEvent(h.connection, event => event.type === "timeline.item" && event.item.type === "error");
  append.resolve(); await error;
  assert.deepEqual(h.events.slice(2).map(event => event.type), ["timeline.item", "session.permission", "request.completed", "timeline.item"]);
  assert.deepEqual((await h.store.read(key)).events, [h.events[2]]);
  await h.connection.close();
});

test("a restart during a live ACP prompt falls back instead of replaying its partial journal", async t => {
  const f = fixture(t), first = await f.connect(); await f.open(first);
  const admitted = waitEvent(first.connection, event => event.type === "session.prompt_result");
  await first.connection.send({ type: "session.prompt", sessionId: "first", prompt: {
    clientMessageId: "held", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hold" }] },
  } });
  await admitted;
  await first.connection.close();
  assert.equal((await f.store.read(key)).status, "unusable");
  const second = await f.connect(); await f.open(second, "restarted", persistence);
  assert.equal(timeline(second.events)[0].item.id, "user_message_chunk:1");
  assert.ok(!timeline(second.events).some(event => event.item.clientMessageId === "held"));
});

test("overlapping prompts keep the journal busy until both ACP turns settle", async t => {
  const f = fixture(t), h = await f.connect(); await f.open(h);
  const admitted = waitEvent(h.connection, event => event.type === "session.prompt_result");
  await h.connection.send({ type: "session.prompt", sessionId: "first", prompt: {
    clientMessageId: "first-held", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hold" }] },
  } });
  await admitted;
  let readAtCancel;
  const unsubscribe = h.connection.onEvent(event => {
    if (event.type === "session.turn" && event.state === "canceled") readAtCancel = f.store.read(key);
  });
  await f.prompt(h, "first", "next-client"); unsubscribe();
  assert.equal((await readAtCancel).status, "unusable");
  assert.equal((await f.store.read(key)).status, "complete");
  assert.equal(f.store.calls.filter(call => call.method === "turnStarted").length, 1);
  assert.equal(f.store.calls.filter(call => call.method === "turnSettled").length, 1);
});

test("journal read failures fall back after invalidation; persisted skip opens never start a new journal", async () => {
  const h = queuedHarness(); await h.store.start(key);
  h.store.read = async () => { throw new Error("fixture read failed"); };
  await h.open("boundary", persistence);
  assert.equal(h.raw.sent[0].history, "replay");
  assert.equal(h.store.rows.get(h.store.id(key)).reason, "journal read failed");
  await h.connection.close();

  const other = queuedHarness(); await other.store.start(key);
  const input = { type: "session.open", requestId: "open-skip", sessionId: "skip", history: "skip", persistence,
    config: { cwd: "/unused", env: {}, settings: {}, mcpServers: {}, persist: true } };
  await other.connection.send(input);
  const ready = waitEvent(other.connection, event => event.type === "session.ready"); other.opened("skip"); other.ready("skip"); await ready;
  assert.strictEqual(other.raw.sent[0], input);
  assert.equal(other.store.calls.filter(call => call.method === "start").length, 1);
  assert.equal((await other.store.read(key)).status, "unusable");
  await other.connection.close();
});

test("structured command prompts invalidate and preserve the SDK command conversion", async t => {
  const f = fixture(t), h = await f.connect(); await f.open(h);
  const done = waitEvent(h.connection, event => event.type === "session.turn" && event.state === "completed");
  const input = { type: "session.prompt", sessionId: "first", prompt: {
    clientMessageId: "command", delivery: "auto", input: { type: "command", name: "undo", arguments: "  last  " },
  } };
  const before = structuredClone(input);
  await h.connection.send(input); await done;
  assert.deepEqual(input, before);
  assert.equal((await f.store.read(key)).status, "unusable");
  assert.deepEqual(f.requests().find(request => request.method === "session/prompt").params.prompt, [{ type: "text", text: "/undo   last  " }]);
});

test("server contribution injects the supplied history store into its registered real ACP provider", async t => {
  const f = fixture(t), previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = f.root;
  t.after(() => { if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome; });
  fs.writeFileSync(join(f.root, "config.json"), JSON.stringify({ version: 1, agents: { providers: {
    hermes: { extends: "acp", command: [join(f.root, "hermes"), "acp"] },
  } } }));
  const providers = [];
  const { contributeWithHermesCcHistory } = load("index.server.ts");
  const cleanup = contributeWithHermesCcHistory({ registerSettings() {}, handle() {}, registerProvider(provider) { providers.push(provider); } }, f.store);
  t.after(cleanup);
  assert.equal(providers.length, 1);
  const connection = await providers[0].connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  t.after(() => connection.close());
  await f.open({ connection });
  await f.prompt({ connection });
  assert.equal((await f.store.read(key)).status, "complete");
  assert.ok((await f.store.read(key)).events.some(event => event.type === "timeline.item" && event.item.clientMessageId === "original-client"));
});
