const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const image = (id) => ({ id, thumbDataUri: `data:image/png;base64,${id}`, mime: "image/png", width: 8, height: 8 });

function harness(rpc) {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async (input) => {
      calls.push(input);
      return rpc(calls.length);
    },
  });
  return { h, calls };
}
const byId = (h, tree, id) => h.nodes(tree, (node) => node.props.testID === id)[0];
const thumbs = (h, tree) => h.nodes(tree, (node) => node.props.testID === "prompt-pasted-thumb");

test("pasted prompt images: a pending save shows the hint, then the stored thumbnail", async () => {
  const { h, calls } = harness((n) => n === 1
    ? { images: [], total: 0, reason: null, saving: true }
    : { images: [image("img-stored")], total: 1, reason: null });
  const mounted = h.mount({ type: "user_message", text: "Attachments", messageId: "save-pending", clientMessageId: "save-pending-client", imageCount: 1 });
  await settle();
  let tree = mounted.render();
  assert.equal(calls.length, 1);
  assert.ok(byId(h, tree, "prompt-pasted-saving"), "the saving row is rendered");
  assert.match(h.text(tree), /Saving image/);
  await wait(2200);
  mounted.render();
  await settle();
  tree = mounted.render();
  assert.equal(calls.length, 2, "the row re-checks after two seconds");
  assert.equal(thumbs(h, tree).length, 1);
  assert.equal(byId(h, tree, "prompt-pasted-saving"), undefined);
});

test("pasted prompt images: a final save failure keeps the hint and has no button", async () => {
  const { h, calls } = harness(() => ({ images: [], total: 0, reason: null, saveFailed: true }));
  const mounted = h.mount({ type: "user_message", text: "Attachments", messageId: "save-failed", clientMessageId: "save-failed-client", imageCount: 1 });
  await settle();
  const tree = mounted.render();
  assert.equal(calls.length, 1);
  assert.ok(byId(h, tree, "prompt-pasted-save-failed"));
  assert.match(h.text(tree), /Image wasn't saved/);
  assert.equal(byId(h, tree, "prompt-pasted-retry"), undefined, "#489 retry row must not appear for a save failure");
});
