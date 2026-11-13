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

const { saveWithRetry, retryableSaveReason } = load("server/hermes-cc/save-retry.ts");
const key = { sessionKey: "session", messageId: "message" };
const images = [{ mime: "image/png", data: Buffer.from([1]) }];
const coded = (code) => Object.assign(new Error("boom"), { code });
const fast = [1, 1, 1];

test("save retry: a transient error is retried once and then succeeds", async () => {
  let calls = 0;
  const store = { async save() { calls += 1; if (calls === 1) throw coded("EAGAIN"); return "saved"; } };
  const outcome = await saveWithRetry(store, key, images, fast);
  assert.equal(outcome.result, "saved");
  assert.equal(calls, 2);
});

test("save retry: three transient retries failing return the marker with reason and attempts", async () => {
  let calls = 0;
  const store = { async save() { calls += 1; throw new Error("image_lock_timeout"); } };
  const outcome = await saveWithRetry(store, key, images, fast);
  assert.deepEqual(outcome.failure, { reason: "image_lock_timeout", attempts: 4 });
  assert.equal(calls, 4);
});

test("save retry: a non-retryable failure is marked immediately", async () => {
  let calls = 0;
  const store = { async save() { calls += 1; throw coded("ENOSPC"); } };
  const outcome = await saveWithRetry(store, key, images, fast);
  assert.deepEqual(outcome.failure, { reason: "ENOSPC", attempts: 1 });
  assert.equal(calls, 1);
});

test("save retry: EAGAIN, EMFILE and EBUSY are retryable, ENOSPC is not", () => {
  for (const code of ["EAGAIN", "EMFILE", "EBUSY"]) assert.equal(retryableSaveReason(coded(code)), code);
  assert.equal(retryableSaveReason(new Error("image_lock_timeout")), "image_lock_timeout");
  assert.equal(retryableSaveReason(coded("ENOSPC")), null);
});
