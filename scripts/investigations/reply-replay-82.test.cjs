// Investigation probe: uses the installed Paseo 0.14 server internals deliberately.
// The Codex response is synthetic; no app server, credentials, or model are used.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createToolHarness } = require("../../test/helpers/tool-harness.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
async function serverModules() {
  const bin = fs.realpathSync(execFileSync("which", ["paseo"], { encoding: "utf8" }).trim());
  const cli = path.resolve(path.dirname(bin), "..");
  const version = JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8")).version;
  assert.equal(version, "0.14.0");
  const base = path.join(cli, "node_modules/@getpaseo/server/dist/server/server/agent");
  const load = name => import(pathToFileURL(path.join(base, name)).href);
  const [{ CodexAppServerAgentSession }, { AgentManager }, { InMemoryAgentTimelineStore }] = await Promise.all([
    load("providers/codex-app-server-agent.js"), load("agent-manager.js"), load("agent-timeline-store.js"),
  ]);
  return { CodexAppServerAgentSession, AgentManager, InMemoryAgentTimelineStore };
}

async function render(entries) {
  const agent = { status: "idle", updatedAt: "2026-01-01T00:01:00Z", cwd: "/synthetic" };
  const requests = [];
  const paseo = { agents: { ref: () => ({ timeline: { async refetch(options) {
    requests.push(options);
    return { entries, agent, hasOlder: false, hasNewer: false, error: null };
  } } }) } };
  const h = createToolHarness("web", { paseo, agent, markdown: true, replyFooter: true });
  const last = entries.at(-1);
  const mounted = h.mount(last.item, false, { timestamp: new Date(last.timestamp) });
  await settle();
  const tree = mounted.render();
  const duration = h.nodes(tree, node => node.props.testID === "reply-duration");
  assert.equal(duration.length, 1);
  assert.equal(requests[0].projection, "canonical");
  const text = h.text(duration[0]);
  h.unmount();
  return text;
}

test("Paseo Codex replay without source timing changes a rendered 21s reply to 0s", async t => {
  const { CodexAppServerAgentSession, AgentManager, InMemoryAgentTimelineStore } = await serverModules();
  const fakeResponse = { thread: { turns: [{ id: "synthetic-turn", items: [
    { id: "synthetic-user", type: "userMessage", content: [{ type: "text", text: "Synthetic prompt" }] },
    { id: "synthetic-reply", type: "agentMessage", text: "Synthetic answer" },
  ] }] } };
  const logger = { child() { return this; }, warn() {} };
  const session = new CodexAppServerAgentSession({ cwd: process.cwd() }, { sessionId: "synthetic-thread" }, logger, () => { throw Error("unexpected spawn"); });
  await session.loadPersistedHistory({ async request(method, params) {
    assert.equal(method, "thread/read");
    assert.equal(params.includeTurns, true);
    return structuredClone(fakeResponse);
  } });
  const replay = [];
  for await (const event of session.streamHistory()) replay.push(event);
  assert.deepEqual(replay.map(event => event.item.type), ["user_message", "assistant_message"]);
  assert(replay.every(event => event.timestamp === undefined));

  const store = new InMemoryAgentTimelineStore();
  store.initialize("synthetic");
  store.append("synthetic", replay[0].item, { timestamp: "2026-01-01T00:00:00.000Z" });
  store.append("synthetic", replay[1].item, { timestamp: "2026-01-01T00:00:21.099Z" });
  const initial = store.fetch("synthetic", { limit: 0 }).rows;
  const before = await render(initial);

  // Exercise the actual legacy history hydration method, with its persistence and
  // dispatch dependencies stubbed. recordTimeline delegates to the host store.
  const manager = {
    logger, async deleteCommittedTimeline() { store.initialize("synthetic"); },
    recordTimeline(id, item, options) { return store.append(id, item, options); },
  };
  const managed = { id: "synthetic", session: { async *streamHistory() { yield* replay; } } };
  await AgentManager.prototype.primeTimelineFromLegacyProviderHistory.call(manager, managed, false);
  const restored = store.fetch("synthetic", { limit: 0 }).rows;
  const gap = Date.parse(restored.at(-1).timestamp) - Date.parse(restored[0].timestamp);
  assert(gap >= 0 && gap < 1000, `replay timestamp gap ${gap}ms`);
  const after = await render(restored);
  assert.equal(before, "Worked for 21s");
  assert.equal(after, "Worked for 0s");

  // Control: the same reader uses the turn's supplied start and end times.
  fakeResponse.thread.turns[0].startedAt = "2026-01-01T00:00:00.000Z";
  fakeResponse.thread.turns[0].completedAt = "2026-01-01T00:00:21.099Z";
  await session.loadPersistedHistory({ async request() { return structuredClone(fakeResponse); } });
  const timedReplay = [];
  for await (const event of session.streamHistory()) timedReplay.push(event);
  managed.session = { async *streamHistory() { yield* timedReplay; } };
  await AgentManager.prototype.primeTimelineFromLegacyProviderHistory.call(manager, managed, false);
  const timed = await render(store.fetch("synthetic", { limit: 0 }).rows);
  assert.equal(timed, "Worked for 21s");
  t.diagnostic(`Paseo 0.14.0; initial: ${before}; replay without source timestamps: ${after}; regenerated gap: ${gap}ms; replay with turn timestamps: ${timed}`);
});
