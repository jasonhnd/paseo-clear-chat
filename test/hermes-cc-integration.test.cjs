const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { homedir, tmpdir } = require("node:os");
const { delimiter, dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function loadServer(root, runAcpProvider, workerEnv = {}) {
  const cache = new Map(), logs = [];
  function load(filename) {
    filename = resolve(__dirname, "..", filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    function localRequire(id) {
      if (id === "@getpaseo/plugin/server/acp") return { runAcpProvider };
      return id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : realRequire(id);
    }
    runInThisContext(`(function(require,module,exports,process,console){${code}\n})`, { filename })(
      localRequire, mod, mod.exports, { ...process, env: { ...process.env, PASEO_HOME: root, ...workerEnv } },
      { debug: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    );
    return mod.exports;
  }
  const providers = [], handlers = new Map();
  const cleanup = load("index.server.ts").default({
    registerSettings() { return { read: async () => { throw new Error("startup must stay synchronous"); } }; },
    registerProvider(provider) { providers.push(provider); },
    handle(contract, handler) { handlers.set(contract.name, handler); },
  });
  assert.equal(typeof cleanup, "function");
  return { providers, handlers, cleanup, logs, startup: () => load("server/hermes-cc/startup.ts").hermesCcStartupConfig(root) };
}

const fakeModes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "dontAsk", name: "Don't Ask" },
  ],
};
const fakeModelOptions = [{ id: "model", name: "Model", category: "model", type: "select",
  currentValue: "fake-model", options: [
    { value: "fake-model", name: "Fake model" }, { value: "other-model", name: "Other model" },
  ] }];

function fakeAgent(root, failInitialize = false) {
  const filename = join(root, "hermes");
  fs.writeFileSync(filename, `#!/usr/bin/env node
    const readline = require("node:readline");
    require("node:fs").appendFileSync(${JSON.stringify(join(root, "pids.log"))}, process.pid + "\\n");
    let sessionCwd;
    const modes = ${JSON.stringify(fakeModes)}, configOptions = ${JSON.stringify(fakeModelOptions)};
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      require("node:fs").appendFileSync(${JSON.stringify(join(root, "requests.log"))}, JSON.stringify({ method: request.method, cwd: process.cwd(), params: request.params }) + "\\n");
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      if (${JSON.stringify(failInitialize)} && request.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fixture initialization failed" } }) + "\\n");
        return;
      }
      if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } } });
      else if (request.method === "session/new") { sessionCwd = request.params.cwd; reply({ sessionId: "native-session", modes, configOptions }); }
      else if (request.method === "session/set_mode") { modes.currentModeId = request.params.modeId; reply({}); }
      else if (request.method === "session/set_config_option") {
        configOptions.find(option => option.id === request.params.configId).currentValue = request.params.value;
        reply({ configOptions });
      }
      else if (request.method === "session/list") reply({ sessions: [{ sessionId: "existing-session", cwd: ${JSON.stringify(root)}, title: "Existing session" }] });
      else if (request.method === "session/load") { sessionCwd = request.params.cwd; reply({}); }
      else if (request.method === "session/prompt") {
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "received.json"))}, JSON.stringify(request.params));
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "launch.json"))}, JSON.stringify({ env: process.env, cwd: process.cwd(), sessionCwd }));
        reply({ stopReason: "end_turn" });
      } else if (request.id !== undefined) reply({});
    });
  `);
  fs.chmodSync(filename, 0o700);
  return filename;
}
function host(provider, native = "native-session") {
  const agent = { provider, cwd: "/unused", persistence: {
    provider, sessionId: `plugin:${JSON.stringify({ version: 1, data: { sessionId: native } })}`,
  } };
  return { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent }), current: () => agent }) } } };
}

const stripped = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION",
  "PASEO_NODE_ENV", "PASEO_DESKTOP_MANAGED", "PASEO_SUPERVISED", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ESBUILD_BINARY_PATH"];

