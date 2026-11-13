const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

function load(relative) {
  const filename = resolve(__dirname, "..", relative);
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const realRequire = createRequire(filename);
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(
    id => id.startsWith(".") ? load(resolve(dirname(filename), `${id}.ts`)) : realRequire(id), mod, mod.exports,
  );
  return mod.exports;
}

const { createHermesCcImageCapture } = load("server/hermes-cc/capture.ts");

test("capture: a slow save never blocks the provider hook", async () => {
  const calls = [];
  let release;
  const capture = createHermesCcImageCapture({
    status: {
      async begin(key) { calls.push(["begin", key]); },
      async fail(key, reason, attempts) { calls.push(["fail", key, reason, attempts]); },
      async clear(key) { calls.push(["clear", key]); },
    },
    save: () => new Promise((resolve) => { release = resolve; }),
  });
  const started = Date.now();
  await capture({ sessionKey: "session", messageId: "message" }, []);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `hook returned in ${elapsed} ms`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "begin");
  release({ failure: { reason: "image_lock_timeout", attempts: 4 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["fail", { sessionKey: "session", messageId: "message" }, "image_lock_timeout", 4]);
});
