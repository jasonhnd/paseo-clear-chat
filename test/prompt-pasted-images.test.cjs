const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const prompt = (fields = {}) => ({
  type: "user_message",
  text: "Inspect the attachments.",
  messageId: "sample-prompt",
  clientMessageId: "sample-client",
  ...fields,
});
const pasted = (id, width, height) => ({
  id,
  thumbDataUri: `data:image/png;base64,${id}`,
  mime: "image/png",
  width,
  height,
});
const five = [
  pasted("img-0", 800, 50),
  pasted("img-1", 40, 200),
  pasted("img-2", 100, 100),
  pasted("img-3", 64, 64),
  pasted("img-4", 30, 40),
];
const style = (value) => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
const thumbs = (h, tree) => h.nodes(tree, (node) => node.props.testID === "prompt-pasted-thumb");
const bubbleBody = (h, tree) => h.nodes(tree, (node) => node.props.testID === "prompt-bubble-body")[0];
const measure = (node, width) => node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 48 } } });

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const props = {};
  for (const [key, child] of Object.entries(value.props ?? {})) {
    if (typeof child === "function") continue;
    props[key] = key === "children" ? sanitize(child) : child;
  }
  return { type: typeof value.type === "string" ? value.type : value.type?.name ?? "component", props };
}

function harness(width, promptImagesRpc, promptImageRpc, platform = "web") {
  const calls = [];
  const full = [];
  const h = createToolHarness(platform, {
    width,
    height: 900,
    userMessage: true,
    promptImagesRpc: async (input) => {
      calls.push(input);
      return promptImagesRpc(input);
    },
    promptImageRpc: async (input) => {
      full.push(input);
      return promptImageRpc ? promptImageRpc(input) : { dataUri: null, mime: null, width: null, height: null, bytes: null, error: null };
    },
  });
  return { h, calls, full };
}

test("pasted prompt images: 0, 1 and 5 results, including the +2 chip", async () => {
  const none = harness(1440, async () => ({ images: [], total: 0, reason: null }));
  const emptyMounted = none.h.mount(prompt());
  const emptyBefore = sanitize(emptyMounted.tree);
  await settle();
  const emptyTree = emptyMounted.render();
  assert.deepEqual(sanitize(emptyTree), emptyBefore);
  assert.equal(thumbs(none.h, emptyTree).length, 0);
  assert.doesNotMatch(none.h.text(emptyTree), /\+\d|Pasted image|secret|error/i);
  assert.match(none.h.text(emptyTree), /Inspect the attachments\./);

  const one = harness(820, async () => ({ images: [five[0]], total: 1, reason: null }));
  const oneMounted = one.h.mount(prompt());
  await settle();
  const oneTree = oneMounted.render();
  assert.equal(thumbs(one.h, oneTree).length, 1);
  assert.equal(one.h.nodes(oneTree, (node) => node.props.testID === "prompt-pasted-more").length, 0);
  assert.equal(one.h.nodes(oneTree, (node) => node.props.accessibilityLabel === "Pasted image" && node.type === "Pressable").length, 1);

  const many = harness(390, async () => ({ images: five, total: 5, reason: null }));
  const manyMounted = many.h.mount(prompt());
  await settle();
  const manyTree = manyMounted.render();
  assert.equal(thumbs(many.h, manyTree).length, 3);
  assert.equal(many.h.nodes(manyTree, (node) => node.props.testID === "prompt-pasted-more").length, 1);
  assert.match(many.h.text(manyTree), /\+2/);
  assert.equal(many.calls[0].agentId, "demo-agent");
  assert.equal(many.calls[0].messageId, "sample-prompt");
  assert.equal(many.calls[0].clientMessageId, "sample-client");
  assert.equal(many.calls[0].text, "Inspect the attachments.");
  assert.equal(many.calls.length, 1);
  manyMounted.render();
  assert.equal(many.calls.length, 1, "a later render does not ask again");
  many.h.mount(prompt());
  await settle();
  assert.equal(many.calls.length, 1, "the same agent and message stay cached");
});

test("pasted prompt images: a failed lookup leaves today's bubble unchanged", async () => {
  const { h } = harness(1440, async () => {
    throw new Error("secret daemon path /tmp/hidden");
  });
  const mounted = h.mount(prompt());
  const before = sanitize(mounted.tree);
  await settle();
  const tree = mounted.render();
  assert.deepEqual(sanitize(tree), before);
  assert.equal(thumbs(h, tree).length, 0);
  assert.doesNotMatch(h.text(tree), /secret|hidden|error|Pasted image|\+\d/);
  assert.match(h.text(tree), /Inspect the attachments\./);
});

