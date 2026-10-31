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
    const { hermesCcProvidersFromConfig } = load("server/hermes-cc/provider.ts", options.modules);
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

test("load failures preserve the settled journal and a retry replays it without exposing failed-open history", async t => {
  const f = fixture(t), first = await f.connect();
  await f.open(first); await f.prompt(first); await first.connection.close();
  const saved = await f.store.read(key);
  const second = await f.connect({ failLoad: true });
  const failed = await f.open(second, "failed", persistence);
  assert.equal(failed.type, "request.failed");
  assert.match(failed.error.message, /fixture load failed/);
  assert.deepEqual(historyOnly(second.events), []);
  assert.ok(!second.events.some(event => event.type === "session.ready"));
  assert.deepEqual(await f.store.read(key), saved);
  assert.equal(f.requests().filter(request => request.method === "session/load").length, 1);
  await second.connection.close();
  const retry = await f.connect(); await f.open(retry, "retry", persistence);
  assert.deepEqual(historyOnly(retry.events), saved.events.map(event => ({ ...event, sessionId: "retry" })));
  assert.equal(f.store.calls.filter(call => call.method === "invalidate").length, 0);
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
function queuedHarness(store = new FakeHistoryStore(), journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection) {
  const raw = rawConnection();
  const connection = journal(raw, "hermes-cc", store);
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
  await h.open(); h.opened(); h.ready();
  await tick(); assert.deepEqual(h.events, []);
  await h.open("independent");
  const independentReady = waitEvent(h.connection, event => event.type === "session.ready");
  h.opened("independent", { version: 1, data: { sessionId: "other-native" } }); h.ready("independent");
  await independentReady;
  assert.deepEqual(h.events.map(event => event.sessionId), ["independent", "independent"]);
  const ready = waitEvent(h.connection, event => event.type === "session.ready" && event.sessionId === "boundary");
  start.resolve(); await ready;
  const event = { type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "counter:1", text: "First snapshot" } };
  h.raw.emit(event); event.item.text = "mutated after emit";
  h.raw.emit({ type: "session.config", sessionId: "boundary", config: { models: [], modes: [], thinkingOptions: [], settings: [] } });
  await tick(); assert.equal(h.events.at(-1).type, "session.ready");
  const done = waitEvent(h.connection, event => event.type === "session.config");
  append.resolve(); await done;
  assert.deepEqual(h.events.slice(-2).map(event => event.type), ["timeline.item", "session.config"]);
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
  assert.deepEqual(h.events.map(event => event.type), ["timeline.item", "session.opened", "session.ready"]);
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

test("append failures stop recording without terminating the live session", async () => {
  const h = queuedHarness(); await h.open();
  const ready = waitEvent(h.connection, event => event.type === "session.ready"); h.opened(); h.ready(); await ready;
  h.store.before = async method => { if (method === "append") throw new Error("fixture fsync failed"); };
  const shown = waitEvent(h.connection, event => event.type === "timeline.item" && event.item.id.endsWith("reply"));
  h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "reply", text: "live" } });
  await shown;
  assert.equal(h.events.some(event => event.type === "session.runtime_failed"), false);
  assert.equal((await h.store.read(key)).status, "unusable");
  await h.connection.close();
});

test("a failed prompt journal write leaves the session open and permits a retry after recovery", async t => {
  const h = queuedHarness(); seed(h.store);
  t.after(() => h.connection.close());
  await h.open("boundary", persistence); await becomeReady(h);
  let unavailable = true;
  h.store.before = async method => {
    if (unavailable && (method === "turnStarted" || method === "invalidate")) throw new Error("fixture storage unavailable");
  };
  await assert.rejects(h.connection.send(promptInput("boundary", "not-sent")), /fixture storage unavailable/);
  await tick();
  assert.equal(h.raw.sent.some(input => input.prompt?.clientMessageId === "not-sent"), false);
  assert.equal(h.events.some(event => event.type === "session.runtime_failed"), false);
  await assert.rejects(h.connection.send(promptInput("boundary", "retry-unavailable")), /journal unavailable/);
  assert.equal(h.raw.sent.some(input => input.prompt?.clientMessageId === "retry-unavailable"), false);
  assert.equal((await h.store.read(key)).status, "complete", "the unchanged journal contains no forwarded prompt");
  unavailable = false;
  await h.connection.send(promptInput("boundary", "retry"));
  assert.equal(h.raw.sent.at(-1).prompt.clientMessageId, "retry");
  assert.equal((await h.store.read(key)).status, "unusable");
});

test("a failed retry cannot leave a stale saved disk journal after reopening", async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-retry-disk-"));
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const store = createHermesCcHistoryStore(root);
  await store.start(key);
  const h = queuedHarness(store);
  t.after(async () => { await h.connection.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await h.open("boundary", persistence); await becomeReady(h);
  const turnStarted = store.turnStarted.bind(store), invalidate = store.invalidate.bind(store);
  let unavailable = true;
  store.turnStarted = async (...args) => { if (unavailable) throw new Error("disk unavailable"); return turnStarted(...args); };
  store.invalidate = async (...args) => { if (unavailable) throw new Error("disk unavailable"); return invalidate(...args); };
  await assert.rejects(h.connection.send(promptInput("boundary", "first")), /disk unavailable/);
  await assert.rejects(h.connection.send(promptInput("boundary", "retry")), /journal unavailable/);
  assert.equal(h.raw.sent.filter(input => input.type === "session.prompt").length, 0);
  assert.equal((await createHermesCcHistoryStore(root).read(key)).status, "complete", "the disk snapshot contains every forwarded prompt");
  unavailable = false;
  const send = h.raw.send;
  h.raw.send = async input => {
    assert.equal((await createHermesCcHistoryStore(root).read(key)).status, "unusable", "the fence is durable before forwarding");
    await send(input);
  };
  await h.connection.send(promptInput("boundary", "recovered"));
  assert.equal(h.raw.sent.at(-1).prompt.clientMessageId, "recovered");
  assert.equal((await createHermesCcHistoryStore(root).read(key)).status, "unusable");
});

test("an overlapping prompt survives an append failure and fences subsequent sends", async t => {
  const h = queuedHarness(); seed(h.store);
  t.after(() => h.connection.close());
  await h.open("boundary", persistence); await becomeReady(h);
  await h.connection.send(promptInput("boundary", "first"));
  await h.connection.send(promptInput("boundary", "overlap"));
  assert.equal(h.store.calls.filter(call => call.method === "turnStarted").length, 1);
  let unavailable = true;
  h.store.before = async method => {
    if (unavailable && (method === "append" || method === "invalidate")) throw new Error("fixture storage unavailable");
  };
  const shown = waitEvent(h.connection, event => event.type === "timeline.item" && event.item.text === "live overlap");
  h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "overlap-reply", text: "live overlap" } });
  await shown;
  assert.equal(h.events.some(event => event.type === "session.runtime_failed"), false);
  assert.equal((await h.store.read(key)).reason, "unsettled turn");
  await assert.rejects(h.connection.send(promptInput("boundary", "blocked")), /journal unavailable/);
  assert.equal(h.raw.sent.some(input => input.prompt?.clientMessageId === "blocked"), false);
  unavailable = false;
  await h.connection.send(promptInput("boundary", "after-recovery"));
  assert.equal(h.raw.sent.at(-1).prompt.clientMessageId, "after-recovery");
  assert.equal((await h.store.read(key)).status, "unusable");
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

