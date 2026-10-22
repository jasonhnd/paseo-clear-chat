const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { createColdLoadHost, coldLoadSessions } = require("./helpers/cold-load-host.cjs");
const settle = () => new Promise(setImmediate);

function client(platform, width) {
  const host = createColdLoadHost();
  const h = createToolHarness(platform, {
    width, timelineHost: host, presentationHost: host, markdown: true, replyFooter: true,
  });
  const preferences = h.load("client/preferences.ts");
  function draw(source) {
    return host.project(source).map(item => {
      if (item.type !== "plugin") return { type: "HostReply", props: { children: item.text } };
      const renderer = h.renderers.get(item.kind);
      return h.draw({ type: renderer.Component, props: {
        item: { ...item, data: renderer.schema.parse(item.data) }, agentId: "sample-agent",
        host: { id: "sample-host" }, theme: { colors: {} }, timestamp: new Date("2026-01-01T12:00:00Z"),
        layout: { compact: width < 744, platform },
      } });
    });
  }
  return { h, host, preferences, draw };
}

for (const platform of ["web", "ios", "android"]) {
  for (const width of [1440, 820, 390]) {
    test(`${platform} ${width}px: cached cold-load replies become enhanced without resizing`, async t => {
      const { h, host, preferences, draw } = client(platform, width);
      t.after(() => { h.unmount(); h.dispose(); });
      assert.equal(preferences.areEnhancerPreferencesReady(), false);
      for (const { items } of coldLoadSessions) {
        items.forEach(item => host.project(item));
        const tool = items.find(item => item.type === "tool_call");
        assert.equal(host.project(tool)[0].kind, "omp-tool-call", "tools are enhanced during the pending read");
        for (const reply of items.filter(item => item.type === "assistant_message")) {
          assert.ok(h.text(draw(reply)).includes(reply.text), "pending preferences retain host reply content");
        }
      }
      const before = host.transformCalls;
      const source = coldLoadSessions[0].items[0];
      assert.strictEqual(host.project(source), host.project(source));
      assert.equal(host.transformCalls, before, "unchanged source/phase/registry uses the host cache");

      host.resolvePreferences();
      await settle();
      assert.equal(preferences.areEnhancerPreferencesReady(), true);
      for (const { items } of coldLoadSessions) {
        for (const reply of items.filter(item => item.type === "assistant_message")) {
          assert.equal(host.project(reply)[0].kind, "omp-assistant", "the same cached source must reach the plugin");
          const tree = draw(reply);
          assert.equal(h.nodes(tree, node => node.type === "HostReply").length, 0);
          assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply").length, 1);
          assert.ok(h.text(tree).includes(reply.text));
        }
      }
      assert.equal(h.dimensions.width, width);
    });
  }
}
