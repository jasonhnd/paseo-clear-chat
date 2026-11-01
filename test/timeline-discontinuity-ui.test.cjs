const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { turn, page, createHost, tail, after } = require("./fixtures/timeline-discontinuity-host.cjs");
const settle = () => new Promise(setImmediate);

function fixture(t) {
  const host = createHost();
  const h = createToolHarness("web", { paseo: host.paseo, agents: host.agents, replyFooter: true });
  t.after(() => { host.assertDrained(); h.unmount(); h.dispose(); });
  const { LiveAssistantRenderer } = h.load("client/live-renderers.tsx");
  function draw(agent, entry) {
    return h.draw({ type: LiveAssistantRenderer, props: { agentId: agent, host: { id: "synthetic-host" },
      timestamp: new Date(entry.timestamp), theme: { colors: {} }, item: { data: entry.item } } }, `${agent}-${entry.item.messageId}`);
  }
  async function shown(agent, entry) {
    draw(agent, entry);
    await settle();
    const tree = draw(agent, entry);
    assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply").length, 1);
    return h.text(tree);
  }
  return { host, shown };
}

test("a discarded timeline replaces visible timing while the other agent stays isolated", async t => {
  const { host, shown } = fixture(t);
  const old = turn("old", 1, 21), other = turn("other", 1, 33), replacement = turn("replacement", 1, 42);
  host.enqueue("agent-a", tail(), page("epoch-a", old));
  host.enqueue("agent-b", tail(), page("epoch-b", other));
  assert.match(await shown("agent-a", old[1]), /Worked for 21s/);
  assert.match(await shown("agent-b", other[1]), /Worked for 33s/);

  // The host discards A's history and reuses its sequence numbers in a new epoch.
  host.agents["agent-a"].updatedAt = "2";
  host.enqueue("agent-a", after("epoch-a", 2), page("epoch-new", replacement, { reset: true, staleCursor: true }));
  assert.doesNotMatch(await shown("agent-a", old[1]), /Worked for /);
  assert.match(await shown("agent-a", replacement[1]), /Worked for 42s/);
  assert.match(await shown("agent-b", other[1]), /Worked for 33s/);
  assert.equal(host.requests.filter(request => request.id === "agent-b").length, 1);
});

test("a flagged sequence gap replaces the old timing and uses the new cursor", async t => {
  const { host, shown } = fixture(t);
  const old = turn("old-gap", 1, 21), replacement = turn("after-gap", 7, 42), next = turn("next", 9, 12);
  host.enqueue("agent-a", tail(), page("epoch-a", old));
  assert.match(await shown("agent-a", old[1]), /Worked for 21s/);
  // Sequence numbers 3 through 6 are absent; the host signals the gap.
  host.agents["agent-a"].updatedAt = "2";
  host.enqueue("agent-a", after("epoch-a", 2), page("epoch-a", replacement, { gap: true }));
  assert.doesNotMatch(await shown("agent-a", old[1]), /Worked for /);
  assert.match(await shown("agent-a", replacement[1]), /Worked for 42s/);
  host.agents["agent-a"].updatedAt = "3";
  host.enqueue("agent-a", after("epoch-a", 8), page("epoch-a", next));
  assert.match(await shown("agent-a", next[1]), /Worked for 12s/);
  assert.match(await shown("agent-a", replacement[1]), /Worked for 42s/);
});

test("a duplicated page cannot change a settled reply's visible timing", async t => {
  const { host, shown } = fixture(t);
  const entries = turn("duplicate", 1, 21);
  const firstPage = page("epoch-a", [entries[0]]);
  host.enqueue("agent-a", tail(), firstPage);
  assert.doesNotMatch(await shown("agent-a", entries[1]), /Worked for /);

  host.agents["agent-a"].updatedAt = "2";
  host.enqueue("agent-a", after("epoch-a", 1), page("epoch-a", [entries[1]]));
  assert.match(await shown("agent-a", entries[1]), /Worked for 21s/);

  // Replay the original page after the response has already been observed.
  host.agents["agent-a"].updatedAt = "3";
  host.enqueue("agent-a", after("epoch-a", 2), firstPage);
  assert.match(await shown("agent-a", entries[1]), /Worked for 21s/);
});

test("partial recovery and a failed read never present partial timing as complete", async t => {
  const { host, shown } = fixture(t);
  const old = turn("settled", 1, 21), partial = turn("partial", 7, 42), complete = turn("complete", 7, 30);
  host.enqueue("agent-a", tail(), page("epoch-a", old));
  assert.match(await shown("agent-a", old[1]), /Worked for 21s/);
  host.agents["agent-a"].updatedAt = "2";
  host.enqueue("agent-a", after("epoch-a", 2), page("epoch-a", partial, { staleCursor: true, hasOlder: true }));
  host.enqueue("agent-a", tail(), page("epoch-a", partial, { hasNewer: true }));
  assert.doesNotMatch(await shown("agent-a", partial[1]), /Worked for /);
  assert.match(await shown("agent-a", old[1]), /Worked for 21s/);
  host.agents["agent-a"].updatedAt = "3";
  host.fail("agent-a", after("epoch-a", 2));
  assert.doesNotMatch(await shown("agent-a", partial[1]), /Worked for /);
  assert.match(await shown("agent-a", old[1]), /Worked for 21s/);
  host.agents["agent-a"].updatedAt = "4";
  host.enqueue("agent-a", after("epoch-a", 2), page("epoch-a", complete, { staleCursor: true }));
  assert.match(await shown("agent-a", complete[1]), /Worked for 30s/);
  assert.doesNotMatch(await shown("agent-a", old[1]), /Worked for /);
});