function paseoConfig(env = {}) {
  return { version: 1, providers: { openai: { apiKey: "not-a-real-key" } }, agents: { providers: {
    hermes: { extends: "acp", label: "Hermes", command: ["hermes", "acp"], env },
    "hermes-zk": { extends: "acp", label: "Hermes ZK", command: ["hermes", "-p", "zksc-ops", "acp"] },
    gemini: { extends: "acp", label: "Google Gemini", command: ["gemini", "--acp"] },
    disabled: { extends: "acp", label: "Disabled Hermes", command: ["hermes", "acp"], enabled: false },
    claude: { enabled: true, command: ["claude"] },
  } } };
}

function requests(root) {
  const path = join(root, "requests.log");
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim().split("\n").map(JSON.parse) : [];
}

test("SDK v0.13.0 opens sessions for catalog discovery, but not capability probes or session listing", async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-sdk-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = runAcpProvider({ id: "fixture", label: "Fixture", command: [fakeAgent(root), "acp"] });
  assert.deepEqual(requests(root), []);
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list"] });
  t.after(() => connection.close());
  assert.deepEqual(requests(root).map(request => request.method), ["initialize"]);
  for (const cwd of [undefined, root]) {
    const catalog = waitEvent(connection, event => event.type === "catalog");
    await connection.send({ type: "catalog", requestId: "models", ...(cwd ? { cwd } : {}) });
    assert.deepEqual((await catalog).catalog.models, [
      { id: "fake-model", label: "Fake model" }, { id: "other-model", label: "Other model" },
    ]);
  }
  assert.equal(requests(root).filter(request => request.method === "session/new").length, 2);
  const listed = waitEvent(connection, event => event.type === "sessions");
  await connection.send({ type: "sessions", requestId: "list" });
  assert.equal((await listed).sessions.length, 1);
  assert.equal(requests(root).filter(request => request.method === "session/new").length, 2);
});

