import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zoneDayKey, type HistoryMessageRow } from "./history-reader";

/**
 * The plugin's own archive of the person's messages.
 *
 * Hermes prunes conversations after a retention window, so a calendar that only reads
 * Hermes's databases loses old days. This archive keeps one record per message under
 * `<Paseo home>/plugin-data/clear-chat/history/`, split into UTC months. Every read merges
 * the fresh fast-path rows into it; records never change once written (an existing key wins),
 * so a day Hermes has pruned stays visible.
 *
 * Files are private (directory 0700, files 0600), written through a same-directory `.tmp`
 * file and renamed into place. One archive instance serializes every merge on a promise
 * chain: two RPCs arriving together cannot read the same base and overwrite each other.
 *
 * A file that cannot be read, does not parse, or has an unknown version is renamed to
 * `<name>.bad` (replacing an older `.bad`) and treated as empty; the merge then rewrites what
 * the fast path still has. `meta.json` is rebuilt from the month files the same way. A write
 * failure never fails the RPC: the caller answers from the fast rows and reports
 * `cacheError: true`.
 *
 * A month file that would exceed `maxMonthBytes` (20 MB unless another limit is injected)
 * stops taking text: newly added rows in that month are written as count-only records
 * `{ key, agentId, at }`, and the month is reported in `cacheFull`. Existing text is kept.
 */

export const ARCHIVE_VERSION = 1;
export const DEFAULT_MAX_MONTH_BYTES = 20 * 1024 * 1024;
const MONTH_FILE = /^messages-(\d{4}-\d{2})\.json$/;
const META_FILE = "meta.json";
const TEMP_SUFFIX = ".tmp";
const BAD_SUFFIX = ".bad";
const CORRUPT = Symbol("corrupt");

export interface ArchivedMessage {
  /** sha256 of the session id, instant and text, first 16 hex characters. */
  key: string;
  agentId: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** Absent on a count-only record written after its month file reached the size cap. */
  text?: string;
}

export interface HistoryArchiveOptions {
  /** Paseo home; defaults to `PASEO_HOME` or `<home>/.paseo` when the merge runs. */
  home?: string;
  /** Size at which a month file takes new rows without text. */
  maxMonthBytes?: number;
  now?: () => number;
}

export interface ArchiveMerge {
  /** Every record after the merge, or just the fast rows when the archive is unavailable. */
  messages: ArchivedMessage[];
  cacheError: boolean;
  cacheFull: string[];
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
  rows.sort((left, right) => right.at - left.at
    || (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0)
    || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
  return rows;
}

interface StoreRead {
  records: Map<string, ArchivedMessage>;
  meta: { version: number; months: Record<string, number> } | null;
  cacheError: boolean;
}

export class HistoryArchive {
  private readonly options: HistoryArchiveOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HistoryArchiveOptions = {}) {
    this.options = options;
  }

  /** Merge the fast rows into the archive and return the merged records. */
  merge(fast: readonly HistoryMessageRow[]): Promise<ArchiveMerge> {
    return this.enqueue(() => this.mergeNow(fast));
  }