test("journal read failures fall back after invalidation; persisted skip opens leave the journal alone", async () => {
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
  assert.equal(other.store.calls.filter(call => call.method !== "start").length, 0);
  assert.equal((await other.store.read(key)).status, "complete");
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

const savedTranscript = () => [
  { type: "timeline.item", sessionId: "original", item: {
    type: "user_message", id: "original-client", clientMessageId: "original-client", text: "Original prompt",
  } },
  { type: "timeline.item", sessionId: "original", item: {
    type: "assistant_message", id: "hermes-cc:0:agent_message_chunk:1", text: "Original answer",
  } },
];
function seed(store, events = savedTranscript()) {
  store.rows.set(store.id(key), { events, open: false });
}
function promptInput(sessionId = "boundary", clientMessageId = "new-client", text = "New prompt") {
  return { type: "session.prompt", sessionId, prompt: {
    clientMessageId, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] },
  } };
}
async function becomeReady(h, sessionId = "boundary") {
  const ready = waitEvent(h.connection, event => event.type === "session.ready" && event.sessionId === sessionId);
  h.opened(sessionId); h.ready(sessionId); await ready;
}

function toolTranscript(status = "failed", error = null) {
  const events = savedTranscript();
  events.splice(1, 0, { type: "timeline.item", sessionId: "original", item: {
    type: "tool_call", id: "hermes-cc:0:tool:1", callId: "hermes-cc:0:call:1", name: "Read fixture.txt",
    detail: { type: "unknown", input: { path: "fixture.txt" }, output: null }, status, error,
  } });
  return events;
}

test("a complete legacy failed-null tool journal releases its lease before forwarding the original native replay", async t => {
  const h = queuedHarness(); t.after(() => h.connection.close());
  const saved = toolTranscript(); seed(h.store, saved);
  const order = [];
  h.store.claimWriter = async k => {
    assert.deepEqual(k, key); order.push("claim");
    return { token: "11111111-1111-1111-1111-111111111111", generation: 0,
      async release() { order.push("release"); } };
  };
  h.store.before = async (method, k) => { assert.deepEqual(k, key); order.push(method); };
  const input = { type: "session.open", requestId: "open-boundary", sessionId: "boundary", history: "replay", persistence,
    config: { cwd: "/unused", env: {}, settings: {}, mcpServers: {}, persist: true } };
  const send = h.raw.send;
  h.raw.send = async value => { order.push("send"); await send(value); };
  await h.connection.send(input);
  assert.strictEqual(h.raw.sent[0], input, "native replay retains the entire original open and persistence identity");
  assert.deepEqual(order, ["claim", "read", "invalidate", "release", "send"]);
  assert.equal(h.store.rows.get(h.store.id(key)).reason, "journal projection is invalid");
  assert.deepEqual(h.store.rows.get(h.store.id(key)).events, saved, "invalidation never rewrites journal events");
  const native = { type: "timeline.item", sessionId: "boundary", item: {
    type: "assistant_message", id: "native-answer", text: "Native history has no image content available",
  } };
  h.raw.emit(native);
  await becomeReady(h);
  assert.deepEqual(historyOnly(h.events), [native], "only available native history is forwarded, without image reconstruction");
  assert.deepEqual(h.raw.sent, [input], "recovery sends no new-session request or prompt");
});

for (const [status, error] of [["failed", { message: "Actual failure" }], ["completed", null], ["running", null]]) {
  test(`a complete healthy ${status} tool journal keeps exact local replay`, async t => {
    const h = queuedHarness(); t.after(() => h.connection.close());
    const saved = toolTranscript(status, error); seed(h.store, saved);
    await h.open("boundary", persistence); await becomeReady(h);
    assert.equal(h.raw.sent[0].history, "skip");
    assert.deepEqual(h.raw.sent[0].persistence, persistence);
    assert.deepEqual(historyOnly(h.events), saved.map(event => ({ ...event, sessionId: "boundary" })));
    assert.deepEqual(h.store.calls.map(call => call.method), ["read"]);
    assert.deepEqual(h.store.rows.get(h.store.id(key)), { events: saved, open: false });
  });
}

test("caller skip never touches a complete legacy failed-null tool journal", async () => {
  const h = queuedHarness(); const saved = toolTranscript(); seed(h.store, saved);
  h.store.claimWriter = async () => { assert.fail("caller skip must not claim a writer"); };
  const input = { type: "session.open", requestId: "open-boundary", sessionId: "boundary", history: "skip", persistence,
    config: { cwd: "/unused", env: {}, settings: {}, mcpServers: {}, persist: true } };
  await h.connection.send(input); await becomeReady(h); await h.connection.close();
  assert.strictEqual(h.raw.sent[0], input);
  assert.deepEqual(h.store.calls, []);
  assert.deepEqual(h.store.rows.get(h.store.id(key)), { events: saved, open: false });
  assert.deepEqual(historyOnly(h.events), []);
});

test("an idle runtime failure preserves the exact journal for the next open", async () => {
  const h = queuedHarness(); seed(h.store);
  await h.open("boundary", persistence); await becomeReady(h);
  const saved = await h.store.read(key), failed = waitEvent(h.connection, event => event.type === "session.runtime_failed");
  h.raw.emit({ type: "session.runtime_failed", sessionId: "boundary", error: { message: "idle transport closed" } }); await failed;
  assert.deepEqual(await h.store.read(key), saved);
  await h.open("retry", persistence); await becomeReady(h, "retry");
  assert.equal(h.raw.sent.at(-1).history, "skip");
  assert.deepEqual(historyOnly(h.events.filter(event => event.sessionId === "retry")), saved.events.map(event => ({ ...event, sessionId: "retry" })));
  assert.equal(h.store.calls.filter(call => call.method === "invalidate").length, 0);
  await h.connection.close();
});

test("a runtime failure during this process's admitted turn leaves its durable flag unsettled", async () => {
  const h = queuedHarness(); seed(h.store);
  await h.open("boundary", persistence); await becomeReady(h);
  await h.connection.send(promptInput());
  const failed = waitEvent(h.connection, event => event.type === "session.runtime_failed");
  h.raw.emit({ type: "session.runtime_failed", sessionId: "boundary", error: { message: "transport closed mid-turn" } }); await failed;
  assert.deepEqual(await h.store.read(key), { status: "unusable", reason: "unsettled turn" });
  await h.open("retry", persistence);
  assert.equal(h.raw.sent.at(-1).history, "replay");
  assert.equal(h.store.calls.filter(call => call.method === "invalidate" || call.method === "turnSettled").length, 0);
  await h.connection.close();
});

