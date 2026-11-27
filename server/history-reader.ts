import { closeSync, existsSync, openSync, readdirSync, readSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { localDateKey } from "../shared/local-day";
import { classifyUserMessage, isEmptyMessageText } from "../shared/user-message-kind";
import type { HistoryDayResult, HistoryDaysResult } from "../shared/history-rpc";

/**
 * A read-only reader of Hermes's own SQLite history.
 *
 * Replaying a conversation to count what a person typed costs seconds per conversation; the
 * same rows sit in `state.db`, and a read-only handle can count them in one pass. This module
 * owns that fast path: it opens `<hermes root>/state.db` and `<hermes root>/profiles/<name>/state.db`
 * read-only, maps Paseo conversations to Hermes sessions by id, and keeps only the rows Hermes
 * itself would display as the person's own words.
 *
 * Hermes rules this follows, so a count matches what replay shows:
 * - a live row absorbs every compacted copy at the same timestamp, even when a compaction
 *   summary changed the live text;
 * - compacted copies with no live row are one message only when their text matches;
 * - a row whose newest copy is removed (`active = 0 AND compacted = 0`: rewound or replaced)
 *   is not shown. The approximation here is the same session, timestamp and flattened text
 *   with a larger row id: a removed copy that matches a visible row that way hides it;
 * - rows marked `display_metadata.model_only` are not shown, and neither are blank rows;
 * - structured content is flattened the way Hermes flattens it: each segment's `text`, or a
 *   `type: "text"` segment's `content`, or the segment itself when it is a string.
 *
 * Nothing here writes: every handle is opened read-only, every statement is a `SELECT` or a
 * schema-reading pragma, and a database that cannot be opened or lacks an expected column is
 * skipped so its conversations fall back to the slow timeline path. A WAL-format database
 * whose `-wal`, `-shm` and `-journal` side files are all absent opens through
 * `mode=ro&immutable=1`, so SQLite does not create those files next to someone else's data.
 * A rollback-format database always takes the ordinary read-only open (immutable could skip
 * a journal it needs, and the ordinary open creates no side files), and so does a WAL store
 * with any side file, because immutable would ignore live WAL content or journal recovery.
 */

/** One Paseo conversation, reduced to what the fast path needs. */
export interface HistoryConversation {
  id: string;
  /** The provider-side session id (`runtimeInfo.sessionId`); null when the host has none. */
  sessionId: string | null;
  /** Milliseconds since the epoch. Picks one conversation when several share a session. */
  lastActiveAt: number;
}

export interface HistoryReaderOptions {
  /** Paseo conversations, already filtered to top-level (non-child) agents. */
  conversations: readonly HistoryConversation[];
  /** Hermes root. Defaults to `<home>/.hermes`; tests pass a temporary directory. */
  root?: string;
  /** The reader's IANA zone. Unknown names fall back to the daemon's local clock. */
  timeZone?: string | null;
}

export interface HistoryDayOptions extends HistoryReaderOptions {
  /** `YYYY-MM-DD` on the reader's calendar. */
  day: string;
}

const MESSAGE_COLUMNS = [
  "session_id", "role", "content", "timestamp", "active", "compacted", "display_metadata",
] as const;
const SESSION_COLUMNS = ["id"] as const;
const SESSION_BATCH = 500;
/**
 * Busy timeout for the read-only open. SQLite's busy handler overshoots the budget (250 ms
 * waits about a second or more on the measured hosts, per locked database), so this stays
 * small: a locked database costs about that long, and the reader is synchronous.
 */
const OPEN_TIMEOUT_MS = 250;
const DAY_WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000;
const DAY_WINDOW_AFTER_MS = 48 * 60 * 60 * 1000;

interface DatabaseEntry {
  path: string;
  /** Named relative to the Hermes root so no home directory crosses the plugin boundary. */
  label: string;
}

interface OpenDatabase {
  label: string;
  db: DatabaseSync;
  sessions: ReadonlySet<string>;
}

interface RawMessageRow {
  id: number;
  sessionId: string;
  content: string | null;
  timestamp: number;
  active: boolean;
  compacted: boolean;
}

interface DedupedRow {
  id: number;
  sessionId: string;
  timestamp: number;
  at: number;
  text: string;
}

interface DayScope {
  day: string;
  fromSeconds: number;
  untilSeconds: number;
}

type HistoryMessage = DedupedRow & { agentId: string };

/** One message with the session identity the archive needs for its key. */
export interface HistoryMessageRow {
  sessionId: string;
  agentId: string;
  at: number;
  text: string;
}

/** What the reader itself knows; the RPC handlers add the directory and archive flags. */
export type HistoryDaysSnapshot = Omit<
  HistoryDaysResult, "directoryPartial" | "fromCache" | "cacheError" | "cacheFull"
>;
export type HistoryDaySnapshot = Omit<
  HistoryDayResult, "directoryPartial" | "fromCache" | "cacheError" | "cacheFull"
>;

export interface HistoryDataSnapshot {
  messages: HistoryMessageRow[];
  /** Sessions whose database was read completely, even when they had no messages. */
  readSessions: string[];
  /** Every session id in every completely read database, whether a conversation points at
   * it or not. The archive uses this to drop a session Hermes still has but Paseo no
   * longer points at (a fork or session switch). */
  presentSessions: string[];
  fastConversations: number;
  slowConversationIds: string[];
  skippedDatabases: string[];
  readMs: number;
}

interface HistoryRead {
  messages: HistoryMessage[];
  readSessions: string[];
  presentSessions: string[];
  fastConversations: number;
  slowConversationIds: string[];
  skippedDatabases: string[];
  readMs: number;
}

/** Every message the person typed on each day the history covers, counted on the reader's clock. */
export function readHistoryDays(options: HistoryReaderOptions): HistoryDaysSnapshot {
  const read = readHistory(options);
  const counts = new Map<string, number>();
  for (const message of read.messages) {
    const day = zoneDayKey(message.at, options.timeZone);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([day, count]) => ({ day, count }));
  return {
    days,
    firstDay: days[0]?.day ?? null,
    lastDay: days.at(-1)?.day ?? null,
    fastConversations: read.fastConversations,
    slowConversationIds: read.slowConversationIds,
    skippedDatabases: read.skippedDatabases,
    readMs: read.readMs,
  };
}

/**
 * The raw fast-path rows, for the archive. Passing a day narrows the SQL window the same way
 * the day RPC does; the caller still filters by the exact zone day before merging, because
 * the window intentionally reaches into the neighbouring days.
 */
export function readHistoryData(options: HistoryReaderOptions, day?: string): HistoryDataSnapshot {
  const read = readHistory(options, day === undefined ? undefined : dayScope(day));
  return {
    messages: read.messages.map(({ sessionId, agentId, at, text }) => ({ sessionId, agentId, at, text })),
    readSessions: read.readSessions,
    presentSessions: read.presentSessions,
    fastConversations: read.fastConversations,
    slowConversationIds: read.slowConversationIds,
    skippedDatabases: read.skippedDatabases,
    readMs: read.readMs,
  };
}

/** The person's own messages on one day, newest first, each attributed to one conversation. */
export function readHistoryDay(options: HistoryDayOptions): HistoryDaySnapshot {
  const read = readHistory(options, dayScope(options.day));
  const rows = read.messages
    .filter(message => zoneDayKey(message.at, options.timeZone) === options.day)
    .sort((left, right) => right.at - left.at
      || compareText(left.agentId, right.agentId)
      || compareText(left.text, right.text))
    .map(({ agentId, at, text }) => ({ agentId, at, text }));
  return { rows };
}

/**
 * The calendar day of an instant in `timeZone`, as `YYYY-MM-DD`.
 *
 * An unknown or missing zone falls back to the daemon's own calendar, which is the same rule
 * `localDateKey` applies. Daylight-saving days and year boundaries need no special case:
 * `Intl` resolves the wall clock of the instant in the requested zone.
 */
export function zoneDayKey(at: number, timeZone: string | null | undefined): string {
  const formatter = timeZone ? zoneFormatter(timeZone) : null;
  if (!formatter) return localDateKey(at);
  let year = "";
  let month = "";
  let day = "";
  for (const part of formatter.formatToParts(new Date(at))) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return year && month && day ? `${year}-${month}-${day}` : localDateKey(at);
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = null;
  }
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

function dayScope(day: string): DayScope {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const wallMidnight = Date.UTC(year, month - 1, date);
  // Every IANA day lies inside this window (offsets never span more than a day), so the
  // exact zone-day filter below only ever sees the rows that could belong to the day.
  return {
    day,
    fromSeconds: (wallMidnight - DAY_WINDOW_BEFORE_MS) / 1000,
    untilSeconds: (wallMidnight + DAY_WINDOW_AFTER_MS) / 1000,
  };
}

function readHistory(options: HistoryReaderOptions, scope?: DayScope): HistoryRead {
  const started = performance.now();
  const root = options.root ?? join(homedir(), ".hermes");
  const skippedDatabases: string[] = [];
  const databases: OpenDatabase[] = [];
  for (const entry of discoverDatabases(root)) {
    const opened = openDatabase(entry);
    if (opened) databases.push(opened);
    else skippedDatabases.push(entry.label);
  }

  const messages: HistoryMessage[] = [];
  const readSessions = new Set<string>();
  const failedDatabases = new Set<OpenDatabase>();
  try {
    const sessionDatabase = new Map<string, OpenDatabase>();
    for (const database of databases) {
      for (const id of database.sessions) {
        if (!sessionDatabase.has(id)) sessionDatabase.set(id, database);
      }
    }

    // Only sessions a conversation points at are read; everything else in the file is ignored.
    const conversationsBySession = new Map<string, HistoryConversation[]>();
    for (const conversation of options.conversations) {
      const sessionId = conversation.sessionId;
      if (!sessionId || !sessionDatabase.has(sessionId)) continue;
      const list = conversationsBySession.get(sessionId);
      if (list) list.push(conversation);
      else conversationsBySession.set(sessionId, [conversation]);
    }

    // One shared session counts once; the row is attributed to the most recently active
    // conversation that points at it, so the detail can still open that conversation.
    const agentBySession = new Map<string, string>();
    for (const [sessionId, conversations] of conversationsBySession) {
      agentBySession.set(sessionId, representativeConversationId(conversations));
    }

    const sessionsByDatabase = new Map<OpenDatabase, string[]>();
    for (const sessionId of conversationsBySession.keys()) {
      const database = sessionDatabase.get(sessionId);
      if (!database) continue;
      const list = sessionsByDatabase.get(database);
      if (list) list.push(sessionId);
      else sessionsByDatabase.set(database, [sessionId]);
    }

    for (const [database, sessionIds] of sessionsByDatabase) {
      const before = messages.length;
      try {
        for (const row of readDatabase(database.db, sessionIds, options.timeZone ?? null, scope)) {
          const agentId = agentBySession.get(row.sessionId);
          if (!agentId) continue;
          messages.push({ ...row, agentId });
        }
        for (const sessionId of sessionIds) readSessions.add(sessionId);
      } catch {
        // A schema check cannot see every failure (a corrupt page, or a statement that
        // fails mid-iteration). Drop this database's rows whole and let its conversations
        // use the slow path, exactly as an unopenable file does.
        messages.length = before;
        failedDatabases.add(database);
        skippedDatabases.push(database.label);
      }
    }
  } finally {
    for (const database of databases) closeQuietly(database.db);
  }

  // A database whose session index was built and whose message reads (if any) all
  // succeeded still has every session it listed. Sessions no conversation points at are
  // present too: the archive must not keep a second copy of them (fork, session switch).
  const presentSessions = new Set<string>();
  for (const database of databases) {
    if (failedDatabases.has(database)) continue;
    for (const sessionId of database.sessions) presentSessions.add(sessionId);
  }

  let fastConversations = 0;
  const slowConversationIds: string[] = [];
  for (const conversation of options.conversations) {
    const sessionId = conversation.sessionId;
    if (sessionId && readSessions.has(sessionId)) fastConversations += 1;
    else slowConversationIds.push(conversation.id);
  }

  return {
    messages,
    readSessions: [...readSessions],
    presentSessions: [...presentSessions],
    fastConversations,
    slowConversationIds,
    skippedDatabases,
    readMs: Math.round(performance.now() - started),
  };
}

function discoverDatabases(root: string): DatabaseEntry[] {
  const found: DatabaseEntry[] = [];
  const rootDatabase = join(root, "state.db");
  if (existsSync(rootDatabase)) found.push({ path: rootDatabase, label: "state.db" });
  const profiles = join(root, "profiles");
  let entries: Dirent[];
  try {
    entries = readdirSync(profiles, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(profiles, entry.name, "state.db");
    if (existsSync(path)) found.push({ path, label: `profiles/${entry.name}/state.db` });
  }
  return found;
}

type SqliteModule = typeof import("node:sqlite");

/**
 * `node:sqlite`, loaded on first use rather than imported, so a host whose Node has no
 * SQLite module still starts the plugin: the reader then skips every database and all
 * conversations take the slow timeline path.
 */
export function loadSqlite(): SqliteModule | null {
  try {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    return (getBuiltin?.call(process, "node:sqlite") as SqliteModule | undefined) ?? null;
  } catch {
    return null;
  }
}

let openHandles = 0;

/** Test hook: handles this module opened and has not closed yet. */
export function openDatabaseHandlesForTests(): number {
  return openHandles;
}

function openDatabase(entry: DatabaseEntry): OpenDatabase | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  let db: DatabaseSync;
  try {
    db = openReadOnlyDatabase(sqlite, entry.path, openTarget(entry.path));
  } catch {
    return null;
  }
  openHandles += 1;
  try {
    // One read transaction covers the session index and every message query, so a prune
    // that commits between them cannot turn a live session into "read, zero messages".
    // Closing the handle ends the transaction; a read-only transaction has nothing to keep.
    // In a DELETE-journal database this SHARED lock can make Hermes's writer wait about
    // 0.2-0.3 s; Hermes retries inside its 1 s timeout, so the write is delayed, not lost.
    db.exec("BEGIN");
    if (!hasColumns(db, "sessions", SESSION_COLUMNS)) throw new Error("sessions columns");
    if (!hasColumns(db, "messages", MESSAGE_COLUMNS)) throw new Error("messages columns");
    const sessions = new Set<string>();
    for (const row of db.prepare("SELECT id FROM sessions").iterate()) {
      if (typeof row.id === "string") sessions.add(row.id);
    }
    return { label: entry.label, db, sessions };
  } catch {
    closeQuietly(db);
    return null;
  }
}

/**
 * Where to open a database read-only.
 *
 * `immutable=1` is used only for a WAL-format store whose `-wal`, `-shm` and `-journal` side
 * files are all absent: then every committed row is in the main file, and SQLite must not
 * create the side files next to someone else's data. The header check matters: a rollback
 * (DELETE-journal) store can also have no side files while a writer is attached, and
 * immutable would skip any journal recovery it needs. Rollback stores therefore always take
 * the plain read-only path, which does not create side files anyway. When a WAL store has any
 * side file, a writer may be live or the WAL may hold newer rows; immutable would ignore
 * them, so the plain path is used and SQLite reads them. `pathToFileURL` escapes spaces, `#`
 * and `?`, so only the query string is read as URI parameters.
 */
function openTarget(path: string): string | URL {
  if (!isWalStore(path)) return path;
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`) || existsSync(`${path}-journal`)) return path;
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url;
}

/** Test hook: the target `openDatabase` would use for a database path. */
export function openTargetForTests(path: string): string | URL {
  return openTarget(path);
}

const SQLITE_HEADER_BYTES = 100;
const SQLITE_FILE_FORMAT_WRITE = 18;
const SQLITE_FILE_FORMAT_READ = 19;
const SQLITE_WAL_FORMAT = 2;

/**
 * Whether the SQLite header says this is a WAL-format store. Bytes 18 and 19 are the file
 * format write and read versions; both are 2 for WAL. A short or unreadable file is not
 * treated as WAL, so it takes the ordinary read-only path (and fails there if it is broken).
 */
function isWalStore(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const read = readSync(descriptor, header, 0, header.length, 0);
    return read > SQLITE_FILE_FORMAT_READ
      && header[SQLITE_FILE_FORMAT_WRITE] === SQLITE_WAL_FORMAT
      && header[SQLITE_FILE_FORMAT_READ] === SQLITE_WAL_FORMAT;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor is already gone; nothing left to release.
      }
    }
  }
}

/**
 * Open read-only, with one fallback for hosts whose `node:sqlite` does not accept a URL path.
 * Node 22.13 and 22.14 ship `node:sqlite` but only take string paths; they raise a TypeError
 * with `ERR_INVALID_ARG_TYPE`. Retrying the plain path can create WAL side files, so this
 * retry is limited to that error shape. Any other failure, or an error that cannot be
 * classified, stays a skip.
 */
function openReadOnlyDatabase(
  sqlite: SqliteModule, path: string, target: string | URL,
): DatabaseSync {
  try {
    return new sqlite.DatabaseSync(target, { readOnly: true, timeout: OPEN_TIMEOUT_MS });
  } catch (error) {
    if (!(target instanceof URL) || !isUnsupportedUrlPath(error)) throw error;
    return new sqlite.DatabaseSync(path, { readOnly: true, timeout: OPEN_TIMEOUT_MS });
  }
}

function isUnsupportedUrlPath(error: unknown): boolean {
  return error instanceof TypeError
    && (error as { code?: unknown }).code === "ERR_INVALID_ARG_TYPE";
}

function hasColumns(db: DatabaseSync, table: string, required: readonly string[]): boolean {
  const present = new Set<string>();
  // The table name is a private constant, never request input.
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (typeof row.name === "string") present.add(row.name);
  }
  return required.every(column => present.has(column));
}

function* readUserRows(
  db: DatabaseSync, sessionIds: readonly string[], scope: DayScope | undefined,
): Generator<RawMessageRow> {
  const window = scope ? " AND timestamp >= ? AND timestamp < ?" : "";
  const sql = `SELECT id, session_id, content, timestamp, active, compacted FROM messages
    WHERE role = 'user' AND (active = 1 OR compacted = 1)
      AND COALESCE(json_extract(CASE WHEN json_valid(display_metadata) THEN display_metadata ELSE '{}' END, '$.model_only'), 0) = 0${window}
      AND session_id IN (${sessionIds.map(() => "?").join(",")})
    ORDER BY session_id, id`;
  const parameters: Array<string | number> = scope
    ? [scope.fromSeconds, scope.untilSeconds, ...sessionIds]
    : [...sessionIds];
  for (const row of db.prepare(sql).iterate(...parameters)) {
    const parsed = rawMessageRow(row);
    if (parsed) yield parsed;
  }
}

/**
 * The rows Hermes treats as removed (`active = 0 AND compacted = 0`: rewound, or replaced by
 * a newer copy). Only their identity is needed: a removed copy hides a visible message when
 * the session, timestamp and flattened text match and its id is larger. This is the simple
 * approximation of `_dedupe_display_generations(drop_removed=True)`: Hermes also folds copies
 * by `message_uid` and stores a display identity, neither of which this reader uses.
 *
 * `display_metadata` is not filtered here on purpose: Hermes builds a removed row's identity
 * from its content, not from the model-only flag.
 */
function* readRemovedRows(
  db: DatabaseSync, sessionIds: readonly string[], scope: DayScope | undefined,
): Generator<RawMessageRow> {
  const window = scope ? " AND timestamp >= ? AND timestamp < ?" : "";
  for (let start = 0; start < sessionIds.length; start += SESSION_BATCH) {
    const chunk = sessionIds.slice(start, start + SESSION_BATCH);
    const sql = `SELECT id, session_id, content, timestamp, active, compacted FROM messages
      WHERE role = 'user' AND active = 0 AND compacted = 0${window}
        AND session_id IN (${chunk.map(() => "?").join(",")})
      ORDER BY session_id, id`;
    const parameters: Array<string | number> = scope
      ? [scope.fromSeconds, scope.untilSeconds, ...chunk]
      : [...chunk];
    for (const row of db.prepare(sql).iterate(...parameters)) {
      const parsed = rawMessageRow(row);
      if (parsed) yield parsed;
    }
  }
}

/** A row the reader can use; NULL or non-numeric ids and timestamps are skipped. */
function rawMessageRow(row: Record<string, unknown>): RawMessageRow | null {
  const id = Number(row.id);
  if (!Number.isFinite(id)) return null;
  if (row.timestamp === null || row.timestamp === undefined) return null;
  const timestamp = Number(row.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  return {
    id,
    sessionId: String(row.session_id),
    content: typeof row.content === "string" ? row.content : null,
    timestamp,
    active: Number(row.active) === 1,
    compacted: Number(row.compacted) === 1,
  };
}

/**
 * The person's rows from one database, yielded batch by batch.
 *
 * Sessions are split into `SESSION_BATCH` chunks and each chunk is queried separately, so a
 * statement that fails partway (a corrupt page, an unreadable value) throws only after the
 * earlier chunks were read. `readHistory` then drops every row this database contributed and
 * puts its conversations on the slow path, which is why this must be a generator rather than
 * a function returning one array: a caller has to see the rows a later chunk failure makes
 * invalid.
 */
function* readDatabase(
  db: DatabaseSync, sessionIds: readonly string[], timeZone: string | null, scope: DayScope | undefined,
): Generator<DedupedRow> {
  // The newest removed copy of each (session, timestamp, text) identity. Removed rows never
  // add a message; they only hide a visible copy they are newer than.
  const removed = new Map<string, number>();
  for (const raw of readRemovedRows(db, sessionIds, scope)) {
    const at = Math.round(raw.timestamp * 1000);
    if (!Number.isFinite(at)) continue;
    if (scope && zoneDayKey(at, timeZone) !== scope.day) continue;
    const text = flattenContent(raw.content);
    if (!text) continue;
    const key = removedKey(raw.sessionId, raw.timestamp, text);
    const previous = removed.get(key);
    if (previous === undefined || raw.id > previous) removed.set(key, raw.id);
  }

  for (let start = 0; start < sessionIds.length; start += SESSION_BATCH) {
    const chunk = sessionIds.slice(start, start + SESSION_BATCH);
    const groups = new Map<string, { live: DedupedRow[]; compacted: Map<string, DedupedRow> }>();
    for (const raw of readUserRows(db, chunk, scope)) {
      const at = Math.round(raw.timestamp * 1000);
      if (!Number.isFinite(at)) continue;
      if (scope && zoneDayKey(at, timeZone) !== scope.day) continue;
      const text = flattenContent(raw.content);
      if (!text) continue;
      const key = `${raw.sessionId}\u0000${raw.timestamp}`;
      let group = groups.get(key);
      if (!group) {
        group = { live: [], compacted: new Map() };
        groups.set(key, group);
      }
      const row: DedupedRow = { id: raw.id, sessionId: raw.sessionId, timestamp: raw.timestamp, at, text };
      if (raw.active) group.live.push(row);
      else {
        // Keep the newest archived copy of this text. A removed copy between two archived
        // copies must hide neither: Hermes compares the newest copy, not the first one.
        const previous = group.compacted.get(text);
        if (!previous || row.id > previous.id) group.compacted.set(text, row);
      }
    }
    const deduped: DedupedRow[] = [];
    for (const group of groups.values()) {
      if (group.live.length) deduped.push(...group.live);
      else deduped.push(...group.compacted.values());
    }
    const visible = deduped.filter(row => {
      const removedId = removed.get(removedKey(row.sessionId, row.timestamp, row.text));
      return removedId === undefined || removedId <= row.id;
    });
    for (const row of keepHumanMessages(visible)) yield row;
  }
}

function removedKey(sessionId: string, timestamp: number, text: string): string {
  return `${sessionId}\u0000${timestamp}\u0000${text}`;
}

function keepHumanMessages(rows: readonly DedupedRow[]): DedupedRow[] {
  const kept: DedupedRow[] = [];
  for (const row of rows) {
    const classified = classifyUserMessage(row.text);
    if (classified.kind !== "human" || isEmptyMessageText(classified.text)) continue;
    kept.push({ ...row, text: classified.text });
  }
  return kept;
}

/** Hermes's `_flatten_history_text`: structured segments become one newline-joined string. */
function flattenContent(content: string | null): string {
  if (content === null) return "";
  const trimmedStart = content.trimStart();
  if (trimmedStart.startsWith("[{")) {
    try {
      const parts: unknown = JSON.parse(trimmedStart);
      if (Array.isArray(parts)) {
        return parts
          .map(segmentText)
          .map(text => text.trim())
          .filter(text => text.length > 0)
          .join("\n")
          .trim();
      }
    } catch {
      // Not JSON after all: the message is plain text.
    }
  }
  return content.trim();
}

function segmentText(segment: unknown): string {
  if (typeof segment === "string") return segment;
  if (!segment || typeof segment !== "object") return "";
  const record = segment as { text?: unknown; type?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  if (record.type === "text" && typeof record.content === "string") return record.content;
  return "";
}

function representativeConversationId(conversations: readonly HistoryConversation[]): string {
  const first = conversations[0];
  if (!first) return "";
  let best = first;
  for (const conversation of conversations) {
    if (conversation.lastActiveAt > best.lastActiveAt
      || (conversation.lastActiveAt === best.lastActiveAt && conversation.id < best.id)) {
      best = conversation;
    }
  }
  return best.id;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function closeQuietly(db: DatabaseSync): void {
  if (!db.isOpen) return;
  try {
    db.close();
    openHandles -= 1;
  } catch {
    // A statement that is still active keeps the handle open; the count stays truthful.
  }
}
