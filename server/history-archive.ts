import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zoneDayKey, type HistoryMessageRow } from "./history-reader";

/**
 * The plugin's own archive of the person's messages.
 *
 * Hermes prunes conversations after a retention window, so a calendar that only reads
 * Hermes's databases loses old days. This archive keeps one record per message under
 * `<Paseo home>/plugin-data/clear-chat/history/`, split into UTC months.
 *
 * Alignment rule: a session Hermes still has is represented by what this read returned for
 * it. A merge replaces every stored record of each session the fast read completed (even a
 * session with no messages, so a rewrite or a retraction disappears), and leaves every other
 * session untouched. A session Hermes has deleted, or whose database could not be read
 * completely, therefore never shrinks: that is what "only grows" means here. A record carries
 * its `sessionId`, so the replacement never has to guess from the key.
 *
 * Files are private (history directory 0700, files 0600; the parent directories keep the
 * normal umask), written through a same-directory temporary file with `fsync`, renamed into
 * place, then the directory is synced. One archive instance serializes every operation on a
 * promise chain. A cross-process lock file (`history/.lock`, O_EXCL, pid and timestamp)
 * keeps two plugin processes from writing the same home; a lock older than 30 seconds is
 * taken over. A merge that cannot take the lock does not write, answers from its in-memory
 * merge, and reports `cacheError: true`.
 *
 * Content that parses but is not a version 2 archive (bad JSON, unknown version, wrong
 * shape) is renamed to `<name>.bad-<time>-<n>` (at most three kept per name) and treated as
 * empty. A file that cannot be read at all (EACCES, EMFILE, EIO, EISDIR, ...) is not renamed:
 * the merge does not write, answers from the fast rows, and reports `cacheError: true`.
 * `meta.json` is rebuilt from the month files the same way. A write failure never fails the
 * RPC: the caller answers from the fast rows and reports `cacheError: true`.
 *
 * A month file that would exceed `maxMonthBytes` (20 MB unless another limit is injected)
 * stops taking text: only the rows new to the archive in that month are written as count-only
 * records `{ key, sessionId, agentId, at }`, and the month is reported in `cacheFull`. Text
 * already stored is kept.
 */

export const ARCHIVE_VERSION = 2;
export const DEFAULT_MAX_MONTH_BYTES = 20 * 1024 * 1024;
const MONTH_FILE = /^messages-(\d{4}-\d{2})\.json$/;
const META_FILE = "meta.json";
const LOCK_FILE = ".lock";
const LOCK_STALE_MS = 30_000;
const MAX_BAD_FILES = 3;
const BAD_SUFFIX = ".bad";
const CORRUPT = Symbol("corrupt");
const READ_ERROR = Symbol("read-error");

export interface ArchivedMessage {
  /** sha256 of the session id, instant and text, first 16 hex characters. */
  key: string;
  /** The Hermes session this message belongs to; replacement is per session. */
  sessionId: string;
  agentId: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** Absent on a count-only record written after its month file reached the size cap. */
  text?: string;
}

/** Injection points for tests that need a read to fail (EACCES, EMFILE, ...). */
export interface ArchiveFileHooks {
  readdir?: (directory: string) => Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>>;
  readFile?: (path: string) => Promise<string>;
}

export interface HistoryArchiveOptions {
  /** Paseo home; defaults to `PASEO_HOME` or `<home>/.paseo` when the operation runs. */
  home?: string;
  /** Size at which a month file takes new rows without text. */
  maxMonthBytes?: number;
  now?: () => number;
  files?: ArchiveFileHooks;
}

export interface ArchiveMerge {
  /** Every record after the merge, or the fast rows when the archive was unavailable. */
  messages: ArchivedMessage[];
  cacheError: boolean;
  cacheFull: string[];
}

export interface ArchiveRead {
  messages: ArchivedMessage[];
  cacheError: boolean;
}

/** `<Paseo home>/plugin-data/clear-chat/history`, resolved when called. */
export function historyArchiveDirectory(home?: string): string {
  const root = home || process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(root, "plugin-data", "clear-chat", "history");
}

