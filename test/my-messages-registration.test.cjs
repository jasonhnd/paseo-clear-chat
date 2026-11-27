const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

test("client startup registers What I said only in the sidebar", async t => {
  const h = createToolHarness("web");
  t.after(h.dispose);
  const screens = [];
  const sidebarItems = [];
  const registerPanel = t.mock.fn(() => () => {});
  const registerHeaderButton = t.mock.fn(() => ({ remove() {} }));
  const stop = h.load("index.client.tsx").default({
    i18n: h.translations.runtime,
    paseo: {
      agents: {},
      workspaces: { list: async () => ({ entries: [{ id: "workspace" }] }) },
    },
    rpc() {},
    addSettingsScreen() {},
    addScreen(screen) { screens.push(screen.id); return () => {}; },
    addSidebarHeaderItem(item) { sidebarItems.push(item.id); return () => {}; },
    addAgentPanel: registerPanel,
    addHeaderButton: registerHeaderButton,
    openPanel() {},
  });
  t.after(stop);

  await new Promise(setImmediate);
  assert.deepEqual(screens, ["my-messages-today"]);
  assert.deepEqual(sidebarItems, ["my-messages-today"]);
  assert.equal(registerPanel.mock.callCount(), 0);
  // Clear Chat registers no conversation header button at all.
  assert.equal(registerHeaderButton.mock.callCount(), 0);
});
