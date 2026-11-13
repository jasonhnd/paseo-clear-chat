const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prompt = (fields = {}) => ({ type: "user_message", text: "Inspect the attachments.", ...fields });
const pasted = (id) => ({ id, thumbDataUri: `data:image/png;base64,${id}`, mime: "image/png", width: 80, height: 60 });
const timedOut = () => ({ images: [], total: 0, reason: "timeout" });
const empty = () => ({ images: [], total: 0, reason: null });

function harness(lookup) {
  const calls = [];
  const h = createToolHarness("web", {
    width: 820,
    height: 900,
    userMessage: true,
    promptImagesRpc: async (input) => {
      calls.push(input);
      return lookup(calls.length, input);
    },
  });
  return { h, calls };
}
const byId = (h, tree, id) => h.nodes(tree, (item) => item.props.testID === id)[0];
const thumbs = (h, tree) => h.nodes(tree, (item) => item.props.testID === "prompt-pasted-thumb");

test("pasted prompt images: a timeout is retried once automatically and a success is cached", async () => {
  const { h, calls } = harness((n) => n === 1 ? timedOut() : { images: [pasted("img-auto")], total: 1, reason: null });
  const fields = { messageId: "retry-auto", clientMessageId: "retry-auto-client" };
  const mounted = h.mount(prompt(fields));
  await settle();
  assert.equal(calls.length, 1);
  await wait(1200);
  const tree = mounted.render();
  assert.equal(calls.length, 2, "one automatic retry");
  assert.equal(thumbs(h, tree).length, 1);
  assert.equal(byId(h, tree, "prompt-pasted-retry"), undefined, "no retry row after recovery");
  h.mount(prompt(fields));
  await settle();
  assert.equal(calls.length, 2, "a real result is cached");
});

test("pasted prompt images: two timeouts show the retry row and the button asks again", async () => {
  const { h, calls } = harness((n) => n <= 2 ? timedOut() : { images: [pasted("img-click")], total: 1, reason: null });
  const mounted = h.mount(prompt({ messageId: "retry-two", clientMessageId: "retry-two-client" }));
  await settle();
  await wait(1200);
  let tree = mounted.render();
  assert.equal(calls.length, 2, "first lookup plus one automatic retry");
  assert.equal(thumbs(h, tree).length, 0);
  assert.ok(byId(h, tree, "prompt-pasted-retry"), "the retry row is rendered");
  assert.match(h.text(tree), /Images didn't load/);
  const button = byId(h, tree, "prompt-pasted-retry-button");
  assert.ok(button, "the retry button is rendered");
  assert.equal(button.props.accessibilityRole, "button");
  button.props.onPress();
  mounted.render();
  await settle();
  tree = mounted.render();
  assert.equal(calls.length, 3, "a timeout is not cached, so the row asks again");
  assert.equal(thumbs(h, tree).length, 1);
  assert.equal(byId(h, tree, "prompt-pasted-retry"), undefined);
});

test("pasted prompt images: a genuine empty result keeps today's count row and has no button", async () => {
  const { h, calls } = harness(() => empty());
  const mounted = h.mount(prompt({ messageId: "retry-empty", clientMessageId: "retry-empty-client", imageCount: 2 }));
  await settle();
  const tree = mounted.render();
  assert.equal(calls.length, 1);
  assert.equal(byId(h, tree, "prompt-pasted-retry"), undefined);
  assert.equal(byId(h, tree, "prompt-pasted-retry-button"), undefined);
  assert.match(h.text(tree), /2 images attached/);
});
