const assert = require("node:assert/strict");
const test = require("node:test");
const entries = require("./fixtures/real-claude-turn-timing.json");
const wrapUp = require("./fixtures/real-claude-wrapup.json");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Read-only capture of the comparison conversation, from both canonical and
// projected timeline APIs. All prose, paths, IDs and dates were replaced;
// keys, nesting, array lengths, value types and relative times are unchanged.
const settle = () => new Promise(resolve => setImmediate(resolve));
function timingHost(timeline = entries) {
  const requests = [];
  const agent = { status: "idle", activeTurn: null, cwd: "/workspace/sample" };
  const paseo = { agents: { ref: () => ({ timeline: {
    async refetch(options) {
      requests.push(options);
      return { entries: timeline, agent, hasOlder: false, hasNewer: false, error: null };
    },
  } }) } };
  return { paseo, agent, requests };
}

for (const platform of ["web", "ios", "android"]) {
  test(`captured final reply retains exactly one Worked for label on ${platform}`, async () => {
    const source = timingHost();
    const h = createToolHarness(platform, { ...source, markdown: true, replyFooter: true });
    const intro = entries.find(entry => entry.item.type === "assistant_message");
    const interim = h.mount(intro.item, false, { timestamp: new Date(intro.timestamp) });
    await settle();
    assert.doesNotMatch(h.text(interim.render()), /Worked for /, "intermediate prose has no duplicate duration");
    const last = entries.at(-1);
    const mounted = h.mount(last.item, false, { timestamp: new Date(last.timestamp) });
    await settle();
    const tree = mounted.render();
    assert.equal((h.text(tree).match(/Worked for 21s/g) ?? []).length, 1);
    const footers = h.nodes(tree, node => node.props.testID === "reply-footer");
    assert.equal(footers.length, 1);
    assert.match(h.text(footers[0]), /Worked for 21s/);
    assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply").length, 1);
    assert.equal(source.requests.length, 1);
    assert.equal(source.requests[0].projection, "canonical");
    h.unmount();
  });

  test(`a final wrap-up tool owns the single duration on ${platform}`, async () => {
    const timeline = structuredClone(entries);
    timeline.at(-1).item = wrapUp;
    const source = timingHost(timeline);
    const h = createToolHarness(platform, { ...source, replyFooter: true });
    const final = timeline.at(-1);
    const mounted = h.mount(final.item, false, { timestamp: new Date(final.timestamp) });
    await settle();
    const tree = mounted.render();
    assert.equal((h.text(tree).match(/Worked for 21s/g) ?? []).length, 1);
    assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply").length, 1);
    h.unmount();
  });

  test(`a live turn gains its duration after settling on ${platform}`, async () => {
    const source = timingHost();
    source.agent.status = "running";
    const h = createToolHarness(platform, { ...source, replyFooter: true });
    const final = entries.at(-1);
    const mounted = h.mount(final.item, false, { timestamp: new Date(final.timestamp) });
    await settle();
    assert.doesNotMatch(h.text(mounted.render()), /Worked for /);
    assert.equal(source.requests.length, 0, "running never refetches");
    source.agent.status = "idle";
    source.agent.updatedAt = "2026-01-01T12:01:00Z";
    mounted.render();
    await settle();
    assert.match(h.text(mounted.render()), /Worked for 21s/);
    assert.equal(source.requests.length, 1, "only the settled lifecycle revision reads history");
    h.unmount();
  });
}

function derive(timeline, running = false) {
  const h = createToolHarness();
  return h.load("client/reply-duration.ts").deriveReplyDurations(timeline, running);
}

test("captured relative timing and order reproduce the host's 21 seconds", () => {
  const before = JSON.stringify(entries);
  assert.equal(entries.length, 10);
  assert.equal(Date.parse(entries.at(-1).timestamp) - Date.parse(entries[0].timestamp), 21099);
  assert.deepEqual([...derive(entries).values()], [21099]);
  assert.equal(JSON.stringify(entries), before, "unordered tool timestamps must not be sorted or mutated");
});

