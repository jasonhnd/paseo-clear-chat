const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const resources = Object.fromEntries(["en", "zh-CN", "ja"].map(locale => [locale, require(`../client/locales/${locale}.json`)]));
const signedAnswerCardCopy = {
  en: ["Send", "Enter to confirm · Shift+Enter for a new line"],
  "zh-CN": ["发送", "Enter 确认 · Shift+Enter 换行"],
  ja: ["送信", "Enter で確定 · Shift+Enter で改行"],
};

function keys(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? keys(child, path) : [path];
  }).sort();
}

test("all locales contain the same translation keys", () => {
  const en = keys(resources.en);
  assert.deepEqual(keys(resources["zh-CN"]), en);
  assert.deepEqual(keys(resources.ja), en);
});

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: signed custom answer copy is unchanged`, () => {
    const card = resources[locale].answerCard;
    assert.deepEqual([card.sendAction, card.hintCustom], signedAnswerCardCopy[locale]);
  });

  test(`${locale}: settings page shows the answer card, saved replies, version and report link`, async () => {
    const h = createToolHarness("ios", {
      locale,
      settingsPage: true,
      presentationHost: { rpc: async () => ({ status: "ready", revision: "0", values: { preferences: {}, legacyMigrated: true } }) },
    });
    await new Promise(setImmediate);
    const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
    const tree = h.draw({ type: Page, props: { theme: { colors: {} } } });
    const text = h.text(tree);
    const r = resources[locale];
    for (const expected of [
      r.settings.title,
      r.settings.answerCard.label,
      r.settings.answerCard.description,
      r.answerStyle.savedRepliesLabel,
      r.settings.report,
    ]) {
      assert.ok(text.includes(expected), expected);
    }
    assert.equal(h.nodes(tree, node => node.props.testID === "installed-version").length, 1);
    assert.equal(h.nodes(tree, node => node.props.testID === "saved-replies-input").length, 1);
    h.unmount();
  });
}
