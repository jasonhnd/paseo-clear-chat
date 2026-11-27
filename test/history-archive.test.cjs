const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { dirname, join, resolve, sep } = require("node:path");
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

const FAILING_VIEW_SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY);
  CREATE TABLE raw_messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    timestamp REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_raw_messages_session ON raw_messages(session_id, id);
  CREATE VIEW messages AS
    SELECT id, session_id, role, content, timestamp, active, compacted,
      CASE WHEN session_id = 's-broken' THEN json_extract('{bad', '$.x') ELSE NULL END AS display_metadata
    FROM raw_messages;
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

function createDatabaseAt(path, rows) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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
  return path;
}

function createHermes(t, rows) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-archive-hermes-"));
  assert.equal(outsideRepository(root), true, "the Hermes root must live outside the repository");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hermes = join(root, "hermes");
  const databasePath = createDatabaseAt(join(hermes, "state.db"), rows);
  return { hermes, databasePath };
}

function createWalHermes(t, rows) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-archive-wal-"));
  assert.equal(outsideRepository(root), true, "the Hermes root must live outside the repository");
  const hermes = join(root, "hermes");
  fs.mkdirSync(hermes, { recursive: true });
  const databasePath = join(hermes, "state.db");
  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(SCHEMA);
  for (const sessionId of new Set(rows.map(row => row.sessionId))) {
    writer.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
  }
  const insert = writer.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata)
    VALUES (?, 'user', ?, ?, 1, 0, NULL)
  `);
  for (const row of rows) insert.run(row.sessionId, row.text, row.at / 1000);
  t.after(() => {
    try {
      writer.close();
    } catch {
      // Already closed by a test.
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { hermes, databasePath, writer };
}

/** Run *callback* just before the reader prepares its first `FROM messages` query. */
function interceptFirstMessagesPrepare(t, callback) {
  const prototype = DatabaseSync.prototype;
  const original = prototype.prepare;
  let fired = false;
  prototype.prepare = function patchedPrepare(sql, ...args) {
    if (!fired && typeof sql === "string" && sql.includes("FROM messages")) {
      fired = true;
      callback();
    }
    return original.call(this, sql, ...args);
  };
  t.after(() => {
    prototype.prepare = original;
  });
  return () => fired;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}


function createFailingDatabase(t, hermes) {
  const path = join(hermes, "state.db");
  fs.rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(FAILING_VIEW_SCHEMA);
  db.prepare("INSERT INTO sessions (id) VALUES ('s-broken')").run();
  db.prepare("INSERT INTO raw_messages (id, session_id, role, content, timestamp, active, compacted) VALUES (1, 's-broken', 'user', 'boom', ?, 1, 0)")
    .run(T / 1000);
  db.close();
  return path;
}

function editDatabase(path, change) {
  const db = new DatabaseSync(path);
  try {
    change(db);
  } finally {
    db.close();
  }
}

function archivePath(home, name) {
  return join(home, "plugin-data", "clear-chat", "history", name);
}

function archiveDirectory(home) {
  return join(home, "plugin-data", "clear-chat", "history");
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function monthRecords(home, month = MONTH) {
  return readJson(archivePath(home, `messages-${month}.json`)).messages;
}

function allRecords(home) {
  return fs.readdirSync(archiveDirectory(home))
    .filter(name => /^messages-\d{4}-\d{2}\.json$/.test(name))
    .flatMap(name => readJson(join(archiveDirectory(home), name)).messages);
}

function badFiles(home, name = `messages-${MONTH}.json`) {
  return fs.readdirSync(archiveDirectory(home)).filter(entry => entry.startsWith(`${name}.bad-`)).sort();
}

function directorySnapshot(home) {
  const directory = archiveDirectory(home);
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const info = fs.statSync(join(directory, name));
    return [name, `${info.mtimeMs}:${info.size}`];
  }));
}

function archive(home, options = {}) {
  return new archiveModule.HistoryArchive({ home, now: () => Date.UTC(2026, 10, 20, 4, 0, 0), ...options });
}

function message(sessionId, agentId, at, text) {
  return { sessionId, agentId, at, text };
}

function sessionsOf(rows) {
  return [...new Set(rows.map(row => row.sessionId))];
}

function merge(instance, rows, sessions = sessionsOf(rows)) {
  return instance.merge(rows, sessions);
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

test("the first merge writes a version 2 month file and meta with private permissions", async t => {
  const home = createHome(t);
  const rows = [
    message("s1", "agent-a", T, "first words"),
    message("s1", "agent-a", T + 1000, "second words"),
  ];
  const merged = await merge(archive(home), rows);
  assert.equal(merged.cacheError, false);
  assert.equal(merged.messages.length, 2);
  const directory = archiveDirectory(home);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(archivePath(home, `messages-${MONTH}.json`)).mode & 0o777, 0o600);
  const month = readJson(archivePath(home, `messages-${MONTH}.json`));
  assert.equal(month.version, 2);
  assert.deepEqual(month.messages.map(record => record.text), ["first words", "second words"]);
  assert.deepEqual(month.messages.map(record => record.sessionId), ["s1", "s1"]);
  for (const record of month.messages) assert.match(record.key, /^[0-9a-f]{16}$/);
  const meta = readJson(archivePath(home, "meta.json"));
  assert.equal(meta.version, 2);
  assert.deepEqual(meta.months, { [MONTH]: 2 });
  assert.equal(meta.updatedAt, new Date(Date.UTC(2026, 10, 20, 4, 0, 0)).toISOString());
});

test("only the history directory is forced to 0700; parents keep the umask mode", async t => {
  const home = createHome(t);
  await merge(archive(home), [message("s1", "agent-a", T, "one")]);
  const expectedParent = 0o777 & ~process.umask();
  assert.equal(fs.statSync(join(home, "plugin-data")).mode & 0o777, expectedParent);
  assert.equal(fs.statSync(join(home, "plugin-data", "clear-chat")).mode & 0o777, expectedParent);
  assert.equal(fs.statSync(archiveDirectory(home)).mode & 0o777, 0o700);
});

test("a second identical merge does not rewrite the month file or meta", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "same words")];
  await merge(archive(home), rows);
  const old = new Date("2000-01-01T00:00:00.000Z");
  const files = [archivePath(home, `messages-${MONTH}.json`), archivePath(home, "meta.json")];
  for (const file of files) fs.utimesSync(file, old, old);
  await merge(archive(home), rows);
  for (const file of files) {
    assert.equal(fs.statSync(file).mtimeMs, old.getTime(), `${file} must stay untouched`);
  }
  assert.equal(monthRecords(home).length, 1, "a repeated read adds no duplicate record");
});

test("a read session replaces its stored records instead of growing", async t => {
  const home = createHome(t);
  await merge(archive(home), [message("s1", "agent-old", T, "first wording")]);
  const merged = await merge(archive(home), [message("s1", "agent-new", T, "second wording")], ["s1"]);
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messages[0].text, "second wording");
  assert.equal(merged.messages[0].agentId, "agent-new");
  assert.equal(monthRecords(home).length, 1);
});

test("two merges at once leave the union in the archive", async t => {
  const home = createHome(t);
  const instance = archive(home);
  await Promise.all([
    instance.merge([message("s1", "agent-a", T, "from the first call")], ["s1"]),
    instance.merge([message("s2", "agent-b", T + 1000, "from the second call")], ["s2"]),
  ]);
  const records = allRecords(home);
  assert.deepEqual(records.map(record => record.text).sort(), ["from the first call", "from the second call"]);
  assert.equal(readJson(archivePath(home, `messages-${MONTH}.json`)).version, 2);
});

test("corrupt content is renamed with a timestamp and rebuilt", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "recover me")];
  await merge(archive(home), rows);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const corrupt = "{\"version\":2,\"messages\":[";
  fs.writeFileSync(monthFile, corrupt);
  const merged = await merge(archive(home), rows);
  assert.equal(merged.cacheError, false);
  const bad = badFiles(home);
  assert.equal(bad.length, 1);
  assert.equal(fs.readFileSync(join(archiveDirectory(home), bad[0]), "utf8"), corrupt);
  assert.deepEqual(readJson(monthFile).messages.map(record => record.text), ["recover me"]);
});

test("keeps the first damaged copy and the newest two", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "still here")];
  await merge(archive(home), rows);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const prefix = `messages-${MONTH}.json.bad`;
  const directory = archiveDirectory(home);
  for (const [stamp, text] of [
    ["1000000000001", "oldest"],
    ["1000000000002", "second"],
    ["1000000000003", "third"],
    ["1000000000004", "fourth"],
  ]) {
    fs.writeFileSync(join(directory, `${prefix}-${stamp}-1-a`), text);
  }
  fs.writeFileSync(monthFile, "{not json");
  await merge(archive(home), rows);
  const kept = badFiles(home).map(name => fs.readFileSync(join(directory, name), "utf8"));
  assert.equal(kept.length, 3);
  assert.ok(kept.includes("oldest"), "the first damaged copy must survive");
  assert.ok(kept.includes("fourth"), "the newest copy must survive");
  assert.ok(kept.includes("{not json"), "the copy made now must survive");
  assert.equal(kept.includes("second"), false);
  assert.equal(kept.includes("third"), false);
});

test("an old version 1 archive and a truncated file are both treated as corrupt", async t => {
  const home = createHome(t);
  fs.mkdirSync(archiveDirectory(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(archivePath(home, "messages-2026-10.json"), JSON.stringify({ version: 1, messages: [] }));
  fs.writeFileSync(archivePath(home, "messages-2026-11.json"), "{\"version\":2,");
  const rows = [
    message("s1", "agent-a", Date.UTC(2026, 9, 20, 3, 0, 0), "october"),
    message("s1", "agent-a", T, "november"),
  ];
  const merged = await merge(archive(home), rows);
  assert.equal(merged.cacheError, false);
  assert.equal(badFiles(home, "messages-2026-10.json").length, 1);
  assert.equal(badFiles(home, "messages-2026-11.json").length, 1);
  assert.deepEqual(readJson(archivePath(home, "messages-2026-10.json")).messages.map(r => r.text), ["october"]);
  assert.deepEqual(readJson(archivePath(home, "messages-2026-11.json")).messages.map(r => r.text), ["november"]);
});

test("a file read error is not corruption: no rename, no write, cacheError", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "protected")];
  await merge(archive(home), rows);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const before = fs.readFileSync(monthFile, "utf8");
  const beforeDirectory = directorySnapshot(home);
  const failing = archive(home, {
    files: {
      readFile: async path => {
        if (path === monthFile) {
          const error = new Error("too many open files");
          error.code = "EMFILE";
          throw error;
        }
        return fs.promises.readFile(path, "utf8");
      },
    },
  });
  const merged = await merge(failing, [message("s1", "agent-a", T, "protected")]);
  assert.equal(merged.cacheError, true);
  assert.equal(fs.readFileSync(monthFile, "utf8"), before);
  assert.equal(badFiles(home).length, 0);
  assert.deepEqual(directorySnapshot(home), beforeDirectory);
});

test("a month path that cannot be read is not renamed", async t => {
  const home = createHome(t);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  fs.mkdirSync(monthFile, { recursive: true });
  const merged = await merge(archive(home), [message("s1", "agent-a", T, "after the read error")]);
  assert.equal(merged.cacheError, true);
  assert.equal(fs.statSync(monthFile).isDirectory(), true);
  assert.equal(badFiles(home).length, 0);
  fs.rmSync(monthFile, { recursive: true, force: true });
  const retried = await merge(archive(home), [message("s1", "agent-a", T, "after the read error")]);
  assert.equal(retried.cacheError, false);
  assert.deepEqual(readJson(monthFile).messages.map(record => record.text), ["after the read error"]);
});

test("a corrupt meta file is renamed and rebuilt from the month files", async t => {
  const home = createHome(t);
  const rows = [message("s1", "agent-a", T, "counted")];
  await merge(archive(home), rows);
  fs.writeFileSync(archivePath(home, "meta.json"), "{not json");
  const merged = await merge(archive(home), rows);
  assert.equal(merged.cacheError, false);
  assert.equal(badFiles(home, "meta.json").length, 1);
  assert.deepEqual(readJson(archivePath(home, "meta.json")).months, { [MONTH]: 1 });
});

test("a write failure answers from the fast rows and reports cacheError", async t => {
  const home = createHome(t);
  const blocked = join(home, "plugin-data", "clear-chat", "history");
  fs.mkdirSync(join(blocked, ".."), { recursive: true });
  fs.writeFileSync(blocked, "a file where the archive directory should be");
  const rows = [message("s1", "agent-a", T, "not stored")];
  const merged = await merge(archive(home), rows);
  assert.equal(merged.cacheError, true);
  assert.deepEqual(merged.messages.map(record => record.text), ["not stored"]);
  assert.match(merged.messages[0].key, /^[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(archivePath(home, `messages-${MONTH}.json`)), false);
});

test("a read directory failure does not write anything", async t => {
  const home = createHome(t);
  await merge(archive(home), [message("s1", "agent-a", T, "kept")]);
  const before = directorySnapshot(home);
  const failing = archive(home, {
    files: {
      readdir: async () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
    },
  });
  const merged = await merge(failing, [message("s2", "agent-b", T + 1000, "must not appear")], ["s2"]);
  assert.equal(merged.cacheError, true);
  assert.deepEqual(directorySnapshot(home), before);
  assert.deepEqual(allRecords(home).map(record => record.text), ["kept"]);
});

test("the month size cap stores new rows without text and reports cacheFull", async t => {
  const home = createHome(t);
  const rows = Array.from({ length: 10 }, (_, index) =>
    message("s1", "agent-a", T + index * 1000, `message number ${index}`));
  const merged = await merge(archive(home, { maxMonthBytes: 900 }), rows);
  assert.equal(merged.cacheError, false);
  assert.deepEqual(merged.cacheFull, [MONTH]);
  const records = monthRecords(home);
  assert.equal(records.length, 10);
  for (const record of records) assert.equal(record.text, undefined, "new records are count-only");
  const size = fs.statSync(archivePath(home, `messages-${MONTH}.json`)).size;
  assert.ok(size <= 900, `the count-only month file is ${size} bytes`);
  const counted = archiveModule.countByDay(merged.messages, "Asia/Tokyo");
  assert.deepEqual(counted.days, [{ day: "2026-11-20", count: 10 }]);
});

test("records stored before the cap keep their text", async t => {
  const home = createHome(t);
  const first = message("s1", "agent-a", T, "kept text");
  await merge(archive(home, { maxMonthBytes: 800 }), [first]);
  const later = [
    first,
    ...Array.from({ length: 10 }, (_, index) =>
      message("s1", "agent-a", T + 1000 + index * 1000, `later message ${index}`)),
  ];
  const merged = await merge(archive(home, { maxMonthBytes: 800 }), later, ["s1"]);
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

  fs.rmSync(fixture.databasePath);
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(second.fastConversations, 0);
  assert.equal(second.fromCache, 2);
  const secondDetail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(secondDetail.rows.map(row => row.text), ["second old words", "first old words"]);
  assert.equal(secondDetail.fromCache, 2);
});

test("a session Hermes still has follows Hermes, including a pruned row", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "still in Hermes" },
    { sessionId: "s1", at: T + 1000, text: "pruned from Hermes" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  editDatabase(fixture.databasePath, db => {
    db.prepare("DELETE FROM messages WHERE content = ?").run("pruned from Hermes");
  });
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(second.fromCache, 0);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["still in Hermes"]);
});

test("a deleted session is served from the archive while a live one comes from Hermes", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "from the deleted session" }]);
  const profilePath = createDatabaseAt(
    join(fixture.hermes, "profiles", "work", "state.db"),
    [{ sessionId: "s2", at: T + 1000, text: "from the live session" }],
  );
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1"), agent("agent-b", "s2")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  fs.rmSync(fixture.databasePath);
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(second.fromCache, 1);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["from the live session", "from the deleted session"]);
  assert.equal(detail.fromCache, 1);
  assert.equal(fs.existsSync(profilePath), true);
});

test("a database that fails mid-read keeps its archived sessions", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s-broken", at: T, text: "before the failure" }]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-broken", "s-broken")]);
  const first = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(first.days, [{ day: "2026-11-20", count: 1 }]);

  createFailingDatabase(t, fixture.hermes);
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(second.fromCache, 1);
});

test("a corrupt meta does not stop the read-only day answer", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "first archived words" },
    { sessionId: "s1", at: T + 1000, text: "second archived words" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  fs.rmSync(fixture.databasePath);
  fs.writeFileSync(archivePath(home, "meta.json"), "{not json");
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["second archived words", "first archived words"]);
  assert.equal(detail.fromCache, 2);
  assert.equal(detail.cacheError, undefined);
});

test("a database that cannot be opened keeps its archived sessions", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "kept while unreadable" }]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  fs.writeFileSync(fixture.databasePath, "this is not a database");
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(second.fromCache, 1);
  assert.deepEqual(second.skippedDatabases, ["state.db"]);
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
  const list = paseo([agent("agent-a", "s1"), agent("agent-b", "s2")]);
  const days = handlers.get("history.days");
  await Promise.all([
    days({ timeZone: "Asia/Tokyo" }, { paseo: list }),
    days({ timeZone: "Asia/Tokyo" }, { paseo: list }),
  ]);
  const records = allRecords(home);
  assert.deepEqual(records.map(record => record.text).sort(), [
    "message on another session",
    "message on one session",
  ]);
  assert.equal(readJson(archivePath(home, `messages-${MONTH}.json`)).version, 2);
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

test("the size cap reaches the days RPC and the day RPC still shows the fast text", async t => {
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
  assert.equal(detail.rows.length, 6, "Hermes still has the text, so the day RPC shows it");
  assert.equal(detail.cacheFull, undefined);
});

test("the day RPC writes no files", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "read only day" }]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  const before = directorySnapshot(home);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["read only day"]);
  assert.deepEqual(directorySnapshot(home), before);
});

test("the day RPC filters archived rows to the requested day", async t => {
  const home = createHome(t);
  const nextDay = T + 24 * 60 * 60 * 1000;
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "on the first day" },
    { sessionId: "s1", at: nextDay, text: "on the second day" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  fs.rmSync(fixture.databasePath);
  const first = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(first.rows.map(row => row.text), ["on the first day"]);
  assert.equal(first.fromCache, 1);
  const second = await handlers.get("history.day")({ day: "2026-11-21", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.rows.map(row => row.text), ["on the second day"]);
  assert.equal(second.fromCache, 1);
});

test("a fresh lock blocks the write and answers from memory; a stale lock is taken over", async t => {
  const home = createHome(t);
  await merge(archive(home), [message("s1", "agent-a", T, "existing")]);
  const directory = archiveDirectory(home);
  const lock = join(directory, ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.UTC(2026, 10, 20, 4, 0, 0) }));
  const blocked = await merge(archive(home), [message("s2", "agent-b", T + 1000, "blocked write")], ["s2"]);
  assert.equal(blocked.cacheError, true);
  assert.deepEqual(blocked.messages.map(record => record.text).sort(), ["blocked write", "existing"]);
  assert.deepEqual(allRecords(home).map(record => record.text), ["existing"]);

  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.UTC(2026, 10, 20, 4, 0, 0) - 31_000 }));
  const taken = await merge(archive(home), [message("s2", "agent-b", T + 1000, "blocked write")], ["s2"]);
  assert.equal(taken.cacheError, false);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(allRecords(home).map(record => record.text).sort(), ["blocked write", "existing"]);
});

test("two archive instances on one home do not overwrite each other", async t => {
  const home = createHome(t);
  const first = archive(home);
  const second = archive(home);
  const firstRows = [message("s1", "agent-a", T, "from process A")];
  const secondRows = [message("s2", "agent-b", T + 1000, "from process B")];
  const [a, b] = await Promise.all([
    first.merge(firstRows, ["s1"]),
    second.merge(secondRows, ["s2"]),
  ]);
  assert.ok(a.cacheError === false || b.cacheError === false, "one instance must take the lock");
  const afterBoth = allRecords(home).map(record => record.text);
  if (!a.cacheError) assert.ok(afterBoth.includes("from process A"), "A's write must not be lost");
  if (!b.cacheError) assert.ok(afterBoth.includes("from process B"), "B's write must not be lost");
  if (a.cacheError) await first.merge(firstRows, ["s1"]);
  if (b.cacheError) await second.merge(secondRows, ["s2"]);
  assert.deepEqual(allRecords(home).map(record => record.text).sort(), ["from process A", "from process B"]);
});

test("a compaction that rewrites the live text keeps one message", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "please fix the bug" }]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  const before = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(before.days, [{ day: "2026-11-20", count: 1 }]);

  editDatabase(fixture.databasePath, db => {
    db.prepare("UPDATE messages SET active = 0, compacted = 1 WHERE content = ?").run("please fix the bug");
    db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp, active, compacted)
      VALUES ('s1', 'user', ?, ?, 1, 0)
    `).run("[Context summary: earlier turns]\n\nplease fix the bug", T / 1000);
  });
  const after = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(after.days, [{ day: "2026-11-20", count: 1 }]);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["[Context summary: earlier turns]\n\nplease fix the bug"]);
});

