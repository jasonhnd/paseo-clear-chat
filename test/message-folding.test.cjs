const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { createExpansionHost } = require("./helpers/expansion-host.cjs");
const timeline = require("./fixtures/real-hermes-reply-footer.json");
const tick = () => new Promise(setImmediate);
const identity = { timestamp: new Date(timeline[0].timestamp) };
const lines = n => Array.from({ length: n }, (_, i) => `sample_line_${i + 1};`).join("\n");
const source = lines(31);
const samples = [
  // Explicit attachment metadata keeps this derived prompt on the enhanced path.
  ["prompt", { ...timeline[0].item, text: source, imageCount: 0 }, "Copy prompt", source],
  ["reply code", { ...timeline.at(-1).item, text: `Before the code.\n\n\`\`\`text\n${source}\n\`\`\`\n\nAfter the code.` }, "Copy code", source],
];
const options = { markdown: true, syntax: true, userMessage: true, copyFeedback: true, replyFooter: true };
const buttons = (h, tree) => h.nodes(tree, node => node.type === "Pressable" && /^(Show all \d+ lines|Show fewer lines)$/.test(node.props.accessibilityLabel));
const visible = (h, tree, line) => h.text(tree).includes(`sample_line_${line};`);

for (const platform of ["web", "ios", "android"]) {
  for (const [kind, item, copyLabel, copiedText] of samples) {
    for (const limit of [10, 15, 30, "never"]) {
      test(`${platform} ${kind} respects ${limit}, copies the full source and toggles both ways`, async () => {
        const h = createToolHarness(platform, { ...options, preferences: { foldLongOutputAfter: limit } });
        const mounted = h.mount(item, false, identity);
        let tree = mounted.tree;
        assert.equal(visible(h, tree, 31), limit === "never");
        assert.equal(buttons(h, tree).length, limit === "never" ? 0 : 1);
        await h.nodes(tree, node => node.props.accessibilityLabel === copyLabel)[0].props.onPress();
        assert.deepEqual(h.copies, [copiedText]);
        if (limit !== "never") {
          assert.equal(visible(h, tree, limit), true);
          assert.equal(visible(h, tree, limit + 1), false);
          assert.equal(buttons(h, tree)[0].props.accessibilityLabel, "Show all 31 lines");
          buttons(h, tree)[0].props.onPress();
          tree = mounted.render();
          assert.equal(visible(h, tree, 31), true);
          assert.equal(buttons(h, tree)[0].props.accessibilityState.expanded, true);
          buttons(h, tree)[0].props.onPress();
          assert.equal(visible(h, mounted.render(), 31), false);
        }
        if (kind === "reply code") {
          assert.match(h.text(tree), /Before the code\./);
          assert.match(h.text(tree), /After the code\./);
          await h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply")[0].props.onPress();
          assert.equal(h.copies.at(-1), item.text);
        }
        h.unmount();
        await tick();
      });
    }

    test(`${platform} ${kind} saves expansion and collapse across fresh module reloads`, async () => {
      const expansionHost = createExpansionHost();
      for (const expanded of [true, false]) {
        const h = createToolHarness(platform, { ...options, expansionHost });
        const mounted = h.mount(item, false, identity);
        await tick();
        let tree = mounted.render();
        assert.equal(visible(h, tree, 31), !expanded);
        buttons(h, tree)[0].props.onPress();
        assert.equal(visible(h, mounted.render(), 31), expanded);
        h.unmount();
        await tick();
        assert.ok(expansionHost.calls.some(call => call.name === "write"));
        const fresh = createToolHarness(platform, { ...options, expansionHost });
        const replay = fresh.mount(structuredClone(item), false, identity);
        await tick();
        assert.equal(visible(fresh, replay.render(), 31), expanded);
        fresh.unmount();
      }
    });
  }
}

test("separate code blocks, messages, hosts, agents and timestamps keep independent choices", async () => {
  const expansionHost = createExpansionHost();
  const h = createToolHarness("ios", { ...options, expansionHost });
  const item = { ...samples[1][1], text: `${samples[1][1].text}\n\n\`\`\`text\n${source}\n\`\`\`` };
  const first = h.mount(item, false, identity);
  assert.equal(buttons(h, first.tree).length, 2);
  buttons(h, first.tree)[0].props.onPress();
  assert.deepEqual(buttons(h, first.render()).map(button => button.props.accessibilityState.expanded), [true, false]);
  h.unmount();
  await tick();
  for (const [otherItem, otherIdentity] of [
    [{ ...item, messageId: "another-message" }, identity],
    [item, { ...identity, host: { id: "another-host" } }],
    [item, { ...identity, agentId: "another-agent" }],
    [item, { timestamp: new Date("2026-01-02T12:00:00Z") }],
    [samples[0][1], identity],
  ]) {
    const replay = h.mount(otherItem, false, otherIdentity);
    await tick();
    assert.ok(buttons(h, replay.render()).every(button => button.props.accessibilityState.expanded === false));
  }
  const replay = h.mount(item, false, identity);
  await tick();
  assert.deepEqual(buttons(h, replay.render()).map(button => button.props.accessibilityState.expanded), [true, false]);
  h.unmount();
});

test("threshold equality, CRLF, settings changes and prompt images preserve their content", async () => {
  const h = createToolHarness("ios", options);
  const item = { ...samples[0][1], text: `${lines(15).replaceAll("\n", "\r\n")}\r\n`, images: ["data:image/png;base64,c2FtcGxl"], imageCount: 2 };
  const mounted = h.mount(item, false, identity);
  assert.equal(buttons(h, mounted.tree).length, 0);
  h.preferences.foldLongOutputAfter = 10;
  let tree = mounted.render();
  assert.equal(visible(h, tree, 15), false);
  assert.equal(buttons(h, tree)[0].props.accessibilityLabel, "Show all 15 lines");
  assert.match(h.text(tree), /2 images attached/);
  assert.equal(h.nodes(tree, node => node.type === "Image").length, 1);
  await h.nodes(tree, node => node.props.accessibilityLabel === "Copy prompt")[0].props.onPress();
  assert.equal(h.copies[0], item.text);
  h.preferences.foldLongOutputAfter = "never";
  tree = mounted.render();
  assert.equal(visible(h, tree, 15), true);
  assert.equal(buttons(h, tree).length, 0);
  h.unmount();
});