test("pasted prompt images: a text-only message does not change while the lookup is in flight", async () => {
  let finish = () => {};
  const { h } = harness(1440, () => new Promise((resolve) => {
    finish = () => resolve({ images: [], total: 0, reason: null });
  }));
  const mounted = h.mount(prompt({ text: "Nothing attached.", images: undefined }));
  const before = sanitize(mounted.tree);
  await settle();
  assert.deepEqual(sanitize(mounted.render()), before);
  assert.equal(thumbs(h, mounted.tree).length, 0);
  assert.doesNotMatch(h.text(mounted.tree), /image attached|Pasted image|\+\d/);
  finish();
  await settle();
  assert.deepEqual(sanitize(mounted.render()), before);
});

test("pasted prompt images: the viewer opens, loads the full image, and closes", async () => {
  const listeners = new Set();
  const previous = globalThis.document;
  globalThis.document = {
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
    activeElement: null,
  };
  try {
    const { h, full } = harness(820, async () => ({ images: five, total: 5, reason: null }), async () => ({
      dataUri: "data:image/png;base64,FULL",
      mime: "image/png",
      width: 800,
      height: 50,
      bytes: 12,
      error: null,
    }));
    const mounted = h.mount(prompt());
    await settle();
    const tree = mounted.render();
    assert.equal(full.length, 0);
    thumbs(h, tree)[0].props.onPress();
    const opening = mounted.render();
    assert.equal(h.nodes(opening, (node) => node.type === "Native.Modal").length, 1);
    assert.equal(full.length, 1);
    assert.equal(full[0].id, "img-0");
    assert.equal(full[0].agentId, "demo-agent");
    await settle();
    const open = mounted.render();
    assert.equal(h.nodes(open, (node) => node.props.testID === "prompt-image-full")[0].props.source.uri, "data:image/png;base64,FULL");
    h.nodes(open, (node) => node.props.accessibilityLabel === "Close image")[0].props.onPress();
    assert.equal(h.nodes(mounted.render(), (node) => node.type === "Native.Modal").length, 0);

    thumbs(h, mounted.render())[0].props.onPress();
    const again = mounted.render();
    assert.equal(listeners.size, 1);
    for (const listener of listeners) {
      listener({
        key: "Escape",
        defaultPrevented: false,
        isComposing: false,
        repeat: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault() {},
        stopPropagation() {},
      });
    }
    assert.equal(h.nodes(again, (node) => node.type === "Native.Modal").length, 1);
    assert.equal(h.nodes(mounted.render(), (node) => node.type === "Native.Modal").length, 0);
    again.props?.onRequestClose?.();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("pasted prompt thumbnails stay inside the bubble at 1440, 820 and 390", async () => {
  for (const width of [1440, 820, 390]) {
    // Narrower than the window, as when the bubble's parent is inset.
    const inset = Math.max(160, Math.floor(width * 0.42));
    const { h } = harness(width, async () => ({ images: five, total: 5, reason: null }));
    const mounted = h.mount(prompt({ messageId: `width-${width}` }));
    await settle();
    measure(bubbleBody(h, mounted.render()), inset);
    const tree = mounted.render();
    const row = thumbs(h, tree);
    const chip = h.nodes(tree, (node) => node.props.testID === "prompt-pasted-more")[0];
    assert.equal(row.length, 3);
    let used = 0;
    for (const node of row) {
      const frame = style(node.props.style);
      assert.ok(frame.width > 1 && frame.width <= inset, `${width} thumb width ${frame.width} inset ${inset}`);
      assert.ok(frame.height > 0 && frame.height <= 96, `${width} thumb height ${frame.height}`);
      used += frame.width;
    }
    const chipFrame = style(chip.props.style);
    used += chipFrame.width + 6 * 3;
    assert.ok(used <= inset + 1, `${width} row uses ${used} of ${inset}`);
    assert.equal(chipFrame.width, 44);

    const panoramic = harness(width, async () => ({ images: [pasted("pano", 8000, 40)], total: 1, reason: null }));
    const wide = panoramic.h.mount(prompt({ messageId: `pano-${width}`, text: "Wide" }));
    await settle();
    measure(bubbleBody(panoramic.h, wide.render()), inset);
    const frame = style(thumbs(panoramic.h, wide.render())[0].props.style);
    assert.equal(frame.width, inset, `${width} panoramic uses the measured content width`);
    assert.ok(frame.height > 0 && frame.height <= 96);
  }
});

test("a reused prompt row hides the previous thumbnails while the next lookup is pending", async () => {
  let release = () => {};
  const { h } = harness(820, (input) => {
    if (input.messageId === "prompt-b") {
      return new Promise((resolve) => {
        release = () => resolve({ images: [five[0]], total: 1, reason: null });
      });
    }
    return Promise.resolve({ images: [five[0]], total: 1, reason: null });
  });
  const mounted = h.mount(prompt({ messageId: "prompt-a", clientMessageId: "client-a", text: "Alpha" }));
  await settle();
  const first = mounted.render();
  assert.equal(thumbs(h, first).length, 1);
  h.nodes(thumbs(h, first)[0], (node) => node.type === "Image")[0].props.onError();
  thumbs(h, first)[0].props.onPress();
  assert.equal(h.nodes(mounted.render(), (node) => node.type === "Native.Modal").length, 1);
  const beta = { text: "Beta", messageId: "prompt-b", clientMessageId: "client-b" };
  const pending = mounted.render(beta);
  assert.equal(thumbs(h, pending).length, 0);
  assert.equal(h.nodes(pending, (node) => node.type === "Native.Modal").length, 0);
  assert.match(h.text(pending), /Beta/);
  assert.doesNotMatch(h.text(pending), /Pasted image|\+\d/);
  await settle();
  assert.equal(thumbs(h, mounted.render(beta)).length, 0);
  release();
  await settle();
  assert.equal(thumbs(h, mounted.render(beta)).length, 1, "the new message's thumbnail is not stuck on the previous failure");
});

test("a reused prompt row drops the previous thumbnails when the next lookup is empty or fails", async () => {
  for (const outcome of ["empty", "error"]) {
    const { h } = harness(820, (input) => {
      if (input.messageId === "prompt-b") {
        if (outcome === "error") return Promise.reject(new Error("secret lookup"));
        return Promise.resolve({ images: [], total: 0, reason: null });
      }
      return Promise.resolve({ images: [five[0]], total: 1, reason: null });
    });
    const mounted = h.mount(prompt({ messageId: "prompt-a", text: "Alpha" }));
    await settle();
    assert.equal(thumbs(h, mounted.render()).length, 1);
    const beta = { text: "Beta", messageId: "prompt-b", clientMessageId: "client-b" };
    const next = mounted.render(beta);
    assert.equal(thumbs(h, next).length, 0, outcome);
    await settle();
    const settled = mounted.render(beta);
    assert.equal(thumbs(h, settled).length, 0, outcome);
    assert.doesNotMatch(h.text(settled), /secret|Pasted image|\+\d/);
    assert.match(h.text(settled), /Beta/);
  }
});

test("identical prompts without ids ask once and neither shows thumbnails", async () => {
  const { h, calls } = harness(820, async () => ({ images: [], total: 0, reason: null }));
  const fields = { text: "Same prompt", messageId: undefined, clientMessageId: undefined };
  const first = h.mount(prompt(fields));
  await settle();
  assert.equal(thumbs(h, first.render()).length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messageId, null);
  assert.equal(calls[0].clientMessageId, null);
  assert.equal(calls[0].text, "Same prompt");
  const second = h.mount(prompt(fields));
  await settle();
  assert.equal(thumbs(h, second.render()).length, 0);
  assert.equal(calls.length, 1, "a text-only key is asked once");
});

test("the transformer forwards message ids and the renderer supplies agentId", () => {
  const h = createToolHarness("ios", { userMessage: true });
  const transformed = h.transformers.get("user_message").transform({
    item: { type: "user_message", text: "Hi", messageId: "provider-id", clientMessageId: "composer-id" },
  });
  assert.deepEqual(transformed.items[0].data, {
    text: "Hi",
    messageId: "provider-id",
    clientMessageId: "composer-id",
  });
  assert.equal(h.renderers.get("omp-user-message").schema.safeParse(transformed.items[0].data).success, true);
  assert.equal("agentId" in transformed.items[0].data, false);
});