for (const kind of ["request before opened", "request after opened", "send throws", "runtime before ready"]) {
  test(`generic open failure (${kind}) drops the opening buffer and preserves the settled journal`, async () => {
    const h = queuedHarness(); seed(h.store);
    const saved = await h.store.read(key);
    if (kind === "send throws") {
      const send = h.raw.send;
      h.raw.send = async () => {
        h.opened();
        h.raw.emit({ type: "session.config", sessionId: "boundary", config: { models: [], modes: [], thinkingOptions: [], settings: [] } });
        throw new Error("generic open failure");
      };
      await assert.rejects(h.open("boundary", persistence), /generic open failure/);
      h.raw.send = send;
    } else {
      await h.open("boundary", persistence);
      const failed = waitEvent(h.connection, event => event.type === "request.failed");
      if (kind !== "request before opened") h.opened();
      h.raw.emit(kind === "runtime before ready"
        ? { type: "session.runtime_failed", sessionId: "boundary", error: { message: "generic open failure" } }
        : { type: "request.failed", requestId: "open-boundary", error: { message: "generic open failure" } });
      await failed;
    }
    h.ready(); await tick();
    assert.deepEqual(h.events.filter(event => event.type !== "request.failed"), []);
    assert.deepEqual(await h.store.read(key), saved);
    await h.open("retry", persistence); await becomeReady(h, "retry");
    assert.equal(h.raw.sent.at(-1).history, "skip");
    assert.deepEqual(timeline(h.events).map(event => event.item.text), ["Original prompt", "Original answer"]);
    assert.equal(h.store.calls.filter(call => call.method === "invalidate").length, 0);
    await h.connection.close();
  });
}

for (const resume of [false, true]) for (const beforeOpened of [true, false]) {
  test(`${resume ? "resume" : "create"} history ${beforeOpened ? "before opened" : "between opened and ready"} is buffered and invalidates future replay`, async () => {
    const h = queuedHarness(); if (resume) seed(h.store);
    await h.open("boundary", resume ? persistence : undefined);
    if (!beforeOpened) h.opened();
    const aside = { type: "timeline.item", sessionId: "boundary", item: {
      type: "assistant_message", id: "agent_message_chunk:9", text: "config-time aside",
    } };
    h.raw.emit(aside); aside.item.text = "mutated after emit";
    if (beforeOpened) h.opened();
    h.raw.emit({ type: "session.config", sessionId: "boundary", config: { models: [], modes: [], thinkingOptions: [], settings: [] } });
    await tick(); assert.deepEqual(h.events, [], "all opening events wait for ready");
    const ready = waitEvent(h.connection, event => event.type === "session.ready"); h.ready(); await ready;
    assert.deepEqual(timeline(h.events).map(event => event.item.text), resume
      ? ["Original prompt", "Original answer", "config-time aside"] : ["config-time aside"]);
    if (resume) assert.deepEqual(h.events.slice(0, 2).map(event => event.item.text), ["Original prompt", "Original answer"]);
    assert.equal((await h.store.read(key)).status, "unusable");
    assert.equal(h.store.calls.filter(call => call.method === "append").length, 0);
    await h.open("retry", persistence); await becomeReady(h, "retry");
    assert.equal(h.raw.sent.at(-1).history, "replay");
    assert.deepEqual(timeline(h.events).filter(event => event.sessionId === "retry"), []);
    await h.connection.close();
  });
}

test("two connections cannot record one native key, and an idle second reader does no damage", async () => {
  const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
  const store = new FakeHistoryStore(); seed(store);
  const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
  await a.open("a", persistence); await becomeReady(a, "a");
  await b.open("b", persistence); await becomeReady(b, "b");
  assert.equal(a.raw.sent[0].history, "skip");
  assert.equal(b.raw.sent[0].history, "replay");
  assert.equal((await store.read(key)).status, "complete");
  assert.equal(store.calls.filter(call => call.method === "invalidate").length, 0);
  await b.connection.close();
  assert.equal((await store.read(key)).status, "complete");
  await a.connection.close();
  const c = queuedHarness(store, journal); await c.open("c", persistence); await becomeReady(c, "c");
  assert.equal(c.raw.sent[0].history, "skip", "closing the owner releases its local claim");
  await c.connection.close();
});

test("a refused claimant presents a recording failure rather than a saved message", async t => {
  const store = new FakeHistoryStore(); seed(store);
  const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
  const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
  t.after(() => a.connection.close()); t.after(() => b.connection.close());
  await a.open("a", persistence); await becomeReady(a, "a");
  await b.open("b", persistence); await becomeReady(b, "b");
  await tick();
  const notices = b.events.filter(event => event.type === "timeline.item" && event.item.type === "notification");
  assert.equal(notices.length, 1);
  assert.match(notices[0].item.message, /could not record/i);
  assert.doesNotMatch(notices[0].item.message, /\brecorded\b/i);
});

for (const mutation of ["prompt", "live update"]) {
  test(`a second connection's ${mutation} invalidates before it can produce a mixed journal`, async () => {
    const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
    const store = new FakeHistoryStore(); seed(store);
    const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
    await a.open("a", persistence); await becomeReady(a, "a");
    await b.open("b", persistence); await becomeReady(b, "b");
    await a.connection.send(promptInput("a", "from-a"));
    if (mutation === "prompt") await b.connection.send(promptInput("b", "from-b"));
    assert.equal(store.rows.get(store.id(key)).reason, mutation === "prompt" ? "foreign_writer" : undefined);
    const shown = waitEvent(b.connection, event => event.type === "timeline.item");
    b.raw.emit({ type: "timeline.item", sessionId: "b", item: {
      type: "assistant_message", id: "agent_message_chunk:1", text: "answer B",
    } }); await shown;
    assert.ok(store.rows.get(store.id(key)).reason);
    for (const [h, sessionId] of [[a, "a"], [b, "b"]]) {
      const done = waitEvent(h.connection, event => event.type === "session.turn" && event.state === "completed");
      h.raw.emit({ type: "session.prompt_result", sessionId, clientMessageId: `from-${sessionId}`,
        result: { type: "turn", turnId: `turn-${sessionId}` } });
      h.raw.emit({ type: "session.turn", sessionId, turnId: `turn-${sessionId}`, state: "started" });
      h.raw.emit({ type: "timeline.item", sessionId, item: {
        type: "user_message", id: `from-${sessionId}`, clientMessageId: `from-${sessionId}`, text: `from ${sessionId}`,
      } });
      h.raw.emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id: "answer", text: `answer ${sessionId}` } });
      h.raw.emit({ type: "session.turn", sessionId, turnId: `turn-${sessionId}`, state: "completed" });
      await done;
    }
    assert.equal(store.calls.filter(call => call.method === "turnStarted").length, 1, "only the owner marks turns");
    assert.equal(store.calls.filter(call => call.method === "turnSettled").length, 1, "the second session cannot settle the owner's flag");
    assert.equal(store.calls.filter(call => call.method === "append" && call.event.sessionId === "b").length, 0);
    assert.equal((await store.read(key)).status, "unusable", "even both terminal turns cannot make a mixed journal complete");
    await a.connection.close(); await b.connection.close();
    const retry = queuedHarness(store, journal); await retry.open("retry", persistence);
    assert.equal(retry.raw.sent[0].history, "replay");
    await retry.connection.close();
  });
}

