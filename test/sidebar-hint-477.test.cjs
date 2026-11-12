const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const expected = {
  en: "Open Settings → Sidebar and select Clear Chat to use it in the sidebar.",
  "zh-CN": "打开 Settings → Sidebar，选 Clear Chat，就能在侧栏使用它。",
  ja: "Settings → Sidebar で Clear Chat を選ぶと、サイドバーで使えます。",
};

for (const [locale, text] of Object.entries(expected)) {
  test(`${locale}: first header mount shows the hint once and persists it`, () => {
    const values = new Map();
    const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const h = createToolHarness("web", { locale, globals: { localStorage } });
    const Item = h.load("client/components/sidebar-hint-item.tsx").SidebarHintItem;
    assert.equal(h.draw({ type: Item, props: {} }), null);
    assert.deepEqual(h.toasts, [text]);
    assert.equal(values.get("clear-chat.sidebar-view-hint-shown"), "1");
    h.unmount();
    h.draw({ type: Item, props: {} });
    assert.deepEqual(h.toasts, [text]);
    h.dispose();
    const fresh = createToolHarness("web", { locale, globals: { localStorage } });
    const FreshItem = fresh.load("client/components/sidebar-hint-item.tsx").SidebarHintItem;
    fresh.draw({ type: FreshItem, props: {} });
    assert.deepEqual(fresh.toasts, []);
    fresh.unmount();
    fresh.dispose();
  });
}

test("unavailable storage does not crash or repeat the hint during the session", () => {
  const h = createToolHarness("web", { globals: { get localStorage() { throw new Error("unavailable"); } } });
  const Item = h.load("client/components/sidebar-hint-item.tsx").SidebarHintItem;
  h.draw({ type: Item, props: {} });
  h.unmount();
  h.draw({ type: Item, props: {} });
  assert.deepEqual(h.toasts, [expected.en]);
  h.unmount();
  h.dispose();
});

test("registers the sidebar hint header item and shows the toast once", () => {
  const values = new Map();
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const h = createToolHarness("web", { globals: { localStorage } });
  const item = h.sidebarHeaderItems.get("clear-chat-hint");
  assert.ok(item, "header item is registered");
  // The host resolves PluginText; the exact "Clear Chat" copy is asserted in test/translations.test.cjs.
  assert.deepEqual(item.title, h.load("client/messages.ts").messages.message("sidebar.title"));
  const Item = h.load("client/components/sidebar-hint-item.tsx").SidebarHintItem;
  assert.equal(item.Component, Item);
  const panelOpensBefore = h.panelOpens.length;
  h.draw({ type: item.Component, props: {} });
  assert.deepEqual(h.toasts, [expected.en]);
  assert.equal(values.get("clear-chat.sidebar-view-hint-shown"), "1");
  assert.equal(h.panelOpens.length, panelOpensBefore);
  h.unmount();
  h.draw({ type: item.Component, props: {} });
  assert.deepEqual(h.toasts, [expected.en]);
  h.dispose();
});
