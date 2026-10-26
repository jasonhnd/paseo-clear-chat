const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { runInThisContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function harness(runAcpProvider) {
  const logs = [], launches = [], commands = [];
  runAcpProvider ??= options => ({ ...options, connect: async request => {
    await options.connector();
    const connection = fakeConnection();
    const send = connection.send;
    connection.send = async input => {
      // The SDK dispatches asynchronously; preserve per-input launch context.
      await Promise.resolve();
      if (["session.open", "catalog", "sessions"].includes(input.type)) await options.connector();
      return send(input);
    };
    return connection;
  } });
  const factory = runAcpProvider;
  runAcpProvider = options => { commands.push(options); return factory(options); };
  const module = { exports: {} };
  const filename = resolve(__dirname, "../server/hermes-cc/provider.ts");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  runInThisContext(`(function(require,module,exports,console){${compiled}\n})`, { filename })(
    id => {
      if (id === "node:async_hooks" || id === "node:crypto" || id === "zod") return require(id);
      if (id === "./catalog") return { hermesCcCatalogObserver() {} };
      if (id === "./history-connection") {
        const history = { exports: {} };
        const source = ts.transpileModule(readFileSync(resolve(__dirname, "../server/hermes-cc/history-connection.ts"), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        runInThisContext(`(function(require,module,exports){${source}\n})`)(
          name => name === "./session-key" ? { nativeKey() {} } : require(name), history, history.exports,
        );
        return history.exports;
      }
      if (id === "./transport") return { hermesCcTransport: async (command, env, launch) => launches.push({ ...Object.fromEntries(Object.entries(launch ?? {}).filter(([key]) => key !== "userOpen")), command, env }) };
      if (id === "./session-key") {
        const keys = { exports: {} };
        const source = ts.transpileModule(readFileSync(resolve(__dirname, "../server/hermes-cc/session-key.ts"), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        runInThisContext(`(function(module,exports){${source}\n})`)(keys, keys.exports);
        return keys.exports;
      }
      assert.equal(id, "@getpaseo/plugin/server/acp");
      return { runAcpProvider };
    }, module, module.exports, { debug: (...args) => logs.push(args) },
  );
  return { ...module.exports, launches, logs, commands };
}

function fakeConnection() {
  const listeners = new Set(), sent = [];
  return {
    version: 1, capabilities: ["prompt.message", "prompt.image", "session.persistence"], sent,
    async send(input) { sent.push(input); },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { for (const fn of listeners) fn(event); },
    async close() { listeners.clear(); },
    get listenerCount() { return listeners.size; },
  };
}
const persistence = sessionId => ({ version: 1, data: { sessionId } });
const handle = sessionId => `plugin:${JSON.stringify(persistence(sessionId))}`;
const opened = (boundary, native) => ({ type: "session.opened", sessionId: boundary, persistence: persistence(native) });
const prompt = (sessionId, id = "client-1", content = [{ type: "text", text: " unchanged\n🎉 " }]) => ({
  type: "session.prompt", sessionId,
  prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content } },
});

const matches = [
  ["hermes", "acp"], ["hermes", "-p", "zksc-ops", "acp"],
  ["/usr/local/bin/hermes", "--profile", "x", "acp"],
  ["hermes", "--profile=x", "acp"], ["hermes.exe", "acp"], ["HeRmEs.ExE", "acp"], ["HERMES.CMD", "acp"], ["HERMES", "acp"],
  ["C:\\bin\\hermes.cmd", "--profile", "two words", "acp"],
];
const misses = [
  ["gemini", "--acp"], ["hermes", "chat"], ["hermes", "acp", "--extra"],
  ["hermes-wrapper", "acp"], ["hermes", "--profile", "x", "-p", "y", "acp"],
  ["hermes", "--profile=", "acp"], ["hermes", "--profile=-x", "acp"], ["hermes", "--profile=--flag", "acp"], ["hermes", "-p", "", "acp"],
  ["hermes", "-p", "--profile=x", "acp"], ["hermes", "--debug", "acp"],
  ["hermes", "-p=x", "acp"], ["hermes", "--profile", "x", "extra", "acp"],
  ["hermes", "acp", "acp"], ["hermes", "acp", 1], [], null, "hermes acp",
];
for (const command of matches) test(`mirrors ${JSON.stringify(command)} without using provider identity`, async () => {
  const h = harness();
  const config = { arbitrary: { extends: "acp", label: "My assistant", command,
    env: { A: "exact value", EMPTY: "" }, secret: "not retained" } };
  const before = structuredClone(config);
  const providers = h.hermesCcProvidersFromConfig(config, true, async () => {});
  assert.equal(providers.length, 1);
  const [provider] = providers;
  assert.equal(provider.id, "arbitrary-cc");
  assert.equal(provider.label, "My assistant·CC");
  assert.equal(provider.command, undefined);
  assert.equal(h.commands[0].command, undefined);
  assert.equal(provider.secret, undefined);
  assert.equal(provider.extends, undefined);
  assert.equal(provider.env, undefined);
  await provider.connect({ versions: [1], capabilities: [], launch: { command: "/resolved/hermes", args: command.slice(1), env: { HOST: "kept", A: "old" } } });
  assert.deepEqual(h.launches[0], { command, env: h.hermesCcSourceEnv(process.env, { A: "exact value", EMPTY: "" }) });
  assert.deepEqual(config, before);
});
for (const command of misses) test(`ignores ${JSON.stringify(command)}`, () => {
  assert.deepEqual(harness().hermesCcProvidersFromConfig({ hermes: { extends: "acp", label: "Hermes", command } }, true, async () => {}), []);
});

for (const description of ["Runs Hermes with the source profile", undefined]) {
  test(`CC registration ${description === undefined ? "has no description when the source has none" : "carries the source description"}`, async () => {
    const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
    const h = harness(runAcpProvider);
    const source = { extends: "acp", command: ["hermes", "acp"],
      ...(description !== undefined ? { description } : {}) };
    const [provider] = h.hermesCcProvidersFromConfig({ hermes: source }, true, async () => {});
    assert.equal(provider.description, description);
  });
}

test("setting OFF, non-ACP configs and existing target IDs register nothing", () => {
  const h = harness(), source = { extends: "acp", command: ["hermes", "acp"] };
  assert.deepEqual(h.hermesCcProvidersFromConfig({ x: source }, false, async () => {}), []);
  assert.deepEqual(h.hermesCcProvidersFromConfig({ x: { ...source, enabled: false } }, true, async () => {}), []);
  assert.deepEqual(h.hermesCcProvidersFromConfig({ x: source, "x-cc": {} }, true, async () => {}), []);
  assert.deepEqual(h.hermesCcProvidersFromConfig({ x: { ...source, extends: "custom" } }, true, async () => {}), []);
  assert.deepEqual(h.hermesCcProvidersFromConfig({ x: { command: source.command }, y: null, z: [] }, true, async () => {}), []);
  assert.deepEqual(h.hermesCcProvidersFromConfig({}, true, async () => {}), []);
  assert.equal(h.hermesCcProvidersFromConfig({ x: source }, true, async () => {})[0].label, "x·CC");
  assert.equal(h.hermesCcProvidersFromConfig({ x: { ...source, label: "  " } }, true, async () => {})[0].label, "x·CC");
});

test("awaits exact image capture and forwards the identical prompt object unchanged", async () => {
  const h = harness(), raw = fakeConnection();
  const first = Buffer.from([0, 255, 128, 10]), second = Buffer.from("other bytes");
  let finish;
  const captured = [];
  const wrapped = h.captureHermesCcPrompts(raw, async info => {
    captured.push(structuredClone(info));
    info.images[0].data.fill(0);
    await new Promise(resolve => { finish = resolve; });
  });
  raw.emit(opened("boundary-1", "native-1"));
  const input = prompt("boundary-1", "exact-id", [
    { type: "image", mimeType: "image/png", data: first.toString("base64") },
    { type: "text", text: " unchanged\n🎉 " },
    { type: "image", mimeType: "image/webp", data: second.toString("base64") },
  ]);
  const before = structuredClone(input), sent = wrapped.send(input);
  assert.equal(raw.sent.length, 0);
  assert.deepEqual(captured[0], { sessionKey: "native-1", clientMessageId: "exact-id", images: [
    { mime: "image/png", data: Uint8Array.from(first) }, { mime: "image/webp", data: Uint8Array.from(second) },
  ] });
  finish(); await sent;
  assert.strictEqual(raw.sent[0], input);
  assert.deepEqual(raw.sent[0], before);
});

test("capture failure logs only a reason code and still forwards", async () => {
  const h = harness(), raw = fakeConnection();
  const wrapped = h.captureHermesCcPrompts(raw, async () => { throw new Error("private prompt and path"); });
  raw.emit(opened("boundary", "native"));
  const input = prompt("boundary");
  await wrapped.send(input);
  assert.strictEqual(raw.sent[0], input);
  assert.deepEqual(h.logs, [["[clear-chat] hermes_cc: capture_failed"]]);
});

test("text/command prompts call the hook with no images, including a missing client ID", async () => {
  const h = harness(), raw = fakeConnection(), captured = [];
  const wrapped = h.captureHermesCcPrompts(raw, async info => { captured.push(info); });
  raw.emit(opened("boundary", "native"));
  await wrapped.send(prompt("boundary"));
  const command = prompt("boundary");
  command.prompt.input = { type: "command", name: "status", arguments: " raw " };
  delete command.prompt.clientMessageId;
  await wrapped.send(command);
  assert.deepEqual(captured, [
    { sessionKey: "native", clientMessageId: "client-1", images: [] },
    { sessionKey: "native", clientMessageId: null, images: [] },
  ]);
  assert.strictEqual(raw.sent[1], command);
});

test("session mapping stays isolated, updates on persistence, and cleans up on close/failure", async () => {
  const h = harness(), raw = fakeConnection(), captured = [], events = [];
  const wrapped = h.captureHermesCcPrompts(raw, async info => { captured.push(info.sessionKey); });
  const stop = wrapped.onEvent(event => events.push(event));
  assert.equal(wrapped.version, raw.version);
  assert.strictEqual(wrapped.capabilities, raw.capabilities);
  raw.emit(opened("a", "native-a")); raw.emit(opened("b", "native-b"));
  await wrapped.send(prompt("a")); await wrapped.send(prompt("b"));
  raw.emit({ type: "session.persistence", sessionId: "a", persistence: persistence("restored-a") });
  await wrapped.send(prompt("a"));
  raw.emit({ type: "session.closed", sessionId: "a" });
  raw.emit({ type: "session.runtime_failed", sessionId: "b" });
  await wrapped.send(prompt("a")); await wrapped.send(prompt("b"));
  raw.emit(opened("a", "")); await wrapped.send(prompt("a"));
  assert.deepEqual(captured, ["native-a", "native-b", "restored-a"]);
  assert.equal(raw.sent.length, 6);
  assert.equal(events.length, 6);
  stop(); await wrapped.close();
  assert.equal(raw.listenerCount, 0);
  assert.equal(h.logs.length, 3);
});

test("persistence helper decodes only unambiguous SDK ACP handles", () => {
  const decode = harness().nativeSessionKeyFromPersistence;
  for (const pair of [[handle("native"), null], [null, handle("native")], [handle("native"), handle("native")]]) {
    assert.equal(decode(...pair), "native");
  }
  for (const pair of [
    [null, null], ["garbage", null], ["plugin:{", null], ["plugin:null", null], ["plugin:[]", null],
    [handle(""), null], [handle("a"), handle("b")], [handle("a"), "garbage"],
    ['plugin:{"version":2,"data":{"sessionId":"x"}}', null],
    ['plugin:{"version":1,"data":{"sessionId":1}}', null],
    ['plugin:{"version":1,"data":[]}', null],
  ]) assert.equal(decode(...pair), null, JSON.stringify(pair));
});

test("real SDK ACP adapter forwards exact image content to a fake ACP process and restores the native key", async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = mkdtempSync(join(tmpdir(), "hermes-cc-acp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, "agent.cjs");
  writeFileSync(filename, `
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
      else if (request.method === "session/new") reply({ sessionId: "native-from-agent" });
      else if (request.method === "session/load") reply({});
      else if (request.method === "session/prompt") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: request.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(request.params) } } } }) + "\\n");
        reply({ stopReason: "end_turn" });
      } else if (request.id !== undefined) reply({});
    });
  `);
  const h = harness(runAcpProvider), captured = [];
  const registration = runAcpProvider({ id: "test-cc", label: "Test·CC", command: [process.execPath, filename] });
  const raw = await registration.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"] });
  const wrapped = h.captureHermesCcPrompts(raw, async info => { captured.push(info); });
  t.after(() => wrapped.close());
  const events = [], waiters = [];
  wrapped.onEvent(event => { events.push(event); for (const notify of [...waiters]) notify(); });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake ACP timed out")), 5000);
    const check = () => { const event = events.find(predicate); if (event) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(event); } };
    waiters.push(check); check();
  });
  for (const [sessionId, restored] of [["new-boundary", false], ["restored-boundary", true]]) {
    await wrapped.send({ type: "session.open", requestId: sessionId, sessionId,
      config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "skip",
      ...(restored ? { persistence: persistence("restored-native") } : {}),
    });
    await waitFor(event => event.type === "session.ready" && event.sessionId === sessionId);
    const bytes = Buffer.from([0, 128, 255, 17]);
    const input = prompt(sessionId, sessionId, [
      { type: "text", text: "  Exact text\n🎉\n" },
      { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
    ]);
    const before = structuredClone(input);
    await wrapped.send(input);
    const update = await waitFor(event => event.type === "timeline.item" && event.sessionId === sessionId && event.item.type === "assistant_message");
    assert.deepEqual(JSON.parse(update.item.text), { sessionId: restored ? "restored-native" : "native-from-agent", prompt: input.prompt.input.content });
    assert.deepEqual(input, before);
    assert.deepEqual(captured.at(-1), { sessionKey: restored ? "restored-native" : "native-from-agent", clientMessageId: sessionId, images: [{ mime: "image/png", data: bytes }] });
    assert.equal(h.nativeSessionKeyFromPersistence(handle(captured.at(-1).sessionKey), null), captured.at(-1).sessionKey);
  }
});


test("source env strips Paseo controls and worker IPC after overrides, for daemon and standalone connections", async () => {
  const h = harness();
  const stripped = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION",
    "PASEO_NODE_ENV", "PASEO_DESKTOP_MANAGED", "PASEO_SUPERVISED", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ESBUILD_BINARY_PATH"];
  stripped.push("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_CHANNEL_FUTURE");
  const overlay = Object.fromEntries(stripped.map(key => [key, "must disappear"]));
  overlay.KEEP = "source";
  assert.deepEqual(h.hermesCcSourceEnv({ ...overlay, KEEP: "daemon", UNDEFINED: undefined, EMPTY: "" }, overlay), { KEEP: "source", EMPTY: "" });
  const [provider] = h.hermesCcProvidersFromConfig({ x: { extends: "acp", command: ["hermes", "acp"], env: overlay } }, true, async () => {});
  for (const launch of [undefined, { command: "/resolved/hermes", args: ["acp"], env: { ...overlay, CC_ONLY: "discard" } }]) {
    await provider.connect({ versions: [1], capabilities: [], ...(launch ? { launch } : {}) });
    assert.deepEqual(h.launches.at(-1).env, h.hermesCcSourceEnv(process.env, overlay));
    for (const key of stripped) assert.equal(h.launches.at(-1).env[key], undefined);
    assert.equal(h.launches.at(-1).env.CC_ONLY, undefined);
  }
});

test("concurrent sessions keep cwd, env and history isolated through asynchronous SDK dispatch", async () => {
  const h = harness();
  const [provider] = h.hermesCcProvidersFromConfig({ x: { extends: "acp", command: ["hermes", "acp"], env: { SOURCE: "kept", ORDER: "source" } } }, true, async () => {});
  const connection = await provider.connect({ versions: [1], capabilities: [] });
  await Promise.all(["one", "two"].map(cwd => connection.send({ type: "session.open",
    config: { cwd, env: { ORDER: cwd, NODE_CHANNEL_FD: "discard" } },
    history: cwd === "one" ? "replay" : "skip", ...(cwd === "one" ? { persistence: persistence("native") } : {}),
  })));
  assert.deepEqual(h.launches.slice(1).map(({ cwd, env, history, existingSession }) => ({
    cwd, source: env.SOURCE, order: env.ORDER, ipc: env.NODE_CHANNEL_FD, history, existingSession,
  })), [
    { cwd: "one", source: "kept", order: "one", ipc: undefined, history: "replay", existingSession: true },
    { cwd: "two", source: "kept", order: "two", ipc: undefined, history: "skip", existingSession: false },
  ]);
});

test("malformed image parts are skipped individually and never change the forwarded prompt", async () => {
  const h = harness(), raw = fakeConnection(), captured = [];
  const wrapped = h.captureHermesCcPrompts(raw, async info => captured.push(info));
  raw.emit(opened("boundary", "native"));
  const good = { type: "image", mimeType: "image/png", data: Buffer.from("good").toString("base64") };
  const input = prompt("boundary", "exact", [good, { type: "image", mimeType: "image/png", data: {} },
    { type: "image", mimeType: "image/png", data: "!!!!" }, null, { type: "image", data: "Zg==" }, good]);
  const before = structuredClone(input);
  await wrapped.send(input);
  assert.deepEqual(captured[0].images, [1, 2].map(() => ({ mime: "image/png", data: Buffer.from("good") })));
  assert.strictEqual(raw.sent[0], input);
  assert.deepEqual(input, before);
  assert.deepEqual(h.logs, []);
  const large = Buffer.alloc(3 * 1024 ** 2, 42);
  await wrapped.send(prompt("boundary", "large", [{ ...good, data: large.toString("base64") }]));
  assert.deepEqual(captured.at(-1).images, [{ mime: "image/png", data: large }]);
});

test("model configuration drops only invalid rows and preserves host merge/default semantics", () => {
  const h = harness();
  const source = { extends: "acp", command: ["hermes", "acp"],
    models: [{ id: "first", label: "First", isDefault: true }, null,
      { id: "second", label: "Second", description: "Keep this description" }],
    additionalModels: [{ id: "second", label: "Override", isDefault: true },
      { id: "invalid", label: 7, description: "private row" }, { id: "third", label: "Third" }],
  };
  const before = structuredClone(source);
  h.hermesCcProvidersFromConfig({ source }, true, async () => {});
  const catalog = h.commands[0].transformers[0].discover({ models: [], modes: [] });
  assert.deepEqual(catalog, { modes: [], defaultModel: "second", models: [
    { id: "first", label: "First", isDefault: false },
    { id: "second", label: "Override", description: "Keep this description", isDefault: true },
    { id: "third", label: "Third", isDefault: false },
  ] });
  assert.deepEqual(h.logs, Array.from({ length: 2 }, () => ["[clear-chat] hermes_cc: configured_model_invalid"]));
  assert.deepEqual(source, before);
});

test("discovery preserves the host default mode even when a legacy remembered catalog has one", () => {
  const h = harness();
  const remembered = { modes: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
    models: [], defaultMode: "second" };
  h.hermesCcProvidersFromConfig({ source: { extends: "acp", command: ["hermes", "acp"] } },
    true, async () => {}, undefined, { read: () => structuredClone(remembered) });
  for (const host of [{ modes: [], models: [] }, { modes: [], models: [], defaultMode: "host-default" }]) {
    const actual = h.commands[0].transformers[0].discover(host);
    assert.deepEqual(actual, { ...host, modes: remembered.modes });
  }
});
