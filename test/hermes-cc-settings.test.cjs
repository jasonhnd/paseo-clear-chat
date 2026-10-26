const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: Hermes setting defaults ON and saves the selected host revision`, async () => {
    let values = { enabled: true }, revision = "4";
    const writes = [];
    const h = createToolHarness("ios", { locale, settingsPage: true, settingsHost: definition => {
      assert.equal(definition.id, "hermes-cc");
      assert.deepEqual(definition.schema.parse({}), { enabled: true });
      return {
        status: "ready", values, revision, saving: false, saveError: null,
        async save(next, expected) {
          assert.equal(expected, revision);
          writes.push(next); values = next; revision = String(Number(revision) + 1);
          return true;
        },
      };
    } });
    const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
    const resources = require(`../client/locales/${locale}.json`);
    const page = () => h.draw({ type: Page, props: { theme: { colors: {} } } });
    const toggle = () => h.nodes(page(), node => node.props.accessibilityLabel === resources.settings.hermesCc.label)[0];
    assert.equal(toggle().props.accessibilityState.checked, true);
    await toggle().props.onPress();
    assert.equal(toggle().props.accessibilityState.checked, false);
    await toggle().props.onPress();
    assert.equal(toggle().props.accessibilityState.checked, true);
    assert.deepEqual(writes, [{ enabled: false }, { enabled: true }]);
    assert.ok(h.text(page()).includes(resources.settings.hermesCc.description));
    h.unmount();
  });
}

test("an invalid Hermes setting shows a translated retry notice and hides the toggle", () => {
  let retries = 0;
  const h = createToolHarness("ios", { settingsPage: true, settingsHost: () => ({
    status: "invalid", revision: "0", error: "private backend detail", saveError: null,
    reload: () => { retries++; },
  }) });
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  const tree = h.draw({ type: Page, props: { theme: { colors: {} } } });
  assert.match(h.text(tree), /Could not load or save the Hermes·CC setting/);
  assert.doesNotMatch(h.text(tree), /private backend detail/);
  assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Hermes·CC providers").length, 0);
  const retry = h.nodes(tree, node => node.type === "Pressable" && h.text(node) === "Retry")[0];
  retry.props.onPress();
  assert.equal(retries, 1);
  h.unmount();
});
