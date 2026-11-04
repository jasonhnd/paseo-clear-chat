const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const quote = "First line\n\n> existing quote\nLast line\n";

function setup(type, locale = "en", text = quote, options = {}) {
  const agent = { status: "idle", cwd: "/sample", workspaceId: "sample" };
  const sent = [], refs = [];
  let refreshedStatus = null;
  const handle = { refresh: async () => ({ agent: { status: refreshedStatus ?? agent.status } }), send: async text => { sent.push(text); } };
  const h = createToolHarness("web", { agent, locale, userMessage: true, replyFooter: true, ...options,
    paseo: { agents: { ref: id => { refs.push(id); return handle; } } } });
  const mounted = h.mount({ type, text }, false);
  return { h, mounted, agent, sent, refs, handle, setRefreshStatus: value => { refreshedStatus = value; } };
}

test("Markdown preview keeps the original bytes when sending", async t => {
  const original = "## Heading\r\n\r\n**Bold** and `inline code`\r\n";
  const { h, mounted, sent } = setup("assistant_message", "en", original, { markdown: true });
  t.after(() => h.unmount());
  byId(h, mounted.tree, "quote-action").props.onPress();
  let tree = mounted.render();
  const preview = byId(h, tree, "quote-original");
  const rendered = h.text(preview);
  assert.equal(rendered, "Heading\nBold\n and \ninline code");
  assert.equal(preview.props.style.borderLeftWidth, 2);
  for (const text of ["Heading", "Bold", "inline code"]) {
    assert.ok(h.nodes(preview, node => node.type === "Text" && node.props.selectable && h.text(node) === text).length, text);
  }
  byId(h, tree, "quote-reply-input").props.onChangeText("  Réponse\n");
  tree = mounted.render();
  await byId(h, tree, "quote-send").props.onPress();
  assert.deepEqual(Buffer.from(sent[0]), Buffer.from("> ## Heading\r\n> \r\n> **Bold** and `inline code`\r\n> \n\n  Réponse\n"));
});

test("tool-rendered final reply exposes quote action for the current agent", async t => {
  const sent = [], refs = [];
  const h = createToolHarness("web", { agent: { status: "idle" }, replyFooter: true,
    paseo: { agents: { ref: id => { refs.push(id); return {
      refresh: async () => ({ agent: { status: "idle" } }), send: async text => { sent.push(text); },
    }; } } } });
  t.after(() => h.unmount());
  const mounted = h.mount({ type: "tool_call", callId: "final-call", name: "wrap_up", status: "completed",
    error: null, detail: { type: "unknown", input: { text: quote }, output: "Acknowledged" } }, false);
  const footer = byId(h, byId(h, mounted.tree, "tool-final-reply"), "reply-footer");
  const action = byId(h, footer, "quote-action");
  assert.ok(action, "tool-rendered final reply footer must show the quote action");
  action.props.onPress();
  let tree = mounted.render();
  assert.equal(h.text(byId(h, tree, "quote-original")), quote);
  byId(h, tree, "quote-reply-input").props.onChangeText("Reply");
  tree = mounted.render();
  await byId(h, tree, "quote-send").props.onPress();
  assert.equal(refs.at(-1), "demo-agent");
  assert.deepEqual(sent, ["> First line\n> \n> > existing quote\n> Last line\n> \n\nReply"]);
});

test("quote preserves CRLF, CR, and LF line breaks", async () => {
  const original = "first\r\n\r\nsecond\rthird\nfourth\r\n";
  const { h, mounted, sent } = setup("assistant_message", "en", original);
  byId(h, mounted.tree, "quote-action").props.onPress();
  let tree = mounted.render();
  assert.equal(h.text(byId(h, tree, "quote-original")), original);
  byId(h, tree, "quote-reply-input").props.onChangeText("reply");
  tree = mounted.render();
  await byId(h, tree, "quote-send").props.onPress();
  assert.deepEqual(sent, ["> first\r\n> \r\n> second\r> third\n> fourth\r\n> \n\nreply"]);
  h.unmount();
});

