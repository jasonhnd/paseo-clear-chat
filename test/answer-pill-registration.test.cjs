const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The host edge: contribute() must find the conversation in front of the user, read its
// timeline, and register one composer pill for it. The app matches a pill to a composer by
// agent id, so a pill registered for another agent never shows.

const questions = "1) First?\nA One\nB Two\n\n2) Second?\nA One\nB Two\n\nReply: A";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const composerObject = () => ({ context: "agent", prompt: "", attachments: [], agent: { metadata: {} } });

function agentApi(snapshot, calls, listCalls) {
  return {
    ref() {
      return {
        refresh: async () => ({ agent: { activeTurn: null } }),
        timeline: {
          refetch: async input => {
            calls.push(input ?? {});
            return { entries: snapshot.a ?? [], hasOlder: false };
          },
          subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
        },
      };
    },
    list: async () => {
      listCalls.count += 1;
      return { entries: (listCalls.agents ?? []).map(agent => ({ agent })) };
    },
  };
}

function replyEntry(at, text) {
  return { agentId: "a", timestamp: new Date(at).toISOString(), seqStart: 0, item: { type: "assistant_message", text } };
}

function registrationHarness(t, options = {}) {
  const focused = { agentId: "a", composer: composerObject() };
  const calls = [];
  const listCalls = { count: 0, agents: options.agents ?? [{ id: "a", workspaceId: "w1" }] };
  const h = createToolHarness("web", {
    locale: options.locale ?? "zh-CN",
    noComposerPill: options.noComposerPill,
    preferencesReady: options.preferencesReady,
    preferencesError: options.preferencesError,
    presentationHost: options.preferences
      ? { rpc: async () => ({ status: "ready", revision: "0", values: { preferences: options.preferences, legacyMigrated: true } }) }
      : undefined,
    composers: selector => {
      if (!focused.agentId) return [];
      if (!("focused" in selector)) return selector.agentId === focused.agentId ? [focused.composer] : [];
      // `separateObject` models a host whose two selectors do not share a composer handle.
      return [options.separateObject ? composerObject() : focused.composer];
    },
    paseo: { agents: agentApi(options.snapshots ?? {}, calls, listCalls) },
  });
  // The harness stores the paseo stub before `focused.composer` exists for the first call.
  listCalls.agents = options.agents ?? [{ id: "a", workspaceId: "w1" }];
  t.after(() => h.dispose());
  return { h, focused, calls, listCalls };
}

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await tick();
}

function captureWarnings() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(value => String(value)).join(" ")); };
  return { lines, restore() { console.warn = original; } };
}

test("contribute() registers the pill for the conversation in front of the user", async t => {
  const { h } = registrationHarness(t, { snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] } });
  await settle();
  const live = h.composerPills.filter(record => !record.removed);
  assert.equal(live.length, 1, "one conversation with a card means one pill");
  const { contribution } = live[0];
  assert.equal(contribution.agentId, "a");
  assert.equal(contribution.workspaceId, "w1");
  assert.equal(contribution.id, "clear-chat-answer-card");
  assert.equal(contribution.button.visible, true);
  // Title and label are plugin messages: the host resolves them in the app language.
  assert.equal(h.translations.runtime.resolve(contribution.button.title), "回答卡片");
  assert.equal(h.translations.runtime.resolve(contribution.button.label), "回答卡片 · 已答 0/2");
  assert.equal(contribution.button.behavior.kind, "popover");
  assert.equal(typeof contribution.button.behavior.Content, "function");
});

test("every language registers the same localized label", async t => {
  const expected = {
    en: ["Answer card", "Answer card · 0/2 answered"],
    "zh-CN": ["回答卡片", "回答卡片 · 已答 0/2"],
    ja: ["回答カード", "回答カード · 回答済み 0/2"],
  };
  for (const [locale, copy] of Object.entries(expected)) {
    const { h } = registrationHarness(t, { locale, snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] } });
    await settle();
    const live = h.composerPills.filter(record => !record.removed);
    assert.equal(live.length, 1, locale);
    const { button } = live[0].contribution;
    assert.equal(h.translations.runtime.resolve(button.title), copy[0], locale);
    assert.equal(h.translations.runtime.resolve(button.label), copy[1], locale);
    h.dispose();
  }
});

test("the feed reads the newest page only when the pin asks for it", async t => {
  const { calls } = registrationHarness(t, { snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] } });
  await settle();
  assert.ok(calls.length > 0, "precondition: the feed must have read the timeline");
  assert.deepEqual(calls.map(call => call.direction), ["tail"], "the pin needs the newest reply, not every older page");
});

test("a host without the composer-pill API keeps the rest of the plugin working", async t => {
  const warnings = captureWarnings();
  const { h } = registrationHarness(t, { noComposerPill: true, snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] } });
  await settle();
  warnings.restore();
  assert.equal(h.settingsScreens.size, 1, "the settings screen still registers");
  assert.equal(warnings.lines.filter(line => line.includes("no composer pill API")).length, 1, "the reason is said once");
});

test("a composer that matches no listed agent is reported once and backed off", async t => {
  const warnings = captureWarnings();
  const { h, listCalls } = registrationHarness(t, {
    separateObject: true,
    snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] },
  });
  await settle(8);
  warnings.restore();
  assert.equal(h.composerPills.length, 0, "a composer that matches no agent shows no pill");
  assert.equal(listCalls.count, 1, "the list is not read on every tick");
  assert.equal(warnings.lines.filter(line => line.includes("cannot match")).length, 1);
});

test("an empty agent list is reported once and backed off", async t => {
  const warnings = captureWarnings();
  const { h, listCalls } = registrationHarness(t, { agents: [], snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] } });
  await settle(8);
  warnings.restore();
  assert.equal(h.composerPills.length, 0);
  assert.equal(listCalls.count, 1, "the list is not read on every tick");
  assert.equal(warnings.lines.filter(line => line.includes("no agents")).length, 1);
});

test("a conversation with no card registers no pill and reads no pill body", async t => {
  const { h, focused } = registrationHarness(t, { snapshots: { a: [] } });
  await settle();
  assert.equal(h.composerPills.filter(record => !record.removed).length, 0);
  focused.agentId = null;
  await settle();
  assert.equal(h.composerPills.length, 0);
});

test("a settings read that has not finished yet waits without asking the host", async t => {
  const { h, listCalls } = registrationHarness(t, {
    preferencesReady: false,
    snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] },
  });
  await settle(8);
  assert.equal(h.composerPills.length, 0, "the stored switch is unknown, so the pin waits");
  assert.equal(listCalls.count, 0, "nothing is read before the switch is known");
});

test("a failed settings read keeps the default and says so once", async t => {
  const warnings = captureWarnings();
  const { h } = registrationHarness(t, {
    preferencesReady: false,
    preferencesError: "settings read failed",
    snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] },
  });
  await settle(8);
  warnings.restore();
  const live = h.composerPills.filter(record => !record.removed);
  assert.equal(live.length, 1, "the default is on, so the pin still appears");
  assert.equal(warnings.lines.filter(line => line.includes("default")).length, 1, "the reason is said once");
});

test("the switched-off card does not read the agent list at all", async t => {
  const { h, listCalls } = registrationHarness(t, {
    preferences: { showAnswerCard: false },
    snapshots: { a: [replyEntry(Date.parse("2026-01-01T10:00:00Z"), questions)] },
  });
  await settle(8);
  assert.equal(h.composerPills.length, 0, "the switch is off");
  assert.equal(listCalls.count, 0, "a switched-off pin asks the host for nothing");
});
