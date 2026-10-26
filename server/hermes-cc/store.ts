import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export interface HermesCcImageKey { sessionKey: string; messageId: string }
export interface HermesCcImageInput { mime: string; data: Buffer }
export interface HermesCcStoredImage { mime: string; bytes: Buffer; sha256: string }
export interface HermesCcImageStore {
  save(key: HermesCcImageKey, images: readonly HermesCcImageInput[]): Promise<void>;
  load(key: HermesCcImageKey): Promise<HermesCcStoredImage[] | null>;
}

/**
 * Paseo v0.13.0 has no data-directory API: packages/plugin/src/server/contracts.ts:30-43.
 * The worker inherits the daemon environment (packages/server/src/server/plugins/runtime.ts:233-238).
 * Follow packages/server/src/server/paseo-home.ts:14-17; only Clear Chat owns this subtree.
 */
export function hermesCcImageRoot(_server: PluginServerContext): string {
  const home = process.env.PASEO_HOME ?? "~/.paseo";
  const expanded = home === "~" ? homedir() : home.startsWith("~/") ? join(homedir(), home.slice(2)) : home;
  return join(resolve(expanded), "plugin-data", "clear-chat", "hermes-cc", "images");
}

const MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const MAX_META_BYTES = 8 * 1024 * 1024;
interface ImageMeta { mime: string; sha256: string; size: number; file: string }
interface Meta extends HermesCcImageKey { createdAt: number; images: ImageMeta[]; conflict?: boolean }
interface Directory { path: string; handle: FileHandle }
const lanes = new Map<string, Promise<unknown>>();

function hash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function keyHash(key: HermesCcImageKey): string {
  for (const id of [key.sessionKey, key.messageId]) {
    // NUL would make two different pairs share the delimiter-based hash input.
    if (typeof id !== "string" || !id.trim() || id.length > 512 || id.includes("\0")) throw new Error("invalid_image_key");
  }
  return hash(`${key.sessionKey}\0${key.messageId}`);
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Linux descriptor-relative paths pin every ancestor, including during eviction. */
function child(directory: Directory, name: string): string {
  return join(process.platform === "linux" ? `/proc/self/fd/${directory.handle.fd}` : directory.path, name);
}
async function directory(path: string, create = false): Promise<Directory> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current: Directory = { path: root, handle: await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) };
  try {
    for (const name of absolute.slice(root.length).split(sep).filter(Boolean)) {
      const target = child(current, name);
      if (create) {
        try { await mkdir(target, { mode: 0o700 }); }
        catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      }
      const next = await openDirectory(target, join(current.path, name));
      await current.handle.close();
      current = next;
    }
    if (create) await current.handle.chmod(0o700);
    return current;
  } catch (error) {
    await current.handle.close();
    throw error;
  }
}
async function openDirectory(target: string, path = target): Promise<Directory> {
  const before = await lstat(target);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe_image_directory");
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw new Error("unsafe_image_directory");
    return { path, handle };
  } catch (error) { await handle.close(); throw error; }
}
async function readFile(directory: Directory, name: string, limit: number): Promise<Buffer> {
  const target = child(directory, name);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("unsafe_image_file");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== BigInt(before.dev) || stat.ino !== BigInt(before.ino) || stat.size > BigInt(limit)) {
      throw new Error("unsafe_image_file");
    }
    // Bound the allocation/read even if a file grows after fstat.
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(length) !== stat.size || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) {
      throw new Error("changed_image_file");
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function atomicWrite(directory: Directory, name: string, bytes: Buffer): Promise<void> {
  const temporary = child(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    // Rename replaces an entry itself; it never follows a symlink at the destination.
    try { if ((await lstat(child(directory, name))).isSymbolicLink()) throw new Error("unsafe_image_file"); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    await rename(temporary, child(directory, name));
  } finally { await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); }
}
async function metadata(directory: Directory, expected?: HermesCcImageKey): Promise<Meta> {
  const value: unknown = JSON.parse((await readFile(directory, "meta.json", MAX_META_BYTES)).toString("utf8"));
  if (!record(value) || typeof value.sessionKey !== "string" || typeof value.messageId !== "string" ||
      typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || !Array.isArray(value.images) ||
      (value.conflict !== undefined && typeof value.conflict !== "boolean")) throw new Error("invalid_image_metadata");
  const key = { sessionKey: value.sessionKey, messageId: value.messageId };
  keyHash(key);
  if (expected && (key.sessionKey !== expected.sessionKey || key.messageId !== expected.messageId)) throw new Error("invalid_image_metadata");
  for (const [index, image] of value.images.entries()) {
    if (!record(image) || typeof image.mime !== "string" || !MIMES.has(image.mime) ||
        typeof image.sha256 !== "string" || !HASH.test(image.sha256) ||
        typeof image.size !== "number" || !Number.isSafeInteger(image.size) || image.size < 0 ||
        image.file !== `${index}-${image.sha256}.bin`) throw new Error("invalid_image_metadata");
  }
  return value as unknown as Meta;
}
async function writeMeta(directory: Directory, meta: Meta): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(meta));
  if (bytes.length > MAX_META_BYTES) throw new Error("image_metadata_too_large");
  await atomicWrite(directory, "meta.json", bytes);
}

