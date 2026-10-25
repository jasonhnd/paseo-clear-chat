const assert = require("node:assert/strict");
const test = require("node:test");
const entries = require("./fixtures/real-claude-agent-message.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const delivery = entries.find(entry => entry.item.agentMessage).item;
const settle = () => new Promise(resolve => setImmediate(resolve));

// Match the host projection, which explicitly copies these fields and freezes
// the result before calling the plugin. The canonical fixture is API data only.
function projected(item = delivery) {
  return Object.freeze({ type: "tool_call", callId: item.callId, name: item.name,
    detail: Object.freeze({ ...item.detail }), status: item.status, error: item.error });
}
function source(timeline = entries) {
  const requests = [];
  const agent = { status: "idle", updatedAt: "2026-01-01T12:00:30Z" };
  const paseo = { agents: { ref: () => ({ timeline: { async refetch(options) {
    requests.push(options);
    return { entries: timeline, agent, error: null, hasNewer: false, hasOlder: false };
  } } }) } };
  return { requests, agent, paseo };
}
const summary = (h, tree) => h.text(h.nodes(tree, n => n.props.testID === "tool-summary-text"));

for (const platform of ["web", "ios", "android"]) {
  for (const width of [1440, 1024, 820, 390]) {
    test(`${platform} ${width}px: projected delivery recovers the sender through the canonical API`, async t => {
      const host = source();
      const h = createToolHarness(platform, { ...host, width });
      t.after(() => h.unmount());
      const item = projected();
      assert.ok(!("agentMessage" in item));
      const mounted = h.mount(item, false);
      assert.equal(mounted.data.agentMessage, undefined);
      assert.equal(summary(h, mounted.tree), "Message received");
      assert.ok(!h.text(mounted.tree).includes("sample-delivery"), "a delivery ID is not a sender ID");
      await settle();
      const tree = mounted.render();
      assert.equal(summary(h, tree), "Message received");
      assert.ok(h.nodes(tree, n => n.type === "Glyph" && n.props.name === "MessageSquare").length);
      assert.ok(!h.text(tree).includes("agent_message"));
      assert.deepEqual(host.requests, [{ direction: "tail", limit: 0, projection: "canonical" }]);
      const open = h.mount(item);
      await settle();
      assert.equal(h.text(open.render()).split(delivery.agentMessage.text).length - 1, 1);
      assert.ok(h.text(open.render()).includes("Sender: sample-coordinator"));
      assert.equal(host.requests.length, 1, "rows share the derived message cache");
    });
  }
}

test("a missing structured body falls back to the projected plain-text detail", () => {
  const h = createToolHarness();
  const item = { ...delivery, agentMessage: { event: "message", sender: { id: "sample-coordinator" } } };
  const { data } = h.mount(item, false);
  const built = h.load("client/tool-call-data.ts").buildLiveToolCallData(data);
  assert.equal(built.title, "Message received");
  assert.equal(built.copyResult, `Sender: sample-coordinator\n\n${delivery.detail.text}`);
  h.unmount();
});

test("an already open detail panel receives recovered provenance and copies the body once", async t => {
  const host = source();
  const h = createToolHarness("web", { ...host, preferences: { collapsedStepAction: "details" } });
  t.after(() => h.unmount());
  const mounted = h.mount(projected());
  await settle();
  mounted.render();
  const tree = mounted.render();
  const output = h.nodes(tree, n => n.props.testID === "step-detail-output")[0];
  const expected = `Sender: sample-coordinator\n\n${delivery.detail.text}`;
  assert.equal(h.text(output), expected);
  assert.equal(h.text(tree).split(delivery.detail.text).length - 1, 1);
  await h.nodes(tree, n => n.props.testID === "step-detail-copy-output")[0].props.onPress();
  assert.deepEqual(h.copies, [expected]);
});

test("failed provenance lookup keeps the projected body without inventing a sender", async t => {
  const host = source();
  host.paseo.agents.ref = () => ({ timeline: { refetch: async () => { throw Error("Sample unavailable"); } } });
  const h = createToolHarness("web", host);
  t.after(() => h.unmount());
  const mounted = h.mount(projected());
  await settle();
  const text = h.text(mounted.render());
  assert.equal(summary(h, mounted.render()), "Message received");
  assert.equal(text.split(delivery.detail.text).length - 1, 1);
  assert.ok(!text.includes("sample-delivery"));
  assert.ok(!text.includes("Sender:"));
});

test("delivery recognition requires both the reserved call ID and exact tool name", async t => {
  const host = source();
  const h = createToolHarness("web", host);
  t.after(() => h.unmount());
  for (const patch of [{ callId: "sample-ordinary-tool" }, { name: "sample_tool" }, { callId: "paseo-agent-message:" }]) {
    const item = { ...projected(), ...patch };
    assert.equal(summary(h, h.mount(item, false).tree), item.name);
  }
  await settle();
  assert.equal(host.requests.length, 0);
});

test("new deliveries wait for settling and share one provenance read", async t => {
  const first = structuredClone(entries);
  const host = source(first);
  host.agent.status = "running";
  const h = createToolHarness("web", host);
  t.after(() => h.unmount());
  const mounted = h.mount(projected(), false);
  await settle();
  assert.equal(summary(h, mounted.render()), "Message received");
  const next = { ...delivery, callId: "paseo-agent-message:sample-next-delivery",
    agentMessage: { event: "finished", sender: { id: "sample-worker" }, text: "Sample task complete." } };
  first.push({ item: next });
  const second = h.mount(projected(next), false);
  await settle();
  assert.equal(summary(h, second.render()), "Message received");
  assert.equal(host.requests.length, 0, "missing senders never refetch while running");
  host.agent.status = "idle";
  host.agent.updatedAt = "2026-01-01T12:01:00Z";
  second.render();
  await settle();
  assert.equal(summary(h, second.render()), "Agent finished");
  assert.equal(host.requests.length, 1);
});

test("late lookup results cannot cross hosts sharing the same delivery ID", async t => {
  const host = source();
  let resolveRead;
  let requests = 0;
  host.paseo.agents.ref = () => ({ timeline: { refetch: () => ++requests === 1
    ? new Promise(resolve => { resolveRead = resolve; })
    : Promise.resolve({ entries: [], agent: host.agent }) } });
  const h = createToolHarness("web", host);
  t.after(() => h.unmount());
  const { LiveToolCallRenderer } = h.load("client/live-renderers.tsx");
  const props = { host: { id: "sample-first-host" }, agentId: "sample-agent", timestamp: new Date(0),
    theme: { colors: {} }, item: { data: projected() } };
  h.draw({ type: LiveToolCallRenderer, props });
  await settle();
  props.host = { id: "sample-second-host" };
  h.draw({ type: LiveToolCallRenderer, props });
  resolveRead({ entries, agent: host.agent });
  await settle();
  assert.equal(summary(h, h.draw({ type: LiveToolCallRenderer, props })), "Message received");
});

for (const platform of ["web", "ios", "android"]) {
  for (const width of [1440, 1024, 820, 390]) {
    for (const origin of ["canonical", "snapshot"]) {
      test(`${platform} ${width}px: projected sender name from ${origin}`, async t => {
        const timeline = structuredClone(entries);
        if (origin === "canonical") timeline[1].item.agentMessage.sender.title = "Sample coordinator";
        const host = source(timeline);
        const h = createToolHarness(platform, { ...host, width,
          agents: { "sample-coordinator": { title: origin === "canonical" ? "Different current title" : "Sample coordinator" } } });
        t.after(() => h.unmount());
        const mounted = h.mount(projected(), false);
        await settle();
        assert.equal(summary(h, mounted.render()), "Message from Sample coordinator");
        assert.ok(!summary(h, mounted.render()).includes(delivery.agentMessage.sender.id));
      });
    }
  }
}

test("internal identifiers and blank titles never become a sender name", () => {
  const h = createToolHarness();
  const build = h.load("client/tool-call-data.ts").buildLiveToolCallData;
  for (const title of [" ", "sample-coordinator", delivery.callId,
    "12345678-1234-1234-1234-123456789abc"]) {
    const item = { ...delivery, agentMessage: { ...delivery.agentMessage,
      sender: { ...delivery.agentMessage.sender, title } } };
    assert.equal(build(item).title, "Message received");
  }
  h.unmount();
});

test("sender snapshot updates supply names and never reuse the recipient title", async t => {
  const host = source();
  const agents = { "sample-coordinator": { title: null } };
  const h = createToolHarness("web", { ...host, agents,
    agent: { ...host.agent, title: "Recipient title" } });
  t.after(() => h.unmount());
  const mounted = h.mount(projected(), false);
  await settle();
  assert.equal(summary(h, mounted.render()), "Message received");
  agents["sample-coordinator"].title = "Sample coordinator";
  assert.equal(summary(h, mounted.render()), "Message from Sample coordinator");
  agents["sample-coordinator"].title = "sample-coordinator";
  assert.equal(summary(h, mounted.render()), "Message received");
});

test("sender and reply renderers share a cursor and missing deliveries cannot start another full read", async t => {
  const timing = require("./fixtures/real-claude-turn-timing.json");
  const host = source();
  const next = { ...delivery, callId: "paseo-agent-message:sample-incremental",
    agentMessage: { event: "finished", sender: { id: "sample-worker", title: "Sample worker" }, text: "Sample task complete." } };
  const pages = [[...timing, ...entries], [{ item: next }], []];
  host.paseo.agents.ref = () => ({ timeline: { async refetch(options) {
    host.requests.push(options);
    return { entries: pages.shift(), agent: host.agent, endCursor: { epoch: "sample-epoch", seq: host.requests.length * 20 },
      epoch: "sample-epoch", error: null, hasNewer: false, hasOlder: false };
  } } });
  const h = createToolHarness("web", { ...host, replyFooter: true });
  t.after(() => h.unmount());
  const final = timing.at(-1);
  const reply = h.mount(final.item, false, { timestamp: new Date(final.timestamp) });
  await settle();
  assert.match(h.text(reply.render()), /Worked for 21s/);
  const sender = h.mount(projected(), false);
  await settle();
  assert.ok(h.text(sender.render()).includes("Message received"));
  const pending = h.mount(projected(next), false);
  await settle();
  assert.equal(summary(h, pending.render()), "Message received");
  assert.equal(host.requests.length, 1, "all consumers share the settled read even for a missing call ID");
  host.agent.status = "running";
  pending.render(); await settle();
  assert.equal(host.requests.length, 1);
  host.agent.status = "idle";
  host.agent.updatedAt = "2026-01-01T12:02:00Z";
  pending.render(); await settle();
  assert.equal(summary(h, pending.render()), "Agent finished · Sample worker");
  assert.deepEqual(host.requests[1], { direction: "after", cursor: { epoch: "sample-epoch", seq: 20 }, limit: 0, projection: "canonical" });
  const oldSender = h.mount(projected(), true);
  await settle();
  assert.ok(h.text(oldSender.render()).includes("Sender: sample-coordinator"), "earlier provenance survives a delta");
  assert.equal(host.requests.length, 2);
});