  /** One promise chain per archive instance; a failed merge does not break the chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async mergeNow(fast: readonly HistoryMessageRow[]): Promise<ArchiveMerge> {
    const directory = historyArchiveDirectory(this.options.home);
    const fastRecords: ArchivedMessage[] = [];
    for (const row of fast) {
      if (!Number.isFinite(row.at) || Number.isNaN(new Date(row.at).getTime())) continue;
      fastRecords.push({
        key: archiveKey(row.sessionId, row.at, row.text),
        agentId: row.agentId,
        at: row.at,
        text: row.text,
      });
    }
    if (!(await ensureDirectory(directory))) {
      return { messages: fastRecords, cacheError: true, cacheFull: [] };
    }
    const store = await readStore(directory);
    if (store.cacheError) {
      // Without a complete read of the store, writing would risk replacing records that
      // exist but could not be seen. Answer from the fast path only.
      return { messages: fastRecords, cacheError: true, cacheFull: [] };
    }

    const records = store.records;
    const added = new Map<string, Set<string>>();
    for (const record of fastRecords) {
      if (records.has(record.key)) continue; // only grows: an existing key never changes
      records.set(record.key, record);
      const month = utcMonthOf(record.at);
      const keys = added.get(month) ?? new Set<string>();
      keys.add(record.key);
      added.set(month, keys);
    }

    const cacheFull: string[] = [];
    let cacheError = false;
    try {
      if (await this.writeMonths(directory, records, added, cacheFull)) cacheError = true;
      if (await this.writeMeta(directory, records, store.meta)) cacheError = true;
    } catch {
      cacheError = true;
    }
    if (cacheError) return { messages: fastRecords, cacheError: true, cacheFull };
    return { messages: [...records.values()], cacheError: false, cacheFull };
  }

  private async writeMonths(
    directory: string,
    records: Map<string, ArchivedMessage>,
    added: Map<string, Set<string>>,
    cacheFull: string[],
  ): Promise<boolean> {
    let failed = false;
    const limit = this.options.maxMonthBytes ?? DEFAULT_MAX_MONTH_BYTES;
    for (const [month, keys] of added) {
      let payload = monthRecords(records, month);
      let json = serializeMonth(payload);
      if (Buffer.byteLength(json, "utf8") > limit) {
        // Stop adding text to this month. New rows keep their identity for dedupe and
        // counting, but the text is not stored; records already holding text keep it.
        for (const key of keys) {
          const record = records.get(key);
          if (record?.text !== undefined) {
            records.set(key, { key: record.key, agentId: record.agentId, at: record.at });
          }
        }
        payload = monthRecords(records, month);
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
}

async function ensureDirectory(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return true;
  } catch {
    return false;
  }
}

async function readStore(directory: string): Promise<StoreRead> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
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
    if (entry.name === META_FILE) {
      const parsed = await readJsonFile(directory, entry.name);
      if (parsed === CORRUPT) {
        if (!(await renameBad(directory, entry.name))) cacheError = true;
      } else if (parsed !== null && isMetaFile(parsed)) {
        meta = { version: ARCHIVE_VERSION, months: parsed.months };
      } else if (parsed !== null) {
        if (!(await renameBad(directory, entry.name))) cacheError = true;
      }
      continue;
    }
    if (!MONTH_FILE.test(entry.name)) continue;
    const parsed = await readJsonFile(directory, entry.name);
    if (parsed === null) continue;
    if (parsed === CORRUPT || !isMonthFile(parsed)) {
      if (!(await renameBad(directory, entry.name))) cacheError = true;
      continue;
    }
    for (const record of parsed.messages) {
      if (!isArchivedMessage(record)) continue;
      if (!records.has(record.key)) records.set(record.key, record);
    }
  }
  return { records, meta, cacheError };
}

async function readJsonFile(
  directory: string, name: string,
): Promise<Record<string, unknown> | null | typeof CORRUPT> {
  let raw: string;
  try {
    raw = await readFile(join(directory, name), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : CORRUPT;
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

function isMonthFile(value: Record<string, unknown>): value is { version: 1; messages: unknown[] } {
  return value.version === ARCHIVE_VERSION && Array.isArray(value.messages);
}

function isMetaFile(value: Record<string, unknown>): value is { version: 1; months: Record<string, number> } {
  if (value.version !== ARCHIVE_VERSION || !value.months || typeof value.months !== "object") return false;
  return Object.values(value.months).every(count => Number.isInteger(count) && count >= 0);
}

function isArchivedMessage(value: unknown): value is ArchivedMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && record.key.length > 0
    && typeof record.agentId === "string"
    && typeof record.at === "number" && Number.isFinite(record.at)
    && (record.text === undefined || typeof record.text === "string");
}

async function renameBad(directory: string, name: string): Promise<boolean> {
  const source = join(directory, name);
  const target = join(directory, `${name}${BAD_SUFFIX}`);
  try {
    await rm(target, { force: true, recursive: true });
    await rename(source, target);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(directory: string, name: string, contents: string): Promise<boolean> {
  const target = join(directory, name);
  const temporary = join(directory, `${name}${TEMP_SUFFIX}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
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
