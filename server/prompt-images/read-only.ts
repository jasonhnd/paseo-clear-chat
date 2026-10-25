import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Returns a canonical, bounded image file inside a canonical allowed root. */
export async function safeLocalImagePath(candidate: string, allowedRoots: readonly string[]): Promise<string | null> {
  // Reject traversal even if normalizing it would happen to remain inside a root.
  if (candidate.split(/[\\/]/).includes("..")) return null;
  if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) return null;
  try {
    const target = await realpath(resolve(candidate));
    if (!IMAGE_EXTENSIONS.has(extname(target).toLowerCase())) return null;
    const roots = await Promise.all(allowedRoots.map(root => realpath(root)));
    const inside = roots.some(root => {
      const path = relative(root, target);
      return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    });
    if (!inside) return null;
    const entry = await stat(target);
    return entry.isFile() && entry.size <= MAX_IMAGE_BYTES ? target : null;
  } catch {
    return null;
  }
}

/** Streams records without modifying the source; malformed/partial lines are skipped. */
export async function* readJsonlReadOnly(path: string): AsyncGenerator<unknown> {
  const stream = createReadStream(path, { encoding: "utf8", flags: "r" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      yield record;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Opens a main-database snapshot without locks, journals or sidecar writes.
 * Immutable reads cannot see WAL transactions, so refuse a nonempty WAL rather
 * than silently returning stale records. Callers must close the returned handle.
 * Import lazily: hosts lacking node:sqlite fail only the lookup, not startup.
 */
export async function openSqliteReadOnly(path: string) {
  const target = await realpath(path);
  try {
    if ((await stat(`${target}-wal`)).size > 0) throw new Error("sqlite_wal_unsupported");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const uri = pathToFileURL(target);
  uri.search = "?mode=ro&immutable=1";
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(uri.href, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