async function conflicted(root: Directory, name: string): Promise<boolean> {
  try {
    // Zero-byte markers survive whole-key eviction without consuming the byte budget.
    await readFile(root, `.conflict-${name}`, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Never recurse through untrusted directories or follow a linked file while deleting. */
async function removeFiles(directory: Directory): Promise<void> {
  const names = await readdir(child(directory, "."));
  for (const name of names) {
    const entry = await lstat(child(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("unsafe_image_file");
  }
  for (const name of names) await unlink(child(directory, name));
}

/**
 * The cap counts metadata and image files. A zero-byte conflict marker survives
 * eviction: removing it would let a later save make a conflicted ID resolve again.
 * Operations sharing a root serialize across store instances in this worker.
 */
export function createHermesCcImageStore(rootDir: string, options: { maxBytes?: number } = {}): HermesCcImageStore {
  const root = resolve(rootDir), maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_image_cap");
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (lanes.get(root) ?? Promise.resolve()).catch(() => {}).then(operation);
    lanes.set(root, pending);
    void pending.finally(() => { if (lanes.get(root) === pending) lanes.delete(root); }).catch(() => {});
    return pending;
  }
  async function evict(root: Directory): Promise<void> {
    const keys: { name: string; createdAt: number; size: number }[] = [];
    let total = 0;
    for (const name of await readdir(child(root, "."))) {
      if (!HASH.test(name)) continue;
      const dir = await openDirectory(child(root, name));
      try {
        const meta = await metadata(dir);
        if (keyHash(meta) !== name) throw new Error("invalid_image_metadata");
        let size = 0;
        for (const file of await readdir(child(dir, "."))) {
          const stat = await lstat(child(dir, file));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe_image_file");
          size += stat.size;
        }
        if (meta.conflict && !await conflicted(root, name)) {
          await atomicWrite(root, `.conflict-${name}`, Buffer.alloc(0));
        }
        total += size;
        keys.push({ name, createdAt: meta.createdAt, size });
      } finally { await dir.handle.close(); }
    }
    keys.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
    for (const key of keys) {
      if (total <= maxBytes) break;
      const dir = await openDirectory(child(root, key.name));
      try { await removeFiles(dir); }
      finally { await dir.handle.close(); }
      await rmdir(child(root, key.name));
      total -= key.size;
    }
  }
  return {
    async save(key, images) {
      // Capture inputs before waiting for another operation; never retain mutable caller buffers.
      const name = keyHash(key), savedKey = { ...key };
      const accepted = images.filter(image => MIMES.has(image.mime)).map(image => ({ mime: image.mime, bytes: Buffer.from(image.data) }));
      const entries = accepted.map((image, index) => {
        const sha256 = hash(image.bytes);
        return { mime: image.mime, sha256, size: image.bytes.length, file: `${index}-${sha256}.bin` };
      });
      return serialized(async () => {
        const rootDirectory = await directory(root, true);
        try {
          if (await conflicted(rootDirectory, name)) { await evict(rootDirectory); return; }
          let existing: Directory | undefined;
          try { existing = await openDirectory(child(rootDirectory, name)); }
          catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
          if (existing) {
            try {
              const meta = await metadata(existing, savedKey);
              if (!meta.conflict && (meta.images.length !== entries.length || meta.images.some((image, i) => image.sha256 !== entries[i]!.sha256))) {
                await atomicWrite(rootDirectory, `.conflict-${name}`, Buffer.alloc(0));
                await writeMeta(existing, { ...meta, conflict: true });
              }
            } finally { await existing.handle.close(); }
          } else {
            const temporaryName = `.${name}.${randomUUID()}.tmp`;
            await mkdir(child(rootDirectory, temporaryName), { mode: 0o700 });
            const temporary = await openDirectory(child(rootDirectory, temporaryName));
            let published = false;
            try {
              for (const [index, image] of accepted.entries()) await atomicWrite(temporary, entries[index]!.file, image.bytes);
              await writeMeta(temporary, { ...savedKey, createdAt: Date.now(), images: entries });
              await rename(child(rootDirectory, temporaryName), child(rootDirectory, name));
              published = true;
            } finally {
              try { if (!published) await removeFiles(temporary); }
              finally { await temporary.handle.close(); }
              if (!published) await rmdir(child(rootDirectory, temporaryName));
            }
          }
          await evict(rootDirectory);
        } finally { await rootDirectory.handle.close(); }
      });
    },
    async load(key) {
      const name = keyHash(key), savedKey = { ...key };
      return serialized(async () => {
        let rootDirectory: Directory | undefined, keyDirectory: Directory | undefined;
        try {
          rootDirectory = await directory(root);
          if (await conflicted(rootDirectory, name)) return null;
          keyDirectory = await openDirectory(child(rootDirectory, name));
          const meta = await metadata(keyDirectory, savedKey);
          if (meta.conflict || !meta.images.length) return null;
          const images: HermesCcStoredImage[] = [];
          for (const image of meta.images) {
            const bytes = await readFile(keyDirectory, image.file, image.size);
            if (bytes.length !== image.size || hash(bytes) !== image.sha256) return null;
            images.push({ mime: image.mime, bytes, sha256: image.sha256 });
          }
          return images;
        } catch { return null; }
        finally { await keyDirectory?.handle.close(); await rootDirectory?.handle.close(); }
      });
    },
  };
}
