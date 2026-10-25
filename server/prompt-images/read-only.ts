import { constants, createReadStream, realpath } from "node:fs";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * Reads live databases, including committed WAL transactions. Callers must close
 * the handle in finally immediately after querying. Open failures propagate;
 * there is no fallback to a stale main-file snapshot. Import lazily so hosts
 * lacking node:sqlite fail only the lookup, not startup.
 */
export async function openSqliteReadOnly(path: string) {
  const uri = pathToFileURL(await nativeRealpath(path));
  uri.search = "?mode=ro";
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(uri.href, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
