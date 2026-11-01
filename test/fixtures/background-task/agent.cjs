#!/usr/bin/env node
"use strict";

// Synthetic ACP agent. The control socket is fixture-only, not an ACP extension.
const net = require("node:net");
const fs = require("node:fs");
const { isAbsolute } = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");

const socket = process.env.BACKGROUND_TASK_FIXTURE_SOCKET;
if (process.argv.length !== 3 || process.argv[2] !== "acp" || !socket || !isAbsolute(socket)) {
  process.stderr.write("Expected acp and an explicit absolute BACKGROUND_TASK_FIXTURE_SOCKET\n");
  process.exit(1);
}
const sessions = new Map();
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const server = net.createServer(connection => {
  const lines = readline.createInterface({ input: connection, crlfDelay: Infinity });
  lines.on("line", line => {
    let command;
    try { command = JSON.parse(line); } catch { connection.write('{"error":"invalid JSON"}\n'); return; }
    const tasks = sessions.get(command?.sessionId);
    if (!tasks) { connection.write('{"error":"unknown session"}\n'); return; }
    if (command.action === "status") {
      connection.write(JSON.stringify({ tasks: Object.fromEntries(tasks) }) + "\n");
      return;
    }
    if (!["progress", "complete", "fail"].includes(command.action) || !tasks.has(command.taskId)) {
      connection.write('{"error":"unknown action or task"}\n'); return;
    }
    if (tasks.get(command.taskId) !== "in_progress") {
      connection.write('{"error":"task already finished"}\n'); return;
    }
    const status = command.action === "progress" ? "in_progress" : command.action === "complete" ? "completed" : "failed";
    tasks.set(command.taskId, status);
    update(command.sessionId, { sessionUpdate: "tool_call_update", toolCallId: command.taskId, status,
      content: [{ type: "content", content: { type: "text", text: `Synthetic task ${status === "in_progress" ? "in progress" : status}.` } }] });
    connection.write(JSON.stringify({ taskId: command.taskId, status }) + "\n");
  });
});
server.on("error", error => { process.stderr.write(`Control socket: ${error.message}\n`); process.exitCode = 1; });
server.listen(socket, () => {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      send({ id: request?.id ?? null, error: { code: -32600, message: "Invalid request" } }); return;
    }
    const { method, params = {} } = request;
    const reply = result => { if (request.id !== undefined) send({ id: request.id, result }); };
    const error = (code, message) => { if (request.id !== undefined) send({ id: request.id, error: { code, message } }); };
    if (method === "initialize") {
      reply({ protocolVersion: 1, agentInfo: { name: "synthetic-background-task-no-model", version: "1" },
        agentCapabilities: { loadSession: false }, authMethods: [] });
    } else if (method === "session/new") {
      const sessionId = randomUUID();
      sessions.set(sessionId, new Map());
      reply({ sessionId });
    } else if (method === "session/prompt") {
      const tasks = sessions.get(params.sessionId);
      if (!tasks || !Array.isArray(params.prompt) || tasks.size) {
        error(-32602, "Expected a new session and prompt array"); return;
      }
      for (const taskId of ["synthetic-complete", "synthetic-fail"]) {
        tasks.set(taskId, "in_progress");
        update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: taskId,
          title: `Background ${taskId}`, kind: "execute", status: "in_progress" });
      }
      update(params.sessionId, { sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Synthetic reply; background tasks are still running." } });
      reply({ stopReason: "end_turn" });
    } else {
      error(-32601, "Method not found");
    }
  });
  input.on("close", () => server.close(() => { fs.rmSync(socket, { force: true }); }));
});
