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
        for (const prompt of items.filter(item => item.type === "user_message")) {
          assert.equal(host.project(prompt)[0].kind, "omp-user-message", "prompts share the readiness registration path");
        }
      }
      assert.equal(h.dimensions.width, width);
    });
  }

  test(`${platform}: saved text opt-outs survive the cold-load cache`, async t => {
    const { h, host, preferences, draw } = client(platform, 820);
    t.after(() => { h.unmount(); h.dispose(); });
    const texts = coldLoadSessions.flatMap(session => session.items)
      .filter(item => ["assistant_message", "user_message"].includes(item.type));
    texts.forEach(item => host.project(item));
    host.resolvePreferences({ assistantMarkdown: false, enhancedUserBubble: false });
    await settle();
    assert.equal(preferences.areEnhancerPreferencesReady(), true);
    for (const item of texts) assert.strictEqual(host.project(item)[0], item);
    assert.equal(h.nodes(draw(texts.find(item => item.type === "assistant_message")), node => node.props.accessibilityLabel === "Copy reply").length, 0);
  });

  test(`${platform}: Retry reprojects cached replies once and later edits keep the registry stable`, async t => {
    const { h, host, preferences } = client(platform, 390);
    t.after(() => { h.unmount(); h.dispose(); });
    const reply = coldLoadSessions[1].items.find(item => item.type === "assistant_message");
    assert.strictEqual(host.project(reply)[0], reply);
    host.rejectPreferences();
    await settle();
    assert.equal(preferences.areEnhancerPreferencesReady(), false);
    assert.ok(preferences.getEnhancerPreferencesError());
    assert.strictEqual(host.project(reply)[0], reply);
    host.resolvePreferences();
    await preferences.retryEnhancerPreferences();
    assert.equal(preferences.getEnhancerPreferencesError(), null);
    assert.equal(host.project(reply)[0].kind, "omp-assistant");
    const revision = host.getRevision(), projected = host.project(reply);
    await preferences.updateEnhancerPreferences({ assistantMarkdown: false });
    assert.equal(host.getRevision(), revision, "normal edits do not re-register or flush every row");
    assert.strictEqual(host.project(reply), projected);
    const next = { ...reply, messageId: "sample-next-reply" };
    assert.strictEqual(host.project(next)[0], next, "new replies honor the updated opt-out");
  });

  test(`${platform}: unloading before the preference read completes cancels text registration`, async t => {
    const { h, host } = client(platform, 1440);
    t.after(() => h.unmount());
    h.dispose();
    const revision = host.getRevision();
    host.resolvePreferences();
    await settle();
    assert.equal(host.getRevision(), revision);
    assert.equal(host.transformers.size, 0);
    assert.equal(host.renderers.size, 0);
  });
}
