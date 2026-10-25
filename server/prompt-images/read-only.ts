import { constants, createReadStream, existsSync, realpath } from "node:fs";
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

/** Streams bounded records; malformed, partial and oversized lines are skipped. */
export async function* readJsonlReadOnly(path: string): AsyncGenerator<unknown> {
  const stream = createReadStream(path, { flags: "r" });
  let chunks: Buffer[] = [];
  let length = 0;
  let oversized = false;
  const parse = () => {
    if (oversized || !length) return [];
    try { return [JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown]; }
    catch { return []; }
  };
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
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
  } finally {
    stream.destroy();
  }
}

type SqliteDatabase = import("node:sqlite").DatabaseSync;

function sqliteSidecar(path: string): boolean {
  return existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
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
    // Idle files use immutable mode, which has no writer to wait for.
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
): Promise<T> {
  const database = await openSqliteDatabase(path, false, beforeOpen);
  try {
    return query(database);
  } finally {
    database.close();
  }
}

/**
 * Reads one query, then closes the database.
 *
 * When neither `<db>-wal` nor `<db>-shm` exists, nothing is writing, so the
 * file opens as `file:<realpath>?mode=ro&immutable=1` with `{ readOnly: true }`
 * and `query_only`. That creates no sidecar files. When either sidecar exists,
 * the plain `mode=ro` path is used, with `query_only` and a 250 ms busy
 * timeout. The plain read-only path may update reader marks in the existing
 * `-shm` (SQLite's coordination file), but it never changes database content.
 *
 * A writer can create a sidecar after the check and before the immutable open.
 * The sidecars are checked again after that query. If one has appeared, the
 * result is discarded and the query runs once more on the plain path. If that
 * retry also fails, this returns null and the caller reports no images. Open
 * failures propagate when no sidecar raced in. `node:sqlite` is imported
 * lazily so hosts that lack it fail only the lookup, not startup.
 *
 * `hooks.beforeOpen` runs after the sidecar check and before the file is
 * opened, so a test can create a sidecar in that window.
 */
export async function openSqliteReadOnly<T>(
  path: string,
  query: (database: SqliteDatabase) => T,
  hooks?: { beforeOpen?: (plan: { immutable: boolean; uri: string }) => void },
): Promise<T | null> {
  const real = await nativeRealpath(path);
  if (sqliteSidecar(real)) return querySqlitePlain(real, query, hooks?.beforeOpen);
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
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (!sqliteSidecar(real)) {
    if (outcome.ok) return outcome.result;
    throw outcome.error;
  }
  try {
    return await querySqlitePlain(real, query, hooks?.beforeOpen);
  } catch {
    return null;
  }
}
