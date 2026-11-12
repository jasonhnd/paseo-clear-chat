const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const ts = require("typescript");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const filename = resolve(__dirname, "../server/turn-window.ts");
const mod = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(createRequire(filename), mod, mod.exports);
const { createTurnWindows, registerTurnWindows, snapshot, OVERLAP_WARNING, NOT_GIT } = mod.exports;
const state = entries => ({ kind: "ok", files: new Map(entries) });
const at = new Date("2026-01-01T12:00:00Z");

async function displayed(result, item = { type: "assistant_message", text: "Reply" }, reply = { type: "assistant", text: "Reply" }) {
  const entry = { item, timestamp: at.toISOString(), turnId: "t1" };
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries: [entry], hasOlder: false, hasNewer: false, error: null }) } }) } };
  const h = createToolHarness("web", { paseo, revealRpc: async () => result });
  const Card = h.load("client/components/turn-window-card.tsx").TurnWindowCard;
  const element = { type: Card, props: { agentId: "a", at, reply, tokens: h.tokens } };
  const first = h.draw(element);
  await h.nodes(first, node => node.type === "Pressable")[0].props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  const visible = h.text(h.draw(element));
  h.unmount();
  return visible;
}

test("overlapping conversations show the warning and observed files", async () => {
  const captures = [state([]), state([]), state([["alpha.txt", "a"]]), state([["beta.txt", "b"]])];
  const hooks = {};
  const server = { addHook(name, handler) { hooks[name] = handler; return () => {}; } };
  // Exercise actual hook registration and same-agent/turn pairing.
  const original = registerTurnWindows(server);
  original.dispose();
  const windows = createTurnWindows(async () => captures.shift());
  windows.before("a", "t1", "workspace", "/sample");
  windows.before("b", "t2", "workspace", "/sample");
  await windows.after("a", "t1", "/sample");
  await windows.after("b", "t2", "/sample");
  const result = await windows.get("a", "t1");
  assert.equal(result.warning, OVERLAP_WARNING);
  assert.deepEqual(result.files, ["alpha.txt"]);
  const visible = await displayed(result);
  assert.ok(visible.includes(OVERLAP_WARNING));
  assert.ok(visible.includes("alpha.txt"));
  assert.equal(typeof hooks["agent.turn.before"], "function");
  assert.equal(typeof hooks["agent.turn.after"], "function");
});

test("non-Git workspace displays unavailable without invoking git init", async () => {
  const commands = [];
  const capture = () => snapshot("/sample", async (_cwd, args) => {
    commands.push(args);
    assert.ok(!args.includes("init"), "git init must never be invoked");
    const error = new Error("not a repository");
    error.stderr = "fatal: not a git repository (or any of the parent directories): .git";
    throw error;
  });
  const windows = createTurnWindows(capture);
  windows.before("a", "t1", "workspace", "/sample");
  await windows.after("a", "t1", "/sample");
  const result = await windows.get("a", "t1");
  assert.equal(result.message, NOT_GIT);
  assert.ok((await displayed(result)).includes(NOT_GIT));
  assert.deepEqual(commands, [["rev-parse", "--show-toplevel"], ["rev-parse", "--show-toplevel"]]);
});

test("a single window displays changes without an overlap warning", async () => {
  const captures = [state([["old.txt", "before"]]), state([["old.txt", "after"]])];
  const windows = createTurnWindows(async () => captures.shift());
  windows.before("a", "t1", "workspace", "/sample");
  await windows.after("a", "t1", "/sample");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, ["old.txt"]);
  assert.equal(result.warning, null);
  const visible = await displayed(result);
  assert.ok(visible.includes("old.txt"));
  assert.ok(!visible.includes(OVERLAP_WARNING));
  assert.match(visible, /incomplete|unknown/);
});

test("an overlapping turn without an ID still contributes to the warning", async () => {
  const windows = createTurnWindows(async () => state([]));
  windows.before("a", "t1", "workspace", "/sample");
  windows.before("b", null, "workspace", "/sample");
  await windows.after("a", "t1", "/sample");
  await windows.after("b", null, "/sample");
  assert.equal((await windows.get("a", "t1")).warning, OVERLAP_WARNING);
});

test("status and index data are captured without changing the workspace", async () => {
  const commands = [];
  const execute = async (_cwd, args) => {
    commands.push(args);
    assert.ok(!args.includes("init"));
    if (args[0] === "rev-parse") return Buffer.from(args.includes("HEAD") ? "abc123\n" : process.cwd() + "\n");
    if (args[0] === "status") return Buffer.from(" M AGENTS.md\0");
    if (args[0] === "ls-files") return Buffer.from("100644 abcdef 0\tAGENTS.md\0");
    throw new Error("Unexpected Git command");
  };
  const captured = await snapshot(process.cwd(), execute);
  assert.equal(captured.kind, "ok");
  assert.deepEqual([...captured.files.keys()], ["AGENTS.md"]);
  assert.match(captured.files.get("AGENTS.md"), /abcdef/);
  assert.match(captured.files.get("AGENTS.md"), /file:/);
  assert.equal(commands.length, 4);
});


test("a tool-delivered final reply resolves the same turn window", async () => {
  const visible = await displayed({ files: ["result.txt"], message: null, warning: null, incomplete: true },
    { type: "tool_call", name: "finish", callId: "c1" }, { type: "tool", name: "finish", callId: "c1" });
  assert.ok(visible.includes("result.txt"));
});

test("hook results wait for capture and detect overlap during the after snapshot", async () => {
  const hooks = {};
  let finishAfter;
  let count = 0;
  const capture = async () => {
    count++;
    if (count === 2) return new Promise(resolve => { finishAfter = resolve; });
    return state([]);
  };
  const registered = registerTurnWindows({ addHook(name, handler) { hooks[name] = handler; return () => {}; } }, capture);
  const agent = id => ({ id, workspaceId: "workspace", cwd: "/sample" });
  await hooks["agent.turn.before"]({ agent: agent("a"), turnId: "t1" });
  const after = hooks["agent.turn.after"]({ agent: agent("a"), turnId: "t1", outcome: { kind: "completed" } });
  await new Promise(resolve => setImmediate(resolve));
  let settled = false;
  const pending = registered.windows.get("a", "t1").then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  await hooks["agent.turn.before"]({ agent: agent("b"), turnId: "t2" });
  finishAfter(state([["observed.txt", "changed"]]));
  await after;
  const result = await pending;
  assert.equal(result.warning, OVERLAP_WARNING);
  assert.deepEqual(result.files, ["observed.txt"]);
  registered.dispose();
});

test("a changed HEAD is visibly incomplete even when both statuses are clean", async () => {
  const captures = [{ ...state([]), head: "before" }, { ...state([]), head: "after" }];
  const windows = createTurnWindows(async () => captures.shift());
  await windows.before("a", "t1", "workspace", "/sample");
  await windows.after("a", "t1", "/sample");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, []);
  assert.match(await displayed(result), /HEAD changed.*incomplete/);
});