test("Hermes·CC registration, startup probes, catalogs and session listings create no sessions", async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fakeAgent(root);
  const config = paseoConfig({ PATH: `${root}${delimiter}${process.env.PATH}` });
  config.agents.providers["hermes-zk"].env = config.agents.providers.hermes.env;
  fs.writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const h = loadServer(root, runAcpProvider);
  t.after(h.cleanup);
  assert.equal(h.providers.length, 2);
  assert.deepEqual(requests(root), []);
  for (const provider of h.providers) {
    const connection = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.list", "session.persistence"] });
    t.after(() => connection.close());
    assert.ok(connection.capabilities.includes("prompt.image"));
    assert.ok(connection.capabilities.includes("session.list"));
    assert.ok(connection.capabilities.includes("session.persistence"));
    assert.equal(requests(root).filter(request => request.method === "session/new").length, 0);
    // Repeat discovery, including a workspace that no longer exists.
    for (const cwd of [undefined, root, join(root, "removed"), undefined]) {
      const input = { type: "catalog", requestId: "models", ...(cwd ? { cwd } : {}) };
      const before = structuredClone(input);
      const catalog = waitEvent(connection, event => event.type === "catalog");
      await connection.send(input);
      assert.deepEqual((await catalog).catalog, { models: [], modes: [] });
      assert.deepEqual(input, before);
      assert.equal(requests(root).filter(request => request.method === "session/new").length, 0);
    }
    for (const cwd of [undefined, root]) {
      const listed = waitEvent(connection, event => event.type === "sessions");
      await connection.send({ type: "sessions", requestId: "list", ...(cwd ? { cwd } : {}) });
      assert.deepEqual((await listed).sessions, [{ persistence: { version: 1, data: { sessionId: "existing-session" } }, cwd: root, title: "Existing session", updatedAt: undefined }]);
    }
    await connection.close();
  }
  assert.equal(requests(root).filter(request => request.method === "initialize").length, 14);
  assert.equal(requests(root).filter(request => request.method === "session/list").length, 4);
  assert.deepEqual(requests(root).filter(request => request.method === "session/list").map(request => request.params.cwd), [undefined, root, undefined, root]);
  assert.equal(requests(root).filter(request => request.method === "session/new").length, 0);
  for (const request of requests(root)) {
    assert.equal(request.cwd, process.cwd());
  }
  for (const pid of fs.readFileSync(join(root, "pids.log"), "utf8").trim().split("\n").map(Number)) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("CC catalogs mirror source model config before any session and mode/model changes reach ACP", async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-controls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = fakeAgent(root);
  const config = paseoConfig({ PATH: `${root}${delimiter}${process.env.PATH}` });
  const source = config.agents.providers.hermes;
  source.models = [
    { id: "fake-model", label: "Curated model", isDefault: true, description: "Source description",
      thinkingOptions: [{ id: "high", label: "High", isDefault: true }] },
    { id: "other-model", label: "Source other" },
  ];
  source.additionalModels = [
    { id: "other-model", label: "Preferred other", isDefault: true },
    { id: "configured-only", label: "Configured only" },
  ];
  const before = structuredClone(config);
  fs.writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const h = loadServer(root, runAcpProvider);
  t.after(h.cleanup);
  const connection = await h.providers[0].connect({ versions: [1], capabilities: ["session.configure"] });
  t.after(() => connection.close());
  for (const cwd of [undefined, root, join(root, "removed")]) {
    const listed = waitEvent(connection, event => event.type === "catalog");
    await connection.send({ type: "catalog", requestId: "catalog", ...(cwd ? { cwd } : {}) });
    assert.deepEqual((await listed).catalog.models, [
      { ...source.models[0], isDefault: false, defaultThinkingOptionId: "high" },
      { ...source.models[1], ...source.additionalModels[0] }, { ...source.additionalModels[1], isDefault: false },
    ]);
    assert.equal(requests(root).some(request => request.method === "session/new"), false);
  }
  const directSdk = await runAcpProvider({ id: "source", label: "Source", command: [executable, "acp"] })
    .connect({ versions: [1], capabilities: ["session.configure"] });
  t.after(() => directSdk.close());
  const rpcSequences = [];
  for (const current of [directSdk, connection]) {
    const start = requests(root).length;
    const initial = waitEvent(current, event => event.type === "session.config");
    const ready = waitEvent(current, event => event.type === "session.ready");
    await current.send({ type: "session.open", requestId: "open", sessionId: "boundary",
      config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true,
        mode: "dontAsk", model: "other-model" }, history: "skip" });
    await ready;
    const opened = (await initial).config;
    assert.deepEqual(opened.modes.map(mode => [mode.id, mode.label]),
      fakeModes.availableModes.map(mode => [mode.id, mode.name]));
    assert.equal(opened.mode, "dontAsk");
    assert.equal(opened.model, "other-model");
    for (const mode of ["acceptEdits", "dontAsk"]) {
      const configured = waitEvent(current, event => event.type === "session.config" && event.config.mode === mode);
      await current.send({ type: "session.configure", requestId: mode, sessionId: "boundary", changes: { mode } });
      await configured;
    }
    const configured = waitEvent(current, event => event.type === "session.config" && event.config.model === "fake-model");
    await current.send({ type: "session.configure", requestId: "model", sessionId: "boundary", changes: { model: "fake-model" } });
    await configured;
    rpcSequences.push(requests(root).slice(start).filter(request =>
      ["session/set_mode", "session/set_config_option"].includes(request.method))
      .map(({ method, params }) => ({ method, params })));
  }
  assert.deepEqual(rpcSequences[1], rpcSequences[0]);
  assert.deepEqual(rpcSequences[1], [
    { method: "session/set_config_option", params: { sessionId: "native-session", configId: "model", value: "other-model" } },
    ...["dontAsk", "acceptEdits", "dontAsk"].map(modeId => ({ method: "session/set_mode", params: { sessionId: "native-session", modeId } })),
    { method: "session/set_config_option", params: { sessionId: "native-session", configId: "model", value: "fake-model" } },
  ]);
  assert.deepEqual(config, before);
});

