const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const filename = resolve(__dirname, "../server/hermes-cc/model-protocol.ts");
const mod = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText)(createRequire(filename), mod, mod.exports);
const { hermesCcModelProtocol } = mod.exports;
const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const models = { currentModelId: "openai-codex:gpt-fixture", availableModels: [
  { modelId: "openai-codex:gpt-fixture", name: "GPT fixture" },
  { modelId: "anthropic:claude-fixture", name: "Claude fixture" },
] };
const policy = { id: "clear-chat-native-model", name: "Policy", type: "select", category: "mode",
  currentValue: "default", options: [{ value: "default", name: "Default" }] };
function opened(protocol, configOptions = [policy]) {
  protocol.sent(request(1, "session/new"));
  return protocol.received(reply(1, { sessionId: "native", models, configOptions })).result;
}

test("native bridge preserves options, correlates IDs, and publishes only confirmed selections", () => {
  const captured = [], protocol = hermesCcModelProtocol(state => captured.push(structuredClone(state)));
  const initial = opened(protocol);
  assert.deepEqual(initial.configOptions[0], policy);
  const selector = initial.configOptions[1];
  assert.equal(selector.id, "clear-chat-native-model_");
  const select = (id, value) => protocol.sent(request(id, "session/set_config_option", {
    sessionId: "native", configId: selector.id, value,
  }));
  assert.deepEqual(select(2, "anthropic:claude-fixture"), request(2, "session/set_model", {
    sessionId: "native", modelId: "anthropic:claude-fixture",
  }));
  assert.equal(captured.length, 0);
  const failure = { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Not supported" } };
  assert.deepEqual(protocol.received(failure), failure);
  assert.equal(captured.length, 0);
  // String and numeric JSON-RPC IDs must remain distinct, including responses out of order.
  select(3, "anthropic:claude-fixture");
  const original = request("3", "session/set_config_option", { sessionId: "native", configId: policy.id, value: "default" });
  assert.deepEqual(protocol.sent(original), original);
  const policyReply = protocol.received(reply("3", { configOptions: [policy] }));
  assert.equal(policyReply.result.configOptions[1].currentValue, models.currentModelId);
  assert.equal(protocol.received(reply(3, {})).result.configOptions[1].currentValue, "anthropic:claude-fixture");
  assert.equal(captured.at(-1).models.currentModelId, "anthropic:claude-fixture");
});

test("native model/config notifications retain policy options and refresh confirmed catalog", () => {
  const captured = [], protocol = hermesCcModelProtocol(state => captured.push(structuredClone(state)));
  opened(protocol);
  const notification = update => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native", update } });
  const unrelated = { ...notification({ sessionUpdate: "current_model_update", currentModelId: "unknown" }), method: "custom/update" };
  assert.deepEqual(protocol.received(unrelated), unrelated);
  const changed = protocol.received(notification({ sessionUpdate: "current_model_update", currentModelId: "anthropic:claude-fixture" }));
  assert.equal(changed.params.update.sessionUpdate, "config_option_update");
  assert.equal(changed.params.update.configOptions[1].currentValue, "anthropic:claude-fixture");
  const policyUpdate = { ...policy, currentValue: "dontAsk" };
  const updated = protocol.received(notification({ sessionUpdate: "config_option_update", configOptions: [policyUpdate] }));
  assert.deepEqual(updated.params.update.configOptions[0], policyUpdate);
  assert.equal(updated.params.update.configOptions[1].currentValue, "anthropic:claude-fixture");
  assert.equal(captured.length, 2);
  assert.equal(captured.at(-1).models.currentModelId, "anthropic:claude-fixture");
  const mode = notification({ sessionUpdate: "current_mode_update", currentModeId: "dontAsk" });
  assert.deepEqual(protocol.received(mode), mode);
});

test("existing model configOptions take precedence and pass through unchanged", () => {
  for (const value of ["openai-codex:gpt-fixture", "anthropic:claude-fixture"]) {
    const protocol = hermesCcModelProtocol();
    const option = { id: "native-model", name: "Model", category: "model", type: "select", currentValue: value,
      options: models.availableModels.map(model => ({ value: model.modelId, name: model.name })) };
    assert.deepEqual(opened(protocol, [policy, option]).configOptions, [policy, option]);
    const outgoing = request(2, "session/set_config_option", { sessionId: "native", configId: option.id, value });
    assert.deepEqual(protocol.sent(outgoing), outgoing);
    const incoming = reply(2, { configOptions: [policy, option] });
    assert.deepEqual(protocol.received(incoming), incoming);
  }
});
