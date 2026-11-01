"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createIdleLifecycleFixture } = require("./fixtures/idle-lifecycle-provider.cjs");

// Exercise the pinned host version, independently of the older development SDK.
async function hostModules() {
  const serverEntry = require.resolve("@getpaseo/server");
  const serverDir = dirname(serverEntry);
  return Promise.all(["agent/idle-runtime-cleanup/index.js", "agent/agent-manager.js", "agent/plugin-provider.js"]
    .map(path => import(pathToFileURL(join(serverDir, path)).href)));
}

async function harness(t) {
  const [{ createIdleRuntimeCleanup }, { AgentManager }, { PluginAgentClientRegistry }] = await hostModules();
  const fixture = createIdleLifecycleFixture({ runtimeSafety: true });
  const logger = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const providers = new PluginAgentClientRegistry(logger);
  providers.replace([fixture.registration]);
  t.after(() => providers.shutdown());
  const session = await providers.clients()[fixture.registration.id].createSession({ cwd: ".", mcpServers: {} }, {}, {});
  const id = fixture.inputs.find(input => input.type === "session.open").sessionId;
  const manager = new AgentManager({ logger, registry: {} });
  const agent = { id, session, provider: fixture.registration.id, persistence: { sessionId: id }, labels: {},
    updatedAt: new Date(1), lifecycle: "idle", internal: false, activeForegroundTurnId: null,
    pendingReplacement: false, pendingPermissions: new Map(), inFlightPermissionResponses: new Map() };
  manager.agents.set(id, agent);
  // Keep the host's eligibility and permission handlers; replace persistence and dispatch only.
  manager.refreshSessionPersistence = () => {};
  manager.broadcastAgentAttention = () => {};
  manager.emitState = () => {};
  const events = [];
  session.subscribe(event => {
    events.push(event);
    if (event.type === "permission_requested") manager.onStreamPermissionRequested(agent, event);
    if (event.type === "permission_resolved") manager.onStreamPermissionResolved({ agent, event, options: {}, flags: {} });
  });
  manager.closeAgentRuntime = async (agentId, revalidate) => {
    if (!revalidate()) return false;
    await session.close();
    manager.agents.delete(agentId);
    return true;
  };
  let now = 3600001;
  const cleanup = createIdleRuntimeCleanup({ enabled: true, runtimes: () => manager.getRuntimeCleanupCandidates(),
    logger, now: () => now, schedule: () => () => {} });
  t.after(() => cleanup.close());
  const completeTurn = async () => {
    await session.startTurn("synthetic", { clientMessageId: "turn-1" });
    assert.ok(events.some(event => event.type === "turn_completed" && event.turnId === "turn-1"));
  };
  return { fixture, id, session, cleanup, completeTurn, advance: () => { now += 3600000; } };
}

async function retainedThenCollected(h, release) {
  const first = await h.cleanup.sweep();
  assert.deepEqual(first, { collected: [], failures: [] });
  assert.equal(h.fixture.hasSession(h.id), true, "protected runtime must remain open");
  assert.equal(h.fixture.inputs.some(input => input.type === "session.close"), false, "cleanup must not send close while protected");
  await release();
  assert.deepEqual(await h.cleanup.sweep(), { collected: [], failures: [] }, "protection resets the idle clock");
  assert.ok(h.fixture.inputs.some(input => input.type === "session.can_stop_runtime"), "cleanup must consult the provider safety probe");
  h.advance();
  const result = await h.cleanup.sweep();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.collected.map(entry => entry.agentId), [h.id]);
  assert.equal(h.fixture.hasSession(h.id), false, "eligible runtime must close after the idle period");
}

test("host cleanup retains background work after a completed turn", async t => {
  const h = await harness(t);
  h.fixture.startBackground(h.id);
  await h.completeTurn();
  await retainedThenCollected(h, () => h.fixture.finishBackground(h.id));
});

test("host cleanup retains a session with a pending approval", async t => {
  const h = await harness(t);
  h.fixture.requestApproval(h.id);
  await h.completeTurn();
  await retainedThenCollected(h, () => h.session.respondToPermission("approval", { behavior: "deny" }));
});

test("host cleanup retains a provider with a live child process", async t => {
  const h = await harness(t);
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, "spawn");
  h.fixture.setChildProcess(h.id, child);
  await h.completeTurn();
  await retainedThenCollected(h, async () => { child.stdin.end(); await once(child, "exit"); });
});
