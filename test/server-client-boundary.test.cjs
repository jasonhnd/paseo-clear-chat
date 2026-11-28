const assert = require("node:assert/strict");
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const repositoryRoot = resolve(__dirname, "..");

/**
 * The host compiles the plugin's server entry on its own. A module under client/ pulls in
 * the host's client runtime, which that bundle does not have, so one client import anywhere
 * in the server graph makes the whole plugin fail to install. This scan walks every server
 * source (and the shared modules it reaches) and fails on an import that resolves into
 * client/ or the client entry.
 */

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function specifierText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function specifiersOf(file, source) {
  const parsed = ts.createSourceFile(
    file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];
  const lineOf = node => parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) {
      const text = specifierText(node.moduleSpecifier);
      if (text !== null) specifiers.push({ text, line: lineOf(node) });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const text = specifierText(argument);
      if ((dynamicImport || requireCall) && text !== null) specifiers.push({ text, line: lineOf(node) });
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      const text = specifierText(node.moduleReference.expression);
      if (text !== null) specifiers.push({ text, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function resolveLocal(fromFile, specifier, fileExists) {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(fromFile), specifier);
  const stripped = target.replace(/\.(js|mjs|cjs)$/i, "");
  const bases = stripped === target ? [target] : [stripped, target];
  const candidates = [];
  for (const base of bases) {
    candidates.push(base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"));
  }
  return candidates.find(candidate => fileExists(candidate)) ?? bases[0];
}

function isClientModule(fromRoot) {
  return fromRoot === "client" || fromRoot.startsWith("client/")
    || fromRoot === "index.client" || fromRoot === "index.client.ts" || fromRoot === "index.client.tsx";
}

function scanImports(root, seeds, read, fileExists) {
  const queue = [...seeds];
  const visited = new Set();
  const offenders = [];
  let specifiersChecked = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const { text, line } of specifiersOf(file, read(file))) {
      specifiersChecked += 1;
      const target = resolveLocal(file, text, fileExists);
      if (!target) continue;
      const fromRoot = relative(root, target).split(sep).join("/");
      if (isClientModule(fromRoot)) {
        offenders.push(`${relative(root, file).split(sep).join("/")}:${line} imports ${text}`);
        continue;
      }
      if (!fileExists(target)) continue;
      if (!target.endsWith(".ts") && !target.endsWith(".tsx")) continue;
      const area = fromRoot.split("/")[0];
      if (area === "server" || area === "shared" || fromRoot === "index.server.ts") queue.push(target);
    }
  }
  return { offenders, specifiersChecked };
}

function diskExists(file) {
  return existsSync(file) && statSync(file).isFile();
}

test("the plugin server bundle never imports a client module", () => {
  const serverDirectory = join(repositoryRoot, "server");
  const seeds = sourceFiles(serverDirectory);
  const serverEntry = join(repositoryRoot, "index.server.ts");
  if (diskExists(serverEntry)) seeds.push(serverEntry);
  assert.ok(seeds.length >= 3, "the scan must see the server sources");
  const { offenders, specifiersChecked } = scanImports(
    repositoryRoot, seeds, file => readFileSync(file, "utf8"), diskExists,
  );
  assert.ok(specifiersChecked > 0, "the scan must see import statements");
  assert.deepEqual(offenders, [], `server modules must not import client modules:\n${offenders.join("\n")}`);
});

function scanFixture(files) {
  const root = join(repositoryRoot, "boundary-fixture");
  const map = new Map(Object.entries(files).map(([name, source]) => [join(root, name), source]));
  const { offenders } = scanImports(
    root,
    [join(root, "server/history-reader.ts")],
    file => map.get(file),
    file => map.has(file),
  );
  return offenders;
}

test("a template-string import of a client module is rejected", () => {
  const offenders = scanFixture({
    "server/history-reader.ts": "export function load(){ return import(`../client/local-day`); }\n",
  });
  assert.deepEqual(offenders, ["server/history-reader.ts:1 imports ../client/local-day"]);
});

test("the server entry cannot import the client entry", () => {
  const offenders = scanFixture({
    "server/history-reader.ts": "import \"../index.client\";\n",
    "index.client.tsx": "export const marker = 1;\n",
  });
  assert.deepEqual(offenders, ["server/history-reader.ts:1 imports ../index.client"]);
});

test("a javascript suffix still follows a shared module into the client", () => {
  const offenders = scanFixture({
    "server/history-reader.ts": "import { bridge } from \"../shared/bridge.js\";\n",
    "shared/bridge.ts": "export { value } from \"../client/messages\";\n",
  });
  assert.deepEqual(offenders, ["shared/bridge.ts:1 imports ../client/messages"]);
});
