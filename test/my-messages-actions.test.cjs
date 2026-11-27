const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const at = new Date(2026, 2, 15, 9).getTime();
const exactText = "  first line\r\n\r\nlast line  \r\n";
const quotedText = ">   first line\n>\n> last line  \n\n";
const copiedQuoteToast = "Can't insert into this conversation — quote copied";
const destination = { agentId: "target", serverId: "screen-host" };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const {
    platform = "web", locale = "en", text = exactText, composers,
    navigation, copyFails = false, archived = false,
  } = options;
  const events = [];
  const directory = [
    { id: "other", title: "Other conversation", updatedAt: new Date(at + 1000).toISOString() },
    { id: "target", title: "Target conversation", updatedAt: new Date(at).toISOString(),
      ...(archived ? { archivedAt: new Date(at + 2000).toISOString() } : {}) },
  ];
  const paseo = { agents: {
    async list({ filter }) {
      return {
        entries: directory.filter(agent => !agent.archivedAt || filter.includeArchived)
          .map(agent => ({ agent: { ...agent, lastUserMessageAt: agent.updatedAt } })),
        pageInfo: { hasMore: false },
      };
    },
    ref(id) {
      const agent = directory.find(agent => agent.id === id);
      assert.ok(agent, `Unexpected history request for ${id}`);
      return { timeline: {
        async refetch() {
          return { hasOlder: false, entries: [{
            timestamp: agent.updatedAt, seqStart: 1,
            item: { type: "user_message", text: id === "target" ? text : "another message" },
          }] };
        },
      } };
    },
  } };
  const h = createToolHarness(platform, {
    width: 390, locale, paseo, composers: () => [],
    preferences: { showAnswerCard: false },
    copyText(value) {
      events.push(["clipboard", value]);
      if (copyFails) throw new Error("Clipboard unavailable");
    },
  });
  h.load("client/my-messages-clock.ts").setMyMessagesClock(() => at);
  t.after(() => { h.unmount(); h.dispose(); });
  const props = {
    theme: { colors: {} },
    layout: { platform, compact: true },
    host: { id: "screen-host", label: "Host" },
    params: {},
    navigation: Object.hasOwn(options, "navigation") ? navigation : {
      openAgent(input) { events.push(["open", input]); },
    },
  };
  let Component;
  const host = composers ? { composers(selector) { events.push(["composers", selector]); return composers(selector); } } : {};
  const stop = h.load("client/my-messages-screen-registration.tsx").registerMyMessagesScreen({
    ...host,
    addScreen(screen) { Component = screen.Component; return () => {}; },
    addSidebarHeaderItem: () => () => {},
  });
  t.after(stop);
  const draw = () => h.draw({ type: Component, props });
  draw();
  await settle();
  const tree = draw();
  const elements = id => h.nodes(tree, n => n.props.testID === id);
  const rows = elements("my-messages-screen-row");
  assert.equal(rows.length, 2);
  assert.equal(elements("my-message-copy").length, rows.length);
  assert.equal(elements("my-message-quote").length, rows.length);
  const index = rows.length - 1;
  return { h, tree, events, row: rows[index], copy: elements("my-message-copy")[index], quote: elements("my-message-quote")[index] };
}

function pathTo(tree, target) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const path = pathTo(child, target);
      if (path) return path;
    }
  } else if (tree && typeof tree === "object") {
    if (tree === target) return [tree];
    const children = pathTo(tree.props?.children, target);
    if (children) return [tree, ...children];
  }
  return null;
}

function pressButton(tree, button, row) {
  const path = pathTo(tree, button);
  assert.ok(path);
  // A web click bubbles through ancestors, and a native Pressable must not be nested
  // in the row responder. Neither can reach the row when the controls are siblings.
  assert.ok(!path.includes(row), "the action must be outside the row Pressable");
  assert.ok(path.slice(0, -1).every(node => !node.props.onPress), "no ancestor may handle the button press");
  button.props.onPress();
}

test("screen row opens the selected agent on the screen host without copying", async t => {
  const { h, events, row } = await fixture(t);
  assert.match(row.props.accessibilityLabel, /Target conversation/);
  assert.equal(row.props.accessibilityHint, "Opens the conversation");
  row.props.onPress();
  await settle();
  assert.deepEqual(events, [["open", destination]]);
  assert.deepEqual(h.copies, []);
  assert.deepEqual(h.toasts, []);
});

test("screen row copies and toasts when navigation or openAgent is missing", async t => {
  for (const navigation of [undefined, {}]) {
    const { h, row } = await fixture(t, { navigation });
    assert.equal(row.props.accessibilityHint, undefined);
    row.props.onPress();
    await settle();
    assert.deepEqual(h.copies, [exactText]);
    assert.deepEqual(h.toasts, ["Copied"]);
  }
});