test("a rejected second-session prompt still invalidates before forwarding", async () => {
  const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
  const store = new FakeHistoryStore(); seed(store);
  const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
  await a.open("a", persistence); await becomeReady(a, "a");
  await b.open("b", persistence); await becomeReady(b, "b");
  b.raw.send = async () => { throw new Error("prompt rejected"); };
  await assert.rejects(b.connection.send(promptInput("b")), /prompt rejected/);
  assert.deepEqual(await store.read(key), { status: "unusable", reason: "foreign_writer" });
  assert.equal(store.calls.filter(call => call.method === "invalidate").length, 1);
  await a.connection.close(); await b.connection.close();
});

for (const ownerClosed of [false, true]) for (const mutation of ["prompt", "slash command", "structured command", "revert"]) {
  test(`a non-owner's ${mutation} waits for durable invalidation (owner closed: ${ownerClosed})`, async t => {
    const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
    const store = new FakeHistoryStore(); seed(store);
    const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
    t.after(() => a.connection.close()); t.after(() => b.connection.close());
    await a.open("a", persistence); await becomeReady(a, "a");
    await b.open("b", persistence); await becomeReady(b, "b");
    if (ownerClosed) await a.connection.close();
    const entered = deferred(), barrier = deferred();
    t.after(() => barrier.resolve());
    store.before = async method => { if (method === "invalidate") { entered.resolve(); await barrier.promise; } };
    const input = mutation === "revert"
      ? { type: "session.revert", sessionId: "b", requestId: "revert", turnId: "old-turn" }
      : promptInput("b", "foreign", mutation === "slash command" ? "/undo" : "New prompt");
    if (mutation === "structured command") input.prompt.input = { type: "command", name: "undo", arguments: "" };
    const sending = b.connection.send(input); await entered.promise;
    await tick();
    assert.equal(b.raw.sent.length, 1, "no mutation reaches Hermes before fsync");
    assert.equal((await store.read(key)).status, "complete");
    const send = b.raw.send;
    b.raw.send = async value => {
      assert.deepEqual(await store.read(key), { status: "unusable", reason: "foreign_writer" });
      await send(value);
    };
    barrier.resolve(); await sending;
    assert.strictEqual(b.raw.sent.at(-1), input);
  });
}

test("a lost lease fences the triggering prompt before it reaches Hermes", async t => {
  const h = queuedHarness(); seed(h.store);
  t.after(() => h.connection.close());
  await h.open("boundary", persistence); await becomeReady(h);
  h.store.turnStarted = async () => {
    h.store.rows.get(h.store.id(key)).reason = "writer_changed";
    throw new Error("writer_changed");
  };
  const entered = deferred(), barrier = deferred();
  t.after(() => barrier.resolve());
  h.store.before = async method => { if (method === "invalidate") { entered.resolve(); await barrier.promise; } };
  const sending = h.connection.send(promptInput()); await entered.promise;
  assert.equal(h.raw.sent.length, 1);
  barrier.resolve(); await sending;
  assert.equal(h.raw.sent.at(-1).type, "session.prompt");
  assert.deepEqual(await h.store.read(key), { status: "unusable", reason: "foreign_writer" });
});

test("failed foreign invalidation blocks prompts and poisons every local recorder and future open", async t => {
  const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
  const store = new FakeHistoryStore(); seed(store);
  const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
  t.after(() => a.connection.close()); t.after(() => b.connection.close());
  await a.open("a", persistence); await becomeReady(a, "a");
  await b.open("b", persistence); await becomeReady(b, "b");
  store.before = async method => { if (method === "invalidate") throw new Error("disk unavailable"); };
  await assert.rejects(b.connection.send(promptInput("b", "foreign")), /journal unavailable/);
  for (const [h, sessionId] of [[a, "a"], [b, "b"]]) {
    const shown = waitEvent(h.connection, event => event.type === "timeline.item");
    h.raw.emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id: "live", text: "live answer" } });
    await shown;
    assert.equal(h.events.some(event => event.type === "session.runtime_failed"), false);
  }
  await assert.rejects(a.connection.send(promptInput("a", "owner-after-failure")), /journal unavailable/);
  assert.equal(b.raw.sent.some(input => input.prompt?.clientMessageId === "foreign"), false);
  assert.equal(a.raw.sent.some(input => input.prompt?.clientMessageId === "owner-after-failure"), false);
  assert.equal(store.calls.filter(call => call.method === "turnStarted").length, 0);
  const c = queuedHarness(store, journal); t.after(() => c.connection.close());
  await c.open("c", persistence); await becomeReady(c, "c");
  assert.equal(c.raw.sent[0].history, "replay", "an unavailable fence never restores the old snapshot");
  assert.deepEqual(historyOnly(c.events), []);
  store.before = async () => {};
  await a.connection.send(promptInput("a", "retry-persistence"));
  assert.deepEqual(await store.read(key), { status: "unusable", reason: "foreign_writer" });
  assert.equal(store.calls.filter(call => call.method === "append" || call.method === "turnSettled").length, 0);
});

test("a foreign prompt during the creator's in-flight claim fences creation and the next open", async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-foreign-creation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
  const store = createHermesCcHistoryStore(root), entered = deferred(), claimed = deferred();
  const claim = store.claimWriter.bind(store);
  store.claimWriter = async k => {
    const lease = await claim(k);
    entered.resolve(); await claimed.promise;
    return lease;
  };
  t.after(() => claimed.resolve());
  const a = queuedHarness(store, journal), b = queuedHarness(createHermesCcHistoryStore(root), journal);
  t.after(() => a.connection.close()); t.after(() => b.connection.close());
  await a.open("a");
  const ready = waitEvent(a.connection, event => event.type === "session.ready");
  a.opened("a"); a.ready("a"); await entered.promise;
  await b.open("b", persistence); await becomeReady(b, "b");
  assert.equal(b.raw.sent[0].history, "replay");
  const send = b.raw.send;
  b.raw.send = async input => {
    if (input.type === "session.prompt") {
      assert.deepEqual(await createHermesCcHistoryStore(root).read(key), { status: "unusable", reason: "foreign_writer" });
    }
    return send(input);
  };
  await b.connection.send(promptInput("b", "foreign"));
  claimed.resolve(); await ready;
  const shown = waitEvent(a.connection, event => event.type === "timeline.item");
  a.raw.emit({ ...savedTranscript()[1], sessionId: "a" }); await shown;
  assert.deepEqual(await store.read(key), { status: "unusable", reason: "foreign_writer" });
  await a.connection.close(); await b.connection.close();
  const next = queuedHarness(createHermesCcHistoryStore(root), journal);
  t.after(() => next.connection.close());
  await next.open("next", persistence); await becomeReady(next, "next");
  assert.equal(next.raw.sent[0].history, "replay");
  assert.deepEqual(historyOnly(next.events), [], "no journal identities are restored for image lookup");
});

