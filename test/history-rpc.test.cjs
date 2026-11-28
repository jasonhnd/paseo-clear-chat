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

function createHome(t) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-paseo-"));
  assert.equal(resolve(home).startsWith(`${repositoryRoot}${sep}`), false,
    "a temporary Paseo home must live outside the repository");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

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
    directoryPartial: false,
    fromCache: 0,
    readMs: 7,
  };
  assert.equal(contracts.historyDaysResultSchema.safeParse(snapshot).success, true);
  assert.equal(contracts.historyDaysResultSchema.safeParse({ ...snapshot, days: [{ day: "2026-11-20", count: -1 }] }).success, false);
  assert.equal(contracts.historyDaysResultSchema.safeParse({ ...snapshot, firstDay: "20 November" }).success, false);
  assert.equal(contracts.historyDaysResultSchema.safeParse({ ...snapshot, directoryPartial: "no" }).success, false);
  const { directoryPartial: _ignored, ...withoutPartial } = snapshot;
  assert.equal(contracts.historyDaysResultSchema.safeParse(withoutPartial).success, false,
    "directoryPartial is part of the contract, not an optional extra");
  const { fromCache: _alsoIgnored, ...withoutFromCache } = snapshot;
  assert.equal(contracts.historyDaysResultSchema.safeParse(withoutFromCache).success, false,
    "fromCache is part of the contract, not an optional extra");
  assert.equal(contracts.historyDayResultSchema.safeParse({
    rows: [{ agentId: "agent-a", at: Date.UTC(2026, 10, 20, 3, 0, 0), text: "hello" }],
    directoryPartial: true,
    fromCache: 2,
  }).success, true);
  assert.equal(contracts.historyDayResultSchema.safeParse({ rows: [{ agentId: "agent-a", at: 1 }] }).success, false);
  assert.equal(contracts.historyDayResultSchema.safeParse({ rows: [], directoryPartial: null }).success, false);
  assert.equal(contracts.historyDayResultSchema.safeParse({ rows: [], directoryPartial: false }).success, false);
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
  const { conversations, directoryPartial } = await conversationsModule.listHistoryConversations(paseo);
  assert.deepEqual(conversations.map(entry => entry.id), ["agent-a", "agent-archived"]);
  assert.deepEqual(conversations.map(entry => entry.sessionId), ["s1", null]);
  assert.equal(directoryPartial, false);
  assert.equal(paseo.calls.length, 2);
  assert.deepEqual(paseo.calls[0].filter, { includeArchived: true });
  assert.equal(paseo.calls[0].page.limit, 200);
  assert.equal(paseo.calls[1].page.cursor, "c1");
});

test("a page limit reached with more pages left marks the directory partial", async () => {
  const calls = [];
  const paseo = {
    agents: {
      async list(options) {
        calls.push(options);
        const cursor = options.page?.cursor;
        const index = typeof cursor === "string" ? Number(cursor.replace(/^c/, "")) : 0;
        return {
          entries: [agentEntry({ id: `agent-${index}` })],
          pageInfo: { hasMore: true, nextCursor: `c${index + 1}` },
        };
      },
    },
  };
  const { conversations, directoryPartial } = await conversationsModule.listHistoryConversations(paseo);
  assert.equal(directoryPartial, true);
  assert.equal(conversations.length, 50);
  assert.equal(calls.length, 50);
});

test("a repeated agent id is listed once", async () => {
  const pages = [
    { entries: [agentEntry(), agentEntry({ id: "agent-b" })], pageInfo: { hasMore: true, nextCursor: "c1" } },
    { entries: [agentEntry(), agentEntry({ id: "agent-c" })], pageInfo: { hasMore: false, nextCursor: null } },
  ];
  const { conversations, directoryPartial } = await conversationsModule.listHistoryConversations(fakePaseo(pages));
  assert.deepEqual(conversations.map(entry => entry.id), ["agent-a", "agent-b", "agent-c"]);
  assert.equal(directoryPartial, false);
});

