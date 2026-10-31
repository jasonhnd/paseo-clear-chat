#!/usr/bin/env node
"use strict";

const net = require("node:net");
const { isAbsolute } = require("node:path");
const readline = require("node:readline");
const socket = process.env.BACKGROUND_TASK_FIXTURE_SOCKET;
if (!socket || !isAbsolute(socket) || process.argv.length !== 3) {
  process.stderr.write("Expected an absolute BACKGROUND_TASK_FIXTURE_SOCKET and one JSON command argument\n");
  process.exit(1);
}
let command;
try { command = JSON.parse(process.argv[2]); }
catch { process.stderr.write("Command must be JSON\n"); process.exit(1); }
const connection = net.createConnection(socket);
connection.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
connection.on("connect", () => connection.write(JSON.stringify(command) + "\n"));
const lines = readline.createInterface({ input: connection });
lines.once("line", line => {
  process.stdout.write(line + "\n");
  if (JSON.parse(line).error) process.exitCode = 1;
  connection.end();
});