test("a retracted message disappears and a resent one counts once", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "will be retracted" }]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });

  editDatabase(fixture.databasePath, db => {
    db.prepare("UPDATE messages SET active = 0, compacted = 0 WHERE content = ?").run("will be retracted");
  });
  const retracted = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(retracted.days, []);

  editDatabase(fixture.databasePath, db => {
    db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp, active, compacted)
      VALUES ('s1', 'user', ?, ?, 1, 0)
    `).run("will be retracted", T / 1000);
  });
  const resent = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(resent.days, [{ day: "2026-11-20", count: 1 }]);
});

test("a changed classification result replaces the old record instead of doubling", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [{ sessionId: "s1", at: T, text: "original words" }]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  editDatabase(fixture.databasePath, db => {
    db.prepare("UPDATE messages SET content = ? WHERE content = ?").run("changed words", "original words");
  });
  const after = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(after.days, [{ day: "2026-11-20", count: 1 }]);
  const detail = await handlers.get("history.day")({ day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(detail.rows.map(row => row.text), ["changed words"]);
});

test("a session Hermes still has but no conversation points at is dropped", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "copied words" },
    { sessionId: "s2", at: T, text: "copied words" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const first = await handlers.get("history.days")(
    { timeZone: "Asia/Tokyo" },
    { paseo: paseo([agent("agent-a", "s1")]) },
  );
  assert.deepEqual(first.days, [{ day: "2026-11-20", count: 1 }]);

  const switched = await handlers.get("history.days")(
    { timeZone: "Asia/Tokyo" },
    { paseo: paseo([agent("agent-b", "s2")]) },
  );
  assert.deepEqual(switched.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(switched.fromCache, 0);
  assert.deepEqual(allRecords(home).map(record => record.sessionId), ["s2"]);

  const detail = await handlers.get("history.day")(
    { day: "2026-11-20", timeZone: "Asia/Tokyo" },
    { paseo: paseo([agent("agent-b", "s2")]) },
  );
  assert.deepEqual(detail.rows.map(row => row.text), ["copied words"]);

  editDatabase(fixture.databasePath, db => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run("s1");
    db.prepare("DELETE FROM sessions WHERE id = ?").run("s1");
  });
  const afterDelete = await handlers.get("history.days")(
    { timeZone: "Asia/Tokyo" },
    { paseo: paseo([agent("agent-b", "s2")]) },
  );
  assert.deepEqual(afterDelete.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(afterDelete.fromCache, 0);
  assert.deepEqual(allRecords(home).map(record => record.sessionId), ["s2"]);
});

test("the size cap still holds when the capped session is replaced", async t => {
  const home = createHome(t);
  const rows = Array.from({ length: 10 }, (_, index) =>
    message("s1", "agent-a", T + index * 1000, `capped message ${index}`));
  const later = [...rows, message("s1", "agent-a", T + 20_000, "one new message")];
  const instance = archive(home, { maxMonthBytes: 1000 });
  const first = await merge(instance, rows, ["s1"]);
  assert.deepEqual(first.cacheFull, [MONTH]);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const firstSize = fs.statSync(monthFile).size;
  assert.ok(firstSize <= 1000, `the count-only file is ${firstSize} bytes`);
  assert.equal(monthRecords(home).every(record => record.text === undefined), true);

  const second = await merge(instance, later, ["s1"]);
  assert.equal(second.cacheError, false);
  assert.ok(fs.statSync(monthFile).size <= 1000,
    `the replaced month is ${fs.statSync(monthFile).size} bytes`);
  assert.equal(monthRecords(home).every(record => record.text === undefined), true);
  const afterSecond = fs.statSync(monthFile).mtimeMs;

  const third = await merge(instance, later, ["s1"]);
  assert.equal(third.cacheError, false);
  assert.ok(fs.statSync(monthFile).size <= 1000);
  assert.equal(fs.statSync(monthFile).mtimeMs, afterSecond, "a capped read must not rewrite the month");
});

test("two identical rows in one millisecond stay two and do not rewrite", async t => {
  const home = createHome(t);
  const fixture = createHermes(t, [
    { sessionId: "s1", at: T, text: "ok" },
    { sessionId: "s1", at: T, text: "ok" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "s1")]);
  const first = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(first.days, [{ day: "2026-11-20", count: 2 }]);
  const detail = await handlers.get("history.day")(
    { day: "2026-11-20", timeZone: "Asia/Tokyo" }, { paseo: list },
  );
  assert.equal(detail.rows.length, 2);
  assert.equal(allRecords(home).length, 2);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const mtime = fs.statSync(monthFile).mtimeMs;

  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(fs.statSync(monthFile).mtimeMs, mtime, "an identical read must not rewrite the month");
});

test("a prune that commits during a read keeps the archived session", async t => {
  const home = createHome(t);
  const fixture = createWalHermes(t, [
    { sessionId: "old", at: T, text: "survives the prune" },
    { sessionId: "new", at: T + 1000, text: "still in Hermes" },
  ]);
  const handlers = register(t, { root: fixture.hermes, home });
  const list = paseo([agent("agent-a", "old"), agent("agent-b", "new")]);
  const first = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.deepEqual(first.days, [{ day: "2026-11-20", count: 2 }]);

  const fired = interceptFirstMessagesPrepare(t, () => {
    fixture.writer.exec("BEGIN IMMEDIATE");
    fixture.writer.prepare("DELETE FROM messages WHERE session_id = ?").run("old");
    fixture.writer.prepare("DELETE FROM sessions WHERE id = ?").run("old");
    fixture.writer.exec("COMMIT");
  });
  const second = await handlers.get("history.days")({ timeZone: "Asia/Tokyo" }, { paseo: list });
  assert.equal(fired(), true);
  assert.deepEqual(second.days, [{ day: "2026-11-20", count: 2 }]);
  assert.equal(second.fromCache, 0);
  assert.deepEqual(allRecords(home).map(record => record.text).sort(), [
    "still in Hermes",
    "survives the prune",
  ]);
});

test("only one instance takes over an expired lock", async t => {
  const home = createHome(t);
  const now = Date.UTC(2026, 10, 20, 4, 0, 0);
  await merge(archive(home), [message("base", "agent-z", T - 1000, "base")], ["base"]);
  const lock = join(archiveDirectory(home), ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, token: "old-token", at: now - 60_000 }));
  const monthFile = archivePath(home, `messages-${MONTH}.json`);

  const bReady = deferred();
  const bGate = deferred();
  const aReady = deferred();
  const aGate = deferred();
  let bReadsLock = false;
  let aMonthReads = 0;
  const second = archive(home, {
    now: () => now,
    files: {
      readFile: async path => {
        const raw = await fs.promises.readFile(path, "utf8");
        if (path === lock && !bReadsLock) {
          bReadsLock = true;
          bReady.resolve();
          await bGate.promise;
        }
        return raw;
      },
    },
  });
  const first = archive(home, {
    now: () => now,
    files: {
      readFile: async path => {
        const raw = await fs.promises.readFile(path, "utf8");
        if (path === monthFile && ++aMonthReads === 2) {
          aReady.resolve();
          await aGate.promise;
        }
        return raw;
      },
    },
  });

  const bMerge = second.merge([message("s2", "agent-b", T + 1000, "from B")], ["s2"], ["s2"]);
  await bReady.promise;
  const aMerge = first.merge([message("s1", "agent-a", T, "from A")], ["s1"], ["s1"]);
  await aReady.promise;
  bGate.resolve();
  const bResult = await bMerge;
  aGate.resolve();
  const aResult = await aMerge;

  assert.equal(aResult.cacheError, false);
  assert.equal(bResult.cacheError, true);
  assert.deepEqual(allRecords(home).map(record => record.text).sort(), ["base", "from A"]);

  const retry = await second.merge([message("s2", "agent-b", T + 1000, "from B")], ["s2"], ["s2"]);
  assert.equal(retry.cacheError, false);
  assert.deepEqual(allRecords(home).map(record => record.text).sort(), ["base", "from A", "from B"]);
});

test("release does not delete a lock owned by another process", async t => {
  const home = createHome(t);
  await merge(archive(home), [message("base", "agent-z", T - 1000, "base")], ["base"]);
  const lock = join(archiveDirectory(home), ".lock");
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const ready = deferred();
  const gate = deferred();
  let monthReads = 0;
  const instance = archive(home, {
    files: {
      readFile: async path => {
        const raw = await fs.promises.readFile(path, "utf8");
        if (path === monthFile && ++monthReads === 2) {
          ready.resolve();
          await gate.promise;
        }
        return raw;
      },
    },
  });
  const mergePromise = instance.merge([message("s1", "agent-a", T, "mine")], ["s1"], ["s1"]);
  await ready.promise;
  fs.writeFileSync(lock, JSON.stringify({ pid: 999, token: "other-owner", at: Date.now() }));
  gate.resolve();
  await mergePromise;
  const body = JSON.parse(fs.readFileSync(lock, "utf8"));
  assert.equal(body.token, "other-owner", "the release must leave another owner's lock");
});

test("the merge re-reads the archive after it takes the lock", async t => {
  const home = createHome(t);
  await merge(archive(home), [message("base", "agent-z", T - 1000, "base")], ["base"]);
  const monthFile = archivePath(home, `messages-${MONTH}.json`);
  const injected = {
    key: archiveModule.archiveKey("from-another-process", T + 2000, "written elsewhere"),
    sessionId: "from-another-process",
    agentId: "agent-x",
    at: T + 2000,
    text: "written elsewhere",
  };
  let monthReads = 0;
  const instance = archive(home, {
    files: {
      readFile: async path => {
        let raw = await fs.promises.readFile(path, "utf8");
        if (path === monthFile && ++monthReads === 2) {
          const parsed = JSON.parse(raw);
          parsed.messages.push(injected);
          raw = JSON.stringify(parsed);
          await fs.promises.writeFile(path, raw, "utf8");
        }
        return raw;
      },
    },
  });
  const merged = await instance.merge([message("s1", "agent-a", T, "mine")], ["s1"], ["s1"]);
  assert.equal(merged.cacheError, false);
  assert.deepEqual(allRecords(home).map(record => record.text).sort(), [
    "base",
    "mine",
    "written elsewhere",
  ]);
});


test("the archive key is derived from the session id, instant, text and occurrence", () => {
  const key = archiveModule.archiveKey("session-1", 1234, "hello");
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(
    key,
    createHash("sha256").update("session-1\u00001234\u0000hello\u00000", "utf8").digest("hex").slice(0, 16),
  );
  assert.notEqual(key, archiveModule.archiveKey("session-2", 1234, "hello"));
  assert.notEqual(key, archiveModule.archiveKey("session-1", 1235, "hello"));
  assert.notEqual(key, archiveModule.archiveKey("session-1", 1234, "hello!"));
  assert.notEqual(key, archiveModule.archiveKey("session-1", 1234, "hello", 1));
});
