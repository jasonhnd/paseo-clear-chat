const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { join, resolve, sep } = require("node:path");
const test = require("node:test");
const { createTsModules } = require("./helpers/ts-modules.cjs");

const repositoryRoot = resolve(__dirname, "..");
const tsModules = createTsModules();
const archiveModule = tsModules.load(join(repositoryRoot, "server/history-archive.ts"));
const rpcModule = tsModules.load(join(repositoryRoot, "server/history-rpc.ts"));

const T = Date.UTC(2026, 10, 20, 3, 0, 0); // 2026-11-20 12:00 in Asia/Tokyo
const MONTH = "2026-11";

const SCHEMA = `
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
`;

function outsideRepository(path) {
  return !resolve(path).startsWith(`${repositoryRoot}${sep}`);
}

function createHome(t) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-archive-home-"));
  assert.equal(outsideRepository(home), true, "the Paseo home must live outside the repository");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function createHermes(t, rows) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-archive-hermes-"));
  assert.equal(outsideRepository(root), true, "the Hermes root must live outside the repository");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hermes = join(root, "hermes");
  fs.mkdirSync(hermes, { recursive: true });
  const databasePath = join(hermes, "state.db");
  const db = new DatabaseSync(databasePath);
  db.exec(SCHEMA);
  for (const sessionId of new Set(rows.map(row => row.sessionId))) {
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
  }
  const insert = db.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata)
    VALUES (?, 'user', ?, ?, 1, 0, NULL)
  `);
  for (const row of rows) insert.run(row.sessionId, row.text, row.at / 1000);
  db.close();
  return { hermes, databasePath };
}

function removeMessage(databasePath, text) {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("DELETE FROM messages WHERE content = ?").run(text);
  } finally {
    db.close();
  }
}

function archivePath(home, name) {
  return join(home, "plugin-data", "clear-chat", "history", name);
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function monthRecords(home, month = MONTH) {
  return readJson(archivePath(home, `messages-${month}.json`)).messages;
}

function allRecords(home) {
  const directory = join(home, "plugin-data", "clear-chat", "history");
  return fs.readdirSync(directory)
    .filter(name => /^messages-\d{4}-\d{2}\.json$/.test(name))
    .flatMap(name => readJson(join(directory, name)).messages);
}

function archive(home, options = {}) {
  return new archiveModule.HistoryArchive({ home, now: () => Date.UTC(2026, 10, 20, 4, 0, 0), ...options });
}

function message(sessionId, agentId, at, text) {
  return { sessionId, agentId, at, text };
}

function agent(id, sessionId) {
  return {
    id,
    provider: "hermes",
    updatedAt: "2026-11-20T03:00:00.000Z",
    lastUserMessageAt: "2026-11-20T03:00:00.000Z",
    labels: {},
    runtimeInfo: { sessionId },
  };
}

function paseo(agents) {
  return {
    agents: {
      async list() {
        return {
          entries: agents.map(entry => ({ agent: entry, project: {} })),
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
    },
  };
}

function register(t, options) {
  const handlers = new Map();
  const server = { handle(contract, handler) { handlers.set(contract.name, handler); } };
  assert.equal(rpcModule.registerHistoryHandlers(server, options), true);
  return handlers;
}

test("the first merge writes the month file and meta with private permissions", async t => {
  const home = createHome(t);
  const merged = await archive(home).merge([
    message("s1", "agent-a", T, "first words"),
    message("s1", "agent-a", T + 1000, "second words"),
  ]);
  assert.equal(merged.cacheError, false);
  assert.equal(merged.messages.length, 2);
  const directory = join(home, "plugin-data", "clear-chat", "history");
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  assert.equal(fs.statSync(monthFile).mode & 0o777, 0o600);
  const month = readJson(monthFile);
  assert.equal(month.version, 1);
  assert.deepEqual(month.messages.map(record => record.text), ["first words", "second words"]);
  for (const record of month.messages) assert.match(record.key, /^[0-9a-f]{16}$/);
  const meta = readJson(archivePath(home, "meta.json"));
  assert.equal(meta.version, 1);
  assert.deepEqual(meta.months, { [MONTH]: 2 });
  assert.equal(meta.updatedAt, new Date(Date.UTC(2026, 10, 20, 4, 0, 0)).toISOString());
});

test("a second identical merge does not rewrite the month file or meta", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "same words")];
  await archive(home).merge(rows);
  const old = new Date("2000-01-01T00:00:00.000Z");
  const files = [archivePath(home, `messages-${MONTH}.json`), archivePath(home, "meta.json")];
  for (const file of files) fs.utimesSync(file, old, old);
  await archive(home).merge(rows);
  for (const file of files) {
    assert.equal(fs.statSync(file).mtimeMs, old.getTime(), `${file} must stay untouched`);
  }
  assert.equal(monthRecords(home).length, 1, "a repeated read adds no duplicate record");
});

test("an existing key keeps the record that was stored first", async t => {
  const home = createHome(t);
  const first = message("s1", "agent-old", T, "unchanged words");
  await archive(home).merge([first]);
  const second = message("s1", "agent-new", T, "unchanged words");
  const merged = await archive(home).merge([second]);
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messages[0].agentId, "agent-old");
  assert.equal(monthRecords(home)[0].agentId, "agent-old");
});

test("two merges at once leave the union in the archive", async t => {
  const home = createHome(t);
  const instance = archive(home);
  await Promise.all([
    instance.merge([message("s1", "agent-a", T, "from the first call")]),
    instance.merge([message("s2", "agent-b", T + 1000, "from the second call")]),
  ]);
  const records = allRecords(home);
  assert.deepEqual(records.map(record => record.text).sort(), ["from the first call", "from the second call"]);
  assert.equal(readJson(archivePath(home, `messages-${MONTH}.json`)).version, 1);
});

test("a corrupt month file is renamed bad and the next merge rebuilds it", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "recover me")];
  await archive(home).merge(rows);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  fs.writeFileSync(archivePath(home, `messages-${MONTH}.json.bad`), "older bad copy");
  const corrupt = "{\"version\":1,\"messages\":[";
  fs.writeFileSync(monthFile, corrupt);
  const merged = await archive(home).merge(rows);
  assert.equal(merged.cacheError, false);
  assert.equal(fs.readFileSync(archivePath(home, `messages-${MONTH}.json.bad`), "utf8"), corrupt);
  assert.deepEqual(readJson(monthFile).messages.map(record => record.text), ["recover me"]);
});

test("an unknown version and a truncated file are both treated as corrupt", async t => {
  const home = createHome(t);
  fs.mkdirSync(join(home, "plugin-data", "clear-chat", "history"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(archivePath(home, "messages-2026-10.json"), JSON.stringify({ version: 2, messages: [] }));
  fs.writeFileSync(archivePath(home, "messages-2026-11.json"), "{\"version\":1,");
  const rows = [
    message("s1", "agent-a", Date.UTC(2026, 9, 20, 3, 0, 0), "october"),
    message("s1", "agent-a", T, "november"),
  ];
  const merged = await archive(home).merge(rows);
  assert.equal(merged.cacheError, false);
  assert.equal(fs.existsSync(archivePath(home, "messages-2026-10.json.bad")), true);
  assert.equal(fs.existsSync(archivePath(home, "messages-2026-11.json.bad")), true);
  assert.deepEqual(readJson(archivePath(home, "messages-2026-10.json")).messages.map(r => r.text), ["october"]);
  assert.deepEqual(readJson(archivePath(home, "messages-2026-11.json")).messages.map(r => r.text), ["november"]);
});

test("a month path that cannot be read is renamed bad and replaced", async t => {
  const home = createHome(t);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  fs.mkdirSync(monthFile, { recursive: true });
  const merged = await archive(home).merge([message("s1", "agent-a", T, "after the read error")]);
  assert.equal(merged.cacheError, false);
  assert.equal(fs.statSync(`${monthFile}.bad`).isDirectory(), true);
  assert.deepEqual(readJson(monthFile).messages.map(record => record.text), ["after the read error"]);
});

test("a corrupt meta file is renamed and rebuilt from the month files", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "counted")];
  await archive(home).merge(rows);
  fs.writeFileSync(archivePath(home, "meta.json"), "{not json");
  const merged = await archive(home).merge(rows);
  assert.equal(merged.cacheError, false);
  assert.equal(fs.existsSync(archivePath(home, "meta.json.bad")), true);
  assert.deepEqual(readJson(archivePath(home, "meta.json")).months, { [MONTH]: 1 });
});

test("a write failure answers from the fast rows and reports cacheError", async t => {
  const home = createHome(t);
  const blocked = join(home, "plugin-data", "clear-chat", "history");
  fs.mkdirSync(join(blocked, ".."), { recursive: true });
  fs.writeFileSync(blocked, "a file where the archive directory should be");
  const rows = [message("s1", "agent-a", T, "not stored")];
  const merged = await archive(home).merge(rows);
  assert.equal(merged.cacheError, true);
  assert.deepEqual(merged.messages.map(record => record.text), ["not stored"]);
  assert.match(merged.messages[0].key, /^[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(archivePath(home, `messages-${MONTH}.json`)), false);
});

test("the month size cap stores new rows without text and reports cacheFull", async t => {
  const home = createHome(t);
  const rows = Array.from({ length: 10 }, (_, index) =>
    message("s1", "agent-a", T + index * 1000, `message number ${index}`));
  const merged = await archive(home, { maxMonthBytes: 800 }).merge(rows);
  assert.equal(merged.cacheError, false);
  assert.deepEqual(merged.cacheFull, [MONTH]);
  const records = monthRecords(home);
  assert.equal(records.length, 10);
  for (const record of records) assert.equal(record.text, undefined, "new records are count-only");
  const size = fs.statSync(archivePath(home, `messages-${MONTH}.json`)).size;
  assert.ok(size <= 800, `the count-only month file is ${size} bytes`);
  const counted = archiveModule.countByDay(merged.messages, "Asia/Tokyo");
  assert.deepEqual(counted.days, [{ day: "2026-11-20", count: 10 }]);
});

test("records stored before the cap keep their text", async t => {
  const home = createHome(t);
  await archive(home, { maxMonthBytes: 800 }).merge([message("s1", "agent-a", T, "kept text")]);
  const more = Array.from({ length: 10 }, (_, index) =>
    message("s1", "agent-a", T + 1000 + index * 1000, `later message ${index}`));
  const merged = await archive(home, { maxMonthBytes: 800 }).merge(more);
  assert.deepEqual(merged.cacheFull, [MONTH]);
  const records = monthRecords(home);
  assert.equal(records.find(record => record.text === "kept text")?.text, "kept text");
  assert.equal(records.filter(record => record.text === undefined).length, 10);
});

test("a day Hermes deleted is still served from the archive", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "first old words" },
    { sessionId: "s1", at: T + 1000, text: "second old words" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  const first = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(first.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(first.fromCache, 0);
  const firstDetail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.equal(firstDetail.fromCache, 0);

  fs.rmSync(fixture.databasePath);
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(second.fastConversations, 0);
  assert.equal(second.fromCache, 2);
  const secondDetail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(secondDetail.rows.map(row => row.text), ["second old words", "first old words"]);
  assert.equal(secondDetail.fromCache, 2);
});

test("fromCache counts only the rows the fast read no longer returns", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "still in Hermes" },
    { sessionId: "s1", at: T + 1000, text: "pruned from Hermes" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  removeMessage(fixture.databasePath, "pruned from Hermes");
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(second.fromCache, 1);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.equal(detail.rows.length, 2);
  assert.equal(detail.fromCache, 1);
});

test("the same archive serves different zones with different day boundaries", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: Date.UTC(2026, 10, 20, 15, 30), text: "just after Tokyo midnight" },
    { sessionId: "s1", at: Date.UTC(2026, 10, 21, 4, 30), text: "late evening in New York" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  const tokyo = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(tokyo.days, [{ day: "2026-11-21", count: 2 }]);
  const newYork = await handlers.get("history.days")({ timeZone: "America/New_York" }, { paseo: list });
  assert.deepEqual(newYork.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(allRecords(home).length, 2);
});

test("a December UTC row that is January in Tokyo stays in the December month file", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: Date.UTC(2026, 11, 31, 15, 30), text: "new year in Tokyo" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  const tokyo = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(tokyo.days, [{ day: "2027-01-01", count: 1 }]);
  const utc = await handlers.get("history.days")({ timeZone: "UTC" }, { paseo: list });
  assert.deepEqual(utc.days, [{ day: "2026-12-31", count: 1 }]);
  assert.equal(fs.existsSync(archivePath(home, "messages-2026-12.json")), true);
  assert.equal(fs.existsSync(archivePath(home, "messages-2027-01.json")), false);
});

test("two RPC calls at once leave the union of both fast reads", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "message on one session" },
    { sessionId: "s2", at: T + 1000, text: "message on another session" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const first = paseo([agent("agent-a", "s1")]);
  const second = paseo([agent("agent-b", "s2")]);
  const days = handlers.get("history.days");
  await Promise.all([
    days({ timeZone: "Asia/Tokyo" }, { paseo: first }),
    days({ timeZone: "Asia/Tokyo" }, { paseo: second }),
  ]);
  const records = allRecords(home);
  assert.deepEqual(records.map(record => record.text).sort(), [
    "message on another session",
    "message on one session",
  ]);
  assert.equal(readJson(archivePath(home, `messages-${MONTH}.json`)).version, 1);
});

test("a cache write failure keeps both RPCs answering with cacheError", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "fast answer" }]);
  const blocked = join(home, "plugin-data", "clear-chat", "history");
  fs.mkdirSync(join(blocked, ".."), { recursive: true });
  fs.writeFileSync(blocked, "blocked");
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  const days = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(days.fromCache, 0);
  assert.equal(days.cacheError, true);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["fast answer"]);
  assert.equal(detail.cacheError, true);
});

test("the size cap reaches the RPC result and keeps the day count", async t => {
  const home = createHome(t);
  const rows = Array.from({ length: 6 }, (_, index) =>
    ({ sessionId: "s1", at: T + index * 1000, text: `capped message ${index}` }));
  const fixture = createHermes(t, rows);
  const handlers = register(t, { root: fixture.hermes, home, maxMonthBytes: 500 });
  const list = paseo([agent("agent-a", "s1")]);
  const days = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 6 }]);
  assert.deepEqual(days.cacheFull, [MONTH]);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.equal(detail.rows.length, 0, "count-only records have no text to show");
  // Nothing new was added by the day call, so no month hit the cap in that call.
  assert.equal(detail.cacheFull, undefined);
});

test("the archive key is derived from the session id, instant and text", () => {
  const key = archiveModule.archiveKey("session-1", 1234, "hello");
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(key, createHash("sha256").update("session-1\u00001234\u0000hello", "utf8").digest("hex").slice(0, 16));
  assert.notEqual(key, archiveModule.archiveKey("session-2", 1234, "hello"));
  assert.notEqual(key, archiveModule.archiveKey("session-1", 1235, "hello"));
  assert.notEqual(key, archiveModule.archiveKey("session-1", 1234, "hello!"));
});
