import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { localDateKey } from "../client/local-day";
import { classifyUserMessage, isEmptyMessageText } from "../client/user-message-kind";
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
 * - rows marked `display_metadata.model_only` are not shown, and neither are blank rows;
 * - structured content is flattened the way Hermes flattens it: each segment's `text`, or a
 *   `type: "text"` segment's `content`, or the segment itself when it is a string.
 *
 * Nothing here writes: every handle is `readOnly`, every statement is a `SELECT` or a
 * schema-reading pragma, and a database that cannot be opened or lacks an expected column is
 * skipped so its conversations fall back to the slow timeline path.
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
  sessionId: string;
  content: string | null;
  timestamp: number;
  active: boolean;
}

interface DedupedRow {
  sessionId: string;
  at: number;
  text: string;
}

interface DayScope {
  day: string;
  fromSeconds: number;
  untilSeconds: number;
}

type HistoryMessage = DedupedRow & { agentId: string };

interface HistoryRead {
  messages: HistoryMessage[];
  fastConversations: number;
  slowConversationIds: string[];
  skippedDatabases: string[];
  readMs: number;
}

/** Every message the person typed on each day the history covers, counted on the reader's clock. */
export function readHistoryDays(options: HistoryReaderOptions): HistoryDaysResult {
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

/** The person's own messages on one day, newest first, each attributed to one conversation. */
export function readHistoryDay(options: HistoryDayOptions): HistoryDayResult {
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
        // A schema check cannot see every failure (a malformed `display_metadata` value
        // makes `json_extract` throw, for example). Drop this database's rows whole and
        // let its conversations use the slow path, exactly as an unopenable file does.
        messages.length = before;
        skippedDatabases.push(database.label);
      }
    }
  } finally {
    for (const database of databases) closeQuietly(database.db);
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

function openDatabase(entry: DatabaseEntry): OpenDatabase | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(entry.path, { readOnly: true });
  } catch {
    return null;
  }
  try {
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
  for (let start = 0; start < sessionIds.length; start += SESSION_BATCH) {
    const chunk = sessionIds.slice(start, start + SESSION_BATCH);
    const sql = `SELECT session_id, content, timestamp, active FROM messages
      WHERE role = 'user' AND (active = 1 OR compacted = 1)
        AND COALESCE(json_extract(display_metadata, '$.model_only'), 0) = 0${window}
        AND session_id IN (${chunk.map(() => "?").join(",")})
      ORDER BY session_id, id`;
    const parameters: Array<string | number> = scope
      ? [scope.fromSeconds, scope.untilSeconds, ...chunk]
      : [...chunk];
    for (const row of db.prepare(sql).iterate(...parameters)) {
      yield {
        sessionId: String(row.session_id),
        content: typeof row.content === "string" ? row.content : null,
        timestamp: Number(row.timestamp),
        active: Number(row.active) === 1,
      };
    }
  }
}

function readDatabase(
  db: DatabaseSync, sessionIds: readonly string[], timeZone: string | null, scope: DayScope | undefined,
): DedupedRow[] {
  const groups = new Map<string, { live: DedupedRow[]; compacted: Map<string, DedupedRow> }>();
  for (const raw of readUserRows(db, sessionIds, scope)) {
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
    const row: DedupedRow = { sessionId: raw.sessionId, at, text };
    if (raw.active) group.live.push(row);
    else if (!group.compacted.has(text)) group.compacted.set(text, row);
  }
  const deduped: DedupedRow[] = [];
  for (const group of groups.values()) {
    if (group.live.length) deduped.push(...group.live);
    else deduped.push(...group.compacted.values());
  }
  return keepHumanMessages(deduped);
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
  try {
    db.close();
  } catch {
    // Already closed, or closed by a failed statement; nothing left to release.
  }
}
