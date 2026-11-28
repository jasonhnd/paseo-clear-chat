const { existsSync, readFileSync, statSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, resolve } = require("node:path");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

// Load the plugin's TypeScript the way its server process runs it: transpile each file and
// resolve relative imports from disk. Builtins (`node:sqlite`) and installed packages
// (`@getpaseo/*`, `zod`) resolve normally, so tests exercise the real modules.
const transpiled = new Map();

function resolveFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.cjs`, `${base}.json`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base;
}

function createTsModules() {
  const cache = new Map();
  function load(path) {
    const filename = resolveFile(resolve(path));
    if (cache.has(filename)) return cache.get(filename).exports;
    if (filename.endsWith(".json")) return JSON.parse(readFileSync(filename, "utf8"));
    const mod = { exports: {} };
    cache.set(filename, mod);
    const info = statSync(filename);
    const key = `${filename}:${info.mtimeMs}:${info.size}`;
    let source = transpiled.get(key);
    if (source === undefined) {
      source = ts.transpileModule(readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
      transpiled.set(key, source);
    }
    const realRequire = createRequire(filename);
    const localRequire = id => id.startsWith(".") || id.startsWith("/")
      ? load(resolve(dirname(filename), id))
      : realRequire(id);
    runInThisContext(`(function(require,module,exports,__filename,__dirname){${source}\n})`, { filename })(
      localRequire, mod, mod.exports, filename, dirname(filename),
    );
    return mod.exports;
  }
  return { load };
}

module.exports = { createTsModules };