test("a repeated or missing cursor rejects instead of returning half a directory", async () => {
  const repeated = [
    { entries: [agentEntry()], pageInfo: { hasMore: true, nextCursor: "c1" } },
    { entries: [agentEntry()], pageInfo: { hasMore: true, nextCursor: "c1" } },
  ];
  await assert.rejects(conversationsModule.listHistoryConversations(fakePaseo(repeated)),
    /Conversation directory returned an invalid cursor/);
  const missing = [{ entries: [agentEntry()], pageInfo: { hasMore: true, nextCursor: null } }];
  await assert.rejects(conversationsModule.listHistoryConversations(fakePaseo(missing)),
    /Conversation directory returned an invalid cursor/);
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
  const { conversations } = await conversationsModule.listHistoryConversations(fakePaseo(pages));
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

test("a host that refuses the second contract leaves no half-working client surface", async t => {
  const handlers = new Map();
  let calls = 0;
  const server = {
    handle(contract, handler) {
      calls += 1;
      if (calls === 2) throw new Error("removed RPC");
      handlers.set(contract.name, handler);
    },
  };
  assert.equal(rpcModule.registerHistoryHandlers(server, { home: createHome(t) }), false);
  assert.deepEqual([...handlers.keys()], ["history.days"]);
  // The one contract the host accepted must not serve a half surface.
  const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) } };
  await assert.rejects(handlers.get("history.days")({ timeZone: "UTC" }, { paseo }),
    /Clear Chat history reader is unavailable/);
  // The client asks for both calls or neither; one function alone is unsupported.
  const source = sourceModule.createHistorySource({ days: async () => ({}) });
  assert.deepEqual(await source.days(), { status: "unsupported" });
  assert.deepEqual(await source.day("2026-11-20"), { status: "unsupported" });
});

test("the handlers answer days and one day from the real reader against a temporary root", async t => {
  const hermes = createRoot(t);
  const handlers = new Map();
  const server = { handle(contract, handler) { handlers.set(contract.name, handler); } };
  const home = createHome(t);
  assert.equal(rpcModule.registerHistoryHandlers(server, { root: hermes, home }), true);
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
  assert.equal(days.directoryPartial, false);
  assert.equal(days.fromCache, 0);

  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo });
  assert.deepEqual(detail.rows.map(row => [row.agentId, row.text]), [["agent-a", "a message from the person"]]);
  assert.equal(detail.directoryPartial, false);
  assert.equal(detail.fromCache, 0);
});

test("a count-only archive record is named so the client can drop the timeline's copy", async t => {
  const hermes = createRoot(t);
  const home = createHome(t);
  const directory = join(home, "plugin-data", "clear-chat", "history");
  fs.mkdirSync(directory, { recursive: true });
  // 2026-11-20 01:00 in Tokyo; the day already counts it, but the record has no text to list.
  const countedAt = Date.UTC(2026, 10, 19, 16, 0, 0);
  fs.writeFileSync(join(directory, "messages-2026-11.json"), JSON.stringify({
    version: 2,
    messages: [{ key: "c0ffee0000000000", sessionId: "session-gone", agentId: "agent-a", at: countedAt }],
  }));
  const handlers = new Map();
  rpcModule.registerHistoryHandlers(
    { handle(contract, handler) { handlers.set(contract.name, handler); } },
    { root: hermes, home },
  );
  const paseo = fakePaseo([{ entries: [agentEntry()], pageInfo: { hasMore: false, nextCursor: null } }]);
  const days = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo });
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 2 }]);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo });
  assert.deepEqual(detail.rows.map(row => row.text), ["a message from the person"],
    "a record without text is not a row");
  assert.deepEqual(detail.counted, [{ agentId: "agent-a", at: countedAt }],
    "the day names the message it counted without listing");
});

test("a partial directory reaches both RPC results", async t => {
  const hermes = createRoot(t);
  const handlers = new Map();
  rpcModule.registerHistoryHandlers(
    { handle(contract, handler) { handlers.set(contract.name, handler); } },
    { root: hermes, home: createHome(t) },
  );
  const paseo = {
    agents: {
      async list(options) {
        const cursor = options.page?.cursor;
        const index = typeof cursor === "string" ? Number(cursor.replace(/^c/, "")) : 0;
        return {
          entries: index === 0 ? [agentEntry()] : [],
          pageInfo: { hasMore: true, nextCursor: `c${index + 1}` },
        };
      },
    },
  };
  const days = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo });
  assert.equal(days.directoryPartial, true);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo });
  assert.equal(detail.directoryPartial, true);
  assert.equal(detail.rows.length, 1);
});

