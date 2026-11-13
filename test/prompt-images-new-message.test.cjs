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
  assert.ok(calls.length === 2 || calls.length === 3,
    `an empty result on a pending message is not cached (calls=${calls.length})`);
  assert.match(h.text(savingTree), /Saving image/);
  await wait(2400);
  draw();
  await settle();
  const finalTree = draw();
  assert.equal(h.nodes(finalTree, (node) => node.props.testID === "prompt-pasted-thumb").length, 1, "the stored image appears without a manual refresh");
});

test("an old message caches its empty lookup after one call", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => { calls.push(1); return { images: [], total: 0, reason: null }; },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "Old message",
    messageId: "old-msg",
    clientMessageId: "old-msg-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: false,
    tokens: h.tokens,
    timestamp: new Date("2020-01-01T00:00:00Z"),
    now: new Date("2026-01-01T12:00:00Z"),
  };
  const draw = () => h.draw({ type: UserMessage, props });
  draw();
  await settle();
  await wait(1200);
  draw();
  await settle();
  assert.equal(calls.length, 1, "a historical message does not poll");
});

test("a new text-only message stops after the bounded retries without a saving row", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => { calls.push(1); return { images: [], total: 0, reason: null }; },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "Just text",
    messageId: "new-text",
    clientMessageId: "new-text-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: true,
    tokens: h.tokens,
    timestamp: new Date(),
    now: new Date(),
  };
  const draw = () => h.draw({ type: UserMessage, props });
  draw();
  await settle();
  await wait(4500);
  await settle();
  const tree = draw();
  assert.equal(calls.length, 6, "one lookup plus five bounded retries");
  assert.equal(h.nodes(tree, (node) => node.props.testID === "prompt-pasted-saving").length, 0);
  assert.doesNotMatch(h.text(tree), /Saving image/);
});

test("a recent message retries when pending is false (15s window)", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => { calls.push(1); return { images: [], total: 0, reason: null }; },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "Just text",
    messageId: "recent-msg",
    clientMessageId: "recent-msg-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: false,
    tokens: h.tokens,
    timestamp: new Date(),
    now: new Date(),
  };
  const draw = () => h.draw({ type: UserMessage, props });
  draw();
  await settle();
  await wait(4500);
  await settle();
  const tree = draw();
  assert.equal(calls.length, 6, "a message inside the 15s window gets one lookup plus five retries");
  assert.doesNotMatch(h.text(tree), /Saving image/);
});

test("an unmounted message stops the bounded retries", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => { calls.push(1); return { images: [], total: 0, reason: null }; },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "Unmounted text",
    messageId: "unmount-msg",
    clientMessageId: "unmount-msg-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: true,
    tokens: h.tokens,
    timestamp: new Date(),
    now: new Date(),
  };
  h.draw({ type: UserMessage, props });
  await settle();
  assert.equal(calls.length, 1, "the first lookup has run before the row unmounts");
  h.unmount();
  await wait(2600);
  assert.equal(calls.length, 1, "an unmounted row does not keep querying");
});

test("a message whose timestamp is in the future does not retry", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => { calls.push(1); return { images: [], total: 0, reason: null }; },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "Future text",
    messageId: "future-msg",
    clientMessageId: "future-msg-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: false,
    tokens: h.tokens,
    timestamp: new Date(Date.now() + 60_000),
    now: new Date(),
  };
  h.draw({ type: UserMessage, props });
  await settle();
  await wait(1200);
  h.draw({ type: UserMessage, props });
  await settle();
  assert.equal(calls.length, 1, "a future timestamp is outside the retry window");
});

test("an old message does not retry when pending is false", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async () => { calls.push(1); return { images: [], total: 0, reason: null }; },
  });
  const { UserMessage } = h.load("client/components/user-message.tsx");
  const props = {
    text: "Old message",
    messageId: "old-msg-window",
    clientMessageId: "old-msg-window-client",
    agentId: "demo-agent",
    hostId: "demo-host",
    pending: false,
    tokens: h.tokens,
    timestamp: new Date("2020-01-01T00:00:00Z"),
    now: new Date("2026-01-01T12:00:00Z"),
  };
  const draw = () => h.draw({ type: UserMessage, props });
  draw();
  await settle();
  await wait(4500);
  await settle();
  draw();
  assert.equal(calls.length, 1, "a message older than the 15s window keeps its empty result");
});
