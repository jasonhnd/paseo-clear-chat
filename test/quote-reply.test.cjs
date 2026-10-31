const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const quote = "First line\n\n> existing quote\nLast line\n";

function setup(type, locale = "en") {
  const agent = { status: "idle", cwd: "/sample", workspaceId: "sample" };
  const sent = [], refs = [];
  let refreshedStatus = null;
  const handle = { refresh: async () => ({ agent: { status: refreshedStatus ?? agent.status } }), send: async text => { sent.push(text); } };
  const h = createToolHarness("web", { agent, locale, userMessage: true, replyFooter: true,
    paseo: { agents: { ref: id => { refs.push(id); return handle; } } } });
  const mounted = h.mount({ type, text: quote }, false);
  return { h, mounted, agent, sent, refs, setRefreshStatus: value => { refreshedStatus = value; } };
}

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
    assert.equal(byId(h, mounted.tree, "quote-action").props.accessibilityLabel, words.action);
    byId(h, mounted.tree, "quote-action").props.onPress();
    const tree = mounted.render();
    assert.equal(byId(h, tree, "quote-reply-input").props.accessibilityLabel, words.reply);
    for (const word of [words.quoted, words.cancel, words.send]) assert.ok(h.text(tree).includes(word));
    h.unmount();
  });
}
