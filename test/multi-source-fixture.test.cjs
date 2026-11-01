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
  timeout: 30000, skip: host ? false : "Paseo 0.14.0 server is not installed; set PASEO_SERVER_ROOT",
}, async () => {
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