test("v0.13.0 agents.providers mirrors only enabled Hermes sources and captures exact-ID PNGs through real ACP and RPC", async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fakeAgent(root);
  const sourceEnv = { PATH: `${root}${delimiter}${process.env.PATH}`, SOURCE_ONLY: "exact source value",
    ...Object.fromEntries(stripped.map(key => [key, "stripped"])) };
  const config = paseoConfig(sourceEnv), beforeConfig = structuredClone(config);
  fs.writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const workerEnv = { NODE_CHANNEL_FD: "100", NODE_CHANNEL_SERIALIZATION_MODE: "advanced", NODE_CHANNEL_FUTURE: "stripped", WORKER_ONLY: "inherited" };
  const h = loadServer(root, runAcpProvider, workerEnv);
  t.after(h.cleanup);
  assert.deepEqual(h.providers.map(p => [p.id, p.label]), [["hermes-cc", "Hermes·CC"], ["hermes-zk-cc", "Hermes ZK·CC"]]);
  assert.deepEqual(h.startup().providers, beforeConfig.agents.providers);
  assert.equal(h.providers[0].command, undefined);
  const connection = await h.providers[0].connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"],
  });
  t.after(() => connection.close());
  assert.equal(requests(root).filter(request => request.method === "session/new").length, 0);
  const configured = waitEvent(connection, event => event.type === "session.config");
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake ACP timed out")), 5000);
    connection.onEvent(event => { if (event.type === "session.ready") { clearTimeout(timer); resolve(); } });
  });
  await connection.send({ type: "session.open", requestId: "open", sessionId: "boundary-session",
    config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "skip" });
  await ready;
  assert.deepEqual((await configured).config.models, [
    { id: "fake-model", label: "Fake model" }, { id: "other-model", label: "Other model" },
  ]);
  assert.equal(requests(root).filter(request => request.method === "session/new").length, 1);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
  const input = { type: "session.prompt", sessionId: "boundary-session", prompt: {
    clientMessageId: "exact-client-id", delivery: "auto", input: { type: "message", content: [
      { type: "text", text: "  Keep bytes\n🎉  " }, { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ] },
  } };
  const before = structuredClone(input);
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake ACP prompt timed out")), 5000);
    connection.onEvent(event => { if (event.type === "session.turn" && event.state === "completed") { clearTimeout(timer); resolve(); } });
  });
  await connection.send(input);
  await completed;
  assert.deepEqual(input, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "received.json"))), {
    sessionId: "native-session", prompt: before.prompt.input.content,
  });
  const expectedEnv = { ...process.env, PASEO_HOME: root, ...workerEnv, ...sourceEnv };
  for (const key of Object.keys(expectedEnv)) if (stripped.includes(key) || key.startsWith("NODE_CHANNEL_")) delete expectedEnv[key];
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "launch.json"))), { env: expectedEnv, cwd: root, sessionCwd: root });
  assert.deepEqual(config, beforeConfig);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "config.json"))), beforeConfig);
  const rpc = h.handlers.get("prompt.images");
  const lookup = { agentId: "agent", messageId: "exact-client-id", text: "irrelevant" };
  const found = await rpc(lookup, host("hermes-cc"));
  assert.equal(found.total, 1);
  assert.equal(found.images[0].thumbDataUri, `data:image/png;base64,${png.toString("base64")}`);
  for (const [request, context] of [
    [{ ...lookup, messageId: "another-id" }, host("hermes-cc")],
    [lookup, host("hermes-cc", "another-session")],
    [lookup, host("hermes")],
    [lookup, host("hermes-unregistered-cc")],
  ]) assert.deepEqual((await rpc(request, context)).images, []);
  // A second boundary session reporting the same native ACP ID cannot silently
  // replace the first prompt's images, even when it reuses the client identity.
  const secondReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second session timed out")), 5000);
    connection.onEvent(event => { if (event.type === "session.ready" && event.sessionId === "other-boundary") { clearTimeout(timer); resolve(); } });
  });
  await connection.send({ type: "session.open", requestId: "open-2", sessionId: "other-boundary",
    config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "skip" });
  await secondReady;
  const second = structuredClone(input);
  second.sessionId = "other-boundary";
  const different = Buffer.from(png); different[different.length - 1] ^= 1;
  second.prompt.input.content[1].data = different.toString("base64");
  const secondCompleted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second prompt timed out")), 5000);
    connection.onEvent(event => { if (event.type === "session.turn" && event.state === "completed" && event.sessionId === "other-boundary") { clearTimeout(timer); resolve(); } });
  });
  await connection.send(second);
  await secondCompleted;
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "received.json"))).prompt, second.prompt.input.content);
  assert.deepEqual((await rpc(lookup, host("hermes-cc"))).images, []);
  assert.ok(h.logs.some(log => log.length === 1 && log[0] === "[clear-chat] hermes_cc: save_conflict"));

  const settingDir = join(root, "plugin-settings", "clear-chat");
  fs.mkdirSync(settingDir, { recursive: true });
  fs.writeFileSync(join(settingDir, "hermes-cc.json"), JSON.stringify({ version: 1, values: { enabled: false } }));
  const off = loadServer(root, runAcpProvider);
  assert.deepEqual(off.providers, []);
  off.cleanup();
});

