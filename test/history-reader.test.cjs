const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { dirname, join, resolve, sep } = require("node:path");
const test = require("node:test");
const { createTsModules } = require("./helpers/ts-modules.cjs");

// Every database here is built in a temporary directory outside the repository; nothing
// reads the real Hermes data directory. `node:sqlite` is the same module the plugin uses.
const repositoryRoot = resolve(__dirname, "..");
const tsModules = createTsModules();
const reader = tsModules.load(join(repositoryRoot, "server/history-reader.ts"));
const localDay = tsModules.load(join(repositoryRoot, "client/local-day.ts"));

const OUT_OF_BAND = [
  "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]",
  "<their message>",
  "[/OUT-OF-BAND USER MESSAGE]",
].join("\n");

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

const NULLABLE_TIMESTAMP_SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    timestamp REAL,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0,
    display_metadata TEXT
  );
`;

// A `messages` view that passes PRAGMA table_info but throws for one session when read.
// The index keeps the chunk without that session from evaluating its failing expression.
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
      CASE WHEN session_id = 'bad-500' THEN json_extract('{bad', '$.x') ELSE NULL END AS display_metadata
    FROM raw_messages;
`;

function createFixture(t, { hermesName = "hermes" } = {}) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "clear-chat-history-"));
  assert.equal(
    resolve(root).startsWith(`${repositoryRoot}${sep}`),
    false,
    "a temporary Hermes root must live outside the repository",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hermes = join(root, hermesName);
  const opened = [];
  function database(profile, schema = SCHEMA) {
    const path = profile
      ? join(hermes, "profiles", profile, "state.db")
      : join(hermes, "state.db");
    fs.mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(schema);
    const entry = {
      path,
      db,
      current: null,
      session(id) {
        db.prepare("INSERT OR IGNORE INTO sessions (id) VALUES (?)").run(id);
        entry.current = id;
        return entry;
      },
      add({ session = entry.current ?? "s1", text = "hello", at, active = 1, compacted = 0, modelOnly = false, role = "user", metadata }) {
        db.prepare(`
          INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          session, role, text, at === null ? null : at / 1000, active, compacted,
          metadata === undefined
            ? (modelOnly ? JSON.stringify({ model_only: modelOnly === true ? 1 : modelOnly }) : null)
            : metadata,
        );
        return entry;
      },
    };
    opened.push(entry);
    return entry;
  }
  function close() {
    for (const entry of opened) {
      if (entry.db.isOpen) entry.db.close();
    }
  }
  return { root, hermes, database, close };
}

/**
 * A stand-in for `node:sqlite` that can reject a URL target the way Node 22.13/22.14 does.
 * It answers only what `openDatabase` asks: the column pragmas and the session index.
 */
function fakeSqliteModule({ rejectUrl = false, error = null } = {}) {
  const calls = [];
  class FakeDatabaseSync {
    constructor(target, options) {
      calls.push({ target, options });
      if (rejectUrl && target instanceof URL) throw error;
      this.target = target;
      this.isOpen = true;
    }
    prepare(sql) {
      return {
        all: () => {
          if (sql.includes("table_info(sessions)")) return [{ name: "id" }];
          if (sql.includes("table_info(messages)")) {
            return ["session_id", "role", "content", "timestamp", "active", "compacted", "display_metadata"]
              .map(name => ({ name }));
          }
          return [];
        },
        iterate: () => (sql.includes("SELECT id FROM sessions") ? [{ id: "s1" }] : []),
      };
    }
    close() { this.isOpen = false; }
  }
  return { DatabaseSync: FakeDatabaseSync, calls };
}

function withSqliteModule(t, module) {
  const original = process.getBuiltinModule;
  process.getBuiltinModule = id => (id === "node:sqlite" ? module : original.call(process, id));
  t.after(() => { process.getBuiltinModule = original; });
}

function conversation(id, sessionId, lastActiveAt = 0) {
  return { id, sessionId, lastActiveAt };
}

function readDays(fixture, conversations, timeZone = "Asia/Tokyo") {
  fixture.close();
  return reader.readHistoryDays({ conversations, root: fixture.hermes, timeZone });
}

function readDay(fixture, conversations, day, timeZone = "Asia/Tokyo") {
  fixture.close();
  return reader.readHistoryDay({ conversations, root: fixture.hermes, timeZone, day });
}

function total(snapshot) {
  return snapshot.days.reduce((sum, entry) => sum + entry.count, 0);
}

function sha256(path) {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

const T = Date.UTC(2026, 10, 20, 3, 0, 0); // 2026-11-20 12:00 in Asia/Tokyo

test("a live row absorbs a compacted copy at the same timestamp even when the text differs", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "the original request", active: 1, compacted: 0 });
  db.add({ at: T, text: "summary of the original request", active: 0, compacted: 1 });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.equal(total(days), 1);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  const detail = readDay(f, [conversation("agent-a", "s1")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text), ["the original request"]);
});

test("a live row and a compacted copy with the same text still count once", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "same words", active: 1, compacted: 0 });
  db.add({ at: T, text: "same words", active: 0, compacted: 1 });
  assert.equal(total(readDays(f, [conversation("agent-a", "s1")])), 1);
});

test("archived copies with no live row count once when their text matches and twice when it differs", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "repeated", active: 0, compacted: 1 });
  db.add({ at: T, text: "repeated", active: 0, compacted: 1 });
  db.add({ at: T + 1000, text: "first version", active: 0, compacted: 1 });
  db.add({ at: T + 1000, text: "second version", active: 0, compacted: 1 });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 3 }]);
});

test("rows Hermes marks model_only are not the person's messages", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "hidden one", modelOnly: 1 });
  db.add({ at: T + 1000, text: "hidden two", modelOnly: true });
  db.add({ at: T + 2000, text: "visible" });
  assert.deepEqual(readDays(f, [conversation("agent-a", "s1")]).days, [{ day: "2026-11-20", count: 1 }]);
});

test("blank rows and rows of whitespace are not messages", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "" });
  db.add({ at: T + 1000, text: " \n\t " });
  db.add({ at: T + 2000, text: "real words" });
  assert.equal(total(readDays(f, [conversation("agent-a", "s1")])), 1);
});

test("structured content flattens into newline-joined text the way Hermes displays it", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({
    at: T,
    text: JSON.stringify([
      { type: "text", text: "  first  " },
      { type: "text", content: "second" },
      " third ",
      { type: "image", source: { type: "base64", data: "AAAA" } },
    ]),
  });
  db.add({ at: T + 1000, text: "[{not valid json" });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.equal(total(days), 2);
  const detail = readDay(f, [conversation("agent-a", "s1")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text).sort(), ["[{not valid json", "first\nsecond\nthird"]);
});

test("bracketed letters, send headers, instruction tags and pasted context are machine messages", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  const machine = [
    "【任务】请处理",
    "发件：someone",
    "<system-reminder>use the tool</system-reminder>",
    "[IMPORTANT — a direct message from the user]read this",
    "CONTEXT:\ninternal notes",
    "<paseo-system>queued</paseo-system>",
    "Supervised process dev exited with code 0",
  ];
  for (const [index, text] of machine.entries()) db.add({ at: T + index * 1000, text });
  db.add({ at: T + 60_000, text: "帮我看一下这个日历" });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  const detail = readDay(f, [conversation("agent-a", "s1")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text), ["帮我看一下这个日历"]);
});

test("an out-of-band wrapper counts as the person's words and the row shows the body", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: OUT_OF_BAND });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  const detail = readDay(f, [conversation("agent-a", "s1")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text), ["<their message>"]);
});

test("a session shared by two conversations counts once and the detail names the most recent", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "shared words" });
  const conversations = [
    conversation("agent-old", "s1", Date.parse("2026-11-20T01:00:00Z")),
    conversation("agent-new", "s1", Date.parse("2026-11-21T01:00:00Z")),
  ];
  const days = readDays(f, conversations);
  assert.equal(total(days), 1);
  assert.equal(days.fastConversations, 2);
  assert.deepEqual(days.slowConversationIds, []);
  const detail = readDay(f, conversations, "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.agentId), ["agent-new"]);
});

test("conversations without a matching session are named on the slow path", t => {
  const f = createFixture(t);
  f.database().session("s1").add({ at: T, text: "counted" });
  const days = readDays(f, [
    conversation("agent-a", "s1"),
    conversation("agent-b", "missing-session"),
    conversation("agent-c", null),
  ]);
  assert.equal(total(days), 1);
  assert.equal(days.fastConversations, 1);
  assert.deepEqual(days.slowConversationIds, ["agent-b", "agent-c"]);
});

test("a database missing an expected column is skipped and its conversations stay slow", t => {
  const f = createFixture(t);
  const db = f.database(undefined, `
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER, compacted INTEGER);
  `);
  db.session("s1");
  db.db.prepare("INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, ?, ?)")
    .run("s1", "user", "no metadata column", T / 1000, 1, 0);
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, []);
  assert.equal(days.fastConversations, 0);
  assert.deepEqual(days.slowConversationIds, ["agent-a"]);
  assert.deepEqual(days.skippedDatabases, ["state.db"]);
});

test("a corrupt state.db does not throw; its conversations stay slow", t => {
  const f = createFixture(t);
  fs.mkdirSync(f.hermes, { recursive: true });
  fs.writeFileSync(join(f.hermes, "state.db"), "this is not a database at all");
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, []);
  assert.deepEqual(days.slowConversationIds, ["agent-a"]);
  assert.deepEqual(days.skippedDatabases, ["state.db"]);
});

test("a missing Hermes root returns no history instead of failing", t => {
  const f = createFixture(t);
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, []);
  assert.equal(days.firstDay, null);
  assert.equal(days.lastDay, null);
  assert.deepEqual(days.slowConversationIds, ["agent-a"]);
  assert.deepEqual(days.skippedDatabases, []);
});

test("profile databases are read, and the root database wins a duplicated session id", t => {
  const f = createFixture(t);
  const root = f.database();
  const work = f.database("work");
  work.session("profile-session").add({ at: T, text: "from the profile" });
  root.session("shared").add({ at: T, text: "from the root" });
  work.session("shared").add({ at: T + 1000, text: "shadowed copy" });
  const days = readDays(f, [
    conversation("agent-profile", "profile-session"),
    conversation("agent-root", "shared"),
  ]);
  assert.equal(days.fastConversations, 2);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 2 }]);
  const detail = readDay(f, [conversation("agent-root", "shared")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text), ["from the root"]);
});

test("days follow the reader's zone, not the daemon's: Tokyo and UTC disagree across midnight", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: Date.UTC(2026, 10, 20, 15, 30), text: "just after Tokyo midnight" });
  db.add({ at: Date.UTC(2026, 10, 21, 14, 30), text: "late Tokyo evening" });
  const conversations = [conversation("agent-a", "s1")];
  const tokyo = readDays(f, conversations, "Asia/Tokyo");
  assert.deepEqual(tokyo.days, [{ day: "2026-11-21", count: 2 }]);
  const utc = readDays(f, conversations, "UTC");
  assert.deepEqual(utc.days, [
    { day: "2026-11-20", count: 1 },
    { day: "2026-11-21", count: 1 },
  ]);
});

test("day boundaries survive both daylight-saving changes in America/New_York", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  const spring = [
    Date.UTC(2026, 2, 8, 4, 59), // Mar 7 23:59 EST
    Date.UTC(2026, 2, 8, 5, 0), // Mar 8 00:00 EST
    Date.UTC(2026, 2, 9, 3, 59), // Mar 8 23:59 EDT
    Date.UTC(2026, 2, 9, 4, 0), // Mar 9 00:00 EDT
  ];
  for (const [index, at] of spring.entries()) db.add({ at, text: `spring ${index}` });
  const fall = [
    Date.UTC(2026, 10, 1, 3, 59), // Oct 31 23:59 EDT
    Date.UTC(2026, 10, 1, 4, 0), // Nov 1 00:00 EDT
    Date.UTC(2026, 10, 1, 5, 59), // Nov 1 01:59 EDT
    Date.UTC(2026, 10, 1, 6, 0), // Nov 1 01:00 EST, the repeated hour
    Date.UTC(2026, 10, 2, 4, 59), // Nov 1 23:59 EST
    Date.UTC(2026, 10, 2, 5, 0), // Nov 2 00:00 EST
  ];
  for (const [index, at] of fall.entries()) db.add({ at, text: `fall ${index}` });
  const days = readDays(f, [conversation("agent-a", "s1")], "America/New_York");
  assert.deepEqual(days.days, [
    { day: "2026-03-07", count: 1 },
    { day: "2026-03-08", count: 2 },
    { day: "2026-03-09", count: 1 },
    { day: "2026-10-31", count: 1 },
    { day: "2026-11-01", count: 4 },
    { day: "2026-11-02", count: 1 },
  ]);
  assert.equal(days.firstDay, "2026-03-07");
  assert.equal(days.lastDay, "2026-11-02");
});

test("a year boundary lands on the reader's calendar, not UTC's", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: Date.UTC(2026, 11, 31, 14, 30), text: "still December in Tokyo" });
  db.add({ at: Date.UTC(2026, 11, 31, 15, 30), text: "January in Tokyo" });
  const conversations = [conversation("agent-a", "s1")];
  const tokyo = readDays(f, conversations, "Asia/Tokyo");
  assert.deepEqual(tokyo.days, [
    { day: "2026-12-31", count: 1 },
    { day: "2027-01-01", count: 1 },
  ]);
  assert.equal(tokyo.firstDay, "2026-12-31");
  assert.equal(tokyo.lastDay, "2027-01-01");
  const newYork = readDays(f, conversations, "America/New_York");
  assert.deepEqual(newYork.days, [{ day: "2026-12-31", count: 2 }]);
  const detail = readDay(f, conversations, "2027-01-01", "Asia/Tokyo");
  assert.deepEqual(detail.rows.map(row => row.text), ["January in Tokyo"]);
});

test("an unknown zone falls back to the daemon's own calendar day", t => {
  const f = createFixture(t);
  f.database().session("s1").add({ at: T, text: "somewhere" });
  const days = readDays(f, [conversation("agent-a", "s1")], "Not/AZone");
  assert.deepEqual(days.days, [{ day: localDay.localDateKey(T), count: 1 }]);
});

test("the day detail is newest first", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "first" });
  db.add({ at: T + 2000, text: "third" });
  db.add({ at: T + 1000, text: "second" });
  const detail = readDay(f, [conversation("agent-a", "s1")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text), ["third", "second", "first"]);
  assert.deepEqual(readDay(f, [conversation("agent-a", "s1")], "2026-11-19").rows, []);
});

test("reading never changes a database file: the sha256 before and after matches", t => {
  const f = createFixture(t);
  f.database().session("s1").add({ at: T, text: "root message" });
  f.database("work").session("p1").add({ at: T, text: "profile message" });
  const files = [join(f.hermes, "state.db"), join(f.hermes, "profiles", "work", "state.db")];
  f.close();
  const before = files.map(path => createHash("sha256").update(fs.readFileSync(path)).digest("hex"));
  const conversations = [
    conversation("agent-a", "s1"),
    conversation("agent-b", "p1"),
  ];
  reader.readHistoryDays({ conversations, root: f.hermes, timeZone: "Asia/Tokyo" });
  reader.readHistoryDay({ conversations, root: f.hermes, timeZone: "Asia/Tokyo", day: "2026-11-20" });
  const after = files.map(path => createHash("sha256").update(fs.readFileSync(path)).digest("hex"));
  assert.deepEqual(after, before);
});

test("300 conversations with 30 messages each read in under two seconds", t => {
  const f = createFixture(t);
  const db = f.database();
  db.db.exec("BEGIN");
  const conversations = [];
  for (let session = 0; session < 300; session += 1) {
    const id = `session-${String(session).padStart(3, "0")}`;
    db.session(id);
    conversations.push(conversation(`agent-${id}`, id));
    for (let message = 0; message < 30; message += 1) {
      db.add({ session: id, at: T + message * 60_000, text: `message ${message} of ${id}` });
    }
  }
  db.db.exec("COMMIT");
  f.close();
  const started = performance.now();
  const days = reader.readHistoryDays({ conversations, root: f.hermes, timeZone: "Asia/Tokyo" });
  const elapsed = performance.now() - started;
  assert.equal(total(days), 9000);
  assert.equal(days.fastConversations, 300);
  assert.ok(days.readMs < 2000, `reader reported ${days.readMs} ms`);
  assert.ok(elapsed < 2000, `wall clock was ${Math.round(elapsed)} ms`);
});

test("a host without node:sqlite keeps the plugin running and sends every conversation to the slow path", t => {
  const f = createFixture(t);
  const db = f.database();
  db.session("s-1");
  db.add({ session: "s-1", at: T, text: "typed by a person" });
  f.close();
  const original = process.getBuiltinModule;
  process.getBuiltinModule = id => (id === "node:sqlite" ? undefined : original.call(process, id));
  t.after(() => { process.getBuiltinModule = original; });
  const days = reader.readHistoryDays({ conversations: [conversation("agent-1", "s-1")], root: f.hermes, timeZone: "Asia/Tokyo" });
  assert.equal(total(days), 0);
  assert.equal(days.fastConversations, 0);
  assert.deepEqual(days.slowConversationIds, ["agent-1"]);
  assert.equal(days.skippedDatabases.length, 1);
});

test("one malformed display_metadata row neither drops its database nor hides other rows", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "good before" });
  db.add({ at: T + 1000, text: "bad metadata row", metadata: "{not json" });
  db.add({ at: T + 2000, text: "good after" });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 3 }]);
  assert.deepEqual(days.skippedDatabases, []);
  assert.equal(days.fastConversations, 1);
  const detail = readDay(f, [conversation("agent-a", "s1")], "2026-11-20");
  assert.deepEqual(detail.rows.map(row => row.text), ["good after", "bad metadata row", "good before"]);
});

test("a removed copy between two archived copies does not hide the newer archived copy", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "kept words", active: 0, compacted: 1 });
  db.add({ at: T, text: "kept words", active: 0, compacted: 0 });
  db.add({ at: T, text: "kept words", active: 0, compacted: 1 });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.deepEqual(readDay(f, [conversation("agent-a", "s1")], "2026-11-20").rows.map(row => row.text), ["kept words"]);
});

test("a removed copy newer than a visible copy hides that message", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "withdrawn words", active: 0, compacted: 1 });
  db.add({ at: T, text: "withdrawn words", active: 0, compacted: 0 });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, []);
  assert.deepEqual(readDay(f, [conversation("agent-a", "s1")], "2026-11-20").rows, []);
});

test("a removed copy older than the visible copy does not hide it", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "kept words", active: 0, compacted: 0 });
  db.add({ at: T, text: "kept words", active: 0, compacted: 1 });
  assert.deepEqual(readDays(f, [conversation("agent-a", "s1")]).days, [{ day: "2026-11-20", count: 1 }]);
});

test("a removed copy hides only the same session, timestamp and text", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "kept words", active: 1, compacted: 0 });
  db.add({ at: T, text: "different words", active: 0, compacted: 0 });
  db.add({ at: T + 1000, text: "kept words", active: 0, compacted: 0 });
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.deepEqual(readDay(f, [conversation("agent-a", "s1")], "2026-11-20").rows.map(row => row.text), ["kept words"]);
});

test("a day's detail covers the first minute at UTC+14 and the last hour at UTC-12", t => {
  const f = createFixture(t);
  const db = f.database();
  const kiritimati = Date.UTC(2026, 10, 19, 10, 30); // 2026-11-20 00:30 at UTC+14
  const baker = Date.UTC(2026, 10, 21, 11, 30); // 2026-11-20 23:30 at UTC-12
  const newYork = Date.UTC(2026, 10, 21, 4, 30); // 2026-11-20 23:30 at UTC-5
  db.session("s-kiri").add({ at: kiritimati, text: "first minute at UTC+14" });
  db.session("s-baker").add({ at: baker, text: "last hour at UTC-12" });
  db.session("s-ny").add({ at: newYork, text: "late evening in New York" });
  assert.deepEqual(
    readDay(f, [conversation("agent-kiri", "s-kiri")], "2026-11-20", "Pacific/Kiritimati").rows.map(row => row.text),
    ["first minute at UTC+14"],
  );
  assert.deepEqual(
    readDay(f, [conversation("agent-baker", "s-baker")], "2026-11-20", "Etc/GMT+12").rows.map(row => row.text),
    ["last hour at UTC-12"],
  );
  assert.deepEqual(
    readDay(f, [conversation("agent-ny", "s-ny")], "2026-11-20", "America/New_York").rows.map(row => row.text),
    ["late evening in New York"],
  );
});

test("rows with a NULL or non-numeric timestamp are skipped by both RPC shapes", t => {
  const f = createFixture(t);
  const db = f.database(undefined, NULLABLE_TIMESTAMP_SCHEMA).session("s1");
  db.add({ at: null, text: "null timestamp" });
  db.add({ at: T, text: "real timestamp" });
  db.db.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp, active, compacted)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("s1", "user", "text timestamp", "not a number", 1, 0);
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.deepEqual(readDay(f, [conversation("agent-a", "s1")], "1970-01-01").rows, []);
  assert.deepEqual(readDay(f, [conversation("agent-a", "s1")], "2026-11-20").rows.map(row => row.text), ["real timestamp"]);
});

test("a Hermes path with spaces, # and ? is escaped before it becomes a file URL", t => {
  const f = createFixture(t, { hermesName: "hermes dir #1?" });
  const db = f.database().session("s1");
  db.db.exec("PRAGMA journal_mode=WAL");
  db.add({ at: T, text: "escaped path message" });
  f.close();
  const before = fs.readdirSync(f.hermes).sort();
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.deepEqual(fs.readdirSync(f.hermes).sort(), before);
});

test("a WAL database with no side files is read without creating any", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.db.exec("PRAGMA journal_mode=WAL");
  db.add({ at: T, text: "wal message" });
  f.close();
  const databasePath = join(f.hermes, "state.db");
  const before = { files: fs.readdirSync(f.hermes).sort(), sha: sha256(databasePath) };
  assert.deepEqual(before.files, ["state.db"], "closing the last connection leaves no -wal/-shm");
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.deepEqual(fs.readdirSync(f.hermes).sort(), before.files, "reading must not create side files");
  assert.equal(sha256(databasePath), before.sha);
  assert.equal(reader.openDatabaseHandlesForTests(), 0);
});

test("a live writer's uncheckpointed WAL rows are read without changing either file", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.db.exec("PRAGMA journal_mode=WAL");
  db.add({ at: T, text: "checkpointed row" });
  f.close();
  const databasePath = join(f.hermes, "state.db");
  const walPath = `${databasePath}-wal`;
  const writer = new DatabaseSync(databasePath);
  try {
    writer.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp, active, compacted, display_metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("s1", "user", "still in the WAL", (T + 1000) / 1000, 1, 0, null);
    assert.equal(fs.existsSync(walPath), true, "a live writer keeps the WAL file");
    const before = { main: sha256(databasePath), wal: sha256(walPath) };
    const days = readDays(f, [conversation("agent-a", "s1")]);
    assert.deepEqual(days.days, [{ day: "2026-11-20", count: 2 }]);
    assert.equal(sha256(databasePath), before.main, "the main file is untouched");
    assert.equal(sha256(walPath), before.wal, "the WAL is untouched: no checkpoint from the reader");
    assert.equal(reader.openDatabaseHandlesForTests(), 0, "every handle is closed");
    const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    assert.equal(checkpoint.busy, 0, "no reader still holds the WAL");
    assert.equal(checkpoint.checkpointed, checkpoint.log);
    assert.equal(fs.statSync(walPath).size, 0);
  } finally {
    if (writer.isOpen) writer.close();
  }
});

test("only a WAL store with no side files takes the immutable target", t => {
  const f = createFixture(t);
  const rollback = f.database().session("s1");
  rollback.add({ at: T, text: "rollback words" });
  const wal = f.database("wal").session("s2");
  wal.db.exec("PRAGMA journal_mode=WAL");
  wal.add({ at: T, text: "wal words" });
  f.close();
  assert.equal(typeof reader.openTargetForTests(rollback.path), "string",
    "a rollback-journal store never takes immutable");
  const immutable = reader.openTargetForTests(wal.path);
  assert.equal(typeof immutable, "object");
  assert.match(String(immutable), /[?&]immutable=1/);
  fs.writeFileSync(`${wal.path}-wal`, "");
  assert.equal(typeof reader.openTargetForTests(wal.path), "string", "a -wal side file means plain");
  fs.rmSync(`${wal.path}-wal`);
  fs.writeFileSync(`${wal.path}-shm`, "");
  assert.equal(typeof reader.openTargetForTests(wal.path), "string", "a -shm side file means plain");
  fs.rmSync(`${wal.path}-shm`);
  fs.writeFileSync(`${wal.path}-journal`, "");
  assert.equal(typeof reader.openTargetForTests(wal.path), "string", "a -journal means plain");
  fs.rmSync(`${wal.path}-journal`);
  assert.equal(typeof reader.openTargetForTests(wal.path), "object");
});

test("a session with no messages still counts as read", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  assert.equal(db.current, "s1");
  f.close();
  const data = reader.readHistoryData({
    conversations: [conversation("agent-a", "s1")],
    root: f.hermes,
    timeZone: "Asia/Tokyo",
  });
  assert.deepEqual(data.messages, []);
  assert.deepEqual(data.readSessions, ["s1"]);
});

test("a database that fails mid-read is not in the read session set", t => {
  const f = createFixture(t);
  const db = f.database(undefined, FAILING_VIEW_SCHEMA);
  db.session("bad-500");
  db.db.prepare(`
    INSERT INTO raw_messages (id, session_id, role, content, timestamp, active, compacted)
    VALUES (1, 'bad-500', 'user', 'boom', ?, 1, 0)
  `).run(T / 1000);
  f.close();
  const data = reader.readHistoryData({
    conversations: [conversation("agent-a", "bad-500")],
    root: f.hermes,
    timeZone: "Asia/Tokyo",
  });
  assert.deepEqual(data.messages, []);
  assert.deepEqual(data.readSessions, []);
});

test("a database that fails mid-read drops all its rows and keeps the other databases", t => {
  const f = createFixture(t);
  const bad = f.database(undefined, FAILING_VIEW_SCHEMA);
  const good = f.database("work").session("good-profile");
  good.add({ at: T, text: "from the good database" });
  const insert = bad.db.prepare(`
    INSERT INTO raw_messages (id, session_id, role, content, timestamp, active, compacted)
    VALUES (?, ?, 'user', ?, ?, 1, 0)
  `);
  const conversations = [];
  bad.db.exec("BEGIN");
  for (let index = 0; index < 500; index += 1) {
    const id = `good-${String(index).padStart(3, "0")}`;
    bad.session(id);
    insert.run(index + 1, id, `row ${index}`, T / 1000);
    conversations.push(conversation(`agent-${id}`, id));
  }
  bad.session("bad-500");
  insert.run(501, "bad-500", "boom", T / 1000);
  conversations.push(conversation("agent-bad", "bad-500"));
  bad.db.exec("COMMIT");
  conversations.push(conversation("agent-profile", "good-profile"));
  const days = readDays(f, conversations);
  // The first chunk (500 good sessions) was read and then dropped with the failing chunk.
  assert.deepEqual(days.days, [{ day: "2026-11-20", count: 1 }]);
  assert.equal(days.fastConversations, 1, "only the other database stays fast");
  assert.deepEqual(days.skippedDatabases, ["state.db"]);
  assert.equal(days.slowConversationIds.length, 501, "every conversation in the failed database is slow");
});

test("the reader retries the plain path when the host rejects a URL target", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.db.exec("PRAGMA journal_mode=WAL");
  db.add({ at: T, text: "wal words" });
  f.close();
  const error = new TypeError("The path argument must be a string or Buffer");
  error.code = "ERR_INVALID_ARG_TYPE";
  withSqliteModule(t, fakeSqliteModule({ rejectUrl: true, error }));
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.equal(days.fastConversations, 1);
  assert.deepEqual(days.slowConversationIds, []);
  assert.deepEqual(days.skippedDatabases, []);
});

test("the reader skips a database when a URL open fails for an unclassified reason", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.db.exec("PRAGMA journal_mode=WAL");
  db.add({ at: T, text: "wal words" });
  f.close();
  withSqliteModule(t, fakeSqliteModule({ rejectUrl: true, error: new Error("URL not supported") }));
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.equal(days.fastConversations, 0);
  assert.deepEqual(days.slowConversationIds, ["agent-a"]);
  assert.deepEqual(days.skippedDatabases, ["state.db"]);
});

function openFileDescriptors() {
  for (const directory of ["/dev/fd", "/proc/self/fd"]) {
    try {
      return fs.readdirSync(directory).length;
    } catch {
      // Try the other platform's descriptor directory.
    }
  }
  return null;
}

test("isWalStore closes every descriptor it opens", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.db.exec("PRAGMA journal_mode=WAL");
  db.add({ at: T, text: "descriptor check" });
  f.close();
  const before = openFileDescriptors();
  assert.notEqual(before, null, "this platform exposes its open file descriptors");
  for (let index = 0; index < 500; index += 1) {
    reader.openTargetForTests(db.path);
    reader.openTargetForTests(join(f.hermes, "missing.db"));
    reader.openTargetForTests(f.hermes);
  }
  assert.equal(openFileDescriptors(), before);
});

test("every read-only open carries the busy timeout", t => {
  const f = createFixture(t);
  const db = f.database().session("s1");
  db.add({ at: T, text: "timeout check" });
  f.close();
  const module = fakeSqliteModule();
  withSqliteModule(t, module);
  const days = readDays(f, [conversation("agent-a", "s1")]);
  assert.equal(days.fastConversations, 1);
  assert.equal(module.calls.length, 1);
  assert.equal(module.calls[0].options.readOnly, true);
  assert.equal(module.calls[0].options.timeout, 250);
});

test("no server module imports node:sqlite as a value, so loading the plugin never needs it", () => {
  const root = resolve(__dirname, "..");
  const files = ["index.server.ts", ...fs.readdirSync(join(root, "server")).map(name => join("server", name))];
  for (const file of files.filter(name => name.endsWith(".ts"))) {
    const source = fs.readFileSync(join(root, file), "utf8");
    for (const line of source.split("\n")) {
      if (/from\s+["']node:sqlite["']/.test(line)) assert.match(line, /^import type /, `${file}: ${line}`);
      assert.doesNotMatch(line, /require\(["']node:sqlite["']\)/, file);
    }
  }
});
