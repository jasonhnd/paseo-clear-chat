const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("pasted prompt images: a save failure shows the inline hint and no retry row", async () => {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async (input) => {
      calls.push(input);
      return { images: [], total: 0, reason: null, saveFailure: { reason: "image_lock_timeout", attempts: 4 } };
    },
  });
  const mounted = h.mount({ type: "user_message", text: "Inspect the attachments.", messageId: "save-failed", clientMessageId: "save-failed-client", imageCount: 1 });
  await settle();
  const tree = mounted.render();
  assert.equal(calls.length, 1, "a recorded save failure is definitive and is not looked up again");
  assert.equal(h.nodes(tree, (node) => node.props.testID === "prompt-pasted-save-failed").length, 1);
  assert.match(h.text(tree), /Image wasn't saved/);
  assert.equal(h.nodes(tree, (node) => node.props.testID === "prompt-pasted-retry").length, 0, "#489 retry row must not appear for a save failure");
});