for (const platform of ["web", "ios", "android"]) {
  test(`screen Copy and Quote buttons do not trigger the row press on ${platform} at 390 px`, async t => {
    const inserts = [];
    const f = await fixture(t, { platform, composers: () => [{
      async focus() {},
      insertText: value => inserts.push(value),
    }] });
    pressButton(f.tree, f.copy, f.row);
    await settle();
    assert.deepEqual(f.events, [["clipboard", exactText]]);
    assert.deepEqual(f.h.toasts, ["Copied"]);
    pressButton(f.tree, f.quote, f.row);
    await settle();
    assert.deepEqual(f.events, [["clipboard", exactText], ["composers", { agentId: "target" }], ["composers", { agentId: "target" }]]);
    assert.deepEqual(f.h.toasts, ["Copied"], "inserting a quote does not copy or toast");
    assert.equal(inserts.length, 1);
  });
}

test("screen Quote waits for the selected composer's focus before inserting at the cursor", async t => {
  let resolveFocus;
  const focus = new Promise(resolve => { resolveFocus = resolve; });
  const calls = [];
  const { h, events, quote } = await fixture(t, { composers: ({ agentId }) => [{
    focus() { calls.push(["focus", agentId]); return focus; },
    insertText(value) { calls.push(["insert", agentId, value]); },
  }] });
  quote.props.onPress();
  await settle();
  assert.deepEqual(events, [["composers", { agentId: "target" }]]);
  assert.deepEqual(calls, [["focus", "target"]], "must not insert while focus is pending");
  resolveFocus();
  await settle();
  assert.deepEqual(calls, [["focus", "target"], ["insert", "target", quotedText]]);
  assert.deepEqual(h.copies, []);
  assert.deepEqual(h.toasts, []);
});

test("Quote prefixes every line and adds one blank line after the quote", async t => {
  for (const [text, expected] of [
    ["line1\nline2", "> line1\n> line2\n\n"],
    ["line1\n\nline2", "> line1\n>\n> line2\n\n"],
    ["line1\n", "> line1\n\n"],
    ["\n\nline1\n  \nline2\n\n", "> line1\n>\n> line2\n\n"],
    [exactText, quotedText],
  ]) {
    const { h, quote } = await fixture(t, { text });
    quote.props.onPress();
    await settle();
    assert.deepEqual(h.copies, [expected]);
    assert.deepEqual(h.toasts, [copiedQuoteToast]);
  }
});

test("screen Quote opens an archived conversation before copying when no composer resolves", async t => {
  const { h, events, quote } = await fixture(t, { archived: true, composers: () => [] });
  quote.props.onPress();
  await settle();
  assert.deepEqual(events, [["composers", { agentId: "target" }], ["open", destination], ["clipboard", quotedText]]);
  assert.deepEqual(h.toasts, [copiedQuoteToast]);
});

test("screen Quote opens the conversation and copies when focus rejects", async t => {
  const calls = [];
  const { h, events, quote } = await fixture(t, { composers: () => [{
    async focus() { calls.push("focus"); throw new Error("Focus unavailable"); },
    insertText() { calls.push("insert"); },
  }] });
  quote.props.onPress();
  await settle();
  assert.deepEqual(calls, ["focus"]);
  assert.deepEqual(events, [["composers", { agentId: "target" }], ["open", destination], ["clipboard", quotedText]]);
  assert.deepEqual(h.toasts, [copiedQuoteToast]);
});

test("screen Quote copies on an older host and still copies if navigation throws", async t => {
  let navigationAttempts = 0;
  for (const navigation of [undefined, { openAgent() { navigationAttempts++; throw new Error("Cannot open"); } }]) {
    const { h, events, quote } = await fixture(t, { navigation });
    quote.props.onPress();
    await settle();
    assert.deepEqual(events, [["clipboard", quotedText]]);
    assert.deepEqual(h.toasts, [copiedQuoteToast]);
  }
  assert.equal(navigationAttempts, 1);
});

test("Quote keeps a blank line between an existing draft and the inserted quote", async t => {
  const note = "> note\n\n";
  const cases = [
    ["", note],
    ["DRAFT-KEEP", `\n\n${note}`],
    ["DRAFT-KEEP\n", `\n${note}`],
    ["DRAFT-KEEP\n\n", note],
  ];
  for (const [prompt, expected] of cases) {
    const inserted = [];
    const { quote } = await fixture(t, {
      text: "note",
      composers: () => [{
        prompt,
        async focus() {},
        insertText(value) { inserted.push(value); },
      }],
    });
    quote.props.onPress();
    await settle();
    assert.equal(inserted.at(-1), expected, `draft ${JSON.stringify(prompt)}`);
  }
});

