const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const reportUrl = "https://github.com/jasonhnd/paseo-clear-chat/issues/new?template=bug_report.yml";

for (const client of ["desktop", "web", "ios", "android"]) {
  test(`settings report link opens the bug template through the ${client} client`, async t => {
    const desktop = [], browser = [];
    const h = createToolHarness(client === "desktop" ? "web" : client, {
      settingsPage: true,
      globals: {
        ...(client !== "web" ? { paseoDesktop: { opener: { openUrl: url => desktop.push(url) } } } : {}),
        open: (...args) => browser.push(args),
      },
    });
    t.after(() => h.unmount());
    const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
    const tree = h.draw({ type: Page, props: { theme: { colors: {} } } });
    const links = h.nodes(tree, node => node.props.accessibilityRole === "link" && h.text(node) === "Report a problem");
    assert.equal(links.length, 1);
    assert.equal(tree.props.children.at(-1), links[0], "the report row is at the bottom of settings");
    assert.deepEqual(desktop, []);
    assert.deepEqual(browser, []);
    assert.deepEqual(h.links, []);

    await links[0].props.onPress();

    assert.deepEqual(desktop, client === "desktop" ? [reportUrl] : []);
    assert.deepEqual(browser, client === "web" ? [[reportUrl, "_blank", "noopener,noreferrer"]] : []);
    assert.deepEqual(h.links, client === "ios" || client === "android" ? [reportUrl] : []);
  });
}
