const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Synthetic host storage shared by independent client module caches.
function createPresentationHost() {
  let values = { preferences: {}, legacyMigrated: true };
  let revision = 0;
  const calls = [];
  return {
    calls,
    get values() { return structuredClone(values); },
    async rpc(contract, input) {
      calls.push(contract.name);
      if (contract.name === "settings.presentation.read") {
        return { status: "ready", revision: String(revision), values: structuredClone(values) };
      }
      assert.equal(contract.name, "settings.presentation.write");
      assert.equal(input.revision, String(revision));
      values = structuredClone(input.values);
      revision++;
      return { status: "saved", revision: String(revision), values: structuredClone(values) };
    },
  };
}

async function client(presentationHost) {
  const h = createToolHarness("ios", { settingsPage: true, presentationHost });
  await new Promise(setImmediate);
  assert.equal(h.load("client/preferences.ts").areEnhancerPreferencesReady(), true);
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  return { h, page: () => h.draw({ type: Page, props: { theme: { colors: {} } } }) };
}

const toggle = (h, tree) => h.nodes(tree, node => node.props.accessibilityLabel === "Fold finished steps")[0];
const option = (h, tree, label) => h.nodes(tree, node => node.type === "Pressable" && h.text(node) === label)[0];
const summary = (h, tree) => h.nodes(tree, node => node.props.testID === "tool-summary-row")[0];
const output = (h, tree) => h.text(h.nodes(tree, node => node.props.testID === "tool-card-body")[0]);
const call = {
  type: "tool_call", name: "shell", callId: "settings-call", status: "completed",
  detail: { type: "shell", command: "sample", output: Array.from({ length: 31 }, (_, i) => `ROW ${i + 1}`).join("\n") },
};

test("finished-step settings control updates mounted calls and survives host rereads in both directions", async () => {
  const host = createPresentationHost();
  const { h, page } = await client(host);
  const mounted = h.mount(call, false);
  assert.equal(toggle(h, page()).props.accessibilityState.checked, true);
  assert.equal(summary(h, mounted.tree).props.accessibilityState.expanded, false);

  for (const checked of [false, true]) {
    await toggle(h, page()).props.onPress();
    assert.equal(toggle(h, page()).props.accessibilityState.checked, checked);
    assert.equal(summary(h, mounted.render()).props.accessibilityState.expanded, !checked);
    assert.equal(host.values.preferences.foldFinishedSteps, checked);

    const readsBefore = host.calls.filter(name => name.endsWith(".read")).length;
    const fresh = await client(host);
    assert.equal(host.calls.filter(name => name.endsWith(".read")).length, readsBefore + 1);
    assert.equal(toggle(fresh.h, fresh.page()).props.accessibilityState.checked, checked);
    assert.equal(summary(fresh.h, fresh.h.mount(call, false).tree).props.accessibilityState.expanded, !checked);
    fresh.h.unmount();
  }
  h.unmount();
});

for (const [label, limit] of [["10 lines", 10], ["15 lines", 15], ["30 lines", 30], ["Never", "never"]]) {
  test(`output settings control saves ${label} and restores its selection and preview after reload`, async () => {
    const host = createPresentationHost();
    const { h, page } = await client(host);
    const mounted = h.mount({ ...call, status: "running" }, false);
    const labels = ["10 lines", "15 lines", "30 lines", "Never"];
    const selected = (client, render, expected) => {
      assert.deepEqual(labels.map(label => option(client, render(), label).props.accessibilityState.selected),
        labels.map(label => label === expected));
    };
    const preview = (client, tree, expected) => {
      const lastLine = expected === "never" ? 31 : expected;
      assert.ok(output(client, tree).split("\n").includes(`ROW ${lastLine}`));
      assert.equal(output(client, tree).split("\n").includes(`ROW ${lastLine + 1}`), false);
      const reveal = client.nodes(tree, node => node.props.accessibilityLabel === "Show all 31 lines");
      assert.equal(reveal.length, expected === "never" ? 0 : 1);
    };
    selected(h, page, "15 lines");
    preview(h, mounted.tree, 15);
    // Exercise a real change even when the requested value is the default.
    if (limit === 15) await option(h, page(), "10 lines").props.onPress();
    await option(h, page(), label).props.onPress();
    selected(h, page, label);
    preview(h, mounted.render(), limit);
    assert.equal(host.values.preferences.foldLongOutputAfter, limit);
    assert.ok(host.calls.includes("settings.presentation.write"));

    h.unmount();
    const readsBefore = host.calls.filter(name => name.endsWith(".read")).length;
    const fresh = await client(host);
    assert.equal(host.calls.filter(name => name.endsWith(".read")).length, readsBefore + 1);
    selected(fresh.h, fresh.page, label);
    preview(fresh.h, fresh.h.mount({ ...call, status: "running" }, false).tree, limit);
    fresh.h.unmount();
  });
}
