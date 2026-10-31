const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { settingsVersion } = require("../scripts/settings-version.cjs");
const packageVersion = require("../package.json").version;

test("generated version matches package metadata and updates for another artifact", t => {
  settingsVersion(join(__dirname, ".."));
  const dir = mkdtempSync(join(tmpdir(), "settings-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "client"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "12.34.56.78" }));
  writeFileSync(join(dir, "client", "package-version.json"), JSON.stringify({ version: "1.0.0.0" }));
  assert.throws(() => settingsVersion(dir), /does not match/);
  settingsVersion(dir, { write: true });
  assert.equal(settingsVersion(dir), "12.34.56.78");
  assert.equal(JSON.parse(readFileSync(join(dir, "client", "package-version.json"))).version, "12.34.56.78");
});

for (const [locale, label] of [["en", "Clear Chat version"], ["zh-CN", "Clear Chat 版本"], ["ja", "Clear Chat バージョン"]]) {
  for (const version of [packageVersion, "12.34.56.78"]) {
    test(`${locale}: settings show the installed package version ${version}`, t => {
      const h = createToolHarness("ios", {
        locale, settingsPage: true,
        ...(version === packageVersion ? {} : { localeResources: { "package-version": { version } } }),
      });
      t.after(() => h.unmount());
      const screen = h.settingsScreens.get("chat-presentation");
      assert.ok(screen, "settings screen is registered");
      const tree = h.draw({ type: screen.Component, props: { theme: { colors: {} } } });
      const rows = h.nodes(tree, node => node.props.testID === "installed-version");
      assert.equal(rows.length, 1);
      assert.equal(h.text(rows[0]), `${label} ${version}`);
    });
  }
}
