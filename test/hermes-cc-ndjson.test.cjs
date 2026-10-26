const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

const filename = resolve(__dirname, "../server/hermes-cc/ndjson.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
// A type-only SDK import must not become a runtime dependency.
runInThisContext(`(function(module,exports){${compiled}\n})`, { filename })(mod, mod.exports);
const { ndJsonStream } = mod.exports;
const encoder = new TextEncoder();
const first = { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { text: "line\n🎉" } };
const second = { jsonrpc: "2.0", id: 1, result: {} };

function harness(chunks, outputSink) {
  const written = [];
  const output = new WritableStream({ write: outputSink ?? (chunk => written.push(Buffer.from(chunk).toString("utf8"))) });
  const input = new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    controller.close();
  } });
  return { ...ndJsonStream(output, input), written };
}

async function collect(readable) {
  const reader = readable.getReader(), messages = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return messages;
      messages.push(value);
    }
  } finally { reader.releaseLock(); }
}

test("NDJSON round trip writes each message as JSON followed by one newline", async () => {
  const wire = new TransformStream();
  const stream = ndJsonStream(wire.writable, wire.readable);
  const messages = collect(stream.readable), writer = stream.writable.getWriter();
  await writer.write(first);
  await writer.write(second);
  await writer.close();
  const wireWriter = wire.writable.getWriter();
  await wireWriter.close();
  assert.deepEqual(await messages, [first, second]);

  const h = harness([]), rawWriter = h.writable.getWriter();
  await rawWriter.write(first);
  await rawWriter.write(second);
  assert.deepEqual(h.written, [JSON.stringify(first) + "\n", JSON.stringify(second) + "\n"]);
});

test("NDJSON preserves messages split across chunks, including UTF-8 characters", async () => {
  const bytes = encoder.encode(JSON.stringify(first) + "\n");
  const h = harness(Array.from(bytes, byte => Uint8Array.of(byte)));
  assert.deepEqual(await collect(h.readable), [first]);
  assert.deepEqual(h.written, []);
});

test("NDJSON reads multiple messages from one chunk in order", async () => {
  const h = harness([JSON.stringify(first) + "\n" + JSON.stringify(second) + "\n"]);
  assert.deepEqual(await collect(h.readable), [first, second]);
});

test("NDJSON skips empty and whitespace-only lines, including CRLF", async () => {
  const h = harness(["\n\n \t\r\n\u00a0" + JSON.stringify(first) + "\u00a0\r\n\n \n"]);
  assert.deepEqual(await collect(h.readable), [first]);
  assert.deepEqual(h.written, []);
});

test("NDJSON replies to malformed lines with SDK parse errors and continues reading", async () => {
  const h = harness([JSON.stringify(first) + '\n{"broken":\n' + JSON.stringify(second) + "\nnot-json\n"]);
  assert.deepEqual(await collect(h.readable), [first, second]);
  assert.deepEqual(h.written, Array(2).fill('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n'));
});

test("NDJSON matches SDK invalid-request replies for primitives and accepts arrays", async () => {
  const primitives = [null, true, 42, "text"];
  const h = harness([...primitives.map(value => JSON.stringify(value) + "\n"), JSON.stringify([first, second]) + "\n"]);
  assert.deepEqual(await collect(h.readable), [[first, second]]);
  assert.deepEqual(h.written.map(line => JSON.parse(line)), primitives.map(data => ({
    jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request", data },
  })));
});

test("NDJSON consumes a final unterminated line and reports malformed EOF", async () => {
  const h = harness([JSON.stringify(first)]);
  assert.deepEqual(await collect(h.readable), [first]);
  const broken = harness(['{"broken":']);
  assert.deepEqual(await collect(broken.readable), []);
  assert.equal(JSON.parse(broken.written[0]).error.code, -32700);
});

test("NDJSON cancellation cancels the pending input read and releases its lock", async () => {
  let reason;
  const input = new ReadableStream({ cancel(value) { reason = value; } });
  const stream = ndJsonStream(new WritableStream(), input);
  await stream.readable.cancel("closed");
  assert.equal(reason, "closed");
  assert.equal(input.locked, false);
});

test("NDJSON serializes parse-error replies with pending application writes", async () => {
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const written = [];
  let inputController;
  const input = new ReadableStream({ start(controller) { inputController = controller; } });
  const output = new WritableStream({ async write(chunk) {
    written.push(JSON.parse(Buffer.from(chunk).toString("utf8")));
    if (written.length === 1) { started(); await pending; }
  } });
  const stream = ndJsonStream(output, input), writer = stream.writable.getWriter();
  const write = writer.write(first);
  await writing;
  inputController.enqueue(encoder.encode("broken\n" + JSON.stringify(second) + "\n"));
  inputController.close();
  release();
  await write;
  assert.deepEqual(await collect(stream.readable), [second]);
  assert.deepEqual(written, [first, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
  assert.equal(output.locked, false);
});

test("NDJSON propagates input failures through the readable stream", async () => {
  const failure = new Error("input failed");
  const input = new ReadableStream({ start(controller) { controller.error(failure); } });
  const stream = ndJsonStream(new WritableStream(), input);
  await assert.rejects(collect(stream.readable), error => error === failure);
  assert.equal(input.locked, false);
});
