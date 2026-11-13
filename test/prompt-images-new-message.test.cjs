const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const image = (id) => ({ id, thumbDataUri: `data:image/png;base64,${id}`, mime: "image/png", width: 8, height: 8 });

test("a newly sent image message retries the transient empty lookup until saving appears", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => {
      calls.push(1);
      if (calls.length === 1) return { images: [], total: 0, reason: null };
      if (calls.length === 2) return { images: [], total: 0, reason: null, saving: true };
      return { images: [image("img-new")], total: 1, reason: null };
    },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "New image",
    messageId: "new-msg",
    clientMessageId: "new-msg-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: true,
    tokens: h.tokens,
    timestamp: new Date("2026-01-01T12:00:00Z"),
    now: new Date("2026-01-01T12:00:00Z"),
  };
  const draw = () => h.draw({ type: UserMessage, props });
  draw();
  await settle();
  assert.equal(calls.length, 1, "the first lookup returns empty before the daemon records the prompt");
  await wait(900);
  await settle();
  const savingTree = draw();
  assert.ok(calls.length >= 2, "an empty result on a pending message is not cached");
  assert.match(h.text(savingTree), /Saving image/);
  await wait(2400);
  draw();
  await settle();
  const finalTree = draw();
  assert.equal(h.nodes(finalTree, (node) => node.props.testID === "prompt-pasted-thumb").length, 1, "the stored image appears without a manual refresh");
});