test("a foreign fence synced during a resume's events read keeps that open on Hermes replay", async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-foreign-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const store = createHermesCcHistoryStore(root);
  await store.start(key);
  for (const event of savedTranscript()) await store.append(key, event);
  const h = queuedHarness(store);
  t.after(() => h.connection.close());
  const readState = store.read.bind(store);
  let state;
  store.read = async k => state = await readState(k);

  const fsp = require("node:fs/promises"), open = fsp.open, synced = deferred();
  let invalidating;
  t.mock.method(fsp, "open", async (path, ...args) => {
    const handle = await open(path, ...args);
    if (String(path).includes("/.foreign-")) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); synced.resolve(); };
    }
    if (String(path).endsWith("/events.jsonl")) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        if (!invalidating) {
          invalidating = store.invalidate(key, "foreign_writer");
          // Marker close follows both file and directory fsync. Invalidation
          // cannot publish its manifest until this read leaves the key's lane.
          await synced.promise;
        }
        return result;
      };
    }
    return handle;
  });

  await h.open("boundary", persistence);
  assert.ok(invalidating, "invalidation started inside the events-file read");
  await invalidating;
  await becomeReady(h);
  assert.deepEqual(state, { status: "unusable", reason: "foreign_writer" });
  assert.equal(h.raw.sent[0].history, "replay");
  assert.deepEqual(historyOnly(h.events), [], "no journal user message IDs are restored for image lookup");
});

test("a truncated writer lease keeps the open on Hermes replay", async t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-bad-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const store = createHermesCcHistoryStore(root);
  await store.start(key);
  for (const event of savedTranscript()) await store.append(key, event);
  const name = require("node:crypto").createHash("sha256").update(`${key.providerId}\0${key.nativeSessionId}`).digest("hex");
  const path = join(root, `.writer-${name}`);
  fs.writeFileSync(path, "{not-json");
  const h = queuedHarness(store);
  t.after(() => h.connection.close());
  await h.open("boundary", persistence); await becomeReady(h);
  assert.equal(h.raw.sent.length, 1);
  assert.equal(h.raw.sent[0].history, "replay");
  assert.deepEqual(historyOnly(h.events).filter(event => event.item?.type !== "notification"), []);
  assert.equal(fs.readFileSync(path, "utf8"), "{not-json");
  await h.connection.send(promptInput());
  assert.equal(h.raw.sent.at(-1).type, "session.prompt");
  assert.deepEqual(await store.read(key), { status: "unusable", reason: "foreign_writer" });
});