/** Stable identity for one Hermes message: session id, millisecond instant and text. */
export function archiveKey(sessionId: string, at: number, text: string): string {
  return createHash("sha256")
    .update(`${sessionId}\u0000${at}\u0000${text}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** The UTC month a record belongs to; month files follow UTC, not the reader's zone. */
export function utcMonthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** Per-day counts in the reader's zone, from any records that carry `at`. */
export function countByDay(
  messages: readonly { at: number }[], timeZone: string | null | undefined,
): { days: Array<{ day: string; count: number }>; firstDay: string | null; lastDay: string | null } {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const day = zoneDayKey(message.at, timeZone);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([day, count]) => ({ day, count }));
  return { days, firstDay: days[0]?.day ?? null, lastDay: days.at(-1)?.day ?? null };
}

/** Rows with text on one local day, newest first; count-only records cannot be shown. */
export function rowsOnDay(
  messages: readonly { agentId: string; at: number; text?: string }[],
  day: string,
  timeZone: string | null | undefined,
): Array<{ agentId: string; at: number; text: string }> {
  const rows: Array<{ agentId: string; at: number; text: string }> = [];
  for (const message of messages) {
    if (typeof message.text !== "string" || message.text.length === 0) continue;
    if (zoneDayKey(message.at, timeZone) !== day) continue;
    rows.push({ agentId: message.agentId, at: message.at, text: message.text });
  }
  rows.sort(compareRows);
  return rows;
}

function compareRows(
  left: { agentId: string; at: number; text: string },
  right: { agentId: string; at: number; text: string },
): number {
  return right.at - left.at
    || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
    || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0);
}

interface StoreRead {
  records: Map<string, ArchivedMessage>;
  meta: { version: number; months: Record<string, number> } | null;
  cacheError: boolean;
}

interface AppliedSessions {
  records: Map<string, ArchivedMessage>;
  changed: Set<string>;
  added: Map<string, Set<string>>;
}

export class HistoryArchive {
  private readonly options: HistoryArchiveOptions;
  private readonly readDirectory: NonNullable<ArchiveFileHooks["readdir"]>;
  private readonly readText: NonNullable<ArchiveFileHooks["readFile"]>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HistoryArchiveOptions = {}) {
    this.options = options;
    this.readDirectory = options.files?.readdir
      ?? (directory => readdir(directory, { withFileTypes: true }));
    this.readText = options.files?.readFile ?? (path => readFile(path, "utf8"));
  }

  /**
   * Align the archive with one complete fast read. *readSessions* lists every session whose
   * database was read without a mid-read failure; those sessions are replaced wholesale,
   * every other session is left alone.
   */
  merge(
    fast: readonly HistoryMessageRow[], readSessions: readonly string[],
  ): Promise<ArchiveMerge> {
    return this.enqueue(() => this.mergeNow(fast, readSessions));
  }

  /** Read every stored record without writing anything (the day RPC is read-only). */
  read(): Promise<ArchiveRead> {
    return this.enqueue(async () => {
      const directory = historyArchiveDirectory(this.options.home);
      const store = await this.readStore(directory, { repair: false, corruptIsError: true });
      return { messages: [...store.records.values()], cacheError: store.cacheError };
    });
  }

  /** One promise chain per archive instance; a failed task does not break the chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async mergeNow(
    fast: readonly HistoryMessageRow[], readSessions: readonly string[],
  ): Promise<ArchiveMerge> {
    const directory = historyArchiveDirectory(this.options.home);
    const fastRecords: ArchivedMessage[] = [];
    for (const row of fast) {
      if (!Number.isFinite(row.at) || Number.isNaN(new Date(row.at).getTime())) continue;
      fastRecords.push({
        key: archiveKey(row.sessionId, row.at, row.text),
        sessionId: row.sessionId,
        agentId: row.agentId,
        at: row.at,
        text: row.text,
      });
    }
    if (!(await this.ensureDirectory(directory))) {
      return { messages: fastRecords, cacheError: true, cacheFull: [] };
    }

    // A tolerant read before the lock supplies the in-memory answer when another process
    // holds the lock. Corrupt content is simply skipped here; the locked read repairs it.
    const initial = await this.readStore(directory, { repair: false, corruptIsError: false });
    if (initial.cacheError) return { messages: fastRecords, cacheError: true, cacheFull: [] };
    const memory = applySessions(initial.records, fastRecords, readSessions);

    const lock = await this.acquireLock(directory);
    if (lock !== "acquired") {
      return { messages: [...memory.records.values()], cacheError: true, cacheFull: [] };
    }
    try {
      // Re-read under the lock so another process's committed writes are not overwritten.
      const current = await this.readStore(directory, { repair: true, corruptIsError: false });
      if (current.cacheError) return { messages: fastRecords, cacheError: true, cacheFull: [] };
      const applied = applySessions(current.records, fastRecords, readSessions);
      const cacheFull: string[] = [];
      let writeError = false;
      if (await this.writeMonths(directory, applied, cacheFull)) writeError = true;
      if (await this.writeMeta(directory, applied.records, current.meta)) writeError = true;
      if (writeError) return { messages: fastRecords, cacheError: true, cacheFull };
      return { messages: [...applied.records.values()], cacheError: false, cacheFull };
    } finally {
      await this.releaseLock(directory);
    }
  }

  private async writeMonths(
    directory: string, applied: AppliedSessions, cacheFull: string[],
  ): Promise<boolean> {
    let failed = false;
    const limit = this.options.maxMonthBytes ?? DEFAULT_MAX_MONTH_BYTES;
    for (const month of applied.changed) {
      let payload = monthRecords(applied.records, month);
      let json = serializeMonth(payload);
      if (Buffer.byteLength(json, "utf8") > limit) {
        // Stop adding text to this month, but only for rows new to the archive: text that
        // was already stored stays, even when the file is already over the limit.
        for (const key of applied.added.get(month) ?? []) {
          const record = applied.records.get(key);
          if (record?.text !== undefined) {
            applied.records.set(key, {
              key: record.key,
              sessionId: record.sessionId,
              agentId: record.agentId,
              at: record.at,
            });
          }
        }
        payload = monthRecords(applied.records, month);
        json = serializeMonth(payload);
        cacheFull.push(month);
      }
      if (!(await writeAtomic(directory, `messages-${month}.json`, json))) failed = true;
    }
    return failed;
  }

  private async writeMeta(
    directory: string,
    records: Map<string, ArchivedMessage>,
    previous: { version: number; months: Record<string, number> } | null,
  ): Promise<boolean> {
    const counts: Record<string, number> = {};
    for (const record of records.values()) {
      const month = utcMonthOf(record.at);
      counts[month] = (counts[month] ?? 0) + 1;
    }
    const months = Object.fromEntries(Object.keys(counts).sort().map(month => [month, counts[month]!]));
    if (previous && sameMonths(previous.months, months)) return false;
    const now = this.options.now ?? Date.now;
    const meta = { version: ARCHIVE_VERSION, updatedAt: new Date(now()).toISOString(), months };
    return !(await writeAtomic(directory, META_FILE, JSON.stringify(meta)));
  }

  private async readStore(
    directory: string, mode: { repair: boolean; corruptIsError: boolean },
  ): Promise<StoreRead> {
    let entries;
    try {
      entries = await this.readDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { records: new Map(), meta: null, cacheError: false };
      }
      return { records: new Map(), meta: null, cacheError: true };
    }
    const records = new Map<string, ArchivedMessage>();
    let meta: StoreRead["meta"] = null;
    let cacheError = false;
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const isMeta = entry.name === META_FILE;
      if (!isMeta && !MONTH_FILE.test(entry.name)) continue;
      // A read that does not write does not need meta; a corrupt meta must not make the
      // day RPC drop the month files. The merge repairs it under the lock.
      if (isMeta && !mode.repair) continue;
      const parsed = await this.readJsonFile(directory, entry.name);
      if (parsed === READ_ERROR) {
        // A file that cannot be read is not corrupt; keep it and write nothing this call.
        cacheError = true;
        continue;
      }
      if (parsed === null) continue;
      const corrupt = parsed === CORRUPT || (isMeta ? !isMetaFile(parsed) : !isMonthFile(parsed));
      if (corrupt) {
        if (mode.repair) {
          if (!(await renameBad(directory, entry.name))) cacheError = true;
        } else if (mode.corruptIsError) {
          cacheError = true;
        }
        continue;
      }
      if (isMeta) {
        meta = { version: ARCHIVE_VERSION, months: (parsed as { months: Record<string, number> }).months };
        continue;
      }
      for (const record of (parsed as { messages: unknown[] }).messages) {
        if (!isArchivedMessage(record)) continue;
        if (!records.has(record.key)) records.set(record.key, record);
      }
    }
    return { records, meta, cacheError };
  }

  private async readJsonFile(
    directory: string, name: string,
  ): Promise<Record<string, unknown> | null | typeof CORRUPT | typeof READ_ERROR> {
    let raw: string;
    try {
      raw = await this.readText(join(directory, name));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : READ_ERROR;
    }
    try {
      const value: unknown = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : CORRUPT;
    } catch {
      return CORRUPT;
    }
  }

  private async ensureDirectory(directory: string): Promise<boolean> {
    try {
      // Only the history directory is private; plugin-data and clear-chat keep the default
      // umask so the rest of Paseo's plugin data is not altered.
      await mkdir(join(directory, ".."), { recursive: true });
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await stat(directory);
      if (!info.isDirectory()) return false;
      await chmod(directory, 0o700);
      return true;
    } catch {
      return false;
    }
  }

  private async acquireLock(directory: string): Promise<"acquired" | "busy" | "error"> {
    const lock = join(directory, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lock, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: (this.options.now ?? Date.now)() }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return "acquired";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "error";
        let raw: string;
        try {
          raw = await this.readText(lock);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          return "busy";
        }
        let at = Number.NaN;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object") at = Number((parsed as { at?: unknown }).at);
        } catch {
          // An unreadable lock body is treated as stale: its owner cannot release it safely.
        }
        if (Number.isFinite(at) && (this.options.now ?? Date.now)() - at <= LOCK_STALE_MS) {
          return "busy";
        }
        try {
          await rm(lock, { force: true });
        } catch {
          return "error";
        }
      }
    }
    return "busy";
  }

  private async releaseLock(directory: string): Promise<void> {
    try {
      await rm(join(directory, LOCK_FILE), { force: true });
    } catch {
      // A lock that cannot be removed is taken over once it is stale.
    }
  }
}

function applySessions(
  records: Map<string, ArchivedMessage>,
  fastRecords: readonly ArchivedMessage[],
  readSessions: readonly string[],
): AppliedSessions {
  const incoming = new Map<string, ArchivedMessage[]>();
  for (const record of fastRecords) {
    const list = incoming.get(record.sessionId) ?? [];
    list.push(record);
    incoming.set(record.sessionId, list);
  }
  const changed = new Set<string>();
  const added = new Map<string, Set<string>>();
  const beforeKeys = new Set(records.keys());
  for (const sessionId of new Set(readSessions)) {
    const next = incoming.get(sessionId) ?? [];
    const previous = [...records.values()].filter(record => record.sessionId === sessionId);
    if (sameSession(previous, next)) continue;
    for (const record of previous) {
      records.delete(record.key);
      changed.add(utcMonthOf(record.at));
    }
    for (const record of next) {
      records.set(record.key, record);
      const month = utcMonthOf(record.at);
      changed.add(month);
      if (!beforeKeys.has(record.key)) {
        const keys = added.get(month) ?? new Set<string>();
        keys.add(record.key);
        added.set(month, keys);
      }
    }
  }
  return { records, changed, added };
}

function sameSession(previous: readonly ArchivedMessage[], next: readonly ArchivedMessage[]): boolean {
  if (previous.length !== next.length) return false;
  const byKey = new Map(previous.map(record => [record.key, record]));
  for (const record of next) {
    const old = byKey.get(record.key);
    if (!old) return false;
    if (old.agentId !== record.agentId) return false;
    if (old.text !== record.text) return false;
  }
  return true;
}

function isMonthFile(value: Record<string, unknown>): value is { version: 2; messages: unknown[] } {
  return value.version === ARCHIVE_VERSION && Array.isArray(value.messages);
}

function isMetaFile(value: Record<string, unknown>): value is { version: 2; months: Record<string, number> } {
  if (value.version !== ARCHIVE_VERSION || !value.months || typeof value.months !== "object") return false;
  return Object.values(value.months).every(count => Number.isInteger(count) && count >= 0);
}

function isArchivedMessage(value: unknown): value is ArchivedMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && record.key.length > 0
    && typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.agentId === "string"
    && typeof record.at === "number" && Number.isFinite(record.at)
    && (record.text === undefined || typeof record.text === "string");
}

async function renameBad(directory: string, name: string): Promise<boolean> {
  // Timestamp first (so the retention sort is chronological), plus the process id and a
  // random suffix so two processes cannot rename onto the same name and overwrite a copy.
  const target = join(directory, `${name}${BAD_SUFFIX}-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    await rename(join(directory, name), target);
  } catch {
    return false;
  }
  await pruneBad(directory, name);
  return true;
}

