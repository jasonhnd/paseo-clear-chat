const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { settingsVersion } = require("../scripts/settings-version.cjs");
const packageVersion = require("../package.json").version;

test("generated version matches package metadata and updates for another artifact", t => {
  const dir = mkdtempSync(join(tmpdir(), "settings-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "client"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "12.34.56.78" }));
  writeFileSync(join(dir, "client", "package-version.svg"), JSON.stringify({ version: "1.0.0.0" }));
  assert.throws(() => settingsVersion(dir), /does not match/);
  settingsVersion(dir, { write: true });
  assert.equal(settingsVersion(dir), "12.34.56.78");
  assert.equal(JSON.parse(readFileSync(join(dir, "client", "package-version.svg"))).version, "12.34.56.78");
});

for (const [locale, label] of [["en", "Clear Chat version"], ["zh-CN", "Clear Chat 版本"], ["ja", "Clear Chat バージョン"]]) {
  for (const version of [packageVersion, "12.34.56.78"]) {
    test(`${locale}: settings show the installed package version ${version}`, t => {
      const h = createToolHarness("ios", {
        locale, settingsPage: true,
        packageVersionText: JSON.stringify({ version }),
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

for (const [locale, label, unknown] of [["en", "Clear Chat version", "Unknown"], ["zh-CN", "Clear Chat 版本", "未知"], ["ja", "Clear Chat バージョン", "不明"]]) {
  test(`${locale}: a directory install with no generated version shows localized unknown`, t => {
    const h = createToolHarness("ios", { locale, settingsPage: true, directoryInstall: "1.0.0.0" });
    t.after(() => h.unmount());
    const tree = h.draw({ type: h.settingsScreens.get("chat-presentation").Component, props: { theme: { colors: {} } } });
    assert.equal(h.text(h.nodes(tree, node => node.props.testID === "installed-version")[0]), `${label} ${unknown}`);
  });
}

for (const [problem, raw] of [["missing", new Error("missing")], ["malformed JSON", "{"], ["invalid value", JSON.stringify({ version: "garbage" })]]) {
  test(`${problem} version metadata falls back without preventing settings from loading`, t => {
    const h = createToolHarness("ios", { settingsPage: true, packageVersionText: raw });
    t.after(() => h.unmount());
    const tree = h.draw({ type: h.settingsScreens.get("chat-presentation").Component, props: { theme: { colors: {} } } });
    assert.equal(h.text(h.nodes(tree, node => node.props.testID === "installed-version")[0]), "Clear Chat version Unknown");
  });
}