test("a crash at the foreign prompt fence reopens durable rows using Hermes replay without images", async t => {
  const entered = deferred(), persist = deferred(), persisted = deferred(), forward = deferred();
  t.after(() => { persist.resolve(); forward.resolve(); });
  const root = fs.mkdtempSync(join(tmpdir(), "cc-foreign-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const store = createHermesCcHistoryStore(root), observer = createHermesCcHistoryStore(root);
  await store.start(key);
  for (const event of savedTranscript()) await store.append(key, event);
  const f = fixture(t, store), modules = new Map();
  const a = await f.connect({ modules }), b = await f.connect({ modules });
  await f.open(a, "a", persistence); await f.open(b, "b", persistence);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
  await f.images.save({ sessionKey: key.nativeSessionId, messageId: "original-client" }, [{ mime: "image/png", data: png }]);
  assert.equal((await f.resolver.find({ provider: "hermes-cc", sessionId: `plugin:${JSON.stringify(persistence)}`,
    messageId: "original-client", hermesCcImageStore: f.images, signal: new AbortController().signal,
  })).matchedMessages, 1, "the stale identity would restore its original image");
  const invalidate = store.invalidate.bind(store);
  store.invalidate = async (k, reason) => {
    assert.equal(reason, "foreign_writer");
    entered.resolve(); await persist.promise;
    await invalidate(k, reason);
    persisted.resolve(); await forward.promise;
  };
  const sending = b.connection.send(promptInput("b", "foreign")); await entered.promise;
  assert.equal((await observer.read(key)).status, "complete");
  assert.equal(f.requests().filter(request => request.method === "session/prompt").length, 0);
  persist.resolve(); await persisted.promise;
  assert.deepEqual(await observer.read(key), { status: "unusable", reason: "foreign_writer" });
  assert.equal(f.requests().filter(request => request.method === "session/prompt").length, 0);
  // Drop the original owner's runtime/lease without allowing the blocked prompt
  // or any history event to run. Only the persisted fence survives the restart.
  await a.connection.close();
  const recoveredStore = createHermesCcHistoryStore(root), restarted = fixture(t, recoveredStore);
  const resumed = await restarted.connect(); await restarted.open(resumed, "restarted", persistence);
  assert.deepEqual(timeline(resumed.events).map(event => event.item.text), ["Hermes stored ", "Hermes stored rewritten text", "Hermes stored reply"]);
  assert.ok(!timeline(resumed.events).some(event => event.item.clientMessageId === "original-client"));
  for (const event of timeline(resumed.events).filter(event => event.item.type === "user_message")) {
    assert.deepEqual(await f.resolver.find({ provider: "hermes-cc", sessionId: `plugin:${JSON.stringify(persistence)}`,
      messageId: event.item.id, clientMessageId: event.item.clientMessageId, text: event.item.text,
      hermesCcImageStore: f.images, signal: new AbortController().signal,
    }), { matchedMessages: 0, images: [] });
  }
  forward.resolve(); await sending;
});

test("simultaneous opens reserve a single recorder before asynchronous reads", async () => {
  const journal = load("server/hermes-cc/history-connection.ts").journalHermesCcConnection;
  const store = new FakeHistoryStore(); seed(store);
  const barrier = deferred(), entered = deferred();
  store.before = async method => { if (method === "read") { entered.resolve(); await barrier.promise; } };
  const a = queuedHarness(store, journal), b = queuedHarness(store, journal);
  const first = a.open("a", persistence); await entered.promise;
  await b.open("b", persistence);
  assert.equal(b.raw.sent[0].history, "replay");
  barrier.resolve(); await first;
  assert.equal(a.raw.sent[0].history, "skip");
  await a.connection.close(); await b.connection.close();
});

test("a rejected start leaves the existing journal intact and emits only an open failure", async () => {
  const h = queuedHarness(); seed(h.store);
  const saved = await h.store.read(key);
  await h.open();
  const failed = waitEvent(h.connection, event => event.type === "request.failed");
  h.opened(); h.ready(); await failed; await tick();
  assert.deepEqual(await h.store.read(key), saved);
  assert.deepEqual(h.events.map(event => event.type), ["request.failed"]);
  assert.equal(h.store.calls.filter(call => call.method === "invalidate").length, 0);
  await h.open("retry", persistence); await becomeReady(h, "retry");
  assert.equal(h.raw.sent.at(-1).history, "skip");
  await h.connection.close();
});

test("a settled clientMessageId cannot be reused with different text in the same runtime", async t => {
  const f = fixture(t), h = await f.connect(); await f.open(h);
  await f.prompt(h, "first", "same-client", "first wording");
  f.store.before = async method => {
    if (method === "invalidate") assert.equal(f.requests().filter(request => request.method === "session/prompt").length, 1);
  };
  await f.prompt(h, "first", "same-client", "retried wording");
  assert.equal((await f.store.read(key)).status, "unusable");
  const users = timeline(f.store.rows.get(f.store.id(key)).events).filter(event => event.item.type === "user_message");
  assert.deepEqual(users.map(event => event.item.text), ["first wording"]);
  await h.connection.close();
  const retry = await f.connect(); await f.open(retry, "retry", persistence);
  assert.ok(timeline(retry.events).every(event => event.item.clientMessageId === undefined));
});

test("a clientMessageId already in a resumed journal invalidates before forwarding", async () => {
  const h = queuedHarness(); seed(h.store);
  await h.open("boundary", persistence); await becomeReady(h);
  const send = h.raw.send;
  h.raw.send = async input => {
    assert.equal((await h.store.read(key)).status, "unusable");
    await send(input);
  };
  await h.connection.send(promptInput("boundary", "original-client", "retried wording"));
  assert.equal(h.store.calls.filter(call => call.method === "turnStarted").length, 0);
  assert.equal(h.store.rows.get(h.store.id(key)).reason, "duplicate prompt identity");
  await h.connection.close();
});

test("leading whitespace slash commands invalidate before the SDK receives the original prompt", async t => {
  const f = fixture(t), h = await f.connect(); await f.open(h); await f.prompt(h);
  f.store.before = async method => {
    if (method === "invalidate") assert.equal(f.requests().filter(request => request.method === "session/prompt").length, 1);
  };
  await f.prompt(h, "first", "spaced-command", " \n\t/undo");
  assert.equal((await f.store.read(key)).status, "unusable");
});

test("revert invalidates before forwarding even when the provider rejects it", async () => {
  const h = queuedHarness(); seed(h.store); await h.open("boundary", persistence); await becomeReady(h);
  const send = h.raw.send;
  h.raw.send = async input => { assert.equal((await h.store.read(key)).status, "unusable"); await send(input); };
  await h.connection.send({ type: "session.revert", sessionId: "boundary", requestId: "revert", turnId: "old-turn" });
  const failed = waitEvent(h.connection, event => event.type === "request.failed");
  h.raw.emit({ type: "request.failed", requestId: "revert", error: { message: "unsupported" } }); await failed;
  assert.equal(h.store.rows.get(h.store.id(key)).reason, "history-mutating command");
  await h.connection.close();
});

for (const type of ["error", "notification", "plugin"]) {
  test(`opening ${type} notices wait for the snapshot and stay out of the journal`, async () => {
    const h = queuedHarness(); seed(h.store); const saved = await h.store.read(key);
    await h.open("boundary", persistence);
    const item = type === "plugin" ? { type, id: "notice", pluginId: "plugin", kind: "notice", version: 1, data: {} }
      : { type, id: "notice", message: "opening notice", ...(type === "notification" ? { level: "info" } : {}) };
    h.raw.emit({ type: "timeline.item", sessionId: "boundary", item });
    h.opened(); await tick(); assert.deepEqual(h.events, []);
    const ready = waitEvent(h.connection, event => event.type === "session.ready"); h.ready(); await ready;
    assert.deepEqual(timeline(h.events).map(event => event.item.type), ["user_message", "assistant_message", type]);
    assert.deepEqual(await h.store.read(key), saved);
    await h.connection.close();
  });
}

for (const followup of [
  { type: "session.interrupt", requestId: "interrupt" },
  { type: "session.configure", requestId: "configure", changes: {} },
  { type: "session.permission", permissionId: "permission", response: { behavior: "deny" } },
  { type: "session.close", requestId: "close" },
]) {
  test(`${followup.type} cannot overtake a prompt awaiting turnStarted durability`, async () => {
    const h = queuedHarness(); await h.open(); await becomeReady(h);
    const entered = deferred(), barrier = deferred();
    h.store.before = async method => { if (method === "turnStarted") { entered.resolve(); await barrier.promise; } };
    const prompt = h.connection.send(promptInput()); await entered.promise;
    const next = h.connection.send({ ...followup, sessionId: "boundary" });
    await tick(); assert.deepEqual(h.raw.sent.map(input => input.type), ["session.open"]);
    barrier.resolve(); await Promise.all([prompt, next]);
    assert.deepEqual(h.raw.sent.map(input => input.type), ["session.open", "session.prompt", followup.type]);
    await h.connection.close();
  });
}

for (const resume of [false, true]) test(`a store lease held outside the wrapper fences ${resume ? "resume" : "creation"} sends before forwarding`, async t => {
  const f = fixture(t);
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const root = join(f.root, "history"), owner = createHermesCcHistoryStore(root);
  await owner.start(key);
  for (const event of savedTranscript()) await owner.append(key, event);
  const saved = await owner.read(key), lease = await owner.claimWriter(key);
  assert.ok(lease);
  t.after(() => lease.release());
  const observer = createHermesCcHistoryStore(root), h = queuedHarness(observer);
  t.after(() => h.connection.close());
  await h.open("boundary", resume ? persistence : undefined); await becomeReady(h);
  assert.equal(h.raw.sent[0].history, resume ? "replay" : "skip");
  assert.deepEqual(historyOnly(h.events).filter(event => event.item?.type !== "notification"), [], "a refused claim never hydrates from the journal");
  assert.deepEqual(await observer.read(key), saved, "opening alone never invalidates");
  await h.connection.send(promptInput());
  await h.connection.send(promptInput("boundary", "slash", "/undo"));
  await h.connection.send({ type: "session.revert", sessionId: "boundary", requestId: "revert", turnId: "old-turn" });
  assert.deepEqual(await observer.read(key), { status: "unusable", reason: "foreign_writer" });
  const shown = waitEvent(h.connection, event => event.type === "timeline.item");
  h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "other-writer", text: "new history" } });
  await shown;
  assert.equal((await observer.read(key)).status, "unusable");
  assert.equal(await observer.claimWriter(key), null, "a non-owner cannot release the owner's lease");
  await h.connection.close(); await lease.release();
  const replacement = await observer.claimWriter(key);
  assert.ok(replacement); await replacement.release();
});

