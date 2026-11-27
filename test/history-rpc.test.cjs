const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { dirname, join, resolve, sep } = require("node:path");
const test = require("node:test");
const { createTsModules } = require("./helpers/ts-modules.cjs");

const repositoryRoot = resolve(__dirname, "..");
const tsModules = createTsModules();
const contracts = tsModules.load(join(repositoryRoot, "shared/history-rpc.ts"));
const conversationsModule = tsModules.load(join(repositoryRoot, "server/history-conversations.ts"));
const rpcModule = tsModules.load(join(repositoryRoot, "server/history-rpc.ts"));
const sourceModule = tsModules.load(join(repositoryRoot, "client/history-source.ts"));

function agentEntry(overrides = {}) {
  return {
    agent: {
      id: "agent-a",
      provider: "hermes",
      updatedAt: "2026-11-20T03:00:00.000Z",
      lastUserMessageAt: "2026-11-20T03:00:00.000Z",
      labels: {},
      runtimeInfo: { sessionId: "s1" },
      ...overrides,
    },
    project: {},
  };
}

function fakePaseo(pages) {
  const calls = [];
  return {
    calls,
    agents: {
      async list(options) {
        calls.push(options);
        const cursor = options.page?.cursor;
        const index = typeof cursor === "string" ? Number(cursor.replace(/^c/, "")) : 0;
        return pages[index];
      },
    },
  };
}

function createRoot(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-history-rpc-"));
  assert.equal(resolve(root).startsWith(`${repositoryRoot}${sep}`), false,
    "a temporary Hermes root must live outside the repository");
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
  db.prepare("INSERT INTO sessions (id) VALUES (?)").run("s1");
  db.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("s1", "user", "a message from the person", Date.UTC(2026, 10, 20, 3, 0, 0) / 1000, 1, 0, null);
  db.close();
  return hermes;
}

test("the history contracts name both methods and reject malformed input", () => {
  assert.equal(contracts.historyDaysRpc.name, "history.days");
  assert.equal(contracts.historyDayRpc.name, "history.day");
  assert.equal(contracts.historyDaysInputSchema.safeParse({ timeZone: "Asia/Tokyo" }).success, true);
  assert.equal(contracts.historyDaysInputSchema.safeParse({ timeZone: "" }).success, false);
  assert.equal(contracts.historyDaysInputSchema.safeParse({}).success, false);
  assert.equal(contracts.historyDayInputSchema.safeParse({ day: "2026-11-20", timeZone: "UTC" }).success, true);
  assert.equal(contracts.historyDayInputSchema.safeParse({ day: "2026-1-2", timeZone: "UTC" }).success, false);
  assert.equal(contracts.historyDayInputSchema.safeParse({ day: "2026-11-20" }).success, false);
});

test("the history result contracts carry the fields the calendar needs", () => {
  const snapshot = {
    days: [{ day: "2026-11-20", count: 2 }],
    firstDay: "2026-11-20",
    lastDay: "2026-11-20",
    fastConversations: 1,
    slowConversationIds: ["agent-b"],
    skippedDatabases: ["profiles/work/state.db"],
    readMs: 7,
  };
  assert.equal(contracts.historyDaysResultSchema.safeParse(snapshot).success, true);
  assert.equal(contracts.historyDaysResultSchema.safeParse({ ...snapshot, days: [{ day: "2026-11-20", count: -1 }] }).success, false);
  assert.equal(contracts.historyDaysResultSchema.safeParse({ ...snapshot, firstDay: "20 November" }).success, false);
  assert.equal(contracts.historyDayResultSchema.safeParse({
    rows: [{ agentId: "agent-a", at: Date.UTC(2026, 10, 20, 3, 0, 0), text: "hello" }],
  }).success, true);
  assert.equal(contracts.historyDayResultSchema.safeParse({ rows: [{ agentId: "agent-a", at: 1 }] }).success, false);
});

test("the conversation list walks every page, keeps archived agents and skips child agents", async () => {
  const pages = [
    {
      entries: [
        agentEntry(),
        agentEntry({ id: "agent-child", labels: { [conversationsModule.PARENT_AGENT_ID_LABEL]: "agent-a" } }),
      ],
      pageInfo: { hasMore: true, nextCursor: "c1" },
    },
    {
      entries: [agentEntry({ id: "agent-archived", archivedAt: "2026-01-01T00:00:00.000Z", runtimeInfo: { sessionId: null } })],
      pageInfo: { hasMore: false, nextCursor: null },
    },
  ];
  const paseo = fakePaseo(pages);
  const conversations = await conversationsModule.listHistoryConversations(paseo);
  assert.deepEqual(conversations.map(entry => entry.id), ["agent-a", "agent-archived"]);
  assert.deepEqual(conversations.map(entry => entry.sessionId), ["s1", null]);
  assert.equal(paseo.calls.length, 2);
  assert.deepEqual(paseo.calls[0].filter, { includeArchived: true });
  assert.equal(paseo.calls[0].page.limit, 200);
  assert.equal(paseo.calls[1].page.cursor, "c1");
});

test("a repeated agent id is listed once and a repeated cursor stops the walk", async () => {
  const pages = [
    { entries: [agentEntry(), agentEntry({ id: "agent-b" })], pageInfo: { hasMore: true, nextCursor: "c1" } },
    { entries: [agentEntry(), agentEntry({ id: "agent-c" })], pageInfo: { hasMore: true, nextCursor: "c1" } },
  ];
  const paseo = fakePaseo(pages);
  const conversations = await conversationsModule.listHistoryConversations(paseo);
  assert.deepEqual(conversations.map(entry => entry.id), ["agent-a", "agent-b", "agent-c"]);
  assert.equal(paseo.calls.length, 2);
});

