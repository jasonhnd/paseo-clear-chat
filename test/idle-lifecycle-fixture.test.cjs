"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createIdleLifecycleFixture } = require("./fixtures/idle-lifecycle-provider.cjs");

async function harness(t) {
  const { ProviderInputSchema, ProviderEventSchema } = await import("@getpaseo/plugin/server/provider");
  const fixture = createIdleLifecycleFixture();
  const connection = await fixture.registration.connect({ versions: [1], capabilities: ["prompt.message", "permission", "session.subsession"] });
  const events = [];
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  t.after(() => connection.close());
  return { fixture, events, send: input => connection.send(ProviderInputSchema.parse(input)) };
}
const open = id => ({ type: "session.open", requestId: `open-${id}`, sessionId: id,
  config: { cwd: ".", env: {}, mcpServers: {}, settings: {}, persist: false }, history: "skip" });
const prompt = id => ({ type: "session.prompt", sessionId: id, prompt: { clientMessageId: "turn-1", delivery: "auto",
  input: { type: "message", content: [{ type: "text", text: "synthetic" }] } } });
const close = (id, requestId) => ({ type: "session.close", sessionId: id, requestId });

test("synthetic work and approval outlive a completed turn and resolve independently", async t => {
  const { fixture, events, send } = await harness(t);
  await send(open("parent"));
  fixture.startBackground("parent");
  fixture.requestApproval("parent");
  await send(prompt("parent"));
  assert.deepEqual(events.map(e => e.type), ["session.opened", "session.ready", "timeline.item", "session.permission",
    "session.prompt_result", "session.turn", "session.turn"]);
  assert.equal(events[2].item.status, "running");
  assert.equal(events[3].request.id, "approval");
  assert.equal(events.at(-1).state, "completed");
  assert.throws(() => fixture.startBackground("parent"), /already running/);
  assert.throws(() => fixture.requestApproval("parent"), /already pending/);
  await send({ type: "session.permission", sessionId: "parent", permissionId: "approval", response: { behavior: "deny" } });
  assert.deepEqual(events.at(-1), { type: "session.permission_resolved", sessionId: "parent", permissionId: "approval" });
  fixture.finishBackground("parent");
  assert.equal(events.at(-1).item.status, "completed");
  assert.throws(() => fixture.finishBackground("parent"), /No work running/);
  await assert.rejects(send({ type: "session.permission", sessionId: "parent", permissionId: "approval", response: { behavior: "allow" } }), /Unknown synthetic approval/);
  assert.equal(fixture.hasSession("parent"), true);
});

test("child targeting and synthetic refusal retain identity; successful close is a negative control", async t => {
  const { fixture, events, send } = await harness(t);
  await send(open("parent"));
  fixture.openChild("parent", "child");
  assert.deepEqual(events[2], { type: "session.opened", sessionId: "child", parentSessionId: "parent", toolCallId: "child-call",
    cwd: ".", capabilities: ["prompt.message", "permission", "session.subsession"], restoration: "parent" });
  fixture.startBackground("child");
  fixture.requestApproval("child");
  fixture.setCloseRefusal("child", true);
  await send(close("child", "refused"));
  assert.deepEqual(events.at(-1), { type: "request.failed", requestId: "refused",
    error: { code: "synthetic_refusal", message: "Synthetic close refusal" } });
  fixture.setPromptRefusal("child", true);
  const beforeRefusedPrompt = events.length;
  await send(prompt("child"));
  const refusedEvents = events.slice(beforeRefusedPrompt);
  assert.deepEqual(refusedEvents.find(e => e.type === "session.prompt_result"), {
    type: "session.prompt_result", sessionId: "child", clientMessageId: "turn-1",
    result: { type: "failed", error: { code: "synthetic_refusal", message: "Synthetic message refusal" } },
  }, "sender must receive the message refusal");
  assert.equal(refusedEvents.some(e => e.type === "timeline.item" && e.item.type === "user_message"), false,
    "the conversation must not show the refused message as saved");
  assert.equal(refusedEvents.some(e => e.type === "session.turn" ||
    (e.type === "session.prompt_result" && e.result.type !== "failed")), false,
    "the refused message must not be admitted as a turn");
  assert.equal(fixture.hasSession("child"), true);
  assert.equal(fixture.hasSession("parent"), true);
  await send(close("parent", "parent-close"));
  assert.deepEqual(events.slice(-2), [{ type: "session.closed", sessionId: "parent" }, { type: "request.completed", requestId: "parent-close" }]);
  assert.equal(fixture.hasSession("parent"), false);
  assert.equal(fixture.hasSession("child"), true);
  fixture.finishBackground("child");
  await send({ type: "session.permission", sessionId: "child", permissionId: "approval", response: { behavior: "allow" } });
  fixture.setCloseRefusal("child", false);
  await send(close("child", "accepted"));
  assert.deepEqual(events.slice(-2), [{ type: "session.closed", sessionId: "child" }, { type: "request.completed", requestId: "accepted" }]);
  assert.equal(fixture.hasSession("child"), false);
  assert.deepEqual(fixture.inputs.filter(i => i.type === "session.close"), [close("child", "refused"), close("parent", "parent-close"), close("child", "accepted")]);
  await assert.rejects(send(close("child", "missing")), /Unknown synthetic session/);
});

test("fixture instances are isolated and reject duplicate identities", async t => {
  const first = await harness(t), second = await harness(t);
  await first.send(open("same"));
  assert.equal(second.fixture.hasSession("same"), false);
  await second.send(open("same"));
  await assert.rejects(first.send(open("same")), /Duplicate synthetic session/);
  assert.throws(() => first.fixture.openChild("same", "same"), /Duplicate synthetic session/);
  await first.send(close("same", "close"));
  assert.equal(second.fixture.hasSession("same"), true);
  assert.equal(second.events.some(e => e.type === "session.closed"), false);
});