test("a refused writer's native identity mismatch fails the open without invalidating the owner's journal", async t => {
  const f = fixture(t);
  const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
  const root = join(f.root, "history"), owner = createHermesCcHistoryStore(root);
  await owner.start(key);
  for (const event of savedTranscript()) await owner.append(key, event);
  const saved = await owner.read(key), lease = await owner.claimWriter(key);
  t.after(() => lease.release());
  const h = queuedHarness(createHermesCcHistoryStore(root));
  await h.open("boundary", persistence);
  const failed = waitEvent(h.connection, event => event.type === "request.failed");
  h.opened("boundary", { version: 1, data: { sessionId: "wrong-native" } });
  await failed;
  assert.deepEqual(await owner.read(key), saved);
  await h.connection.close(); await lease.release();
});

for (const failure of ["open send", "open request", "start", "runtime", "prompt send", "close", "close throws"]) {
  test(`the durable writer lease is released after ${failure}`, async t => {
    const f = fixture(t);
    const { createHermesCcHistoryStore } = load("server/hermes-cc/history-store.ts");
    const root = join(f.root, "history"), store = createHermesCcHistoryStore(root), other = createHermesCcHistoryStore(root);
    await store.start(key);
    for (const event of savedTranscript()) await store.append(key, event);
    const saved = await store.read(key), h = queuedHarness(store);
    t.after(() => h.connection.close());
    if (failure === "open send") {
      h.raw.send = async () => { throw new Error("open send failed"); };
      await assert.rejects(h.open("boundary", persistence), /open send failed/);
    } else {
      await h.open("boundary", failure === "start" ? undefined : persistence);
      if (failure === "start" || failure === "open request") {
        const failed = waitEvent(h.connection, event => event.type === "request.failed");
        if (failure === "start") h.opened();
        else h.raw.emit({ type: "request.failed", requestId: "open-boundary", error: { message: "open failed" } });
        await failed;
      } else {
        await becomeReady(h);
        assert.equal(await other.claimWriter(key), null, "recording owns the store lease");
        if (failure === "runtime") {
          const failed = waitEvent(h.connection, event => event.type === "session.runtime_failed");
          h.raw.emit({ type: "session.runtime_failed", sessionId: "boundary", error: { message: "runtime failed" } });
          await failed;
        } else if (failure === "prompt send") {
          h.raw.send = async () => { throw new Error("prompt send failed"); };
          await assert.rejects(h.connection.send(promptInput()), /prompt send failed/);
        } else if (failure === "close throws") {
          h.raw.close = async () => { throw new Error("close failed"); };
          await assert.rejects(h.connection.close(), /close failed/);
          h.raw.close = async () => {};
        } else await h.connection.close();
      }
    }
    const replacement = await other.claimWriter(key);
    assert.ok(replacement, "cleanup releases ownership before the failure or close is observed");
    await replacement.release();
    if (failure === "prompt send") assert.equal((await other.read(key)).status, "unusable");
    else assert.deepEqual(await other.read(key), saved);
    await h.connection.close();
  });
}

for (const result of [{ type: "completed" }, { type: "failed", error: { message: "admission failed" } }]) {
  test(`a prompt_result ${result.type} cannot certify a terminal ACP turn`, async () => {
    const h = queuedHarness(); await h.open(); await becomeReady(h);
    await h.connection.send(promptInput());
    const reply = waitEvent(h.connection, event => event.type === "session.prompt_result");
    h.raw.emit({ type: "session.prompt_result", sessionId: "boundary", clientMessageId: "client", result });
    await reply;
    assert.equal(h.store.calls.filter(call => call.method === "turnSettled").length, 0);
    assert.equal((await h.store.read(key)).status, "unusable");
    await h.connection.close();
  });
}

test("default contribution restores two image prompts from disk after restart and rejects a tampered journal", async t => {
  const f = fixture(t), previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = f.root;
  t.after(() => { if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome; });
  fs.writeFileSync(join(f.root, "config.json"), JSON.stringify({ version: 1, agents: { providers: {
    hermes: { extends: "acp", command: [join(f.root, "hermes"), "acp"] },
  } } }));
  async function restart() {
    // Fresh contribution, provider, journal, image store and module state share only disk.
    const modules = new Map(), providers = [];
    const cleanup = load("index.server.ts", modules).default({
      registerSettings() {}, handle() {}, registerProvider(provider) { providers.push(provider); },
    });
    t.after(cleanup);
    assert.deepEqual(providers.map(provider => provider.id), ["hermes-cc"]);
    const connection = await providers[0].connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"] });
    t.after(() => connection.close());
    const events = [];
    connection.onEvent(event => events.push(structuredClone(event)));
    const history = load("server/hermes-cc/history-store.ts", modules);
    const images = load("server/hermes-cc/store.ts", modules);
    const historyRoot = history.hermesCcHistoryRoot({});
    assert.equal(historyRoot, join(f.root, "plugin-data", "clear-chat", "hermes-cc-history"));
    return { connection, events, historyRoot,
      store: history.createHermesCcHistoryStore(historyRoot, { trustedRoot: f.root }),
      images: images.createHermesCcImageStore(images.hermesCcImageRoot({}), { trustedRoot: f.root }),
      resolver: load("server/prompt-images/hermes-cc.ts", modules).hermesCcPromptImageResolver,
    };
  }
  const pngs = [
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ].map(value => Buffer.from(value, "base64"));
  assert.notDeepEqual(pngs[0], pngs[1]);
  const first = await restart();
  await f.open(first);
  const texts = ["  First paste\n🎉  ", "Second paste, different image"];
  for (let i = 0; i < pngs.length; i++) await f.prompt(first, "first", `paste-${i}`, texts[i], [
    { type: "text", text: texts[i] }, { type: "image", mimeType: "image/png", data: pngs[i].toString("base64") },
  ]);
  const recorded = await first.store.read(key);
  assert.equal(recorded.status, "complete");
  assert.deepEqual(recorded.events, JSON.parse(JSON.stringify(historyOnly(first.events))));
  assert.equal(recorded.events.filter(event => event.type === "session.turn" && event.state === "completed").length, 2);
  assert.deepEqual(timeline(recorded.events).filter(event => event.item.type === "assistant_message").map(event => event.item.text),
    ["Hello", "Hello world", "Hello", "Hello world"]);
  await first.connection.close();

  const second = await restart();
  assert.notStrictEqual(first.store, second.store);
  assert.notStrictEqual(first.images, second.images);
  await f.open(second, "resumed", persistence);
  assert.equal(f.requests().filter(request => request.method === "session/load").length, 1);
  assert.deepEqual(historyOnly(second.events), recorded.events.map(event => ({ ...event, sessionId: "resumed" })));
  assert.equal(second.events.at(-1).type, "session.ready");
  assert.ok(!timeline(second.events).some(event => event.item.text?.startsWith("Hermes stored")));
  const users = timeline(second.events).filter(event => event.item.type === "user_message").map(event => event.item);
  assert.deepEqual(users, texts.map((text, i) => ({ type: "user_message", id: `paste-${i}`, clientMessageId: `paste-${i}`, text })));
  const lookup = (h, item) => h.resolver.find({ provider: "hermes-cc", sessionId: `plugin:${JSON.stringify(persistence)}`,
    messageId: item.id, clientMessageId: item.clientMessageId, text: item.text,
    hermesCcImageStore: h.images, signal: new AbortController().signal });
  for (let i = 0; i < users.length; i++) {
    const found = await lookup(second, users[i]);
    assert.equal(found.matchedMessages, 1);
    assert.equal(found.images.length, 1);
    assert.deepEqual(await found.images[0].readBytes(), pngs[i]);
  }
  assert.deepEqual(await second.store.read(key), recorded, "hydration never appends itself");
  await second.connection.close();

  const directory = fs.readdirSync(second.historyRoot).find(name => /^[a-f0-9]{64}$/.test(name));
  const file = join(second.historyRoot, directory, "events.jsonl"), bytes = fs.readFileSync(file);
  const offset = bytes.indexOf(Buffer.from("First paste"));
  assert.ok(offset >= 0);
  bytes[offset] ^= 1; // Preserve length and JSON syntax while breaking the hash chain.
  fs.writeFileSync(file, bytes);
  const third = await restart();
  assert.equal((await third.store.read(key)).status, "unusable");
  await f.open(third, "fallback", persistence);
  assert.equal(f.requests().filter(request => request.method === "session/load").length, 2);
  assert.deepEqual(timeline(third.events).map(event => event.item.text),
    ["Hermes stored ", "Hermes stored rewritten text", "Hermes stored reply"]);
  for (const event of timeline(third.events).filter(event => event.item.type === "user_message")) {
    assert.equal(event.item.clientMessageId, undefined);
    assert.deepEqual(await lookup(third, event.item), { matchedMessages: 0, images: [] });
  }
  await third.connection.close();
});

