const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { writeClientVersion } = require("../scripts/install.cjs");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const root = resolve(__dirname, "..");

test("the checked-in client version matches the package and the install generator", t => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const checkout = mkdtempSync(join(root, ".tmp", "version-test-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, "client"));
  writeFileSync(join(checkout, "package.json"), readFileSync(join(root, "package.json")));
  writeClientVersion(checkout);
  assert.equal(readFileSync(join(root, "client/package-version.ts"), "utf8"), readFileSync(join(checkout, "client/package-version.ts"), "utf8"));
});

test("the install generator and settings render a different package version", t => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const checkout = mkdtempSync(join(root, ".tmp", "version-test-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, "client"));
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "9.8.7-test.42" }));
  writeClientVersion(checkout);
  const generated = readFileSync(join(checkout, "client/package-version.ts"), "utf8");
  assert.match(generated, /export const packageVersion = "9\.8\.7-test\.42";/);
  const ts = require("typescript");
  const vm = require("node:vm");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(generated, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  assert.equal(exports.packageVersion, "9.8.7-test.42");
  const h = createToolHarness("ios", { settingsPage: true, fileModules: { "client/package-version": exports } });
  t.after(() => h.unmount());
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  const tree = h.draw({ type: Page, props: { theme: { colors: {} } } });
  const version = h.nodes(tree, node => node.props.testID === "package-version");
  assert.equal(version.length, 1);
  assert.equal(h.text(version[0]), "Clear Chat version: 9.8.7-test.42");
});
