const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The host edge: contribute() must find the conversation in front of the user, read its
// timeline, and register one composer pill for it. The app matches a pill to a composer by
// agent id, so a pill registered for another agent never shows.

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function agentApi(entries, snapshot = {}) {
  return {
    ref(agentId) {
      return {
        refresh: async () => ({ agent: { activeTurn: null } }),
        timeline: {
          refetch: async () => ({ entries: snapshot[agentId] ?? [], hasOlder: false }),
          subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
        },
      };
    },
    list: async () => ({ entries: entries.map(agent => ({ agent })) }),
  };
}

function replyEntry(agentId, at, text) {
  return { agentId, timestamp: new Date(at).toISOString(), seqStart: 0, item: { type: "assistant_message", text } };
}

function registrationHarness(t, options = {}) {
  const agents = options.agents ?? [{ id: "a", workspaceId: "w1" }];
  const focused = { agentId: "a" };
  const h = createToolHarness("web", {
    locale: options.locale ?? "zh-CN",
    noComposerPill: options.noComposerPill,
    composers: selector => ("focused" in selector
      ? (focused.agentId ? [focused.composer] : [])
      : (selector.agentId === focused.agentId ? [focused.composer] : [])),
    paseo: { agents: agentApi(agents, options.snapshots) },
  });
  focused.composer = { context: "agent", prompt: "", attachments: [], agent: { metadata: {} } };
  t.after(() => h.dispose());
  return { h, focused };
}

test("contribute() registers the pill for the conversation in front of the user", async t => {
  const { h } = registrationHarness(t, {
    snapshots: { a: [replyEntry("a", Date.parse("2026-01-01T10:00:00Z"), questions)] },
  });
  for (let i = 0; i < 4; i += 1) await tick();
  const live = h.composerPills.filter(record => !record.removed);
  assert.equal(live.length, 1, "one conversation with a card means one pill");
  const { contribution } = live[0];
  assert.equal(contribution.agentId, "a");
  assert.equal(contribution.workspaceId, "w1");
  assert.equal(contribution.id, "clear-chat-answer-card");
  assert.equal(contribution.button.visible, true);
  assert.equal(contribution.button.label, "回答卡片 · 已答 0/2");
  assert.equal(contribution.button.behavior.kind, "popover");
  assert.equal(typeof contribution.button.behavior.Content, "function");
});

test("every language registers the same localized label", async t => {
  const expected = { en: "Answer card · 0/2 answered", "zh-CN": "回答卡片 · 已答 0/2", ja: "回答カード · 回答済み 0/2" };
  for (const [locale, label] of Object.entries(expected)) {
    const { h } = registrationHarness(t, {
      locale,
      snapshots: { a: [replyEntry("a", Date.parse("2026-01-01T10:00:00Z"), questions)] },
    });
    for (let i = 0; i < 4; i += 1) await tick();
    const live = h.composerPills.filter(record => !record.removed);
    assert.equal(live.length, 1, locale);
    assert.equal(live[0].contribution.button.label, label, locale);
    h.dispose();
  }
});

test("a host without the composer-pill API keeps the rest of the plugin working", async t => {
  const { h } = registrationHarness(t, {
    noComposerPill: true,
    snapshots: { a: [replyEntry("a", Date.parse("2026-01-01T10:00:00Z"), questions)] },
  });
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(h.settingsScreens.size, 1, "the settings screen still registers");
});

test("a conversation with no card registers no pill and reads no pill body", async t => {
  const { h, focused } = registrationHarness(t, { snapshots: { a: [] } });
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(h.composerPills.filter(record => !record.removed).length, 0);
  focused.agentId = null;
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(h.composerPills.length, 0);
});