for (const failure of ["missing", "unreadable", "malformed"]) test(`startup registers nothing and logs a fixed reason when config is ${failure}`, t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  if (failure === "unreadable") fs.mkdirSync(path);
  if (failure === "malformed") fs.writeFileSync(path, '{"private-detail":');
  const h = loadServer(root, () => { throw new Error("must not register"); });
  t.after(h.cleanup);
  assert.deepEqual(h.providers, []);
  assert.deepEqual(h.logs, [["[clear-chat] hermes_cc: config_unavailable"]]);
  assert.deepEqual(h.startup(), { enabled: false, providers: {} });
});

for (const providers of [[], null, "invalid"]) test(`startup rejects a non-object agents.providers: ${JSON.stringify(providers)}`, t => {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-config-shape-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(join(root, "config.json"), JSON.stringify({ ...paseoConfig(), agents: { providers } }));
  const h = loadServer(root, () => { throw new Error("must not register"); });
  t.after(h.cleanup);
  assert.deepEqual(h.providers, []);
  assert.deepEqual(h.startup().providers, {});
});

function waitEvent(connection, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("fake ACP timed out")); }, 5000);
    const stop = connection.onEvent(event => {
      if (predicate(event)) { clearTimeout(timer); stop(); resolve(event); }
      else if (event.type === "request.failed" || event.type === "session.runtime_failed") {
        clearTimeout(timer); stop(); reject(new Error("fake ACP operation failed"));
      }
    });
  });
}

