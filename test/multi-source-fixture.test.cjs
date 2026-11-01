"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { delimiter, dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

// The host is an integration-test prerequisite, not the plugin's 0.13 SDK.
function hostDirectory() {
  if (process.env.PASEO_SERVER_ROOT) return resolve(process.env.PASEO_SERVER_ROOT);
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const cli = join(dir, "paseo");
    if (!fs.existsSync(cli)) continue;
    try {
      const entry = createRequire(fs.realpathSync(cli)).resolve("@getpaseo/server");
      return resolve(dirname(entry), "../../..");
    } catch { /* Try the next executable. */ }
  }
  return null;
}
const host = hostDirectory();
test("concurrent sources use Paseo's queued timeline and deduplication", {
  timeout: 30000,
}, async () => {
  assert.ok(host, "Install Paseo 0.14.0 or set PASEO_SERVER_ROOT to its server package before running npm test");
  const version = JSON.parse(fs.readFileSync(join(host, "package.json"), "utf8")).version;
  assert.equal(version, "0.14.0", "This regression targets Paseo server 0.14.0");
  const agentDir = join(host, "dist/server/server/agent");
  const { AgentManager } = await import(pathToFileURL(join(agentDir, "agent-manager.js")));
  const { formatAgentMessage } = await import(pathToFileURL(join(agentDir, "agent-messages/index.js")));
  const errors = [];
  const logger = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error(...args) { errors.push(args); } };
  let listener;
  const session = {
    capabilities: {}, describePersistence: () => null,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    getAvailableModes: async () => [], getCurrentMode: async () => null,
    getPendingPermissions: () => [], getRuntimeInfo: async () => ({}),
    close: async () => {},
  };
  const manager = new AgentManager({ logger, agentStreamCoalesceWindowMs: 0 });
  await manager.registerSession(session, { provider: "synthetic", cwd: process.cwd() }, "00000000-0000-4000-8000-000000000001", {});

  // Pause the real deduplication read after it has observed the timeline. This
  // models a slow storage read and ensures the other sources arrive in flight.
  let releaseRead, signalRead;
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const reading = new Promise(resolve => { signalRead = resolve; });
  const originalRead = manager.getLastItemFromStores.bind(manager);
  manager.getLastItemFromStores = async id => {
    const last = await originalRead(id);
    signalRead();
    await gate;
    return last;
  };
  const failure = () => ({ type: "turn_failed", provider: "synthetic", error: "Synthetic failure" });
  const delivery = (id, source) => ({ type: "timeline", provider: "synthetic", item: {
    type: "user_message", text: formatAgentMessage({ id, text: "Same synthetic text", source: {
      kind: "agent-message", agentId: source, title: `Title ${source}`,
    } }),
  } });
  const echo = { type: "timeline", provider: "synthetic", item: {
    type: "user_message", text: "Synthetic human input", clientMessageId: "human-1", messageId: "provider-1",
  } };
  try {
    listener(failure());
    await reading;
    // The remaining deliveries enter the same session while the first is held.
    for (const event of [failure(), delivery("msg-b", "source-b"), echo,
      delivery("msg-a", "source-a"), delivery("msg-c", "source-c"), delivery("msg-b", "source-b"), echo]) listener(event);
    await new Promise(resolve => setImmediate(resolve));
    releaseRead();
    await manager.drainSessionEvents("00000000-0000-4000-8000-000000000001");
    assert.deepEqual(errors, [], "Host must process every event without errors");
    const rows = manager.getTimeline("00000000-0000-4000-8000-000000000001");
    assert.equal(rows.length, 5, "One error, three distinct sources, and one human message survive");
    assert.equal(rows.find(row => row.type === "assistant_message")?.text, "[System Error] Synthetic failure", "Identical adjacent failures are deduplicated");
    assert.deepEqual(rows.map(row => row.type), ["assistant_message", "tool_call", "user_message", "tool_call", "tool_call"]);
    assert.deepEqual(rows.filter(row => row.type === "tool_call").map(row => ({
      id: row.callId, sender: row.agentMessage.sender, text: row.agentMessage.text,
    })), ["b", "a", "c"].map(letter => ({
      id: `paseo-agent-message:msg-${letter}`,
      sender: { id: `source-${letter}`, title: `Title source-${letter}` }, text: "Same synthetic text",
    })));
    assert.deepEqual(rows.filter(row => row.type === "user_message").map(row => ({
      text: row.text, clientMessageId: row.clientMessageId,
    })), [{ text: "Synthetic human input", clientMessageId: "human-1" }]);
    const human = (await manager.getTimelineRows("00000000-0000-4000-8000-000000000001")).find(row => row.item.type === "user_message");
    assert.equal(human.providerMessageId, "provider-1");
  } finally {
    releaseRead();
    await manager.drainSessionEvents("00000000-0000-4000-8000-000000000001");
  }
});

