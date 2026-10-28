"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { join, resolve, isAbsolute, relative } = require("node:path");
const readline = require("node:readline");
const test = require("node:test");

const executable = resolve(__dirname, "fixtures/hermes-journal/hermes");
const repository = resolve(__dirname, "..");
function temporary() {
  const base = process.env.TMPDIR;
  assert.ok(base && isAbsolute(base), "An explicit absolute TMPDIR is required");
  const outside = relative(repository, fs.realpathSync(base));
  assert.ok(outside.startsWith("../"), "TMPDIR must be outside the repository");
  assert.ok(!/^\/tmp(?:\/|$)/.test(fs.realpathSync(base)), "Do not use system /tmp");
  return fs.mkdtempSync(join(base, "hermes-journal-"));
}
function client(root, overrides = {}) {
  // Deliberately do not inherit credential or provider environment variables.
  const child = spawn(executable, ["acp"], { env: {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    PASEO_HOME: process.env.PASEO_HOME,
    HERMES_CC_FIXTURE_STATE_DIR: join(root, "state"),
    HERMES_CC_FIXTURE_LOG: join(root, "requests.jsonl"), ...overrides,
  }, stdio: "pipe" });
  const messages = [], pending = new Map();
  let sequence = 0, stderr = "", protocolError;
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      if ("id" in message) {
        assert.equal(typeof message.id, "number");
        assert.ok(("result" in message) !== ("error" in message));
        assert.ok(pending.has(message.id), "Every reply matches a request");
      } else {
        assert.equal(message.method, "session/update");
        assert.equal(typeof message.params.sessionId, "string");
        assert.ok(["user_message_chunk", "agent_message_chunk"].includes(message.params.update.sessionUpdate));
      }
      messages.push(message);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    } catch (error) {
      protocolError = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      child.kill("SIGTERM");
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      for (const waiter of pending.values()) waiter.reject(new Error("Fixture exited before reply"));
      pending.clear();
      resolve({ code, signal });
    });
  });
  return { child, messages,
    async request(method, params = {}) {
      const id = ++sequence;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return response;
    },
    async close(signal = false) {
      if (child.exitCode === null && child.signalCode === null) {
        if (signal) child.kill("SIGTERM"); else child.stdin.end();
      }
      assert.deepEqual(await closed, { code: 0, signal: null });
      assert.equal(stderr, "");
      if (protocolError) throw protocolError;
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      lines.close();
    },
  };
}
const notifications = client => client.messages.filter(message => message.method === "session/update");
const logs = root => fs.readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const stored = (root, id) => JSON.parse(fs.readFileSync(join(root, "state", id + ".json"), "utf8"));
async function initialize(client) {
  const response = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.agentCapabilities.loadSession, true);
  assert.match(response.result.agentInfo.name, /synthetic-no-model/);
}