for (const [kind, history, existing] of [
  ["directory", "skip", false], ["directory", "replay", true],
  ["missing", "replay", true], ["not-directory-parent", "replay", true],
]) test(`Hermes process uses ${kind === "directory" ? "the session cwd" : "home for missing history cwd"} (${history}, existing=${existing}, ${kind}) and closes with the SDK connection`, async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-cwd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fakeAgent(root);
  const parent = join(root, "parent");
  if (kind === "not-directory-parent") fs.writeFileSync(parent, "a file is not a directory");
  const cwd = kind === "not-directory-parent" ? join(parent, "workspace") : join(root, "workspace");
  if (kind === "directory") fs.mkdirSync(cwd);
  else assert.throws(() => fs.statSync(cwd), { code: kind === "missing" ? "ENOENT" : "ENOTDIR" });
  fs.writeFileSync(join(root, "config.json"), JSON.stringify(paseoConfig({ PATH: `${root}${delimiter}${process.env.PATH}` })));
  const h = loadServer(root, runAcpProvider);
  t.after(h.cleanup);
  const connection = await h.providers[0].connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  t.after(() => connection.close());
  const ready = waitEvent(connection, event => event.type === "session.ready");
  await connection.send({ type: "session.open", requestId: "open", sessionId: "boundary",
    config: { cwd, env: { SESSION_ONLY: "kept", NODE_CHANNEL_FD: "discard", CLAUDECODE: "discard" }, mcpServers: {}, settings: {}, persist: true },
    history, ...(existing ? { persistence: { version: 1, data: { sessionId: "native-session" } } } : {}),
  });
  await ready;
  const completed = waitEvent(connection, event => event.type === "session.turn" && event.state === "completed");
  await connection.send({ type: "session.prompt", sessionId: "boundary", prompt: {
    clientMessageId: "cwd-test", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "cwd" }] },
  } });
  await completed;
  const launch = JSON.parse(fs.readFileSync(join(root, "launch.json")));
  assert.equal(launch.cwd, kind === "directory" ? cwd : homedir());
  assert.equal(launch.sessionCwd, cwd);
  assert.equal(launch.env.SESSION_ONLY, "kept");
  assert.equal(launch.env.NODE_CHANNEL_FD, undefined);
  assert.equal(launch.env.CLAUDECODE, undefined);
  assert.equal(fs.existsSync(cwd), kind === "directory");
  if (kind === "not-directory-parent") assert.equal(fs.readFileSync(parent, "utf8"), "a file is not a directory");
  await connection.close();
  const pids = fs.readFileSync(join(root, "pids.log"), "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 2); // Capability probe and session process.
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const [history, existing, kind] of [
  ["skip", false, "missing"], ["replay", false, "missing"], ["skip", true, "missing"],
  ["skip", false, "file"], ["skip", false, "empty"],
  ["skip", false, "symlink-loop"], ["replay", true, "symlink-loop"],
  ["skip", false, "denied-parent"], ["replay", true, "denied-parent"],
]) test(`Hermes session fails for an invalid cwd (${history}, existing=${existing}, ${kind})`, async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  if (kind === "denied-parent" && (process.platform === "win32" || process.getuid?.() === 0)) {
    t.skip("Requires POSIX directory permissions and an unprivileged user");
    return;
  }
  const root = fs.mkdtempSync(join(tmpdir(), "cc-invalid-cwd-"));
  const parent = join(root, "parent");
  t.after(() => {
    if (kind === "denied-parent") fs.chmodSync(parent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fakeAgent(root);
  const cwd = kind === "empty" ? "" : kind === "denied-parent" ? join(parent, "workspace") : join(root, "workspace");
  if (kind === "file") fs.writeFileSync(cwd, "a file is not a directory");
  if (kind === "symlink-loop") fs.symlinkSync("workspace", cwd, "dir");
  if (kind === "denied-parent") {
    fs.mkdirSync(cwd, { recursive: true });
    fs.chmodSync(parent, 0o000);
  }
  const errorPattern = { empty: /working directory is empty/, file: /ENOTDIR/, missing: /ENOENT/,
    "symlink-loop": /ELOOP/, "denied-parent": /EACCES/ }[kind];
  if (kind === "symlink-loop" || kind === "denied-parent") {
    assert.throws(() => fs.statSync(cwd), errorPattern);
  }
  fs.writeFileSync(join(root, "config.json"), JSON.stringify(paseoConfig({ PATH: `${root}${delimiter}${process.env.PATH}` })));
  const h = loadServer(root, runAcpProvider);
  t.after(h.cleanup);
  const connection = await h.providers[0].connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => events.push(event));
  const failed = waitEvent(connection, event => event.type === "request.failed" && event.requestId === "open");
  await connection.send({ type: "session.open", requestId: "open", sessionId: "boundary",
    config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true }, history,
    ...(existing ? { persistence: { version: 1, data: { sessionId: "native-session" } } } : {}),
  });
  assert.match((await failed).error.message, errorPattern);
  assert.equal(events.some(event => event.type === "session.ready"), false);
  assert.equal(fs.existsSync(cwd), kind === "file");
  if (kind === "file") assert.equal(fs.readFileSync(cwd, "utf8"), "a file is not a directory");
  assert.equal(fs.existsSync(join(root, "launch.json")), false);
  assert.deepEqual(requests(root).map(request => request.method), ["initialize"]);
  await connection.close();
  const pids = fs.readFileSync(join(root, "pids.log"), "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 1); // Only the capability probe ran; no session process.
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const failure of ["spawn", "initialize"]) test(`SDK connector cleans up when Hermes fails to ${failure}`, async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-launch-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = paseoConfig();
  config.agents.providers.hermes.command[0] = failure === "spawn" ? join(root, "missing", "hermes") : fakeAgent(root, true);
  fs.writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const h = loadServer(root, runAcpProvider);
  t.after(h.cleanup);
  await assert.rejects(h.providers[0].connect({ versions: [1], capabilities: [] }));
  if (failure === "initialize") {
    const pid = Number(fs.readFileSync(join(root, "pids.log"), "utf8").trim());
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});
