const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
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

const { createHermesCcImageStore } = load("server/hermes-cc/store.ts");

test("image store: saving an empty list publishes nothing", async () => {
  const base = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "image-store-empty-"));
  const root = join(base, "images");
  const store = createHermesCcImageStore(root, { trustedRoot: base });
  const result = await store.save({ sessionKey: "session", messageId: "message" }, []);
  assert.equal(result, "saved");
  assert.equal(fs.existsSync(root), false, "the store root was not even created");
  assert.deepEqual(fs.readdirSync(base), []);
});