test("does not send if the agent becomes busy after the first refresh", async () => {
  const { h, mounted, handle } = setup("assistant_message");
  let refreshes = 0, sends = 0, serverStatus = "idle";
  handle.refresh = async () => {
    if (++refreshes === 2) serverStatus = "running";
    return { agent: { status: serverStatus } };
  };
  handle.send = async () => { sends++; assert.notEqual(serverStatus, "running", "send would interrupt the running turn"); };
  byId(h, mounted.tree, "quote-action").props.onPress();
  let tree = mounted.render();
  byId(h, tree, "quote-reply-input").props.onChangeText("draft");
  tree = mounted.render();
  await byId(h, tree, "quote-send").props.onPress();
  tree = mounted.render();
  assert.equal(refreshes, 2);
  assert.equal(sends, 0);
  assert.equal(byId(h, tree, "quote-reply-input").props.value, "draft");
  assert.ok(h.text(tree).includes(require("../client/locales/en.json").quote.busy));
  assert.ok(h.text(tree).includes(require("../client/locales/en.json").quote.failed));
  h.unmount();
});

test("a long quote can be expanded and collapsed without losing the draft", () => {
  const original = "Long quote\n".repeat(100);
  const { h, mounted } = setup("assistant_message", "en", original);
  byId(h, mounted.tree, "quote-action").props.onPress();
  let tree = mounted.render();
  const preview = byId(h, tree, "quote-preview");
  assert.ok(preview, "the quote preview must be available to expand");
  const collapsedHeight = preview.props.style.maxHeight;
  preview.props.onContentSizeChange(300, 2000);
  tree = mounted.render();
  byId(h, tree, "quote-reply-input").props.onChangeText("draft");
  tree = mounted.render();
  const expand = byId(h, tree, "quote-expand");
  assert.ok(expand, "long quotes must have an expand control");
  assert.equal(expand.props.accessibilityLabel, require("../client/locales/en.json").quote.expand);
  assert.equal(expand.props.accessibilityState.expanded, false);
  expand.props.onPress();
  tree = mounted.render();
  assert.ok(byId(h, tree, "quote-preview").props.style.maxHeight > collapsedHeight);
  assert.equal(byId(h, tree, "quote-expand").props.accessibilityState.expanded, true);
  assert.equal(h.text(byId(h, tree, "quote-original")), original);
  assert.equal(byId(h, tree, "quote-reply-input").props.value, "draft");
  byId(h, tree, "quote-expand").props.onPress();
  tree = mounted.render();
  assert.equal(byId(h, tree, "quote-preview").props.style.maxHeight, collapsedHeight);
  byId(h, tree, "quote-cancel").props.onPress();
  byId(h, mounted.render(), "quote-action").props.onPress();
  assert.equal(byId(h, mounted.render(), "quote-preview").props.style.maxHeight, collapsedHeight);
  h.unmount();
});

for (const type of ["user_message", "assistant_message"]) {
  test(`${type}: quotes the entire message and sends the exact reply`, async () => {
    const { h, mounted, sent, refs } = setup(type);
    byId(h, mounted.tree, "quote-action").props.onPress();
    let tree = mounted.render();
    assert.equal(h.text(byId(h, tree, "quote-original")), quote);
    byId(h, tree, "quote-reply-input").props.onChangeText("  Reply\nsecond line  ");
    tree = mounted.render();
    await byId(h, tree, "quote-send").props.onPress();
    assert.deepEqual(sent, ["> First line\n> \n> > existing quote\n> Last line\n> \n\n  Reply\nsecond line  "]);
    assert.equal(refs.at(-1), "demo-agent");
    assert.equal(byId(h, mounted.render(), "quote-reply-input"), undefined);
    h.unmount();
  });

  test(`${type}: cancel closes the draft without sending`, () => {
    const { h, mounted, sent } = setup(type);
    byId(h, mounted.tree, "quote-action").props.onPress();
    let tree = mounted.render();
    byId(h, tree, "quote-reply-input").props.onChangeText("draft");
    tree = mounted.render();
    byId(h, tree, "quote-cancel").props.onPress();
    assert.equal(byId(h, mounted.render(), "quote-reply-input"), undefined);
    assert.deepEqual(sent, []);
    byId(h, mounted.render(), "quote-action").props.onPress();
    assert.equal(byId(h, mounted.render(), "quote-reply-input").props.value, "");
    h.unmount();
  });
}