test("Quote reads a cursor when the composer exposes one", async t => {
  const note = "> note\n\n";
  const inserted = [];
  const { quote } = await fixture(t, {
    text: "note",
    composers: () => [{
      prompt: "DRAFT-KEEP\n\n",
      selection: { start: "DRAFT-KEEP".length, end: "DRAFT-KEEP".length },
      async focus() {},
      insertText(value) { inserted.push(value); },
    }],
  });
  quote.props.onPress();
  await settle();
  assert.equal(inserted.at(-1), `\n\n${note}`, "the gap follows the character before the cursor");
});

test("Copy uses the existing no-text and clipboard-failed feedback", async t => {
  const image = await fixture(t, { text: "  " });
  image.copy.props.onPress();
  await settle();
  assert.deepEqual(image.h.copies, []);
  assert.deepEqual(image.h.toasts, ["This message has no text to copy"]);

  const failed = await fixture(t, { copyFails: true });
  failed.copy.props.onPress();
  await settle();
  assert.deepEqual(failed.h.copies, [exactText]);
  assert.deepEqual(failed.h.toasts, ["Could not copy this message"]);
});

test("Quote fallback reports a clipboard failure without claiming the quote was copied", async t => {
  const { h, events, quote } = await fixture(t, { copyFails: true });
  quote.props.onPress();
  await settle();
  assert.deepEqual(events, [["open", destination], ["clipboard", quotedText]]);
  assert.deepEqual(h.toasts, ["Could not copy this message"]);
});

test("all three locales define action labels, accessibility text and the quote fallback toast", async t => {
  for (const [locale, [copyLabel, quoteLabel]] of Object.entries({
    en: ["Copy", "Quote"], "zh-CN": ["复制", "引用"], ja: ["コピー", "引用"],
  })) {
    const { myMessages } = require(`../client/locales/${locale}.json`);
    for (const key of ["copy", "quote", "screenOpenHint", "quoteCopied"]) {
      assert.ok(myMessages[key]?.trim(), `${locale} is missing myMessages.${key}`);
    }
    const { h, row, copy, quote } = await fixture(t, { locale });
    assert.equal(h.text(copy), copyLabel);
    assert.equal(copy.props.accessibilityLabel, copyLabel);
    assert.equal(h.text(quote), quoteLabel);
    assert.equal(quote.props.accessibilityLabel, quoteLabel);
    assert.equal(row.props.accessibilityHint, myMessages.screenOpenHint);
    quote.props.onPress();
    await settle();
    assert.deepEqual(h.toasts, [myMessages.quoteCopied]);
  }
});

test("Quote on a message without text says so and inserts or copies nothing", async t => {
  const calls = [];
  const { h, events, quote } = await fixture(t, { text: "   ", composers: () => [{
    async focus() { calls.push("focus"); },
    insertText(value) { calls.push(["insert", value]); },
  }] });
  quote.props.onPress();
  await settle();
  assert.deepEqual(calls, [], "no focus or insert for an empty message");
  assert.deepEqual(events.filter(event => event[0] !== "composers"), [], "no navigation or clipboard");
  assert.deepEqual(h.copies, []);
  assert.deepEqual(h.toasts, ["This message has no text to quote"]);
});

test("Quote inserts into the composer the host reports after focus", async t => {
  const calls = [];
  let generation = 0;
  const { h, quote } = await fixture(t, { composers: ({ agentId }) => {
    const handle = ++generation;
    return [{
      async focus() { calls.push(["focus", agentId, handle]); },
      insertText(value) { calls.push(["insert", agentId, handle, value]); },
    }];
  } });
  quote.props.onPress();
  await settle();
  assert.deepEqual(calls, [["focus", "target", 1], ["insert", "target", 2, quotedText]]);
  assert.deepEqual(h.copies, []);
});

test("Quote stays fast for a message with many CRLF line breaks", async t => {
  // Line breaks between two text lines are the shape that makes a nested-quantifier
  // trim backtrack; a run at the very end does not.
  const text = "p1" + "\r\n".repeat(26) + "p2" + "\r\n".repeat(26);
  const { h, quote } = await fixture(t, { text });
  const started = Date.now();
  quote.props.onPress();
  await settle();
  const elapsed = Date.now() - started;
  assert.deepEqual(h.copies, ["> p1\n" + ">\n".repeat(25) + "> p2\n\n"]);
  assert.ok(elapsed < 1000, `quoting must not backtrack on repeated line breaks (${elapsed} ms)`);
});

test("Quote falls back to the first composer when the host returns none after focus", async t => {
  const calls = [];
  let asked = 0;
  const { h, quote } = await fixture(t, { composers: ({ agentId }) => (++asked === 1 ? [{
    async focus() { calls.push(["focus", agentId]); },
    insertText(value) { calls.push(["insert", agentId, value]); },
  }] : []) });
  quote.props.onPress();
  await settle();
  assert.deepEqual(calls, [["focus", "target"], ["insert", "target", quotedText]]);
  assert.deepEqual(h.copies, []);
});