// Exercise submission before provider delivery. Only the session and storage
// boundaries are synthetic; routing, admission, and projection are Paseo's.
async function submissionsScenario(fault) {
  assert.ok(host, "Install Paseo 0.14.0 or set PASEO_SERVER_ROOT to its server package before running npm test");
  const agentDir = join(host, "dist/server/server/agent");
  const { AgentManager } = await import(pathToFileURL(join(agentDir, "agent-manager.js")));
  const { createAgentMessageDelivery, parseAgentMessages } = await import(pathToFileURL(join(agentDir, "agent-messages/index.js")));
  const { sendPreparedPromptToAgent, sendPromptToAgent } = await import(pathToFileURL(join(agentDir, "agent-prompt.js")));
  const agentId = "00000000-0000-4000-8000-000000000002";
  const errors = [];
  const logger = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error(...args) { errors.push(args); } };
  const received = [];
  let listener, release, entered, humanEntered;
  const gate = new Promise(resolve => { release = resolve; });
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const humanInAdmission = new Promise(resolve => { humanEntered = resolve; });
  const session = {
    capabilities: {}, describePersistence: () => null,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    getAvailableModes: async () => [], getCurrentMode: async () => null,
    getPendingPermissions: () => [], getRuntimeInfo: async () => ({}), close: async () => {},
    async steerActiveTurn(prompt, options) {
      const messages = parseAgentMessages(prompt);
      const values = messages ? messages.map(m => ({ id: m.id, sender: m.source?.agentId, text: m.text }))
        : [{ id: options.clientMessageId, sender: "human", text: prompt }];
      if (!received.length) { entered(); await gate; }
      for (const value of values) {
        if (fault === "lost" && value.id === "msg-b") continue;
        const row = fault === "misattributed" && value.id === "msg-b" ? { ...value, sender: "source-a" } : value;
        received.push(row);
        if (fault === "duplicate" && value.id === "msg-b") received.push(row);
      }
      return { status: "accepted" };
    },
  };
  const manager = new AgentManager({ logger, agentStreamCoalesceWindowMs: 0 });
  await manager.registerSession(session, { provider: "synthetic", cwd: process.cwd() }, agentId, {});
  listener({ type: "turn_started", provider: "synthetic", turnId: "synthetic-turn" });
  await manager.drainSessionEvents(agentId);
  const steer = manager.steerOrReplaceActiveTurn.bind(manager);
  manager.steerOrReplaceActiveTurn = (id, prompt, options) => {
    if (options?.clientMessageId === "human-1") humanEntered();
    return steer(id, prompt, options);
  };
  const storage = { get: async () => null };
  const common = { agentManager: manager, agentStorage: storage, agentId, logger, activeTurnBehavior: "steer", unarchive: false };
  let scheduled;
  const delivery = createAgentMessageDelivery({
    schedule(_delay, callback) { scheduled = callback; return () => {}; },
    dispatch: batch => sendPreparedPromptToAgent({ ...common, prompt: batch.prompt, activeTurnBehavior: batch.activeTurnBehavior,
      runOptions: { clientMessageId: batch.messageIds[0] }, onDispatch: batch.onDispatch }).then(result => result.disposition),
    onError(error) { errors.push(error); },
  });
  const source = letter => delivery.enqueue({ recipientId: agentId, messageId: `msg-${letter}`, prompt: "Same synthetic text",
    source: { kind: "agent-message", agentId: `source-${letter}`, title: `Title source-${letter}` } });
  try {
    const a = source("a");
    scheduled();
    await firstEntered;
    const b = source("b");
    scheduled();
    const human = sendPromptToAgent({ ...common, prompt: "Synthetic human input", runOptions: { clientMessageId: "human-1" } });
    await humanInAdmission;
    release();
    await Promise.all([a.dispatched, b.dispatched, human]);
    await manager.drainSessionEvents(agentId);
    return { received, rows: manager.getTimeline(agentId), errors };
  } finally {
    release();
    await delivery.close();
    await manager.drainSessionEvents(agentId);
  }
}

function assertSubmissions(result) {
  assert.deepEqual(result.errors, [], "submission paths must not report errors");
  const expected = [
    { id: "msg-a", sender: "source-a", text: "Same synthetic text" },
    { id: "msg-b", sender: "source-b", text: "Same synthetic text" },
    { id: "human-1", sender: "human", text: "Synthetic human input" },
  ].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual([...result.received].sort((a, b) => a.id.localeCompare(b.id)), expected,
    "two agent sources and a human must each reach the session once with their own identity");
  const actual = result.rows.map(row => row.type === "tool_call"
    ? { id: row.callId.replace("paseo-agent-message:", ""), sender: row.agentMessage.sender.id, text: row.agentMessage.text }
    : { id: row.clientMessageId, sender: "human", text: row.text });
  assert.deepEqual(actual.sort((a, b) => a.id.localeCompare(b.id)), expected,
    "the shared timeline must retain each accepted submission exactly once and attribute it correctly");
}

test("independent agent deliveries overlap human submission without loss or misattribution", { timeout: 30000 }, async () => {
  assertSubmissions(await submissionsScenario());
});

test("submission oracle rejects lost, duplicated, and misattributed deliveries", { timeout: 30000 }, async () => {
  for (const fault of ["lost", "duplicate", "misattributed"]) {
    const result = await submissionsScenario(fault);
    assert.throws(() => assertSubmissions(result), /two agent sources and a human/);
  }
});