test("a failing conversation list rejects the call so the client can show an error", async t => {
  const hermes = createRoot(t);
  const handlers = new Map();
  rpcModule.registerHistoryHandlers(
    { handle(contract, handler) { handlers.set(contract.name, handler); } },
    { root: hermes, home: createHome(t) },
  );
  const paseo = { agents: { list: async () => { throw new Error("directory unavailable"); } } };
  await assert.rejects(handlers.get("history.days")({ timeZone: "UTC" }, { paseo }), /directory unavailable/);
});

test("the client reports unsupported when the host has no RPC surface", async () => {
  const source = sourceModule.createHistorySource(null, "Asia/Tokyo");
  assert.deepEqual(await source.days(), { status: "unsupported" });
  assert.deepEqual(await source.day("2026-11-20"), { status: "unsupported" });
  const partial = sourceModule.createHistorySource({ days: async () => ({}) }, "Asia/Tokyo");
  assert.deepEqual(await partial.days(), { status: "unsupported" });
  assert.deepEqual(await partial.day("2026-11-20"), { status: "unsupported" });
});

test("the client separates an explicit unknown-method code from a failed call", async () => {
  const snapshot = {
    days: [], firstDay: null, lastDay: null, fastConversations: 0,
    slowConversationIds: [], skippedDatabases: [], directoryPartial: false, fromCache: 0, readMs: 1,
  };
  const unavailable = Object.assign(new Error("no such method"), { code: "METHOD_NOT_FOUND" });
  const missing = sourceModule.createHistorySource({
    days: async () => { throw unavailable; },
    day: async () => snapshot,
  });
  assert.deepEqual(await missing.days(), { status: "unsupported" });

  // Text that merely says "not supported" is a failed read, not a missing surface.
  const textOnly = sourceModule.createHistorySource({
    days: async () => { throw new Error("Plugin RPC method history.days is not supported"); },
    day: async () => ({ rows: [], directoryPartial: false, fromCache: 0 }),
  });
  assert.deepEqual(await textOnly.days(), { status: "error" });
  const handlerError = Object.assign(new Error("Request failed: read error"), { code: "handler_error" });
  const failed = sourceModule.createHistorySource({
    days: async () => { throw handlerError; },
    day: async () => ({ rows: [], directoryPartial: false, fromCache: 0 }),
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
    directoryPartial: false,
    fromCache: 0,
    readMs: 4,
  };
  const source = sourceModule.createHistorySource({
    days: async input => { seen.push(["days", input]); return snapshot; },
    day: async input => { seen.push(["day", input]); return { rows: [], directoryPartial: false, fromCache: 0 }; },
  }, "America/New_York");
  assert.deepEqual(await source.days(), { status: "ready", snapshot });
  assert.deepEqual(await source.day("2026-11-20"), { status: "ready", snapshot: { rows: [], directoryPartial: false, fromCache: 0 } });
  assert.deepEqual(seen, [
    ["days", { timeZone: "America/New_York" }],
    ["day", { day: "2026-11-20", timeZone: "America/New_York" }],
  ]);
  assert.equal(source.timeZone, "America/New_York");
});

test("the client falls back to a usable zone and reads only explicit unknown-method codes", () => {
  assert.match(sourceModule.createHistorySource(null).timeZone, /\S/);
  assert.equal(sourceModule.isUnsupportedMethod(Object.assign(new Error("x"), { code: "METHOD_NOT_FOUND" })), true);
  assert.equal(sourceModule.isUnsupportedMethod(Object.assign(new Error("x"), { code: "PLUGIN_RPC_METHOD_NOT_FOUND" })), true);
  assert.equal(sourceModule.isUnsupportedMethod(new Error("unknown method history.days")), false);
  assert.equal(sourceModule.isUnsupportedMethod(Object.assign(new Error("x"), { code: "handler_error" })), false);
  assert.equal(sourceModule.isUnsupportedMethod(null), false);
});