test("synthetic completed transcripts survive fresh processes with exact native identity and isolated sessions", { timeout: 15000 }, async () => {
  const root = temporary(), clients = [];
  const start = (directory = root) => { const instance = client(directory); clients.push(instance); return instance; };
  try {
    const first = start();
    await initialize(first);
    const a = (await first.request("session/new", { cwd: root, mcpServers: [] })).result.sessionId;
    const b = (await first.request("session/new", { cwd: root, mcpServers: [] })).result.sessionId;
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.deepEqual(notifications(first), [], "Creation never emits historical transcript");
    assert.deepEqual(stored(root, a), { sessionId: a, transcript: [] });
    assert.deepEqual(stored(root, b), { sessionId: b, transcript: [] });
    const prompt = [{ type: "text", text: "  Original\n🎉  " },
      { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" }];
    const completion = await first.request("session/prompt", { sessionId: a, prompt });
    assert.deepEqual(completion.result, { stopReason: "end_turn" });
    const original = structuredClone(notifications(first));
    assert.deepEqual(original.map(message => message.params.update), [
      ...prompt.map(content => ({ sessionUpdate: "user_message_chunk", content })),
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Synthetic/no-model turn COMPLETED." } },
    ]);
    assert.ok(original.every(message => message.params.sessionId === a));
    const persisted = stored(root, a);
    assert.deepEqual(persisted.transcript, original, "Full transcript exists when completion is received");
    assert.ok(first.messages.indexOf(completion) > first.messages.indexOf(notifications(first).at(-1)));
    assert.deepEqual(stored(root, b).transcript, []);
    const bytes = fs.readFileSync(join(root, "state", a + ".json"));
    await first.close();

    const second = start();
    await initialize(second);
    const replay = await second.request("session/load", { sessionId: a, cwd: root, mcpServers: [] });
    assert.deepEqual(replay.result, {});
    assert.deepEqual(notifications(second), original);
    assert.deepEqual(fs.readFileSync(join(root, "state", a + ".json")), bytes, "Replay does not rewrite history");
    const c = (await second.request("session/new", { cwd: root, mcpServers: [] })).result.sessionId;
    assert.equal(new Set([a, b, c]).size, 3, "IDs remain unique after restart");
    assert.deepEqual(notifications(second), original, "New session adds no transcript");
    await second.request("session/prompt", { sessionId: b, prompt: [{ type: "text", text: "Independent" }] });
    assert.deepEqual(stored(root, a), persisted);
    assert.equal(stored(root, b).transcript[0].params.update.content.text, "Independent");
    assert.ok(stored(root, b).transcript.every(message => message.params.sessionId === b));
    const beforeUnknown = notifications(second).length;
    for (const id of ["00000000-0000-4000-8000-000000000000", "../escape"]) {
      const unknown = await second.request("session/load", { sessionId: id });
      assert.equal(unknown.error.code, -32602);
      assert.match(unknown.error.message, /Unknown.*native session ID/);
    }
    assert.equal(notifications(second).length, beforeUnknown);
    await second.close(true);

    const third = start();
    await initialize(third);
    await third.request("session/load", { sessionId: b });
    assert.deepEqual(notifications(third), stored(root, b).transcript);
    await third.close();
    const rows = logs(root);
    const counts = method => rows.filter(row => row.method === method).length;
    assert.equal(counts("initialize"), 3);
    assert.equal(counts("session/new"), 3);
    assert.equal(counts("session/prompt"), 2, "Loading never executes a new prompt");
    assert.equal(counts("session/load"), 4);
    for (const row of rows) {
      assert.equal(new Date(row.timestamp).toISOString(), row.timestamp);
      assert.ok(clients.some(instance => instance.child.pid === row.pid));
      assert.deepEqual(Object.keys(row).sort(), ["lifecycle", "method", "nativeId", "pid", "timestamp"]);
      if (row.method === "initialize") assert.equal(row.nativeId, null);
      else assert.equal(typeof row.nativeId, "string");
      assert.equal(row.lifecycle, { initialize: "initialize", "session/new": "create", "session/prompt": "prompt", "session/load": "replay" }[row.method]);
    }
    assert.equal(new Set(rows.map(row => row.pid)).size, 3);
    assert.deepEqual(rows.filter(row => row.lifecycle === "create").map(row => row.nativeId), [a, b, c]);
    assert.deepEqual(rows.filter(row => row.lifecycle === "prompt").map(row => row.nativeId), [a, b]);

    const isolatedRoot = join(root, "isolated"), isolated = start(isolatedRoot);
    await initialize(isolated);
    assert.ok((await isolated.request("session/load", { sessionId: a })).error);
    const d = (await isolated.request("session/new")).result.sessionId;
    assert.equal(new Set([a, b, c, d]).size, 4);
    assert.deepEqual(notifications(isolated), []);
    await isolated.close();
    assert.deepEqual(fs.readdirSync(join(isolatedRoot, "state")), [d + ".json"]);
    assert.deepEqual(fs.readdirSync(join(root, "state")).sort(), [a, b, c].map(id => id + ".json").sort());
    assert.equal(logs(root).length, rows.length, "Supplied log locations stay isolated");
  } finally {
    await Promise.all(clients.map(instance => instance.cleanup()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit state and log locations are mandatory", { timeout: 5000 }, async () => {
  const root = temporary();
  try {
    for (const missing of ["HERMES_CC_FIXTURE_STATE_DIR", "HERMES_CC_FIXTURE_LOG"]) {
      const child = spawn(executable, ["acp"], { env: { PATH: process.env.PATH,
        HERMES_CC_FIXTURE_STATE_DIR: join(root, "state"), HERMES_CC_FIXTURE_LOG: join(root, "requests.jsonl"), [missing]: "" } });
      let stdout = "", stderr = "";
      child.stdout.on("data", bytes => { stdout += bytes; });
      child.stderr.on("data", bytes => { stderr += bytes; });
      try {
        const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        assert.equal(code, 1);
        assert.equal(stdout, "");
        assert.match(stderr, /explicit absolute HERMES_CC_FIXTURE_STATE_DIR and HERMES_CC_FIXTURE_LOG/);
      } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
    }
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
