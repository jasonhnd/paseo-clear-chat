import { constants, existsSync, read, realpath, type ReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Hard stop for reading a file into memory. Inline responses use a lower cap. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_JSONL_LINE_BYTES = 4 * MAX_IMAGE_BYTES + 64 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const nativeRealpath = promisify(realpath.native);

function insideRoot(target: string, roots: readonly string[]): boolean {
  return roots.some(root => {
    const path = relative(root, target);
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
}

/** Validate the opened file's identity and read only through that descriptor. */
export async function readLocalImageReadOnly(candidate: string, allowedRoots: readonly string[]): Promise<Buffer | null> {
  if (candidate.split(/[\\/]/).includes("..")) return null;
  if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const roots = await Promise.all(allowedRoots.map(root => nativeRealpath(root)));
    // NONBLOCK also prevents a substituted FIFO from stalling before fstat.
    file = await open(resolve(candidate), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const entry = await file.stat();
    if (!entry.isFile() || entry.size > MAX_IMAGE_BYTES) return null;
    const validate = async () => {
      // Native realpath preserves the filesystem's casing on macOS. Checking
      // dev/ino binds this canonical allowed path to the already open file.
      const target = await nativeRealpath(candidate);
      if (!IMAGE_EXTENSIONS.has(extname(target).toLowerCase()) || !insideRoot(target, roots)) return false;
      const current = await stat(target);
      return current.dev === entry.dev && current.ino === entry.ino;
    };
    if (!await validate()) return null;
    // Bound reads even if another process grows the file after fstat.
    const bytes = Buffer.alloc(entry.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > entry.size || !await validate()) return null;
    return bytes.subarray(0, length);
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

/** Read an already-open descriptor. `path` is not opened and this does not close `fd`. */
export interface JsonlReadOptions {
  fd?: number;
  /** Validate path-based reads against these roots. */
  allowedRoots?: readonly string[];
  signal?: AbortSignal;
  /** With `fd`, parse at most this many bytes from offset 0. */
  byteLength?: number;
  /** Called once per dropped record. Blank lines are not records. */
  onSkipped?: (event: { reason: "malformed" | "oversized" }) => void;
}

function readAt(fd: number, buffer: Buffer, position: number, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buffer, 0, length, position, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });
}

/** Positional reads leave the caller's descriptor open and do not follow a replaced path. */
async function* readDescriptor(fd: number, byteLength?: number): AsyncGenerator<Buffer> {
  const scratch = Buffer.alloc(64 * 1024);
  let position = 0;
  const limit = byteLength ?? Number.POSITIVE_INFINITY;
  while (position < limit) {
    const length = Math.min(scratch.length, limit - position);
    const bytesRead = await readAt(fd, scratch, position, length);
    if (bytesRead === 0) return;
    position += bytesRead;
    // The parser keeps slices until the newline, so the scratch buffer cannot be reused.
    yield Buffer.from(scratch.subarray(0, bytesRead));
  }
}

async function* recordsFromChunks(
  source: AsyncIterable<Buffer>,
  onSkipped?: (event: { reason: "malformed" | "oversized" }) => void,
): AsyncGenerator<unknown> {
  let chunks: Buffer[] = [];
  let length = 0;
  let oversized = false;
  const parse = () => {
    if (!length) return [];
    if (oversized) {
      onSkipped?.({ reason: "oversized" });
      return [];
    }
    try { return [JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown]; }
    catch {
      onSkipped?.({ reason: "malformed" });
      return [];
    }
  };
  for await (const bytes of source) {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      if (!oversized) {
        length += end - start;
        if (length > MAX_JSONL_LINE_BYTES) { oversized = true; chunks = []; }
        else chunks.push(bytes.subarray(start, end));
      }
      if (newline === -1) break;
      for (const record of parse()) yield record;
      chunks = []; length = 0; oversized = false;
      start = newline + 1;
    }
  }
  for (const record of parse()) yield record;
}

/**
 * Streams bounded records. Malformed, partial and oversized lines are skipped.
 * Pass `onSkipped` to learn that a record was dropped; callers that omit it
 * keep the previous behavior.
 */
export async function* readJsonlReadOnly(path: string, options?: JsonlReadOptions): AsyncGenerator<unknown> {
  options?.signal?.throwIfAborted();
  if (options?.fd !== undefined) {
    yield* recordsFromChunks(readDescriptor(options.fd, options.byteLength), options.onSkipped);
    return;
  }
  if (path.split(/[\\/]/).includes("..")) throw new Error("invalid_store");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let stream: ReadStream | undefined;
  try {
    const entry = await file.stat();
    if (!entry.isFile()) throw new Error("invalid_store");
    if (options?.allowedRoots) {
      const roots = await Promise.all(options.allowedRoots.map(root => nativeRealpath(root)));
      const target = await nativeRealpath(path);
      const current = await stat(target);
      if (!insideRoot(target, roots) || current.dev !== entry.dev || current.ino !== entry.ino) {
        throw new Error("invalid_store");
      }
    }
    stream = file.createReadStream({ autoClose: false, signal: options?.signal });
    yield* recordsFromChunks(stream as AsyncIterable<Buffer>, options?.onSkipped);
  } finally {
    stream?.destroy();
    await file.close();
  }
}

type SqliteDatabase = import("node:sqlite").DatabaseSync;

function sqliteSidecar(path: string): boolean {
  return existsSync(`${path}-wal`) || existsSync(`${path}-shm`) || existsSync(`${path}-journal`);
}

/** Opens one read-only connection. The caller closes it. */
async function openSqliteDatabase(
  path: string,
  immutable: boolean,
  beforeOpen?: (plan: { immutable: boolean; uri: string }) => void,
) {
  const uri = pathToFileURL(path);
  uri.search = immutable ? "?mode=ro&immutable=1" : "?mode=ro";
  beforeOpen?.({ immutable, uri: uri.href });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(uri.href, { readOnly: true });
  try {
    // Only the plain path can coordinate with a writer and wait for locks.
    database.exec(immutable ? "PRAGMA query_only = ON" : "PRAGMA query_only = ON; PRAGMA busy_timeout = 250");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function querySqlitePlain<T>(
  path: string,
  query: (database: SqliteDatabase) => T,
  beforeOpen?: (plan: { immutable: boolean; uri: string }) => void,
): Promise<T | null> {
  let database: SqliteDatabase | undefined;
  try {
    database = await openSqliteDatabase(path, false, beforeOpen);
    return query(database);
  } catch {
    // Hot journal recovery requires writes, which this reader must never make.
    return null;
  } finally {
    database?.close();
  }
}

/**
 * Reads one query, then closes the database.
 *
 * When no `<db>-wal`, `<db>-shm` or `<db>-journal` exists, the file is a
 * candidate for `file:<realpath>?mode=ro&immutable=1` with `{ readOnly: true }`
 * and `query_only`. That creates no sidecar files. When any sidecar exists,
 * the plain `mode=ro` path is used, with `query_only` and a 250 ms busy
 * timeout. The plain read-only path may update reader marks in the existing
 * `-shm` (SQLite's coordination file), but it never changes database content.
 * Hot journals and lock errors on the plain path return null without recovery.
 *
 * A writer can create a sidecar after the check and before the immutable open.
 * The sidecars and main file identity, size and mtime are checked after that
 * query. A change also catches a writer that checkpoints and removes its
 * sidecars before the check. The result is discarded and the query runs once
 * more on the plain path if a sidecar exists, or immutably if only the main
 * file changed. Another change, a sidecar or a failure during the immutable
 * retry returns null and the caller reports no images. Open failures propagate
 * only on the first attempt when both checks stay unchanged. `node:sqlite` is
 * imported lazily so hosts that lack it fail only the lookup, not startup.
 *
 * `hooks.beforeOpen` runs after the sidecar check and before the file is
 * opened, so a test can create a sidecar in that window. `afterImmutableQuery`
 * runs after closing the immutable connection, before sampling the file again.
 */
export async function openSqliteReadOnly<T>(
  path: string,
  query: (database: SqliteDatabase) => T,
  hooks?: {
    beforeOpen?: (plan: { immutable: boolean; uri: string }) => void;
    afterImmutableQuery?: () => void;
  },
): Promise<T | null> {
  const real = await nativeRealpath(path);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (sqliteSidecar(real)) return attempt === 0 ? querySqlitePlain(real, query, hooks?.beforeOpen) : null;
    let before;
    try {
      before = await stat(real, { bigint: true });
    } catch (error) {
      if (attempt === 0) throw error;
      return null;
    }
    let outcome: { ok: true; result: T } | { ok: false; error: unknown };
    try {
      const database = await openSqliteDatabase(real, true, hooks?.beforeOpen);
      try {
        outcome = { ok: true, result: query(database) };
      } catch (error) {
        outcome = { ok: false, error };
      } finally {
        database.close();
      }
      hooks?.afterImmutableQuery?.();
    } catch (error) {
      outcome = { ok: false, error };
    }
    let unchanged = false;
    try {
      const after = await stat(real, { bigint: true });
      unchanged = before.dev === after.dev && before.ino === after.ino &&
        before.size === after.size && before.mtimeNs === after.mtimeNs;
    } catch {
      // A missing or unreadable main file also invalidates the immutable result.
    }
    const sidecar = sqliteSidecar(real);
    if (unchanged && !sidecar) {
      if (outcome.ok) return outcome.result;
      if (attempt === 0) throw outcome.error;
      return null;
    }
    if (attempt === 1) return null;
    if (sidecar) return querySqlitePlain(real, query, hooks?.beforeOpen);
  }
  return null;
}
