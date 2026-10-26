const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { delimiter, dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function loadServer(root, runAcpProvider) {
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
      localRequire, mod, mod.exports, { ...process, env: { ...process.env, PASEO_HOME: root } },
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
  return { providers, handlers, cleanup, logs };
}

function fakeAgent(root) {
  const filename = join(root, "hermes");
  fs.writeFileSync(filename, `#!/usr/bin/env node
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
      else if (request.method === "session/new") reply({ sessionId: "native-session" });
      else if (request.method === "session/prompt") {
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "received.json"))}, JSON.stringify(request.params));
        require("node:fs").writeFileSync(${JSON.stringify(join(root, "env.json"))}, JSON.stringify({ SOURCE_ONLY: process.env.SOURCE_ONLY, CLAUDECODE: process.env.CLAUDECODE, PASEO_NODE_ENV: process.env.PASEO_NODE_ENV }));
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

test("contribution registers a mirrored provider and captures exact-ID PNGs through real ACP and the prompt.images RPC", async t => {
  const { runAcpProvider } = await import("@getpaseo/plugin/server/acp");
  const root = fs.mkdtempSync(join(tmpdir(), "cc-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fakeAgent(root);
  fs.writeFileSync(join(root, "config.json"), JSON.stringify({ providers: {
    assistant: { extends: "acp", label: "Assistant", command: ["hermes", "acp"],
      env: { PATH: `${root}${delimiter}${process.env.PATH}`, SOURCE_ONLY: "exact source value", CLAUDECODE: "stripped", PASEO_NODE_ENV: "stripped" } },
  } }));
  const h = loadServer(root, runAcpProvider);
  t.after(h.cleanup);
  assert.deepEqual(h.providers.map(p => p.id), ["assistant-cc"]);
  assert.equal(h.providers[0].command, undefined);
  const connection = await h.providers[0].connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"],
  });
  t.after(() => connection.close());
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake ACP timed out")), 5000);
    connection.onEvent(event => { if (event.type === "session.ready") { clearTimeout(timer); resolve(); } });
  });
  await connection.send({ type: "session.open", requestId: "open", sessionId: "boundary-session",
    config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true }, history: "skip" });
  await ready;
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
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "env.json"))), { SOURCE_ONLY: "exact source value" });
  const rpc = h.handlers.get("prompt.images");
  const lookup = { agentId: "agent", messageId: "exact-client-id", text: "irrelevant" };
  const found = await rpc(lookup, host("assistant-cc"));
  assert.equal(found.total, 1);
  assert.equal(found.images[0].thumbDataUri, `data:image/png;base64,${png.toString("base64")}`);
  for (const [request, context] of [
    [{ ...lookup, messageId: "another-id" }, host("assistant-cc")],
    [lookup, host("assistant-cc", "another-session")],
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
  assert.deepEqual((await rpc(lookup, host("assistant-cc"))).images, []);
  assert.ok(h.logs.some(log => log.length === 1 && log[0] === "[clear-chat] hermes_cc: save_conflict"));

  const settingDir = join(root, "plugin-settings", "clear-chat");
  fs.mkdirSync(settingDir, { recursive: true });
  fs.writeFileSync(join(settingDir, "hermes-cc.json"), JSON.stringify({ version: 1, values: { enabled: false } }));
  const off = loadServer(root, runAcpProvider);
  assert.deepEqual(off.providers, []);
  off.cleanup();
});
