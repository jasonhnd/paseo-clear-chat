import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export interface HermesCcImageKey { sessionKey: string; messageId: string }
export interface HermesCcImageInput { mime: string; data: Buffer }
export interface HermesCcStoredImage { mime: string; bytes: Buffer; sha256: string }
export interface HermesCcImageStore {
  save(key: HermesCcImageKey, images: readonly HermesCcImageInput[]): Promise<"saved" | "conflict">;
  load(key: HermesCcImageKey): Promise<HermesCcStoredImage[] | null>;
}

/**
 * SDK v0.13.0 packages/plugin/src/server/contracts.ts:30-43 has no plugin data
 * directory API. Expand the daemon home like server/paseo-home.ts:4-17, then
 * canonicalize it once at contribution. A symlinked ~/.paseo is supported; only
 * descendants of this real root undergo component-by-component NOFOLLOW checks.
 */
export function hermesCcPaseoHome(): string {
  const home = process.env.PASEO_HOME ?? "~/.paseo";
  const expanded = home === "~" ? homedir() : home.startsWith("~/") ? join(homedir(), home.slice(2)) : home;
  return realpathSync(resolve(expanded));
}
export function hermesCcImageRoot(_server: PluginServerContext, home = hermesCcPaseoHome()): string {
  return join(home, "plugin-data", "clear-chat", "hermes-cc-images");
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
async function directory(path: string, create = false, trustedRoot = parse(resolve(path)).root): Promise<Directory> {
  const absolute = resolve(path), root = resolve(trustedRoot), tail = relative(root, absolute);
  if (tail === ".." || tail.startsWith(`..${sep}`)) throw new Error("unsafe_image_directory");
  let current: Directory = { path: root, handle: await open(root, constants.O_RDONLY | constants.O_DIRECTORY) };
  try {
    for (const name of tail.split(sep).filter(Boolean)) {
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

function payloadHash(images: readonly ImageMeta[]): string {
  return hash(JSON.stringify(images.map(image => [image.mime, image.sha256, image.size])));
}
async function rememberPayload(root: Directory, name: string, payload: string): Promise<void> {
  const marker = `.seen-${name}-${payload}`;
  try {
    const handle = await open(child(root, marker), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  await readFile(root, marker, 0);
}
async function payloadConflict(root: Directory, name: string, payload: string): Promise<boolean> {
  const names = (await readdir(child(root, "."))).filter(entry => entry.startsWith(`.seen-${name}-`));
  if (names.length !== 1 || names[0] !== `.seen-${name}-${payload}`) return true;
  await readFile(root, names[0], 0);
  return false;
}

const LOCK_NAME = ".save.lock";
const STALE_MS = 5 * 60_000;

/** Cross-process root lock also serializes eviction and reads against publication. */
async function withDiskLock<T>(root: Directory, run: () => Promise<T>): Promise<T> {
  const target = child(root, LOCK_NAME), deadline = Date.now() + 15_000;
  let handle: FileHandle;
  for (;;) {
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() })); }
      catch (error) { await handle.close(); await unlink(target); throw error; }
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      let stat;
      try { stat = await lstat(target); }
      catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe_image_lock");
      if (Date.now() - stat.mtimeMs > STALE_MS) {
        let alive = false;
        try {
          const owner: unknown = JSON.parse((await readFile(root, LOCK_NAME, 4096)).toString("utf8"));
          if (record(owner) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
            try { process.kill(Number(owner.pid), 0); alive = true; }
            catch (error) { alive = !hasCode(error, "ESRCH"); }
          }
        } catch { /* An abandoned, incomplete lock can expire too. */ }
        if (!alive) {
          // Claim this specific stale inode once. The zero-byte claim survives
          // a reaper crash, so competing reapers can never unlink a newer lock.
          const claim = `.reaped-${hash(`${stat.dev}:${stat.ino}:${stat.mtimeMs}`)}`;
          let claimed: FileHandle | undefined;
          try {
            claimed = await open(child(root, claim), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            const current = await lstat(target);
            if (current.dev === stat.dev && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) await unlink(target);
          } catch (error) { if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOENT")) throw error; }
          finally { await claimed?.close(); }
        }
      }
      if (Date.now() >= deadline) throw new Error("image_lock_timeout");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  const heartbeat = setInterval(() => { const now = new Date(); void handle.utimes(now, now).catch(() => {}); }, STALE_MS / 3);
  heartbeat.unref();
  try { return await run(); }
  finally {
    clearInterval(heartbeat);
    try {
      const held = await handle.stat(), current = await lstat(target);
      if (held.dev === current.dev && held.ino === current.ino) await unlink(target);
    } finally { await handle.close(); }
  }
}

/** Descriptor-relative recursion never follows symlinks, even for orphan cleanup. */
async function removeFiles(directory: Directory): Promise<void> {
  for (const name of await readdir(child(directory, "."))) {
    const entry = await lstat(child(directory, name));
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await openDirectory(child(directory, name));
      try { await removeFiles(nested); } finally { await nested.handle.close(); }
      await rmdir(child(directory, name));
    } else {
      await unlink(child(directory, name));
    }
  }
}
async function directoryBytes(directory: Directory): Promise<number> {
  let size = 0;
  for (const name of await readdir(child(directory, "."))) {
    const entry = await lstat(child(directory, name));
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try {
        const nested = await openDirectory(child(directory, name));
        try { size += await directoryBytes(nested); } finally { await nested.handle.close(); }
      } catch { size += entry.size; }
    } else size += entry.size;
  }
  return size;
}

/**
 * The cap counts metadata, images and orphans. Zero-byte conflict and payload
 * fingerprints survive eviction: forgetting an identity could allow a later
 * different payload to silently win. Intents use O_EXCL before taking the root
 * lock, so even a writer that times out cannot leave an old image selectable.
 * All operations serialize across workers under the on-disk root lock.
 */
export function createHermesCcImageStore(rootDir: string, options: { maxBytes?: number; trustedRoot?: string } = {}): HermesCcImageStore {
  const root = resolve(rootDir), maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_image_cap");
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (lanes.get(root) ?? Promise.resolve()).catch(() => {}).then(operation);
    lanes.set(root, pending);
    void pending.finally(() => { if (lanes.get(root) === pending) lanes.delete(root); }).catch(() => {});
    return pending;
  }
  async function evict(root: Directory): Promise<void> {
    const entries: { name: string; createdAt: number; size: number; directory: boolean; orphan: boolean }[] = [];
    let total = 0;
    for (const name of await readdir(child(root, "."))) {
      if (name === LOCK_NAME) continue;
      const stat = await lstat(child(root, name));
      const marker = /^\.(?:conflict|reaped)-[a-f0-9]{64}$/.test(name) || /^\.seen-[a-f0-9]{64}-[a-f0-9]{64}$/.test(name);
      if (marker && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 0) continue;
      const damagedIdentity = /^\.seen-([a-f0-9]{64})-/.exec(name)?.[1];
      if (damagedIdentity) await atomicWrite(root, `.conflict-${damagedIdentity}`, Buffer.alloc(0));
      if (/^\.conflict-[a-f0-9]{64}$/.test(name)) {
        // Repair a damaged marker without following any target. Its identity
        // stays poisoned and nonzero marker contents cannot bypass the cap.
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const damaged = await openDirectory(child(root, name));
          try { await removeFiles(damaged); } finally { await damaged.handle.close(); }
          await rmdir(child(root, name));
        } else await unlink(child(root, name));
        await atomicWrite(root, name, Buffer.alloc(0));
        continue;
      }
      let size = stat.size, createdAt = stat.mtimeMs, orphan = true;
      const isDirectory = stat.isDirectory() && !stat.isSymbolicLink();
      if (HASH.test(name) && !isDirectory) await atomicWrite(root, `.conflict-${name}`, Buffer.alloc(0));
      if (isDirectory) {
        let dir: Directory | undefined;
        try {
          dir = await openDirectory(child(root, name));
          size = await directoryBytes(dir);
          if (HASH.test(name)) {
            const meta = await metadata(dir);
            if (keyHash(meta) !== name) throw new Error("invalid_image_metadata");
            createdAt = meta.createdAt;
            orphan = false;
            if (meta.conflict && !await conflicted(root, name)) await atomicWrite(root, `.conflict-${name}`, Buffer.alloc(0));
          }
        } catch {
          // Invalid/unreadable metadata never aborts a different prompt's save.
          // Poison a malformed key before reclaiming it; it cannot be healed by
          // a later save with unrelated bytes under that same identity.
          if (HASH.test(name)) await atomicWrite(root, `.conflict-${name}`, Buffer.alloc(0));
        } finally { await dir?.handle.close(); }
      }
      total += size;
      entries.push({ name, createdAt, size, directory: isDirectory, orphan });
    }
    entries.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Stale temporary trees/files are reclaimed even below the cap. Recent
      // orphans still count towards it and may be evicted to enforce the cap.
      if (total <= maxBytes && !(entry.orphan && Date.now() - entry.createdAt > STALE_MS)) continue;
      if (entry.directory) {
        let dir: Directory | undefined;
        try {
          dir = await openDirectory(child(root, entry.name));
          await removeFiles(dir);
        } catch (error) {
          if (!hasCode(error, "EACCES") && !hasCode(error, "EPERM")) throw error;
          continue; // Count unreadable entries; never escape the root to remove them.
        } finally { await dir?.handle.close(); }
        await rmdir(child(root, entry.name));
      } else await unlink(child(root, entry.name));
      total -= entry.size;
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
        const rootDirectory = await directory(root, true, options.trustedRoot).catch(() => { throw new Error("image_store_failed"); });
        try {
          const payload = payloadHash(entries);
          await rememberPayload(rootDirectory, name, payload);
          return await withDiskLock(rootDirectory, async () => {
            if (await conflicted(rootDirectory, name)) { await evict(rootDirectory); return "conflict"; }
            let conflict = await payloadConflict(rootDirectory, name, payload);
            let existing: Directory | undefined;
            try { existing = await openDirectory(child(rootDirectory, name)); }
            catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
            if (existing) {
              try {
                const meta = await metadata(existing, savedKey);
                conflict = conflict || !!meta.conflict || meta.images.length !== entries.length || meta.images.some((image, i) => image.sha256 !== entries[i]!.sha256 || image.mime !== entries[i]!.mime);
                for (const image of meta.images) {
                  const bytes = await readFile(existing, image.file, image.size);
                  if (bytes.length !== image.size || hash(bytes) !== image.sha256) conflict = true;
                }
                if (conflict) {
                  await atomicWrite(rootDirectory, `.conflict-${name}`, Buffer.alloc(0));
                  await writeMeta(existing, { ...meta, conflict: true });
                }
              } finally { await existing.handle.close(); }
            } else if (!conflict) {
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
            // Another process may record its intent while this writer holds the
            // lock. Recheck before reporting success; readers check fingerprints too.
            conflict = conflict || await payloadConflict(rootDirectory, name, payload);
            if (conflict) await atomicWrite(rootDirectory, `.conflict-${name}`, Buffer.alloc(0));
            await evict(rootDirectory);
            return conflict ? "conflict" : "saved";
          });
        } catch { throw new Error("image_store_failed"); }
        finally { await rootDirectory.handle.close(); }
      });
    },
    async load(key) {
      const name = keyHash(key), savedKey = { ...key };
      return serialized(async () => {
        let rootDirectory: Directory | undefined, keyDirectory: Directory | undefined;
        try {
          rootDirectory = await directory(root, false, options.trustedRoot);
          return await withDiskLock(rootDirectory, async () => {
            if (await conflicted(rootDirectory!, name)) return null;
            keyDirectory = await openDirectory(child(rootDirectory!, name));
            const meta = await metadata(keyDirectory, savedKey);
            if (meta.conflict || !meta.images.length || await payloadConflict(rootDirectory!, name, payloadHash(meta.images))) return null;
            const images: HermesCcStoredImage[] = [];
            for (const image of meta.images) {
              const bytes = await readFile(keyDirectory, image.file, image.size);
              if (bytes.length !== image.size || hash(bytes) !== image.sha256) return null;
              images.push({ mime: image.mime, bytes, sha256: image.sha256 });
            }
            return images;
          });
        } catch { return null; }
        finally { await keyDirectory?.handle.close(); await rootDirectory?.handle.close(); }
      });
    },
  };
}
