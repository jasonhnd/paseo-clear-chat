// A scripted SDK boundary for renderer tests. It does not run a daemon or a model.
const assert = require("node:assert/strict");

function turn(name, firstSeq, seconds) {
  const start = Date.parse("2026-01-01T00:00:00Z");
  return ["user_message", "assistant_message"].map((type, index) => ({
    provider: "synthetic", item: { type, text: `${name} ${index ? "reply" : "prompt"}`, messageId: `${name}-${index}` },
    timestamp: new Date(start + index * seconds * 1000).toISOString(),
    seqStart: firstSeq + index, seqEnd: firstSeq + index,
    sourceSeqRanges: [{ startSeq: firstSeq + index, endSeq: firstSeq + index }],
    turnId: name, collapsed: [],
  }));
}

function page(epoch, entries, extra = {}) {
  return { entries, epoch, endCursor: { epoch, seq: entries.at(-1).seqEnd },
    error: null, hasOlder: false, hasNewer: false, reset: false, staleCursor: false, gap: false,
    agent: { status: "idle", activeTurn: null }, ...extra };
}

function createHost() {
  const agents = Object.fromEntries(["agent-a", "agent-b"].map(id => [id, { status: "idle", updatedAt: "1" }]));
  const scripts = new Map(Object.keys(agents).map(id => [id, []]));
  const requests = [];
  const paseo = { agents: { ref(id) {
    assert.ok(scripts.has(id), `unknown synthetic agent ${id}`);
    return { timeline: { async refetch(options) {
      requests.push({ id, options: structuredClone(options) });
      const step = scripts.get(id).shift();
      assert.ok(step, `unexpected read for ${id}`);
      assert.deepEqual(options, step.request);
      if (step.failure) throw new Error("synthetic read failure");
      return structuredClone(step.response);
    } } };
  } } };
  return { agents, paseo, requests, enqueue(id, request, response) { scripts.get(id).push({ request, response }); },
    fail(id, request) { scripts.get(id).push({ request, failure: true }); },
    assertDrained() { for (const queue of scripts.values()) assert.equal(queue.length, 0); } };
}
const tail = () => ({ direction: "tail", limit: 0, projection: "canonical" });
const after = (epoch, seq) => ({ direction: "after", cursor: { epoch, seq }, limit: 0, projection: "canonical" });
module.exports = { turn, page, createHost, tail, after };