test("separate turns keep their own time even when message IDs or prose repeat", () => {
  const next = structuredClone(entries);
  for (const entry of next) {
    entry.timestamp = new Date(Date.parse(entry.timestamp) + 60000).toISOString();
    entry.turnId = "sample-next-turn";
  }
  next.at(-1).timestamp = new Date(Date.parse(next[0].timestamp) + 42000).toISOString();
  assert.deepEqual([...derive([...entries, ...next]).values()], [21099, 42000]);
  assert.deepEqual([...derive([...entries, ...next], true).values()], [21099], "active response must not gain a final label");
});

test("legacy timelines without turn IDs retain user-message boundaries", () => {
  const legacy = structuredClone(entries);
  for (const entry of legacy) delete entry.turnId;
  assert.deepEqual([...derive(legacy).values()], [21099]);
});

test("missing prompt and a new canonical turn without a prompt do not invent timing", () => {
  assert.equal(derive(entries.slice(1)).size, 0);
  const injected = structuredClone(entries);
  injected.at(-1).turnId = "sample-injected-turn";
  assert.equal(derive(injected).size, 0, "a response spanning a system turn must not borrow an earlier prompt");
});

test("canonical IDs take precedence over another user item in the same turn", () => {
  const timeline = structuredClone(entries);
  timeline[1].item = { type: "user_message", text: "Additional sample input." };
  assert.deepEqual([...derive(timeline).values()], [21099]);
});

test("the last timeline event closes elapsed time, including tools after a reply", () => {
  const trailing = structuredClone(entries[3]);
  trailing.timestamp = "2026-01-01T12:00:30.000Z";
  assert.deepEqual([...derive([...entries, trailing]).values()], [30000]);
});

test("invalid and negative timestamps never render a nonfinite or negative elapsed time", () => {
  const invalid = structuredClone(entries);
  invalid[0].timestamp = "invalid";
  assert.equal(derive(invalid).size, 0);
  invalid[0].timestamp = "2026-01-01T13:00:00Z";
  assert.deepEqual([...derive(invalid).values()], [0]);
});

test("duration units match the host at second, minute and hour boundaries", () => {
  const h = createToolHarness();
  const { formatWorkedDuration } = h.load("client/reply-duration.ts");
  for (const [ms, expected] of [[0, "0s"], [999, "0s"], [21099, "21s"], [59999, "59s"],
    [60000, "1m"], [61000, "1m 1s"], [3600000, "1h"], [3661000, "1h 1m"], [NaN, "0s"], [Infinity, "0s"]]) {
    assert.equal(formatWorkedDuration(ms), expected);
  }
});

test("a failed timing read preserves Copy without inventing duration", async () => {
  const source = timingHost();
  source.paseo.agents.ref = () => ({ timeline: { refetch: async () => { throw Error("Sample unavailable"); } } });
  const h = createToolHarness("web", { ...source, replyFooter: true });
  const final = entries.at(-1);
  const mounted = h.mount(final.item, false, { timestamp: new Date(final.timestamp) });
  await settle();
  const tree = mounted.render();
  assert.doesNotMatch(h.text(tree), /Worked for /);
  assert.equal(h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply").length, 1);
  h.unmount();
});

test("late timing results cannot move to a different host with matching message text", async () => {
  const source = timingHost();
  let resolveRead;
  const requests = [];
  source.paseo.agents.ref = () => ({ timeline: { refetch: () => {
    requests.push(true);
    return requests.length === 1 ? new Promise(resolve => { resolveRead = resolve; })
      : Promise.resolve({ entries: entries.slice(1), agent: source.agent });
  } } });
  const h = createToolHarness("web", { ...source, replyFooter: true });
  const { LiveAssistantRenderer } = h.load("client/live-renderers.tsx");
  const final = entries.at(-1);
  const props = { host: { id: "sample-first-host" }, agentId: "sample-agent", timestamp: new Date(final.timestamp),
    theme: { colors: {} }, item: { data: final.item } };
  h.draw({ type: LiveAssistantRenderer, props });
  await settle();
  props.host = { id: "sample-second-host" };
  h.draw({ type: LiveAssistantRenderer, props });
  resolveRead({ entries, agent: source.agent });
  await settle();
  assert.doesNotMatch(h.text(h.draw({ type: LiveAssistantRenderer, props })), /Worked for /);
  h.unmount();
});
