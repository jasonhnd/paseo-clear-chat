"use strict";

// A standalone control protocol, not a Paseo or ACP endpoint.
const readline = require("node:readline");
const sources = ["source-a", "source-b"];
const text = "Identical synthetic message.";
const tasks = new Map();
let phase = "new", sequence = 0, humanSeen = false;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const event = value => send({ event: { sequence: ++sequence, ...value } });

function startTask(source) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const task = { release, state: "pending" };
  task.done = gate.then(() => {
    event({ type: "message", messageId: `message-${source}`, source, text });
    task.state = "finished";
    event({ type: "task_finished", source });
  });
  tasks.set(source, task);
  event({ type: "task_started", source });
}

async function handle(request) {
  if (!request || !Number.isSafeInteger(request.id) || typeof request.op !== "string") {
    throw new Error("Expected an integer id and an op");
  }
  switch (request.op) {
    case "start":
      if (phase !== "new") throw new Error("Already started");
      phase = "running";
      sources.forEach(startTask);
      return { pending: sources };
    case "human":
      if (phase !== "running" || humanSeen || [...tasks.values()].some(task => task.state !== "pending")) {
        throw new Error("Human input requires both tasks pending");
      }
      humanSeen = true;
      event({ type: "human_message", messageId: "message-human", text: "Synthetic human input." });
      return { pending: sources };
    case "release": {
      const task = tasks.get(request.source);
      if (phase !== "running" || !humanSeen || !task || task.state !== "pending") {
        throw new Error("Source cannot be released");
      }
      task.state = "releasing";
      task.release();
      await task.done;
      return { pending: sources.filter(source => tasks.get(source).state === "pending") };
    }
    case "finish":
      if (phase !== "running" || !humanSeen || [...tasks.values()].some(task => task.state !== "finished")) {
        throw new Error("Tasks are still pending");
      }
      phase = "finished";
      event({ type: "run_finished" });
      return { complete: true };
    default:
      throw new Error("Unknown operation");
  }
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      const result = await handle(request);
      send({ id: request.id, result });
    } catch (error) {
      send({ id: Number.isSafeInteger(request?.id) ? request.id : null, error: error.message });
    }
  });
});
input.on("close", () => { queue.then(() => process.stdout.end()); });
