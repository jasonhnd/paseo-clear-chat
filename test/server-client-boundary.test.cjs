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
 * client/.
 */

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function specifiersOf(file, source) {
  const parsed = ts.createSourceFile(
    file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];
  const lineOf = node => parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ text: node.moduleSpecifier.text, line: lineOf(node) });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamicImport || requireCall) && ts.isStringLiteral(argument)) {
        specifiers.push({ text: argument.text, line: lineOf(node) });
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push({ text: node.moduleReference.expression.text, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? base;
}

test("the plugin server bundle never imports a client module", () => {
  const serverDirectory = join(repositoryRoot, "server");
  const serverFiles = sourceFiles(serverDirectory);
  assert.ok(serverFiles.length >= 3, "the scan must see the server sources");

  const queue = [...serverFiles];
  const serverEntry = join(repositoryRoot, "index.server.ts");
  if (existsSync(serverEntry)) queue.push(serverEntry);

  const visited = new Set();
  const offenders = [];
  let specifiersChecked = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const { text, line } of specifiersOf(file, readFileSync(file, "utf8"))) {
      specifiersChecked += 1;
      const target = resolveLocal(file, text);
      if (!target) continue;
      const fromRoot = relative(repositoryRoot, target).split(sep).join("/");
      if (fromRoot === "client" || fromRoot.startsWith("client/")) {
        offenders.push(`${relative(repositoryRoot, file)}:${line} imports ${text}`);
        continue;
      }
      if (!target.endsWith(".ts") && !target.endsWith(".tsx")) continue;
      if (fromRoot.startsWith("server/") || fromRoot.startsWith("shared/") || fromRoot === "index.server.ts") {
        queue.push(target);
      }
    }
  }

  assert.ok(specifiersChecked > 0, "the scan must see import statements");
  assert.deepEqual(offenders, [], `server modules must not import client modules:\n${offenders.join("\n")}`);
});