test("busy and unavailable agents cannot open or send, including when status changes during a draft", async () => {
  const { h, mounted, agent, sent, setRefreshStatus } = setup("assistant_message");
  agent.status = "running";
  let tree = mounted.render();
  assert.equal(byId(h, tree, "quote-action").props.disabled, true);
  assert.equal(byId(h, tree, "quote-action").props.style.opacity, 0.5);
  byId(h, tree, "quote-action").props.onPress();
  assert.equal(byId(h, mounted.render(), "quote-reply-input"), undefined);
  agent.status = "idle";
  byId(h, mounted.render(), "quote-action").props.onPress();
  tree = mounted.render();
  byId(h, tree, "quote-reply-input").props.onChangeText("draft");
  agent.status = "running";
  tree = mounted.render();
  assert.equal(byId(h, tree, "quote-send").props.disabled, true);
  await byId(h, tree, "quote-send").props.onPress();
  assert.deepEqual(sent, []);
  agent.status = "idle";
  setRefreshStatus("running");
  await byId(h, mounted.render(), "quote-send").props.onPress();
  assert.deepEqual(sent, []);
  assert.equal(byId(h, mounted.render(), "quote-reply-input").props.value, "draft");
  agent.status = "closed";
  assert.equal(byId(h, mounted.render(), "quote-action").props.disabled, true);
  h.unmount();
});

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: quote window shows translated controls`, () => {
    const { h, mounted } = setup("assistant_message", locale);
    const words = require(`../client/locales/${locale}.json`).quote;
    assert.equal(h.text(byId(h, mounted.tree, "quote-action")), words.label);
    assert.equal(byId(h, mounted.tree, "quote-action").props.accessibilityLabel, words.action);
    const webElement = {};
    byId(h, mounted.tree, "quote-action").props.ref(webElement);
    assert.equal(webElement.title, words.action);
    byId(h, mounted.tree, "quote-action").props.onPress();
    const tree = mounted.render();
    assert.equal(byId(h, tree, "quote-reply-input").props.accessibilityLabel, words.reply);
    for (const word of [words.quoted, words.cancel, words.send]) assert.ok(h.text(tree).includes(word));
    byId(h, tree, "quote-preview").props.onContentSizeChange(300, 2000);
    let expandedTree = mounted.render();
    assert.equal(byId(h, expandedTree, "quote-expand").props.accessibilityLabel, words.expand);
    byId(h, expandedTree, "quote-expand").props.onPress();
    expandedTree = mounted.render();
    assert.equal(byId(h, expandedTree, "quote-expand").props.accessibilityLabel, words.collapse);
    h.unmount();
  });
}

for (const type of ["user_message", "assistant_message"]) {
  test(`${type}: copy precedes quote with matching controls`, () => {
    const { h, mounted } = setup(type);
    const user = type === "user_message";
    const resources = require("../client/locales/en.json");
    const controls = h.nodes(mounted.tree, node => node.type === "Pressable" &&
      [user ? resources.prompt.copyA11y : resources.reply.copyA11y, resources.quote.action].includes(node.props.accessibilityLabel));
    assert.deepEqual(controls.map(node => node.props.accessibilityLabel), [
      user ? resources.prompt.copyA11y : resources.reply.copyA11y, resources.quote.action,
    ]);
    const [copy, action] = controls;
    assert.equal(h.text(action), user ? "" : resources.quote.label);
    const copyIcon = h.nodes(copy, node => node.type === "Glyph")[0];
    const quoteIcon = h.nodes(action, node => node.type === "Glyph")[0];
    assert.equal(copyIcon.props.name, "Copy");
    assert.equal(quoteIcon.props.name, "Quote");
    assert.equal(quoteIcon.props.size, copyIcon.props.size);
    assert.equal(quoteIcon.props.color, copyIcon.props.color);
    if (user) {
      assert.equal(h.text(copy), "");
    } else {
      for (const key of ["flexDirection", "alignItems", "gap", "marginLeft", "paddingHorizontal", "paddingVertical", "borderRadius"]) {
        assert.equal(action.props.style[key], copy.props.style[key], key);
      }
      const copyLabel = h.nodes(copy, node => node.type === "Text")[0];
      const quoteLabel = h.nodes(action, node => node.type === "Text")[0];
      for (const key of ["fontFamily", "fontSize", "fontWeight", "color"]) {
        assert.equal(quoteLabel.props.style[key], copyLabel.props.style[key], key);
      }
    }
    h.unmount();
  });
}
