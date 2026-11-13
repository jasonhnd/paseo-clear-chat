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
  const mounted = h.mount(prompt({ messageId: "retry-two", clientMessageId: "retry-two-client", imageCount: 1 }));
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

test("pasted prompt images: unmounting during the retry wait does not send a second lookup", async () => {
  const { h, calls } = harness(() => timedOut());
  h.mount(prompt({ messageId: "retry-unmount", clientMessageId: "retry-unmount-client" }));
  await settle();
  assert.equal(calls.length, 1);
  h.unmount();
  await wait(1200);
  assert.equal(calls.length, 1, "an unmounted row does not run the delayed retry");
});

test("pasted prompt images: a pure text message shows nothing when its lookup times out", async () => {
  const { h, calls } = harness(() => timedOut());
  const mounted = h.mount(prompt({ messageId: "retry-text", clientMessageId: "retry-text-client", text: "Just text" }));
  await settle();
  await wait(1200);
  const tree = mounted.render();
  assert.equal(calls.length, 2, "the unknown-count lookup still runs and retries once");
  assert.equal(byId(h, tree, "prompt-pasted-retry"), undefined);
  assert.equal(byId(h, tree, "prompt-pasted-retry-button"), undefined);
  assert.match(h.text(tree), /Just text/);
});

test("pasted prompt images: a broken thumbnail shows the inline hint and keeps good thumbnails", async () => {
  const { h } = harness(() => ({ images: [pasted("img-good"), pasted("img-bad")], total: 2, reason: null }));
  const mounted = h.mount(prompt({ messageId: "retry-broken", clientMessageId: "retry-broken-client", imageCount: 2 }));
  await settle();
  let tree = mounted.render();
  assert.equal(thumbs(h, tree).length, 2);
  const brokenThumb = thumbs(h, tree)[1];
  h.nodes(brokenThumb, (item) => item.type === "Image")[0].props.onError();
  tree = mounted.render();
  assert.equal(thumbs(h, tree).length, 1, "the good image is still a thumbnail");
  assert.equal(byId(h, tree, "prompt-pasted-broken") !== undefined, true, "the broken image is replaced in place");
  assert.match(h.text(tree), /This image can't be displayed/);
  assert.equal(byId(h, tree, "prompt-pasted-retry"), undefined, "a broken image has no retry button");
});

test("pasted prompt images: a host count of 0 still queries and shows store images", async () => {
  const { h, calls } = harness(() => ({ images: [pasted("img-zero")], total: 1, reason: null }));
  const mounted = h.mount(prompt({ messageId: "count-zero", clientMessageId: "count-zero-client", imageCount: 0 }));
  await settle();
  const tree = mounted.render();
  assert.equal(calls.length, 1, "every message is still looked up");
  assert.equal(thumbs(h, tree).length, 1, "the stored image is shown even when the host count is 0");
});

test("pasted prompt images: attachmentCount 0 with hasStored true shows the retry row", async () => {
  const { h, calls } = harness(() => ({ images: [], total: 0, reason: "timeout", hasStored: true }));
  const mounted = h.mount(prompt({ messageId: "stored-timeout", clientMessageId: "stored-timeout-client", text: "Pasted with no count" }));
  await settle();
  await wait(1200);
  const tree = mounted.render();
  assert.equal(calls.length, 2, "initial lookup plus one automatic retry");
  assert.ok(byId(h, tree, "prompt-pasted-retry"), "the stored image is worth another attempt");
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