test("the most recent activity stamps a conversation, falling back to updatedAt", async () => {
  const pages = [{
    entries: [
      agentEntry({ id: "agent-last", lastUserMessageAt: "2026-11-21T00:00:00.000Z" }),
      agentEntry({ id: "agent-updated", lastUserMessageAt: null, updatedAt: "2026-11-22T00:00:00.000Z" }),
      agentEntry({ id: "agent-unknown", lastUserMessageAt: null, updatedAt: "not a date" }),
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }];
  const conversations = await conversationsModule.listHistoryConversations(fakePaseo(pages));
  assert.deepEqual(conversations.map(entry => [entry.id, entry.lastActiveAt]), [
    ["agent-last", Date.parse("2026-11-21T00:00:00.000Z")],
    ["agent-updated", Date.parse("2026-11-22T00:00:00.000Z")],
    ["agent-unknown", 0],
  ]);
});

test("registering on a host without an RPC surface is a no-op, not a startup failure", () => {
  assert.equal(rpcModule.registerHistoryHandlers({}), false);
  assert.equal(rpcModule.registerHistoryHandlers(null), false);
  assert.equal(rpcModule.registerHistoryHandlers({ handle: 42 }), false);
  // An older host can expose `handle` for its own contracts and refuse these.
  assert.equal(rpcModule.registerHistoryHandlers({
    handle() { throw new Error("removed RPC"); },
  }), false);
});

test("the handlers answer days and one day from the real reader against a temporary root", async t => {
  const hermes = createRoot(t);
  const handlers = new Map();
  const server = { handle(contract, handler) { handlers.set(contract.name, handler); } };
  assert.equal(rpcModule.registerHistoryHandlers(server, { root: hermes }), true);
  assert.deepEqual([...handlers.keys()].sort(), ["history.day", "history.days"]);

  const paseo = fakePaseo([{
    entries: [
      agentEntry(),
      // A child agent can share its parent's session; it must not add a second count.
      agentEntry({ id: "agent-child", labels: { [conversationsModule.PARENT_AGENT_ID_LABEL]: "agent-a" } }),
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }]);
  const days = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo });
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(days.fastConversations, 1);
  assert.deepEqual(days.slowConversationIds, []);
  assert.deepEqual(days.skippedDatabases, []);

  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo });
  assert.deepEqual(detail.rows.map(row => [row.agentId, row.text]), [["agent-a", "a message from the person"]]);
});

test("a failing conversation list rejects the call so the client can show an error", async t => {
  const hermes = createRoot(t);
  const handlers = new Map();
  rpcModule.registerHistoryHandlers({ handle(contract, handler) { handlers.set(contract.name, handler); } }, { root: hermes });
  const paseo = { agents: { list: async () => { throw new Error("directory unavailable"); } } };
  await assert.rejects(handlers.get("history.days")({ timeZone: "UTC" }, { paseo }), /directory unavailable/);
});

test("the client reports unsupported when the host has no RPC surface", async () => {
  const source = sourceModule.createHistorySource(null, "Asia/Tokyo");
  assert.deepEqual(await source.days(), { status: "unsupported" });
  assert.deepEqual(await source.day("2026-11-20"), { status: "unsupported" });
  const partial = sourceModule.createHistorySource({ days: async () => ({}) }, "Asia/Tokyo");
  assert.equal((await partial.day("2026-11-20")).status, "unsupported");
});

test("the client turns a missing method and a failed call into distinct states", async () => {
  const missing = sourceModule.createHistorySource({
    days: async () => { throw new Error("Plugin RPC method history.days is not supported"); },
  });
  assert.deepEqual(await missing.days(), { status: "unsupported" });
  const failed = sourceModule.createHistorySource({
    days: async () => { throw new Error("the daemon closed the connection"); },
  });
  assert.deepEqual(await failed.days(), { status: "error" });
});

test("the client rejects an answer that does not match the contract", async () => {
  const source = sourceModule.createHistorySource({
    days: async () => ({ days: "not an array" }),
    day: async () => ({ rows: [{ agentId: "agent-a" }] }),
  });
  assert.deepEqual(await source.days(), { status: "error" });
  assert.deepEqual(await source.day("2026-11-20"), { status: "error" });
});

test("the client returns the parsed snapshot and sends the source's zone with every call", async () => {
  const seen = [];
  const snapshot = {
    days: [{ day: "2026-11-20", count: 2 }],
    firstDay: "2026-11-20",
    lastDay: "2026-11-20",
    fastConversations: 1,
    slowConversationIds: [],
    skippedDatabases: [],
    readMs: 4,
  };
  const source = sourceModule.createHistorySource({
    days: async input => { seen.push(["days", input]); return snapshot; },
    day: async input => { seen.push(["day", input]); return { rows: [] }; },
  }, "America/New_York");
  assert.deepEqual(await source.days(), { status: "ready", snapshot });
  assert.deepEqual(await source.day("2026-11-20"), { status: "ready", snapshot: { rows: [] } });
  assert.deepEqual(seen, [
    ["days", { timeZone: "America/New_York" }],
    ["day", { day: "2026-11-20", timeZone: "America/New_York" }],
  ]);
  assert.equal(source.timeZone, "America/New_York");
});

test("the client falls back to a usable zone and recognises the unsupported wording", () => {
  assert.match(sourceModule.createHistorySource(null).timeZone, /\S/);
  assert.equal(sourceModule.isUnsupportedMethod(new Error("unknown method history.days")), true);
  assert.equal(sourceModule.isUnsupportedMethod(new Error("method not found")), true);
  assert.equal(sourceModule.isUnsupportedMethod(new Error("timeout")), false);
  assert.equal(sourceModule.isUnsupportedMethod(null), false);
});
