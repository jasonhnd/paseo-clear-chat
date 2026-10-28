const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve, dirname, join } = require("node:path");
const { createRequire } = require("node:module");
const { runInThisContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const { ProviderEventSchema } = require("@getpaseo/plugin/server/provider");
const { runAcpProvider } = require("@getpaseo/plugin/server/acp");
const betaSchema = process.env.CC_ACP_TOOLS_BETA_SCHEMA ? require(process.env.CC_ACP_TOOLS_BETA_SCHEMA).FetchAgentTimelineResponseMessageSchema : null;
const { FetchAgentTimelineResponseMessageSchema } = require("@getpaseo/protocol/messages");
const acpPath = dirname(require.resolve("@agentclientprotocol/sdk"));
const { zSessionNotification } = require(join(acpPath, "schema/zod.gen.js"));

function load(filename, overrides = {}, cache = new Map()) {
  filename = resolve(__dirname, "..", filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const native = createRequire(filename);
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    return id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`), overrides, cache) : native(id);
  }, module, module.exports);
  return module.exports;
}
const persistence = sessionId => ({ version: 1, data: { sessionId } });
let openSequence = 0;
const content = text => [{ type: "content", content: { type: "text", text } }];
const call = (toolCallId, extra = {}) => ({ sessionUpdate: "tool_call", toolCallId, title: `Read ${toolCallId}`, kind: "read", status: "in_progress", rawInput: { path: `${toolCallId}.txt` }, ...extra });
const update = (toolCallId, extra) => ({ sessionUpdate: "tool_call_update", toolCallId, ...extra });
function freeze(value) {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

function fixture(updates) {
  const runtimes = [], originals = [], rawEvents = [];
  const transport = async (_command, _env, launch) => {
    // Deliberately asynchronous: the launch context must survive connector work.
    await new Promise(resolve => setImmediate(resolve));
    let controller, closed = false;
    const runtime = { index: runtimes.length, sent: [], tools: launch?.tools, token: launch?.env?.SYNTHETIC_OPEN, native: "synthetic-history-55" };
    runtimes.push(runtime);
    const emit = message => {
      originals.push({ message, before: structuredClone(message) });
      controller.enqueue(freeze(message));
    };
    runtime.notify = (toolUpdates, native = runtime.native) => {
      for (const update of toolUpdates) {
        const params = { sessionId: native, update };
        zSessionNotification.parse(params);
        emit({ jsonrpc: "2.0", method: "session/update", params });
      }
    };
    runtime.finish = () => { if (!closed) { closed = true; controller.close(); } };
    return {
      readable: new ReadableStream({ start(value) { controller = value; }, cancel() { closed = true; } }),
      writable: new WritableStream({
        async write(request) {
          runtime.sent.push(structuredClone(request));
          const reply = result => emit({ jsonrpc: "2.0", id: request.id, result });
          if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
          else if (request.method === "session/new") reply({ sessionId: runtime.native });
          else if (request.method === "session/load" || request.method === "session/prompt") {
            runtime.native = request.params.sessionId;
            await new Promise(resolve => setImmediate(resolve));
            const toolUpdates = updates(runtime);
            const firstId = toolUpdates[0]?.toolCallId;
            if (firstId) runtime.notify([
              call(firstId, { rawInput: { path: "foreign-session.txt" } }),
              update(firstId, { status: "failed", content: content("FOREIGN_SESSION_CONTENT") }),
            ], "foreign-native-session");
            runtime.notify([
              { sessionUpdate: "user_message_chunk", content: { type: "text", text: "SYNTHETIC_USER" } },
              { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SYNTHETIC_THOUGHT" } },
              ...toolUpdates,
              { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SYNTHETIC_FINAL_ANSWER" } },
            ]);
            if (request.params.sessionId === "synthetic-fail-open") emit({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Synthetic open failure" } });
            else reply(request.method === "session/prompt" ? { stopReason: "end_turn" } : {});
          } else if ("id" in request) reply({});
        },
        close() { runtime.finish(); }, abort() { runtime.finish(); },
      }),
    };
  };
  const { hermesCcProvidersFromConfig } = load("server/hermes-cc/provider.ts", {
    "./transport": { hermesCcTransport: transport },
    "@getpaseo/plugin/server/acp": { runAcpProvider(options) {
      const registration = runAcpProvider(options);
      return { ...registration, async connect(request) {
        const raw = await registration.connect(request);
        raw.onEvent(event => rawEvents.push(event));
        return raw;
      } };
    } },
  });
  const source = { extends: "acp", command: ["hermes", "acp"] };
  const create = (store, sources = { synthetic: source }) => hermesCcProvidersFromConfig(sources, true, async () => {}, store);
  return { create, runtimes, originals, rawEvents };
}
async function connect(t, registration) {
  const connection = await registration.connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
  t.after(() => connection.close());
  const events = [], references = [], waiters = new Set();
  connection.onEvent(event => {
    ProviderEventSchema.parse(event);
    references.push(event);
    events.push(structuredClone(event));
    for (const wake of waiters) wake();
  });
  const wait = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(JSON.stringify(events))); }, 4000);
    const check = () => {
      const found = events.find(predicate);
      if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); }
    };
    waiters.add(check); check();
  });
  return { connection, events, references, wait, tokens: new Map() };
}
async function open(h, sessionId, history = "replay", native = "synthetic-history-55") {
  const token = `synthetic-open-${++openSequence}`;
  h.tokens.set(sessionId, token);
  await h.connection.send({ type: "session.open", requestId: `open-${sessionId}`, sessionId, history,
    config: { cwd: process.cwd(), env: { SYNTHETIC_OPEN: token }, mcpServers: {}, settings: {}, persist: true },
    ...(native === null ? {} : { persistence: persistence(native) }),
  });
  await h.wait(event => event.type === "session.ready" && event.sessionId === sessionId);
}
async function prompt(h, sessionId, id = "synthetic-prompt") {
  await h.connection.send({ type: "session.prompt", sessionId, prompt: {
    clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text: "SYNTHETIC_PROMPT" }] },
  } });
  await h.wait(event => event.type === "session.turn" && event.sessionId === sessionId && event.state === "completed" && event.turnId.endsWith(`acp:${id}`));
}
const tools = h => h.events.filter(event => event.type === "timeline.item" && event.item.type === "tool_call").map(event => event.item);
function envelope(events) {
  const items = new Map();
  for (const event of events) if (event.type === "timeline.item") items.set(event.item.id, event.item);
  return { type: "fetch_agent_timeline_response", payload: {
    requestId: "synthetic-request", agentId: "synthetic-agent", agent: null, direction: "tail", projection: "projected",
    epoch: "synthetic", reset: false, staleCursor: false, gap: false,
    window: { minSeq: 0, maxSeq: items.size, nextSeq: items.size + 1 }, startCursor: null, endCursor: null,
    hasOlder: false, hasNewer: false, error: null,
    entries: [...items.values()].map((item, seq) => ({ provider: "synthetic-cc", item, timestamp: "2026-10-28T00:00:00Z",
      seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [] })),
  } };
}
function validate(h) {
  const response = envelope(h.events);
  FetchAgentTimelineResponseMessageSchema.parse(response);
  betaSchema?.parse(response);
  assert(h.events.some(event => event.type === "timeline.item" && event.item.type === "assistant_message" && event.item.text === "SYNTHETIC_FINAL_ANSWER"));
  assert(h.events.some(event => event.type === "timeline.item" && event.item.type === "reasoning" && event.item.text === "SYNTHETIC_THOUGHT"));
  return response;
}

for (const mode of ["history", "live"]) test(`actual composed provider preserves failed read content and final answer: ${mode}`, async t => {
  const id = "qa-tool-054-2";
  const f = fixture(() => [call(id, { title: "Read fixture-054.txt", rawInput: { path: "fixture-054.txt" } }), update(id, { status: "failed", content: content("SYNTHETIC_ERROR_054") })]);
  const h = await connect(t, f.create()[0]);
  await open(h, "boundary", mode === "history" ? "replay" : "skip", mode === "history" ? "synthetic-history-55" : null);
  if (mode === "live") await prompt(h, "boundary");
  const rows = tools(h);
  assert.deepEqual(rows.map(row => row.status), ["running", "failed"]);
  assert.equal(rows[0].detail.content, undefined, "wire read-ahead must not enrich the initial snapshot with future content");
  assert.equal(rows[1].callId, id);
  assert.deepEqual(rows[1].detail, { type: "read", filePath: "fixture-054.txt", content: "SYNTHETIC_ERROR_054" });
  assert.deepEqual(rows[1].error, { message: "Tool call failed" });
  const response = validate(h);
  const negative = structuredClone(response);
  negative.payload.entries.find(entry => entry.item.type === "tool_call").item.error = null;
  assert.equal(FetchAgentTimelineResponseMessageSchema.safeParse(negative).success, false);
  if (betaSchema) assert.equal(betaSchema.safeParse(negative).success, false);
  const rawResponse = envelope(f.rawEvents);
  assert.equal(FetchAgentTimelineResponseMessageSchema.safeParse(rawResponse).success, false);
  if (betaSchema) assert.equal(betaSchema.safeParse(rawResponse).success, false);
  for (const event of f.rawEvents) if (event.type !== "timeline.item" || event.item.type !== "tool_call") {
    assert(h.references.includes(event), "non-tool events must pass through by identity");
  }
  if (process.env.CC_ACP_TOOLS_EVIDENCE) {
    writeFileSync(join(process.env.CC_ACP_TOOLS_EVIDENCE, `${mode}-raw.json`), JSON.stringify(rawResponse, null, 2));
    writeFileSync(join(process.env.CC_ACP_TOOLS_EVIDENCE, `${mode}-adapted.json`), JSON.stringify(response, null, 2));
  }
  for (const { message, before } of f.originals) assert.deepEqual(message, before);
});

test("explicit actual string/object errors remain unchanged; content never becomes an error", async t => {
  const cases = [
    { id: "string", rawOutput: "EXPLICIT_ERROR", error: "EXPLICIT_ERROR" },
    { id: "object", rawOutput: { message: "EXPLICIT_ERROR", code: "E_SYNTHETIC" }, error: { message: "EXPLICIT_ERROR", code: "E_SYNTHETIC" } },
    { id: "extension-string", explicit: "EXPLICIT_EXTENSION", error: "EXPLICIT_EXTENSION" },
    { id: "extension-object", explicit: { message: "EXPLICIT_EXTENSION" }, error: { message: "EXPLICIT_EXTENSION" } },
    { id: "content-only", error: { message: "Tool call failed" } },
    { id: "null", rawOutput: null, error: { message: "Tool call failed" } },
  ];
  const f = fixture(() => cases.flatMap(row => [call(row.id), update(row.id, { status: "failed", content: content("ORDINARY_OUTPUT"), ...(row.rawOutput !== undefined ? { rawOutput: row.rawOutput } : {}), ...(row.explicit !== undefined ? { error: row.explicit } : {}) })]));
  const h = await connect(t, f.create()[0]); await open(h, "boundary");
  for (const row of cases) {
    const item = tools(h).find(item => item.callId === row.id && item.status === "failed");
    assert.deepEqual(item.error, row.error);
    assert.deepEqual(item.metadata.acp.rawOutput, row.rawOutput);
  }
  assert.equal(tools(h).find(item => item.callId === "content-only" && item.status === "failed").detail.content, "ORDINARY_OUTPUT");
  validate(h);
});

test("sparse repeated updates preserve read locations/input/content and completed error:null", async t => {
  const f = fixture(() => [
    call("sparse", { status: "pending", rawInput: { path: "input.txt", offset: 3, limit: 7 }, locations: [{ path: "location.txt", line: 3 }] }),
    update("sparse", { status: "in_progress", content: content("FIRST") }),
    update("sparse", {}), update("sparse", { status: "in_progress" }),
    update("sparse", { status: "completed", content: content("COMPLETE") }),
    call("raw", { status: "completed", rawOutput: { text: "RAW_CONTENT" } }),
    call("unknown", { kind: "other", status: "completed", content: content("UNKNOWN_CONTENT") }),
  ]);
  const h = await connect(t, f.create()[0]); await open(h, "boundary");
  const rows = tools(h).filter(row => row.callId === "sparse");
  assert.deepEqual(rows.map(row => row.detail.content), [undefined, "FIRST", "FIRST", "FIRST", "COMPLETE"]);
  assert.deepEqual(rows.map(row => row.status), ["running", "running", "running", "running", "completed"]);
  assert(rows.every(row => row.error === null));
  assert.deepEqual(rows.at(-1).detail, { type: "read", filePath: "location.txt", content: "COMPLETE", offset: 3, limit: 7 });
  assert.deepEqual(rows.at(-1).metadata.acp.locations, [{ path: "location.txt", line: 3 }]);
  assert.deepEqual(rows.at(-1).metadata.acp.rawInput, { path: "input.txt", offset: 3, limit: 7 });
  assert.equal(tools(h).find(row => row.callId === "raw").detail.content, "RAW_CONTENT");
  assert.equal(tools(h).find(row => row.callId === "unknown").detail.output, "UNKNOWN_CONTENT");
  validate(h);
});

test("simultaneous opens, connections and discovery isolate identical native/call IDs", async t => {
  const f = fixture(runtime => [call("shared", { rawInput: { path: `runtime-${runtime.index}.txt` } }), update("shared", { status: "failed", content: content(`RUNTIME_${runtime.index}`) })]);
  const registration = f.create()[0];
  const [a, b] = await Promise.all([connect(t, registration), connect(t, registration)]);
  await Promise.all([open(a, "one"), open(a, "two", "replay", "synthetic-native-two"), open(b, "one"),
    a.connection.send({ type: "catalog", requestId: "discovery" })]);
  await a.wait(event => event.type === "catalog");
  for (const h of [a, b]) for (const sessionId of new Set(h.events.filter(event => event.type === "session.ready").map(event => event.sessionId))) {
    const row = h.events.find(event => event.type === "timeline.item" && event.sessionId === sessionId && event.item.status === "failed").item;
    const runtime = f.runtimes.find(runtime => runtime.token === h.tokens.get(sessionId));
    assert.equal(row.detail.type, "read");
    assert.equal(row.detail.filePath, `runtime-${runtime.index}.txt`);
    assert.equal(row.detail.content, `RUNTIME_${runtime.index}`);
  }
  const paths = [...tools(a), ...tools(b)].filter(row => row.status === "failed").map(row => row.detail.filePath);
  assert.equal(new Set(paths).size, 3);
  validate(a); validate(b);
});

test("close and runtime failure discard state before boundary/call identity reuse", async t => {
  const f = fixture(runtime => runtime.index === 1
    ? [call("shared"), update("shared", { status: "failed", content: content("OLD_CONTENT") })]
    : [update("shared", { status: "failed" })]);
  const h = await connect(t, f.create()[0]); await open(h, "reused");
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "reused" });
  await h.wait(event => event.type === "session.closed");
  const old = f.rawEvents.find(event => event.type === "timeline.item" && event.item.status === "failed");
  assert.strictEqual(f.runtimes[1].tools.adapt(old), old, "close must clear retained tool snapshots");
  h.events.length = 0;
  await open(h, "reused");
  const row = tools(h).at(-1);
  assert.equal(row.detail.type, "unknown");
  assert.equal(row.detail.output, null);
  assert.deepEqual(row.error, { message: "Tool call failed" });
  f.runtimes.at(-1).finish();
  await h.wait(event => event.type === "session.runtime_failed");
  assert.strictEqual(f.runtimes[2].tools.adapt(old), old, "runtime failure must clear retained tool snapshots");
  // Closing a failed runtime releases its SDK boundary before another open.
  await h.connection.send({ type: "session.close", requestId: "close-failed", sessionId: "reused" });
  await h.wait(event => event.type === "request.completed" && event.requestId === "close-failed");
  h.events.length = 0;
  await open(h, "reused");
  assert.equal(tools(h).at(-1).detail.type, "unknown");
  assert.equal(tools(h).at(-1).detail.output, null);
  validate(h);
});

test("caller skip ignores replay tools and terminalized pending tools keep available content", async t => {
  const f = fixture(() => [call("pending", { content: content("PENDING_CONTENT") })]);
  const h = await connect(t, f.create()[0]); await open(h, "boundary", "skip");
  assert.deepEqual(tools(h), []);
  await prompt(h, "boundary");
  const rows = tools(h);
  assert.deepEqual(rows.map(row => row.status), ["running", "completed"]);
  assert(rows.every(row => row.detail.content === "PENDING_CONTENT" && row.error === null));
  const count = h.events.length;
  f.runtimes.at(-1).notify([update("pending", { content: content("AFTER_TERMINAL") })]);
  await h.wait(event => h.events.indexOf(event) >= count && event.type === "timeline.item" && event.item.callId === "pending");
  assert.equal(tools(h).at(-1).status, "completed");
  assert.equal(tools(h).at(-1).detail.content, "AFTER_TERMINAL");
  validate(h);
});

test("record and reopen journal contains enriched snapshots before persistence", async t => {
  const rows = [];
  let complete = false;
  const store = {
    async start() {}, async append(key, event) { rows.push(structuredClone(event)); },
    async turnStarted() { complete = false; }, async turnSettled() { complete = true; },
    async invalidate() { assert.fail("healthy fresh journal must stay valid"); },
    async read() { assert(complete); return { status: "complete", events: structuredClone(rows) }; },
  };
  const f = fixture(() => [call("recorded"), update("recorded", { status: "failed", content: content("RECORDED_CONTENT") })]);
  const registration = f.create(store)[0];
  const fresh = await connect(t, registration); await open(fresh, "fresh", "skip", null); await prompt(fresh, "fresh");
  assert(complete);
  const recorded = rows.find(event => event.type === "timeline.item" && event.item.status === "failed");
  assert.equal(recorded.item.detail.content, "RECORDED_CONTENT");
  assert.deepEqual(recorded.item.error, { message: "Tool call failed" });
  await fresh.connection.close();
  const reopened = await connect(t, registration); await open(reopened, "reopened");
  const replayed = tools(reopened).find(item => item.status === "failed");
  assert.deepEqual(replayed, recorded.item);
  assert.deepEqual(rows.find(event => event.type === "timeline.item" && event.item.status === "failed"), recorded);
  validate(fresh); validate(reopened);
});

test("failed asynchronous opens clear observations without affecting another session", async t => {
  const f = fixture(() => [call("shared"), update("shared", { status: "failed", content: content("OPEN_CONTENT") })]);
  const h = await connect(t, f.create()[0]);
  await open(h, "healthy");
  await h.connection.send({ type: "session.open", requestId: "failed-open", sessionId: "failed", history: "replay",
    persistence: persistence("synthetic-fail-open"),
    config: { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  await h.wait(event => event.type === "request.failed" && event.requestId === "failed-open");
  const raw = f.rawEvents.find(event => event.type === "timeline.item" && event.sessionId === "failed" && event.item.status === "failed");
  const failedRuntime = f.runtimes.find(runtime => runtime.native === "synthetic-fail-open");
  assert.strictEqual(failedRuntime.tools.adapt(raw), raw);
  await prompt(h, "healthy");
  assert.equal(tools(h).at(-1).detail.content, "OPEN_CONTENT");
  validate(h);
});
