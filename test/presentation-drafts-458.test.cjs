const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// One bad or older draft entry must not invalidate the whole presentation
// document. Entries are dropped one by one; other drafts and stored
// preferences keep loading, and the settings page shows no error.

const goodKey = "a\u000010";
const good = { schema: 1, choices: { 0: "B" }, customDrafts: {}, customOpen: {}, activeQuestion: 1 };
const bad = {
  "future\u000020": { schema: 2, choices: { 0: "A" }, customDrafts: {}, customOpen: {}, activeQuestion: 0 },
  "legacy\u000030": { choices: { 0: "A" } },
  "garbage\u000040": "not-a-draft",
  "wrongtypes\u000050": { schema: 1, choices: { 0: 7 }, customDrafts: {}, customOpen: {}, activeQuestion: 0 },
};

function host(values) {
  let current = structuredClone(values);
  let revision = 0;
  const writes = [];
  return {
    writes,
    get values() { return current; },
    async rpc(contract, input) {
      if (contract.name.endsWith(".read")) return { status: "ready", revision: String(revision), values: structuredClone(current) };
      if (input.revision !== String(revision)) return { status: "conflict", error: "Changed elsewhere" };
      writes.push(structuredClone(input.values));
      current = structuredClone(input.values);
      revision += 1;
      return { status: "saved", revision: String(revision), values: structuredClone(current) };
    },
  };
}

function fixture(t, server) {
  // `presentationHost` keeps the real preferences module instead of the stub.
  const h = createToolHarness("ios", { presentationHost: { rpc: server.rpc } });
  const preferences = h.load("client/preferences.ts");
  const messages = h.load("shared/startup-diagnostics.ts").STARTUP_MESSAGES;
  t.after(() => { h.unmount(); h.dispose(); });
  return { h, preferences, messages };
}

test("a bad draft entry is dropped while other drafts and preferences load", async t => {
  const server = host({
    preferences: { accent: "rose", assistantMarkdown: false, savedReplies: ["Keep it short"] },
    legacyMigrated: true,
    answerDrafts: { [goodKey]: good, ...bad },
  });
  const f = fixture(t, server);
  await f.preferences.initializeEnhancerPreferences(server.rpc);

  assert.equal(f.preferences.getEnhancerPreferencesError(), null, "the settings page must not report an error");
  const prefs = f.preferences.getEnhancerPreferences();
  assert.equal(prefs.accent, "rose", "stored preferences still load");
  assert.equal(prefs.assistantMarkdown, false);
  assert.deepEqual(prefs.savedReplies, ["Keep it short"]);

  const kept = f.preferences.getStoredAnswerDraft(goodKey);
  assert.equal(kept.schema, 1);
  assert.equal(kept.choices[0], "B", "a valid draft is kept");
  for (const key of Object.keys(bad)) {
    assert.equal(f.preferences.getStoredAnswerDraft(key), undefined, `${key}: a bad entry reads as absent`);
  }

  // The next write merges against the filtered document: the bad entries are gone,
  // everything else survives.
  await f.preferences.updateEnhancerPreferences({ accent: "jade" });
  const written = server.writes.at(-1);
  assert.deepEqual(Object.keys(written.answerDrafts), [goodKey], "only the valid draft is written back");
  assert.equal(written.answerDrafts[goodKey].choices[0], "B");
  assert.equal(written.preferences.accent, "jade");
  assert.equal(written.preferences.assistantMarkdown, false, "an unrelated preference is not lost");
  assert.deepEqual(written.preferences.savedReplies, ["Keep it short"]);
  assert.equal(written.legacyMigrated, true);
});

test("a bad entry does not hide drafts from other cards", async t => {
  const otherKey = "b\u000060";
  const server = host({
    preferences: {},
    legacyMigrated: true,
    answerDrafts: { [goodKey]: good, [otherKey]: { schema: 1, choices: {}, customDrafts: { 1: "typed" }, customOpen: { 1: true }, activeQuestion: 1 }, ...bad },
  });
  const f = fixture(t, server);
  await f.preferences.initializeEnhancerPreferences(server.rpc);
  assert.equal(f.preferences.getEnhancerPreferencesError(), null);
  assert.equal(f.preferences.getStoredAnswerDraft(goodKey).choices[0], "B");
  assert.equal(f.preferences.getStoredAnswerDraft(otherKey).customDrafts[1], "typed");
});

test("an invalid preference still rejects the document", async t => {
  const server = host({
    preferences: { accent: "chartreuse" },
    legacyMigrated: true,
    answerDrafts: { [goodKey]: good },
  });
  const f = fixture(t, server);
  await f.preferences.initializeEnhancerPreferences(server.rpc);
  assert.equal(
    f.preferences.getEnhancerPreferencesError(),
    f.messages.settingsInvalid,
    "other settings fields keep their strict validation",
  );
});

for (const [label, block] of [["null", null], ["empty array", []], ["string", "garbage"], ["number", 7]]) {
  test(`an answerDrafts block that is not a record is treated as no drafts (${label})`, async t => {
    const server = host({ preferences: { accent: "rose", assistantMarkdown: false }, legacyMigrated: true, answerDrafts: block });
    const f = fixture(t, server);
    await f.preferences.initializeEnhancerPreferences(server.rpc);
    assert.equal(f.preferences.getEnhancerPreferencesError(), null, "an unusable drafts block must not invalidate the document");
    assert.equal(f.preferences.getEnhancerPreferences().accent, "rose", "stored preferences still load");
    assert.equal(f.preferences.getEnhancerPreferences().assistantMarkdown, false);
    assert.equal(f.preferences.getStoredAnswerDraft(goodKey), undefined, "no draft can be read from an unusable block");

    await f.preferences.updateEnhancerPreferences({ accent: "jade" });
    const written = server.writes.at(-1);
    assert.deepEqual(written.answerDrafts, {}, "the next write stores an empty draft record");
    assert.equal(written.preferences.accent, "jade");
    assert.equal(written.preferences.assistantMarkdown, false, "an unrelated preference is not lost");
    assert.equal(written.legacyMigrated, true);
  });
}

test("a prototype-shaped draft key never becomes a draft or changes the document", t => {
  const h = createToolHarness("ios");
  t.after(() => { h.unmount(); h.dispose(); });
  const { presentationSettings } = h.load("shared/settings.ts");
  const values = JSON.parse('{"preferences":{"accent":"rose"},"legacyMigrated":true,"answerDrafts":{"__proto__":{"schema":1,"choices":{"0":"A"},"customDrafts":{},"customOpen":{},"activeQuestion":0}}}');
  const parsed = presentationSettings.schema.parse(values);
  assert.equal(Object.hasOwn(parsed.answerDrafts, "__proto__"), false, "a prototype-shaped key is not kept as a draft");
  assert.equal(parsed.answerDrafts.choices, undefined, "the key cannot lend a draft shape to the record");
  assert.equal(parsed.preferences.accent, "rose", "the rest of the document still loads");
});
