const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { dirname, join, resolve, sep } = require("node:path");
const test = require("node:test");
const { createTsModules } = require("./helpers/ts-modules.cjs");

/**
 * The days RPC's per-conversation, per-month counts: the ranking must add up to the same
 * month totals the day cells show, and must use the reader's calendar month, not UTC's.
 */

const repositoryRoot = resolve(__dirname, "..");
const tsModules = createTsModules();
const monthsModule = tsModules.load(join(repositoryRoot, "server/history-conversation-months.ts"));
const rpcModule = tsModules.load(join(repositoryRoot, "server/history-rpc.ts"));

function createHome(t) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-month-paseo-"));
  assert.equal(resolve(home).startsWith(`${repositoryRoot}${sep}`), false);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function createRoot(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-month-hermes-"));
  assert.equal(resolve(root).startsWith(`${repositoryRoot}${sep}`), false);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hermes = join(root, "hermes");
  const path = join(hermes, "state.db");
  fs.mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0,
      display_metadata TEXT
    );
  `);
  for (const id of ["s1", "s2"]) db.prepare("INSERT INTO sessions (id) VALUES (?)").run(id);
  const insert = db.prepare(`INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata)
    VALUES (?, 'user', ?, ?, 1, 0, NULL)`);
  const at = (iso) => Date.parse(iso) / 1000;
  insert.run("s1", "first", at("2026-11-20T03:00:00Z"));
  insert.run("s1", "second", at("2026-11-20T04:00:00Z"));
  insert.run("s1", "third", at("2026-11-21T03:00:00Z"));
  // 16:00 UTC on Nov 30 is already December 1 in Tokyo.
  insert.run("s1", "december", at("2026-11-30T16:00:00Z"));
  insert.run("s2", "october", at("2026-10-05T03:00:00Z"));
  insert.run("s2", "another", at("2026-11-20T05:00:00Z"));
  db.close();
  return hermes;
}

function agentEntry(id, title, sessionId) {
  return {
    agent: {
      id, title, provider: "hermes",
      updatedAt: "2026-11-21T03:00:00.000Z",
      lastUserMessageAt: "2026-11-21T03:00:00.000Z",
      labels: {}, runtimeInfo: { sessionId },
    },
    project: {},
  };
}

test("per-conversation months use the reader's calendar and add up to the day totals", async t => {
  const handlers = new Map();
  const registered = rpcModule.registerHistoryHandlers(
    { handle(contract, handler) { handlers.set(contract.name, handler); } },
    { root: createRoot(t), home: createHome(t) },
  );
  assert.equal(registered, true);
  const paseo = {
    agents: {
      async list() {
        return {
          entries: [agentEntry("agent-one", "First conversation", "s1"), agentEntry("agent-two", "Second conversation", "s2")],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
    },
  };
  const days = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo });

  // 2026-11: s1 three messages, s2 one; 2026-12: s1 one; 2026-10: s2 one.
  assert.deepEqual(days.days, [
    { day: "2026-10-05", count: 1 },
    { day: "2026-11-20", count: 3 },
    { day: "2026-11-21", count: 1 },
    { day: "2026-12-01", count: 1 },
  ]);
  assert.deepEqual(
    days.conversationMonths.map(entry => [entry.month, entry.agentId, entry.title, entry.count]),
    [
      ["2026-10", "agent-two", "Second conversation", 1],
      ["2026-11", "agent-one", "First conversation", 3],
      ["2026-11", "agent-two", "Second conversation", 1],
      ["2026-12", "agent-one", "First conversation", 1],
    ],
  );
  // The ranking's month sums are exactly the cells' month sums.
  const byMonth = new Map();
  for (const entry of days.conversationMonths) byMonth.set(entry.month, (byMonth.get(entry.month) ?? 0) + entry.count);
  const cellByMonth = new Map();
  for (const day of days.days) {
    const month = day.day.slice(0, 7);
    cellByMonth.set(month, (cellByMonth.get(month) ?? 0) + day.count);
  }
  assert.deepEqual(Object.fromEntries(byMonth), Object.fromEntries(cellByMonth));
});

test("counts group by conversation, keep the newest instant, and title-less ids stay null", () => {
  const monthFor = (iso, agentId) => ({ agentId, at: Date.parse(iso) });
  const messages = [
    monthFor("2026-11-02T01:00:00Z", "a"),
    monthFor("2026-11-05T01:00:00Z", "a"),
    monthFor("2026-11-03T01:00:00Z", "b"),
    monthFor("2026-11-01T01:00:00Z", "gone"),
  ];
  const counts = monthsModule.countDaysAndConversationMonths(messages, "UTC", new Map([["a", "A"]]));
  assert.deepEqual(counts.conversationMonths.map(entry => [entry.agentId, entry.title, entry.count, entry.lastAt]), [
    ["a", "A", 2, Date.parse("2026-11-05T01:00:00Z")],
    ["b", null, 1, Date.parse("2026-11-03T01:00:00Z")],
    ["gone", null, 1, Date.parse("2026-11-01T01:00:00Z")],
  ]);
  assert.deepEqual(counts.days, [
    { day: "2026-11-01", count: 1 },
    { day: "2026-11-02", count: 1 },
    { day: "2026-11-03", count: 1 },
    { day: "2026-11-05", count: 1 },
  ]);
  assert.equal(counts.firstDay, "2026-11-01");
  assert.equal(counts.lastDay, "2026-11-05");
});

test("the days RPC converts each record's local day once for both aggregates", () => {
  const messages = [
    { agentId: "a", at: Date.parse("2026-11-02T01:00:00Z") },
    { agentId: "b", at: Date.parse("2026-11-03T01:00:00Z") },
    { agentId: "a", at: Date.parse("2026-11-05T01:00:00Z") },
    { agentId: "gone", at: Date.parse("2026-11-01T01:00:00Z") },
  ];
  const calls = [];
  const counts = monthsModule.countDaysAndConversationMonths(
    messages,
    "UTC",
    new Map([["a", "A"]]),
    (at, zone) => {
      assert.equal(zone, "UTC");
      calls.push(at);
      return new Date(at).toISOString().slice(0, 10);
    },
  );
  // One conversion per record: the cells and the ranking read the same day key instead of
  // each running its own pass over the same messages.
  assert.equal(calls.length, messages.length);
  const dayByMonth = new Map();
  for (const entry of counts.days) {
    const month = entry.day.slice(0, 7);
    dayByMonth.set(month, (dayByMonth.get(month) ?? 0) + entry.count);
  }
  const rankByMonth = new Map();
  for (const entry of counts.conversationMonths) {
    rankByMonth.set(entry.month, (rankByMonth.get(entry.month) ?? 0) + entry.count);
  }
  assert.deepEqual(Object.fromEntries(rankByMonth), Object.fromEntries(dayByMonth));
});