/** Keep the newest three renamed copies of one name; older ones are removed (best effort). */
async function pruneBad(directory: string, name: string): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const prefix = `${name}${BAD_SUFFIX}-`;
    const names = entries
      .filter(entry => entry.name.startsWith(prefix))
      .map(entry => entry.name)
      .sort();
    for (const old of names.slice(0, Math.max(0, names.length - MAX_BAD_FILES))) {
      await rm(join(directory, old), { force: true, recursive: true }).catch(() => undefined);
    }
  } catch {
    // Pruning is best effort; a leftover copy is harmless.
  }
}

async function writeAtomic(directory: string, name: string, contents: string): Promise<boolean> {
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    try {
      await handle.sync();
    } catch (error) {
      // A filesystem that cannot fsync a regular file skips durability here; any other
      // error would mean the data may not be on disk, and the write fails.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
    }
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await syncDirectory(directory);
    return true;
  } catch {
    try {
      await handle?.close();
    } catch {
      // Already closed.
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Make the rename durable; a platform that cannot fsync a directory skips this. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms/filesystems do not allow fsync on a directory.
  } finally {
    try {
      await handle?.close();
    } catch {
      // Already closed.
    }
  }
}

function monthRecords(records: Map<string, ArchivedMessage>, month: string): ArchivedMessage[] {
  return [...records.values()]
    .filter(record => utcMonthOf(record.at) === month)
    .sort((left, right) => left.at - right.at || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

function serializeMonth(messages: ArchivedMessage[]): string {
  return JSON.stringify({ version: ARCHIVE_VERSION, messages });
}

function sameMonths(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
