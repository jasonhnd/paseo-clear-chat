"use strict";
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const net = require("node:net");
const { isAbsolute, join } = require("node:path");
const readline = require("node:readline");
const test = require("node:test");

const agent = join(__dirname, "fixtures/background-task/agent.cjs");
const controlCli = join(__dirname, "fixtures/background-task/control.cjs");
const execFileAsync = promisify(execFile);
function start(socket) {
  const child = spawn(process.execPath, [agent, "acp"], {
    env: { BACKGROUND_TASK_FIXTURE_SOCKET: socket }, stdio: "pipe",
  });
  const messages = [], pending = new Map();
  let nextId = 0, stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    messages.push(message);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, messages, closed, stderr: () => stderr,
    request(method, params = {}) {
      const id = ++nextId;
      const result = new Promise(resolve => pending.set(id, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return result;
    },
  };
}
function control(socket, command) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    connection.on("error", reject);
    connection.on("connect", () => connection.write(JSON.stringify(command) + "\n"));
    const lines = readline.createInterface({ input: connection });
    lines.once("line", line => { connection.end(); resolve(JSON.parse(line)); });
  });
}

test("background tasks remain running after the reply until independently controlled", { timeout: 10000 }, async () => {
  assert.ok(process.env.TMPDIR && isAbsolute(process.env.TMPDIR));
  const root = fs.mkdtempSync(join(process.env.TMPDIR, "background-task-"));
  const socket = join(root, "control.sock");
  const instance = start(socket);
  try {
    const initialized = await instance.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(initialized.result.protocolVersion, 1);
    assert.match(initialized.result.agentInfo.name, /no-model/);
    const sessionId = (await instance.request("session/new", { cwd: root, mcpServers: [] })).result.sessionId;
    const otherId = (await instance.request("session/new", { cwd: root, mcpServers: [] })).result.sessionId;
    const prompt = await instance.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Run synthetic tasks" }] });
    assert.deepEqual(prompt.result, { stopReason: "end_turn" });
    const notifications = () => instance.messages.filter(message => message.method === "session/update");
    assert.deepEqual(notifications().map(message => message.params.update), [
      { sessionUpdate: "tool_call", toolCallId: "synthetic-complete", title: "Background synthetic-complete", kind: "execute", status: "in_progress" },
      { sessionUpdate: "tool_call", toolCallId: "synthetic-fail", title: "Background synthetic-fail", kind: "execute", status: "in_progress" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Synthetic reply; background tasks are still running." } },
    ]);
    assert.ok(instance.messages.indexOf(prompt) > instance.messages.indexOf(notifications().at(-1)));
    assert.deepEqual(await control(socket, { action: "status", sessionId }), {
      tasks: { "synthetic-complete": "in_progress", "synthetic-fail": "in_progress" },
    });
    assert.deepEqual(await control(socket, { action: "status", sessionId: otherId }), { tasks: {} });
    assert.deepEqual(await control(socket, { action: "complete", sessionId: otherId, taskId: "synthetic-complete" }), { error: "unknown action or task" });
    assert.deepEqual(await control(socket, { action: "fail", sessionId: "unknown", taskId: "synthetic-fail" }), { error: "unknown session" });
    assert.deepEqual(await control(socket, { action: "cancel", sessionId, taskId: "synthetic-fail" }), { error: "unknown action or task" });
    assert.equal(notifications().length, 3);
    assert.deepEqual(await control(socket, { action: "progress", sessionId, taskId: "synthetic-complete" }), { taskId: "synthetic-complete", status: "in_progress" });
    assert.deepEqual(await control(socket, { action: "progress", sessionId, taskId: "synthetic-fail" }), { taskId: "synthetic-fail", status: "in_progress" });
    assert.deepEqual(await control(socket, { action: "status", sessionId }), {
      tasks: { "synthetic-complete": "in_progress", "synthetic-fail": "in_progress" },
    });
    const command = { action: "complete", sessionId, taskId: "synthetic-complete" };
    const cli = await execFileAsync(process.execPath, [controlCli, JSON.stringify(command)], { env: { BACKGROUND_TASK_FIXTURE_SOCKET: socket } });
    assert.deepEqual(JSON.parse(cli.stdout), { taskId: "synthetic-complete", status: "completed" });
    assert.equal(cli.stderr, "");
    assert.deepEqual(await control(socket, { action: "status", sessionId }), {
      tasks: { "synthetic-complete": "completed", "synthetic-fail": "in_progress" },
    });
    assert.deepEqual(await control(socket, { action: "complete", sessionId, taskId: "synthetic-complete" }), { error: "task already finished" });
    assert.deepEqual(await control(socket, { action: "progress", sessionId, taskId: "synthetic-complete" }), { error: "task already finished" });
    assert.deepEqual(await control(socket, { action: "fail", sessionId, taskId: "synthetic-fail" }), { taskId: "synthetic-fail", status: "failed" });
    assert.deepEqual(await control(socket, { action: "status", sessionId }), {
      tasks: { "synthetic-complete": "completed", "synthetic-fail": "failed" },
    });
    // A subsequent ACP response is a barrier for notifications written by the controls.
    await instance.request("initialize");
    assert.deepEqual(notifications().slice(3).map(message => message.params), [
      { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "synthetic-complete", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "Synthetic task in progress." } }] } },
      { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "synthetic-fail", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "Synthetic task in progress." } }] } },
      { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "synthetic-complete", status: "completed", content: [{ type: "content", content: { type: "text", text: "Synthetic task completed." } }] } },
      { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "synthetic-fail", status: "failed", content: [{ type: "content", content: { type: "text", text: "Synthetic task failed." } }] } },
    ]);
    assert.ok(notifications().slice(3).every(message => instance.messages.indexOf(message) > instance.messages.indexOf(prompt)));
    assert.equal((await instance.request("session/prompt", { sessionId, prompt: [] })).error.code, -32602);
    instance.child.stdin.end();
    assert.deepEqual(await instance.closed, { code: 0, signal: null });
    assert.equal(instance.stderr(), "");
    assert.equal(fs.existsSync(socket), false);
  } finally {
    if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
    await instance.closed;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control socket must be explicit and cannot replace an existing file", { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(join(process.env.TMPDIR, "background-task-"));
  try {
    for (const socket of ["", "relative.sock"]) {
      const instance = start(socket);
      assert.deepEqual(await instance.closed, { code: 1, signal: null });
      assert.match(instance.stderr(), /explicit absolute BACKGROUND_TASK_FIXTURE_SOCKET/);
      assert.deepEqual(instance.messages, []);
    }
    const socket = join(root, "occupied");
    fs.writeFileSync(socket, "do not replace");
    const instance = start(socket);
    assert.deepEqual(await instance.closed, { code: 1, signal: null });
    assert.match(instance.stderr(), /Control socket:/);
    assert.equal(fs.readFileSync(socket, "utf8"), "do not replace");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
