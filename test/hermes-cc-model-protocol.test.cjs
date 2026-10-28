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

const capturedClaude = require("./fixtures/hermes-claude-native.cjs");
for (const method of ["session/new", "session/load"]) test(`captured Claude subset bridges ${method} without mutating source fields`, () => {
  const source = structuredClone(capturedClaude);
  const protocol = hermesCcModelProtocol();
  protocol.sent(request(1, method, { sessionId: "native" }));
  const initial = protocol.received(reply(1, { sessionId: "native", ...source })).result;
  assert.equal(source.configOptions, null);
  assert.deepEqual(source, capturedClaude);
  assert.deepEqual(initial.modes, source.modes);
  const selector = initial.configOptions[0];
  assert.equal(selector.category, "model");
  assert.equal(selector.currentValue, source.models.currentModelId);
  assert.deepEqual(selector.options, source.models.availableModels.map(({ modelId, name, description }) => ({ value: modelId, name, description })));
  const alternate = source.models.availableModels[1].modelId;
  assert.deepEqual(protocol.sent(request(2, "session/set_config_option", {
    sessionId: "native", configId: selector.id, value: alternate,
  })), request(2, "session/set_model", { sessionId: "native", modelId: alternate }));
  assert.equal(protocol.received(reply(2, {})).result.configOptions[0].currentValue, alternate);
  protocol.sent(request(3, "session/set_config_option", { sessionId: "native", configId: selector.id, value: "unsupported:model" }));
  const rejection = { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unsupported model fixture" } };
  assert.deepEqual(protocol.received(rejection), rejection);
  for (const [index, mode] of source.modes.availableModes.entries()) {
    const outgoing = request(4 + index, "session/set_mode", { sessionId: "native", modeId: mode.id });
    assert.deepEqual(protocol.sent(outgoing), outgoing);
    assert.equal(protocol.received(reply(4 + index, {})).result.configOptions[0].currentValue, alternate);
  }
  assert.equal(source.configOptions, null);
});

test("raw GPT current input retains confirmed provider context even with another provider offering the same model text", () => {
  const protocol = hermesCcModelProtocol();
  const current = "openai-codex:gpt-6.1-sol-900k";
  protocol.sent(request(1, "session/new"));
  const initial = protocol.received(reply(1, { sessionId: "native", configOptions: null, models: {
    currentModelId: current, availableModels: [current, "different-provider:gpt-6.1-sol-900k"].map(modelId => ({ modelId, name: modelId })),
  } })).result;
  assert.deepEqual(protocol.sent(request(2, "session/set_config_option", {
    sessionId: "native", configId: initial.configOptions[0].id, value: "gpt-6.1-sol-900k",
  })), request(2, "session/set_model", { sessionId: "native", modelId: current }));
  assert.equal(protocol.received(reply(2, {})).result.configOptions[0].currentValue, current);
});

test("native current context never replaces an exact bare catalog ID or guesses another provider alias", () => {
  for (const exactBare of [false, true]) {
    const protocol = hermesCcModelProtocol();
    const current = "openai-codex:gpt-6.1-sol-900k", bare = "gpt-6.1-sol-900k";
    protocol.sent(request(1, "session/new"));
    const initial = protocol.received(reply(1, { sessionId: "native", configOptions: null, models: {
      currentModelId: current,
      availableModels: [current, "anthropic:other-model", ...(exactBare ? [bare] : [])].map(modelId => ({ modelId, name: modelId })),
    } })).result;
    const value = exactBare ? bare : "other-model";
    assert.deepEqual(protocol.sent(request(2, "session/set_config_option", {
      sessionId: "native", configId: initial.configOptions[0].id, value,
    })), request(2, "session/set_model", { sessionId: "native", modelId: value }));
    if (exactBare) {
      assert.equal(protocol.received(reply(2, {})).result.configOptions[0].currentValue, bare);
    } else {
      const rejection = { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Unsupported raw model in current provider" } };
      assert.deepEqual(protocol.received(rejection), rejection);
      protocol.sent(request(3, "session/set_mode", { sessionId: "native", modeId: "default" }));
      assert.equal(protocol.received(reply(3, {})).result.configOptions[0].currentValue, current);
    }
  }
});