for (const setting of [true, false]) test(`original Hermes sessions never write Clear Chat journals (Hermes·CC enabled: ${setting})`, async t => {
  const f = fixture(t), previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = f.root;
  t.after(() => { if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome; });
  fs.writeFileSync(join(f.root, "config.json"), JSON.stringify({ version: 1, agents: { providers: {
    hermes: { extends: "acp", command: [join(f.root, "hermes"), "acp"] },
  } } }));
  const settings = join(f.root, "plugin-settings", "clear-chat");
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(join(settings, "hermes-cc.json"), JSON.stringify({ version: 1, values: { enabled: setting } }));
  const providers = [];
  t.after(load("index.server.ts").default({ registerSettings() {}, handle() {}, registerProvider(provider) { providers.push(provider); } }));
  assert.deepEqual(providers.map(provider => provider.id), setting ? ["hermes-cc"] : []);
  const { runAcpProvider } = require("@getpaseo/plugin/server/acp");
  const provider = runAcpProvider({ id: "hermes", label: "Hermes", command: [join(f.root, "hermes"), "acp"] });
  const connection = await provider.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  t.after(() => connection.close());
  await f.open({ connection });
  await f.prompt({ connection });
  await connection.close();
  assert.equal(fs.existsSync(join(f.root, "plugin-data")), false, "neither journal nor image storage was written");
});

test("session close releases its recorder, preserves the journal, and forwards the SDK acknowledgement", async () => {
  const h = queuedHarness(); seed(h.store); await h.open("boundary", persistence); await becomeReady(h);
  const saved = await h.store.read(key);
  await h.connection.send({ type: "session.close", sessionId: "boundary", requestId: "close" });
  const completed = waitEvent(h.connection, event => event.type === "request.completed");
  h.raw.emit({ type: "session.closed", sessionId: "boundary" });
  h.raw.emit({ type: "request.completed", requestId: "close" }); await completed;
  assert.deepEqual(h.events.slice(-2).map(event => event.type), ["session.closed", "request.completed"]);
  assert.deepEqual(await h.store.read(key), saved);
  await h.open("boundary", persistence); await becomeReady(h);
  assert.equal(h.raw.sent.at(-1).history, "skip");
  await h.connection.close();
});

for (const rejected of ["start", "append", "turnStarted", "turnSettled"]) {
  test(`a fenced ${rejected} stops recording and keeps the live session usable`, async t => {
    const store = new FakeHistoryStore();
    if (rejected !== "start") seed(store);
    let releases = 0, fenced = false;
    const lease = { token: "11111111-1111-1111-1111-111111111111", generation: 7, async release() { releases++; } };
    store.claimWriter = async () => lease;
    for (const method of ["start", "append", "turnStarted", "turnSettled"]) {
      const original = store[method].bind(store);
      store[method] = async (...args) => {
        assert.equal(args[method === "append" ? 2 : 1], lease, `${method} presents the lease`);
        if (method === rejected) {
          fenced = true;
          const row = store.rows.get(store.id(args[0]));
          if (row) row.reason = "writer_changed";
          throw new Error("writer_changed");
        }
        await original(...args);
      };
    }
    const h = queuedHarness(store);
    t.after(() => h.connection.close());
    await h.open("boundary", rejected === "start" ? undefined : persistence);
    await becomeReady(h);
    if (rejected !== "start") {
      await h.connection.send(promptInput());
      if (rejected === "append") {
        const shown = waitEvent(h.connection, event => event.type === "timeline.item" && event.item.text === "live answer");
        h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "live", text: "live answer" } });
        await shown;
      } else if (rejected === "turnSettled") {
        h.raw.emit({ type: "session.prompt_result", sessionId: "boundary", clientMessageId: "new-client", result: { type: "turn", turnId: "turn" } });
        const settled = waitEvent(h.connection, event => event.type === "session.turn" && event.state === "completed");
        h.raw.emit({ type: "session.turn", sessionId: "boundary", turnId: "turn", state: "completed" });
        await settled;
      }
    }
    assert.equal(fenced, true);
    assert.equal(releases, 1, "a fenced recorder releases its lease");
    const calls = store.calls.length;
    await h.connection.send(promptInput("boundary", "after-fence"));
    const shown = waitEvent(h.connection, event => event.type === "timeline.item" && event.item.text === "after fence");
    h.raw.emit({ type: "timeline.item", sessionId: "boundary", item: { type: "assistant_message", id: "after-fence", text: "after fence" } });
    await shown;
    assert.deepEqual(store.calls.slice(calls).map(call => call.method), ["invalidate"], "the stopped recorder fences later sends");
    assert.equal(h.raw.sent.at(-1).prompt.clientMessageId, "after-fence");
    assert.equal(h.events.some(event => event.type === "request.failed" || event.type === "session.runtime_failed"), false);
    await h.connection.close();
    assert.equal(releases, 1);
  });
}
