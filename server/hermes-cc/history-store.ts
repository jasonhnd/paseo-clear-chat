import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hermesCcPaseoHome } from "./store";

export interface HermesCcJournalKey { providerId: string; nativeSessionId: string }
export type HermesCcJournalState =
  | { status: "complete"; events: readonly unknown[] }
  | { status: "unusable"; reason: string };
export interface HermesCcWriterOwner { token: string; generation: number }
export interface HermesCcWriterLease extends HermesCcWriterOwner { release(): Promise<void> }
/** Mutation owners are required once a journal has been leased; a mismatch throws writer_changed after invalidation. */
export interface HermesCcHistoryStore {
  /** Start a journal for a session Clear Chat saw being CREATED (history "skip" on a brand-new session). Fails if one exists. */
  start(key: HermesCcJournalKey, owner?: HermesCcWriterOwner): Promise<void>;
  /** Durably append one provider event (already in final, emitted form). Ordered; serialised per key; resolves only after fsync. No-op if the key has no journal or is invalidated. */
  append(key: HermesCcJournalKey, event: unknown, owner?: HermesCcWriterOwner): Promise<void>;
  /** Mark prompt admission / terminal ACP response after notifications drain (not the SDK session.prompt_result). Open turns are unusable. */
  turnStarted(key: HermesCcJournalKey, owner?: HermesCcWriterOwner): Promise<void>;
  turnSettled(key: HermesCcJournalKey, owner?: HermesCcWriterOwner): Promise<void>;
  /** Permanently mark unusable (history-mutating commands, load failure mismatch, etc.).
   * A foreign_writer marker is synced outside the journal lock, including before
   * session creation. Failed marker writes are retried before local access.
   */
  invalidate(key: HermesCcJournalKey, reason: string): Promise<void>;
  read(key: HermesCcJournalKey): Promise<HermesCcJournalState>;
  /** Optional recorder ownership. Refuses a second live claimant, including in this process.
   * Only a dead process may be replaced. Present the returned owner on every mutation;
   * writer_changed rejects stale owners and permanently disables replay.
   */
  claimWriter?(key: HermesCcJournalKey): Promise<HermesCcWriterLease | null>;
}

/**
 * Presentation journal for Hermes·CC. Paseo 0.13 keeps timelines in memory, so
 * resume replays this file instead of Hermes only when the journal was recorded
 * from session creation and every turn has settled. A crash after the JSONL
 * line is fsynced and before the manifest is renamed stays unusable: counts are
 * never repaired upward from the file.
 */
const VERSION = 1;
const EVENTS = "events.jsonl";
const MANIFEST = "manifest.json";
const LOCK = ".journal.lock";
const USAGE = ".usage.json";
const USAGE_BYTES = 256;
const WRITER_MS = 30_000;
const DEFAULT_SESSION_BYTES = 64 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const STALE_MS = 5 * 60_000;
const HASH = /^[a-f0-9]{64}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const ERRORS = new Set([
  "invalid_journal_key", "invalid_history_cap", "journal_exists", "invalid_event",
  "unsafe_history_directory", "unsafe_history_file", "unsafe_history_lock",
  "history_lock_timeout", "history_store_failed", "writer_changed",
]);
interface Manifest {
  version: 1;
  providerId: string;
  nativeSessionId: string;
  startedFromCreation: boolean;
  openTurns: number;
  bytes: number;
  records: number;
  createdAt: number;
  journalId: string;
  headHash: string;
  manifestHash: string;
  invalid?: string;
  writer?: HermesCcWriterOwner;
}
interface Directory { path: string; handle: FileHandle }
interface Entry { name: string; createdAt: number; size: number; eventsBytes: number; kind: "session" | "orphan" | "link" }
const lanes = new Map<string, Promise<unknown>>();
// Shared across store instances for one root. Keep failed marker writes pending
// until they are durable. Until storage recovers, local reads fail closed.
const pendingInvalidations = new Map<string, string>();

export function hermesCcHistoryRoot(_server: PluginServerContext, home = hermesCcPaseoHome()): string {
  return join(home, "plugin-data", "clear-chat", "hermes-cc-history");
}

function hash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function keyHash(key: HermesCcJournalKey): string { return hash(`${key.providerId}\0${key.nativeSessionId}`); }
function snapshotKey(key: HermesCcJournalKey): HermesCcJournalKey {
  if (key === null || typeof key !== "object") throw new Error("invalid_journal_key");
  const snapshot = { providerId: key.providerId, nativeSessionId: key.nativeSessionId };
  assertKey(snapshot);
  return snapshot;
}
function assertKey(key: HermesCcJournalKey): void {
  if (key === null || typeof key !== "object") throw new Error("invalid_journal_key");
  for (const id of [key.providerId, key.nativeSessionId]) {
    if (typeof id !== "string" || !id.trim() || id.length > 512 || id.includes("\0")) throw new Error("invalid_journal_key");
  }
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function writerOwner(value: unknown): value is HermesCcWriterOwner {
  return record(value) && typeof value.token === "string" && /^[a-f0-9-]{36}$/.test(value.token) &&
    typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation > 0;
}
function sameWriter(left: HermesCcWriterOwner | undefined, right: HermesCcWriterOwner | undefined): boolean {
  return left?.token === right?.token && left?.generation === right?.generation;
}
function snapshotOwner(owner: HermesCcWriterOwner | undefined): HermesCcWriterOwner | undefined {
  return owner === undefined ? undefined : { token: owner.token, generation: owner.generation };
}
function fail(error: unknown): never {
  if (error instanceof Error && ERRORS.has(error.message)) throw error;
  throw new Error("history_store_failed");
}
function reasonCode(reason: string): string { return REASON.test(reason) ? reason : "invalidated"; }
function unusable(reason: string): HermesCcJournalState { return { status: "unusable", reason }; }
function evictedMarker(name: string): string { return `.evicted-${name}`; }
function isEvictedMarker(name: string): boolean { return /^\.evicted-[a-f0-9]{64}$/.test(name); }
function foreignMarker(name: string): string { return `.foreign-${name}`; }
function isForeignMarker(name: string): boolean { return /^\.foreign-[a-f0-9]{64}$/.test(name); }
function isReapedMarker(name: string): boolean { return /^\.reaped-[a-f0-9]{64}$/.test(name); }
function isTemp(name: string): boolean { return name.endsWith(".tmp"); }

function child(directory: Directory, name: string): string {
  return join(process.platform === "linux" ? `/proc/self/fd/${directory.handle.fd}` : directory.path, name);
}
async function directory(path: string, create = false, trustedRoot = parse(resolve(path)).root): Promise<Directory> {
  const absolute = resolve(path), root = resolve(trustedRoot), tail = relative(root, absolute);
  if (tail === ".." || tail.startsWith(`..${sep}`)) throw new Error("unsafe_history_directory");
  let current: Directory = { path: root, handle: await open(root, constants.O_RDONLY | constants.O_DIRECTORY) };
  try {
    for (const name of tail.split(sep).filter(Boolean)) {
      const target = child(current, name);
      if (create) {
        try { await mkdir(target, { mode: 0o700 }); await syncDirectory(current); }
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
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe_history_directory");
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw new Error("unsafe_history_directory");
    return { path, handle };
  } catch (error) { await handle.close(); throw error; }
}
async function readFile(directory: Directory, name: string, limit: number, stableTimes = true): Promise<Buffer> {
  const target = child(directory, name);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("unsafe_history_file");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== BigInt(before.dev) || stat.ino !== BigInt(before.ino) || stat.size > BigInt(limit)) {
      throw new Error("unsafe_history_file");
    }
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(length) !== stat.size || stat.size !== after.size ||
        (stableTimes && (stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs))) {
      throw new Error("unsafe_history_file");
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function syncDirectory(directory: Directory): Promise<void> { await directory.handle.sync(); }
async function atomicWrite(directory: Directory, name: string, bytes: Buffer): Promise<void> {
  const temporary = child(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    try { if ((await lstat(child(directory, name))).isSymbolicLink()) throw new Error("unsafe_history_file"); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    await rename(temporary, child(directory, name));
    await syncDirectory(directory);
  } finally { await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); }
}

// Checksums detect corruption and accidental mixing, not a local attacker who can rewrite everything.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function seed(manifest: Pick<Manifest, "providerId" | "nativeSessionId" | "journalId">): string {
  return hash(canonical({ providerId: manifest.providerId, nativeSessionId: manifest.nativeSessionId, journalId: manifest.journalId }));
}
function manifestDigest(manifest: Manifest): string {
  const { manifestHash: _ignored, ...fields } = manifest;
  return hash(keyHash(manifest) + canonical(fields));
}
function encodeManifest(manifest: Manifest): Buffer {
  const bytes = Buffer.from(canonical(manifest));
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("history_store_failed");
  return bytes;
}
function parseManifest(value: unknown, key: HermesCcJournalKey, dirName: string): Manifest | "schema_mismatch" | "corrupt" {
  if (!record(value) || value.version !== VERSION) return "schema_mismatch";
  if (value.providerId !== key.providerId || value.nativeSessionId !== key.nativeSessionId) return "schema_mismatch";
  if (!HASH.test(dirName) || keyHash(key) !== dirName) return "schema_mismatch";
  if (value.writer !== undefined && !writerOwner(value.writer)) return "schema_mismatch";
  if (typeof value.startedFromCreation !== "boolean") return "schema_mismatch";
  for (const field of ["openTurns", "bytes", "records"]) {
    if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || Number(value[field]) < 0) return "schema_mismatch";
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return "schema_mismatch";
  if (value.invalid !== undefined && (typeof value.invalid !== "string" || !REASON.test(value.invalid))) return "schema_mismatch";
  if (typeof value.journalId !== "string" || !/^[a-f0-9-]{36}$/.test(value.journalId) ||
      typeof value.headHash !== "string" || !HASH.test(value.headHash) ||
      typeof value.manifestHash !== "string" || !HASH.test(value.manifestHash)) return "corrupt";
  const manifest = value as unknown as Manifest;
  if (manifestDigest(manifest) !== manifest.manifestHash) return "corrupt";
  return manifest;
}
async function loadManifest(session: Directory, key: HermesCcJournalKey, dirName: string): Promise<Manifest | "schema_mismatch" | "corrupt" | "missing"> {
  try {
    const value: unknown = JSON.parse((await readFile(session, MANIFEST, MAX_MANIFEST_BYTES)).toString("utf8"));
    return parseManifest(value, key, dirName);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "missing";
    if (error instanceof Error && error.message === "unsafe_history_file") throw error;
    return "schema_mismatch";
  }
}
async function writeManifest(session: Directory, manifest: Manifest): Promise<void> {
  manifest.manifestHash = manifestDigest(manifest);
  await atomicWrite(session, MANIFEST, encodeManifest(manifest));
}

function encodeEvent(event: unknown): string {
  try {
    const text = JSON.stringify(event);
    if (typeof text !== "string" || text.length === 0 || /[\n\r]/.test(text)) throw new Error("invalid_event");
    return canonical(JSON.parse(text));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_event") throw error;
    throw new Error("invalid_event");
  }
}
function parseLines(bytes: Buffer): string[] | null {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0x0a) return null;
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  if (lines.some(line => line.length === 0)) return null;
  return lines;
}
type EventsView = { status: "ok"; events: unknown[] } | { status: "corrupt" } | { status: "foreign_writer" } | { status: "over_cap" } | { status: "unsafe" };
async function viewEvents(session: Directory, manifest: Manifest, maxBytesPerSession: number): Promise<EventsView> {
  let size = 0n;
  const target = child(session, EVENTS);
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return { status: "unsafe" };
    size = BigInt(before.size);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { status: "corrupt" };
    throw error;
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER) || Number(size) !== manifest.bytes) return { status: "corrupt" };
  if (manifest.bytes > maxBytesPerSession) return { status: "over_cap" };
  let bytes: Buffer;
  try { bytes = await readFile(session, EVENTS, manifest.bytes); }
  catch (error) {
    if (error instanceof Error && error.message === "unsafe_history_file") return { status: "unsafe" };
    return { status: "corrupt" };
  }
  if (bytes.length !== manifest.bytes) return { status: "corrupt" };
  const lines = parseLines(bytes);
  if (lines === null || lines.length !== manifest.records) return { status: "corrupt" };
  if (!Buffer.from(lines.length ? `${lines.join("\n")}\n` : "").equals(bytes)) return { status: "corrupt" };
  const events: unknown[] = [];
  let head = seed(manifest), foreign = false;
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (!record(value) || !Object.hasOwn(value, "event")) return { status: "corrupt" };
      const writer = value.writer;
      if (writer !== undefined && !writerOwner(writer)) return { status: "corrupt" };
      head = hash(head + canonical(writer === undefined ? value.event : { event: value.event, writer }));
      if (value.hash !== head || canonical({ event: value.event, hash: head, ...(writer === undefined ? {} : { writer }) }) !== line) return { status: "corrupt" };
      if (writer && (!manifest.writer || writer.generation > manifest.writer.generation ||
          (writer.generation === manifest.writer.generation && writer.token !== manifest.writer.token))) foreign = true;
      events.push(value.event);
    } catch { return { status: "corrupt" }; }
  }
  if (head !== manifest.headHash) return { status: "corrupt" };
  return foreign ? { status: "foreign_writer" } : { status: "ok", events };
}
async function appendLine(session: Directory, line: string): Promise<number> {
  const payload = Buffer.from(`${line}\n`, "utf8");
  const target = child(session, EVENTS);
  let handle: FileHandle;
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("unsafe_history_file");
    handle = await open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      await handle.close();
      throw new Error("unsafe_history_file");
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error("unsafe_history_file");
    await handle.appendFile(payload);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || after.ino !== before.ino || after.size !== before.size + BigInt(payload.length)) throw new Error("unsafe_history_file");
    return Number(after.size);
  } finally { await handle.close(); }
}

async function removeEntry(directory: Directory, name: string): Promise<void> {
  const target = child(directory, name);
  const entry = await lstat(target);
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    const nested = await openDirectory(target);
    try { await removeChildren(nested); } finally { await nested.handle.close(); }
    await rmdir(target);
  } else {
    await unlink(target);
  }
}
async function removeChildren(directory: Directory, keep?: string): Promise<void> {
  for (const name of await readdir(child(directory, "."))) {
    if (name === keep) continue;
    await removeEntry(directory, name);
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

const LOCK_BYTES = 4096;
async function withDiskLock<T>(root: Directory, run: () => Promise<T>): Promise<T> {
  const target = child(root, LOCK), deadline = Date.now() + 15_000;
  let handle: FileHandle | undefined;
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe_history_lock");
      if (Date.now() - stat.mtimeMs > STALE_MS) {
        let alive = false;
        try {
          const owner: unknown = JSON.parse((await readFile(root, LOCK, LOCK_BYTES)).toString("utf8"));
          if (record(owner) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
            try { process.kill(Number(owner.pid), 0); alive = true; }
            catch (error) { alive = !hasCode(error, "ESRCH"); }
          }
        } catch { /* An abandoned, incomplete lock can expire too. */ }
        if (!alive) {
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
      if (Date.now() >= deadline) throw new Error("history_lock_timeout");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  const held = handle;
  const heartbeat = setInterval(() => { const now = new Date(); void held.utimes(now, now).catch(() => {}); }, STALE_MS / 3);
  heartbeat.unref();
  try { return await run(); }
  finally {
    clearInterval(heartbeat);
    try {
      const current = await lstat(target), openStat = await held.stat();
      if (openStat.dev === current.dev && openStat.ino === current.ino) await unlink(target);
    } finally { await held.close(); }
  }
}

async function cleanTemps(root: Directory): Promise<void> {
  for (const name of await readdir(child(root, "."))) {
    if (name === LOCK || name === USAGE || name.startsWith(".writer-") || isEvictedMarker(name) || isReapedMarker(name) || isForeignMarker(name)) continue;
    const entry = await lstat(child(root, name));
    if (entry.isSymbolicLink()) {
      if (isTemp(name) || Date.now() - entry.mtimeMs > STALE_MS) await unlink(child(root, name));
      continue;
    }
    if (entry.isDirectory()) {
      let nested: Directory | undefined;
      try {
        nested = await openDirectory(child(root, name));
        for (const childName of await readdir(child(nested, "."))) {
          if (!isTemp(childName)) continue;
          await removeEntry(nested, childName);
        }
        if (!HASH.test(name) && (isTemp(name) || Date.now() - entry.mtimeMs > STALE_MS)) {
          await removeChildren(nested);
          await nested.handle.close();
          nested = undefined;
          await rmdir(child(root, name));
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT") && !(error instanceof Error && error.message === "unsafe_history_directory")) throw error;
      } finally { await nested?.handle.close(); }
    } else if (isTemp(name) || (!HASH.test(name) && Date.now() - entry.mtimeMs > STALE_MS && !isEvictedMarker(name))) {
      await unlink(child(root, name));
    }
  }
}

async function listEntries(root: Directory): Promise<{ total: number; entries: Entry[] }> {
  const entries: Entry[] = [];
  let total = 0;
  for (const name of await readdir(child(root, "."))) {
    if (name === LOCK || name === USAGE || name.startsWith(".writer-")) continue;
    const entry = await lstat(child(root, name));
    if ((isEvictedMarker(name) || isReapedMarker(name) || isForeignMarker(name)) && entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size === 0) continue;
    if (entry.isSymbolicLink()) {
      total += entry.size;
      entries.push({ name, createdAt: entry.mtimeMs, size: entry.size, eventsBytes: 0, kind: "link" });
      continue;
    }
    if (!entry.isDirectory()) {
      total += entry.size;
      entries.push({ name, createdAt: entry.mtimeMs, size: entry.size, eventsBytes: 0, kind: "orphan" });
      continue;
    }
    let nested: Directory | undefined;
    try {
      nested = await openDirectory(child(root, name));
      const size = await directoryBytes(nested);
      total += size;
      let createdAt = entry.mtimeMs;
      let eventsBytes = 0;
      if (HASH.test(name)) {
        try {
          const value: unknown = JSON.parse((await readFile(nested, MANIFEST, MAX_MANIFEST_BYTES)).toString("utf8"));
          if (record(value) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)) createdAt = value.createdAt;
        } catch { /* Unreadable journals are evicted by directory age. */ }
        try {
          const events = await lstat(child(nested, EVENTS));
          // A link is not an oversized journal. Read refuses it; only a real file counts toward the session cap.
          if (events.isFile() && !events.isSymbolicLink() && events.nlink === 1) eventsBytes = events.size;
        } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      }
      entries.push({ name, createdAt, size, eventsBytes, kind: HASH.test(name) ? "session" : "orphan" });
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe_history_directory") {
        total += entry.size;
        entries.push({ name, createdAt: entry.mtimeMs, size: entry.size, eventsBytes: 0, kind: "link" });
      } else throw error;
    } finally { await nested?.handle.close(); }
  }
  return { total, entries };
}

function byAge(a: Entry, b: Entry): number { return a.createdAt - b.createdAt || a.name.localeCompare(b.name); }

async function dropPayload(root: Directory, name: string): Promise<void> {
  const nested = await openDirectory(child(root, name));
  try { await removeChildren(nested, MANIFEST); }
  finally { await nested.handle.close(); }
}
async function writeEvictedMarker(root: Directory, name: string): Promise<void> {
  const marker = evictedMarker(name);
  try {
    const existing = await lstat(child(root, marker));
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error("unsafe_history_file");
    return;
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const handle = await open(child(root, marker), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(root);
}
async function tombstone(root: Directory, name: string, reason: string, key?: HermesCcJournalKey): Promise<void> {
  let nested: Directory | undefined;
  try {
    nested = await openDirectory(child(root, name));
    const loaded = key ? await loadManifest(nested, key, name) : "missing";
    let manifest: Manifest | undefined;
    if (typeof loaded !== "string") manifest = loaded;
    else {
      try {
        const value: unknown = JSON.parse((await readFile(nested, MANIFEST, MAX_MANIFEST_BYTES)).toString("utf8"));
        if (record(value) && typeof value.providerId === "string" && typeof value.nativeSessionId === "string" &&
            typeof value.createdAt === "number" && value.startedFromCreation === true) {
          manifest = {
            version: VERSION,
            providerId: value.providerId,
            nativeSessionId: value.nativeSessionId,
            startedFromCreation: true,
            openTurns: 0,
            bytes: 0,
            records: 0,
            createdAt: value.createdAt,
            journalId: randomUUID(), headHash: "", manifestHash: "",
            invalid: typeof value.invalid === "string" && REASON.test(value.invalid) ? value.invalid : reason,
          };
        }
      } catch { /* Fall through to a directory-only tombstone when the identity is unreadable. */ }
    }
    if (manifest && keyHash({ providerId: manifest.providerId, nativeSessionId: manifest.nativeSessionId }) === name) {
      manifest.invalid = manifest.invalid ?? reasonCode(reason);
      manifest.bytes = 0;
      manifest.records = 0;
      manifest.openTurns = 0;
      manifest.headHash = seed(manifest);
      await writeManifest(nested, manifest);
      await removeChildren(nested, MANIFEST);
      return;
    }
  } finally { await nested?.handle.close(); }
  await writeEvictedMarker(root, name);
  await removeEntry(root, name);
}

async function enforceCaps(root: Directory, maxBytesPerSession: number, maxBytesTotal: number): Promise<void> {
  await cleanTemps(root);
  for (let pass = 0; pass < 10_000; pass++) {
    const { total, entries } = await listEntries(root);
    const oversized = entries.filter(entry => entry.kind === "session" && entry.eventsBytes > maxBytesPerSession);
    if (oversized.length) {
      const entry = oversized[0]!;
      await tombstone(root, entry.name, "over_cap");
      continue;
    }
    if (total + USAGE_BYTES <= maxBytesTotal) return;
    const orphans = entries.filter(entry => entry.kind !== "session").sort(byAge);
    if (orphans.length) {
      const entry = orphans[0]!;
      if (entry.kind === "link") await unlink(child(root, entry.name));
      else await removeEntry(root, entry.name);
      continue;
    }
    const sessions = entries.filter(entry => entry.kind === "session").sort(byAge);
    const oldest = sessions[0];
    if (!oldest) return;
    let nested: Directory | undefined;
    let payload = false;
    try {
      nested = await openDirectory(child(root, oldest.name));
      const names = await readdir(child(nested, "."));
      payload = names.some(name => name !== MANIFEST);
    } catch { payload = true; }
    finally { await nested?.handle.close(); }
    if (payload) await tombstone(root, oldest.name, "evicted");
    else {
      await writeEvictedMarker(root, oldest.name);
      await removeEntry(root, oldest.name);
    }
  }
}

async function markerExists(root: Directory, name: string): Promise<boolean> {
  try {
    const stat = await lstat(child(root, evictedMarker(name)));
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

// Permanent, zero-byte markers are excluded from cleanup and caps, like eviction
// tombstones. No journal lock: even a paused owner must observe a foreign prompt.
async function writeForeignMarker(root: Directory, name: string): Promise<void> {
  const handle = await open(child(root, foreignMarker(name)),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) throw new Error("unsafe_history_file");
    await handle.sync();
    await syncDirectory(root);
  } finally { await handle.close(); }
}
async function hasForeignMarker(root: Directory, name: string): Promise<boolean> {
  try { await lstat(child(root, foreignMarker(name))); return true; }
  catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
}

function judge(manifest: Manifest, viewed: EventsView): HermesCcJournalState {
  if (manifest.invalid) return unusable(manifest.invalid);
  if (!manifest.startedFromCreation) return unusable("started_mid_session");
  if (viewed.status === "unsafe") throw new Error("unsafe_history_file");
  if (viewed.status === "corrupt") return unusable("corrupt");
  if (viewed.status === "foreign_writer") return unusable("foreign_writer");
  if (viewed.status === "over_cap") return unusable("over_cap");
  if (manifest.openTurns !== 0) return unusable("unsettled_turn");
  return { status: "complete", events: viewed.events };
}

export function createHermesCcHistoryStore(rootDir: string, options?: {
  maxBytesPerSession?: number;
  maxBytesTotal?: number;
  trustedRoot?: string;
}): HermesCcHistoryStore {
  const root = resolve(rootDir);
  const maxBytesPerSession = options?.maxBytesPerSession ?? DEFAULT_SESSION_BYTES;
  const maxBytesTotal = options?.maxBytesTotal ?? DEFAULT_TOTAL_BYTES;
  const trustedRoot = options?.trustedRoot;
  if (!Number.isSafeInteger(maxBytesPerSession) || maxBytesPerSession < 0) throw new Error("invalid_history_cap");
  if (!Number.isSafeInteger(maxBytesTotal) || maxBytesTotal < 0) throw new Error("invalid_history_cap");

  function lane(key: HermesCcJournalKey): string { return `${root}\0${keyHash(key)}`; }
  function serialized<T>(key: HermesCcJournalKey, operation: () => Promise<T>): Promise<T> {
    const id = lane(key);
    const pending = (lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    lanes.set(id, pending);
    void pending.finally(() => { if (lanes.get(id) === pending) lanes.delete(id); }).catch(() => {});
    return pending;
  }
  // The fixed-size ledger is dirtied before mutations. A crash requires a full
  // rescan; cooperating processes otherwise update only the affected session's delta.
  async function usageWrite(rootDirectory: Directory, total: number | null): Promise<void> {
    const text = JSON.stringify({ version: 1, total });
    await atomicWrite(rootDirectory, USAGE, Buffer.from(text.padEnd(USAGE_BYTES, " ")));
  }
  async function sessionBytes(rootDirectory: Directory, key: HermesCcJournalKey): Promise<number> {
    const session = await openSession(rootDirectory, keyHash(key));
    if (session === "missing") return 0;
    try { return await directoryBytes(session); }
    finally { await session.handle.close(); }
  }
  async function locked<T>(create: boolean, key: HermesCcJournalKey, run: (rootDirectory: Directory) => Promise<T>, refresh = false): Promise<T> {
    // Walk from the trusted root. lstat of the full path would follow an ancestor symlink and hide it.
    const rootDirectory = await directory(root, create, trustedRoot);
    try {
      if (pendingInvalidations.has(lane(key))) {
        await writeForeignMarker(rootDirectory, keyHash(key));
        pendingInvalidations.delete(lane(key));
      }
      return await withDiskLock(rootDirectory, async () => {
        let total: number | undefined;
        if (!create && !refresh) {
          try {
            const value: unknown = JSON.parse((await readFile(rootDirectory, USAGE, USAGE_BYTES)).toString("utf8"));
            if (record(value) && value.version === 1 && typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= 0) total = value.total;
          } catch { /* Missing or dirty accounting is recovered under the lock. */ }
        }
        if (total === undefined) {
          await enforceCaps(rootDirectory, maxBytesPerSession, maxBytesTotal);
          total = (await listEntries(rootDirectory)).total;
        }
        const before = await sessionBytes(rootDirectory, key);
        await usageWrite(rootDirectory, null);
        if (await hasForeignMarker(rootDirectory, keyHash(key))) {
          const session = await openSession(rootDirectory, keyHash(key));
          if (session !== "missing") {
            try {
              const loaded = await loadManifest(session, key, keyHash(key));
              if (typeof loaded !== "string" && loaded.invalid !== "foreign_writer") {
                await publish(session, { ...loaded, invalid: "foreign_writer" });
              }
            } finally { await session.handle.close(); }
          }
        }
        const result = await run(rootDirectory);
        total += await sessionBytes(rootDirectory, key) - before;
        if (total + USAGE_BYTES > maxBytesTotal) {
          await enforceCaps(rootDirectory, maxBytesPerSession, maxBytesTotal);
          total = (await listEntries(rootDirectory)).total;
        }
        await usageWrite(rootDirectory, total);
        return result;
      });
    } finally { await rootDirectory.handle.close(); }
  }
  type Verified = { manifestHash: string; fingerprint: string; headHash: string; records: number; bytes: number };
  const verified = new Map<string, Verified>();
  async function fingerprint(session: Directory): Promise<string> {
    const stat = await lstat(child(session, EVENTS), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("unsafe_history_file");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }
  async function remember(session: Directory, manifest: Manifest): Promise<void> {
    verified.set(keyHash(manifest), { manifestHash: manifest.manifestHash, fingerprint: await fingerprint(session),
      headHash: manifest.headHash, records: manifest.records, bytes: manifest.bytes });
  }
  async function verifyForWrite(session: Directory, manifest: Manifest): Promise<EventsView> {
    const cached = verified.get(keyHash(manifest));
    let current: string;
    try { current = await fingerprint(session); }
    catch (error) { if (hasCode(error, "ENOENT")) return { status: "corrupt" }; throw error; }
    if (cached && cached.manifestHash === manifest.manifestHash && cached.fingerprint === current &&
        cached.headHash === manifest.headHash && cached.records === manifest.records && cached.bytes === manifest.bytes) {
      return { status: "ok", events: [] };
    }
    const viewed = await viewEvents(session, manifest, maxBytesPerSession);
    if (viewed.status === "ok") await remember(session, manifest);
    else verified.delete(keyHash(manifest));
    return viewed;
  }
  async function publish(session: Directory, manifest: Manifest): Promise<void> {
    await writeManifest(session, manifest);
    if (!manifest.invalid) await remember(session, manifest);
    else verified.delete(keyHash(manifest));
  }
  async function openSession(rootDirectory: Directory, name: string): Promise<Directory | "missing"> {
    try { return await openDirectory(child(rootDirectory, name)); }
    catch (error) { if (hasCode(error, "ENOENT")) return "missing"; throw error; }
  }

  async function checkWriter(session: Directory, manifest: Manifest, owner: HermesCcWriterOwner | undefined): Promise<void> {
    if (manifest.invalid === "foreign_writer") throw new Error("writer_changed");
    if (sameWriter(manifest.writer, owner)) return;
    await publish(session, { ...manifest, invalid: "writer_changed" });
    throw new Error("writer_changed");
  }
  async function readWriter(rootDirectory: Directory, name: string): Promise<(HermesCcWriterOwner & { pid: number; changed?: boolean }) | null> {
    try {
      // Heartbeats change timestamps, never lease contents. Keep path/size checks.
      const value: unknown = JSON.parse((await readFile(rootDirectory, name, LOCK_BYTES, false)).toString("utf8"));
      if (!record(value) || !writerOwner(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
      return { token: value.token, generation: value.generation, pid: Number(value.pid), changed: value.changed === true };
    } catch { return null; } // Missing, torn or unknown ownership never authorizes replacement.
  }
  async function claimWriter(key: HermesCcJournalKey): Promise<HermesCcWriterLease | null> {
    const name = `.writer-${keyHash(key)}`;
    const token = randomUUID();
    let generation = 0;
    let held: FileHandle | undefined;
    try {
      const acquired = await locked(true, key, async rootDirectory => {
        const previous = await readWriter(rootDirectory, name);
        if (previous) {
          try { process.kill(previous.pid, 0); return false; }
          catch (error) { if (!hasCode(error, "ESRCH")) return false; }
        }
        if (!previous) {
          // Distinguish an absent lease from unreadable ownership with O_EXCL,
          // before touching the manifest. Unknown leases must stay in place.
          try {
            held = await open(child(rootDirectory, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          } catch (error) { if (hasCode(error, "EEXIST")) return false; throw error; }
        }
        const session = await openSession(rootDirectory, keyHash(key));
        try {
          const loaded = session === "missing" ? "missing" : await loadManifest(session, key, keyHash(key));
          generation = Math.max(previous?.generation ?? 0, typeof loaded === "string" ? 0 : loaded.writer?.generation ?? 0) + 1;
          if (!Number.isSafeInteger(generation)) throw new Error("history_store_failed");
          // Publish the fence (and uncertainty) before replacing the lease file,
          // using the same operation lock as every journal mutation.
          if (typeof loaded !== "string" && session !== "missing") {
            let replayable = false;
            // Check against the old owner before advancing the generation, or a
            // same-generation foreign record could be mistaken for old history.
            const foreign = loaded.invalid === "foreign_writer" || (!loaded.invalid &&
              (await viewEvents(session, loaded, maxBytesPerSession)).status === "foreign_writer");
            if (previous && !Object.hasOwn(loaded, "invalid") && sameWriter(loaded.writer, previous)) {
              try {
                // A dead writer is safe to replace only after the full read checks,
                // never the incremental write cache. Any uncertainty keeps the fence.
                const viewed = await viewEvents(session, loaded, maxBytesPerSession);
                replayable = judge(loaded, viewed).status === "complete" &&
                  (await listEntries(rootDirectory)).total + USAGE_BYTES <= maxBytesTotal &&
                  !await hasForeignMarker(rootDirectory, keyHash(key));
              } catch { /* Failed verification must not preserve replay. */ }
            }
            await writeManifest(session, { ...loaded, writer: { token, generation },
              ...(foreign ? { invalid: "foreign_writer" } : previous && !replayable ? { invalid: "writer_changed" } : {}) });
            verified.delete(keyHash(key));
          }
        } finally { if (session !== "missing") await session.handle.close(); }
        if (previous) await unlink(child(rootDirectory, name));
        held ??= await open(child(rootDirectory, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await held.writeFile(JSON.stringify({ pid: process.pid, token, generation, changed: !!previous }));
        await held.sync();
        await syncDirectory(rootDirectory);
        return true;
      });
      if (!acquired || !held) return null;
    } catch (error) {
      await held?.close();
      throw error;
    }
    const handle = held;
    const heartbeat = setInterval(() => {
      const now = new Date();
      void handle.utimes(now, now).catch(() => {});
    }, WRITER_MS / 3);
    heartbeat.unref();
    let released = false;
    return { token, generation, async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      let currentRoot: Directory | undefined;
      try {
        currentRoot = await directory(root, false, trustedRoot);
        const openedRoot = currentRoot;
        await withDiskLock(openedRoot, async () => {
          try {
            const stat = await lstat(child(openedRoot, name)), original = await handle.stat();
            const owner: unknown = JSON.parse((await readFile(openedRoot, name, LOCK_BYTES, false)).toString("utf8"));
            if (stat.dev === original.dev && stat.ino === original.ino && record(owner) && owner.token === token) {
              await unlink(child(openedRoot, name));
              await syncDirectory(openedRoot);
            }
          } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
        });
      } catch (error) { if (!hasCode(error, "ENOENT")) fail(error); }
      finally { await currentRoot?.handle.close(); await handle.close(); }
    } };
  }

  return {
    async claimWriter(key) {
      key = snapshotKey(key);
      try { return await serialized(key, () => claimWriter(key)); }
      catch (error) { fail(error); }
    },
    async start(key, owner) {
      key = snapshotKey(key);
      owner = snapshotOwner(owner);
      try {
        await serialized(key, () => locked(true, key, async rootDirectory => {
          const name = keyHash(key);
          const existing = await openSession(rootDirectory, name);
          if (existing !== "missing") {
            try {
              const loaded = await loadManifest(existing, key, name);
              if (typeof loaded !== "string") await checkWriter(existing, loaded, owner);
            } finally { await existing.handle.close(); }
            throw new Error("journal_exists");
          }
          if (await markerExists(rootDirectory, name)) throw new Error("journal_exists");
          const lease = await readWriter(rootDirectory, `.writer-${name}`);
          const writer = lease ? { token: lease.token, generation: lease.generation } : undefined;
          const rejected = !sameWriter(writer, owner);
          await mkdir(child(rootDirectory, name), { mode: 0o700 });
          await syncDirectory(rootDirectory);
          const session = await openDirectory(child(rootDirectory, name));
          try {
            await session.handle.chmod(0o700);
            const created = await open(child(session, EVENTS), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await created.sync(); } finally { await created.close(); }
            await syncDirectory(session);
            const journalId = randomUUID();
            await publish(session, {
              journalId, headHash: seed({ ...key, journalId }), manifestHash: "",
              version: VERSION,
              providerId: key.providerId,
              nativeSessionId: key.nativeSessionId,
              startedFromCreation: true,
              openTurns: 0,
              bytes: 0,
              records: 0,
              createdAt: Date.now(),
              ...(writer ? { writer } : {}),
              ...(await hasForeignMarker(rootDirectory, name) ? { invalid: "foreign_writer" }
                : rejected || lease?.changed ? { invalid: "writer_changed" } : {}),
            });
            if (rejected) throw new Error("writer_changed");
          } finally { await session.handle.close(); }
        }));
      } catch (error) { fail(error); }
    },
    async append(key, event, owner) {
      key = snapshotKey(key);
      owner = snapshotOwner(owner);
      let line: string | undefined;
      try { line = encodeEvent(event); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "invalid_event") fail(error);
      }
      const encoded = line;
      let rejectInvalid = false;
      try {
        await serialized(key, () => locked(false, key, async rootDirectory => {
          const name = keyHash(key);
          const session = await openSession(rootDirectory, name);
          if (session === "missing") return;
          try {
            const loaded = await loadManifest(session, key, name);
            if (typeof loaded === "string") return;
            await checkWriter(session, loaded, owner);
            if (loaded.invalid) return;
            if (encoded === undefined) {
              await publish(session, { ...loaded, invalid: "invalid_event" });
              rejectInvalid = true;
              return;
            }
            const event = JSON.parse(encoded);
            const writer = loaded.writer;
            const headHash = hash(loaded.headHash + (writer ? canonical({ event, writer }) : encoded));
            const line = canonical({ event, hash: headHash, ...(writer ? { writer } : {}) });
            const added = Buffer.byteLength(`${line}\n`, "utf8");
            const viewed = await verifyForWrite(session, loaded);
            if (viewed.status === "unsafe") throw new Error("unsafe_history_file");
            if (viewed.status === "corrupt" || viewed.status === "foreign_writer") {
              await publish(session, { ...loaded, invalid: viewed.status });
              if (viewed.status === "foreign_writer") throw new Error("writer_changed");
              return;
            }
            if (viewed.status === "over_cap" || loaded.bytes + added > maxBytesPerSession) {
              await publish(session, { ...loaded, invalid: "over_cap" });
              if (viewed.status === "over_cap") await removeChildren(session, MANIFEST);
              return;
            }
            const bytes = await appendLine(session, line);
            await publish(session, { ...loaded, bytes, records: loaded.records + 1, headHash });
          } finally { await session.handle.close(); }
        }).catch(error => { if (hasCode(error, "ENOENT")) return; throw error; }));
      } catch (error) { fail(error); }
      if (rejectInvalid) throw new Error("invalid_event");
    },
    async turnStarted(key, owner) {
      key = snapshotKey(key);
      owner = snapshotOwner(owner);
      try {
        await serialized(key, () => locked(false, key, async rootDirectory => {
          const session = await openSession(rootDirectory, keyHash(key));
          if (session === "missing") return;
          try {
            const loaded = await loadManifest(session, key, keyHash(key));
            if (typeof loaded === "string") return;
            await checkWriter(session, loaded, owner);
            if (loaded.invalid) return;
            const viewed = await verifyForWrite(session, loaded);
            if (viewed.status !== "ok") {
              if (viewed.status === "unsafe") throw new Error("unsafe_history_file");
              await publish(session, { ...loaded, invalid: viewed.status });
              if (viewed.status === "foreign_writer") throw new Error("writer_changed");
              return;
            }
            if (loaded.openTurns === Number.MAX_SAFE_INTEGER) {
              await publish(session, { ...loaded, invalid: "corrupt" });
              return;
            }
            await publish(session, { ...loaded, openTurns: loaded.openTurns + 1 });
          } finally { await session.handle.close(); }
        }).catch(error => { if (hasCode(error, "ENOENT")) return; throw error; }));
      } catch (error) { fail(error); }
    },
    async turnSettled(key, owner) {
      key = snapshotKey(key);
      owner = snapshotOwner(owner);
      try {
        await serialized(key, () => locked(false, key, async rootDirectory => {
          const session = await openSession(rootDirectory, keyHash(key));
          if (session === "missing") return;
          try {
            const loaded = await loadManifest(session, key, keyHash(key));
            if (typeof loaded === "string") return;
            await checkWriter(session, loaded, owner);
            if (loaded.invalid) return;
            const viewed = await verifyForWrite(session, loaded);
            if (viewed.status !== "ok") {
              if (viewed.status === "unsafe") throw new Error("unsafe_history_file");
              await publish(session, { ...loaded, invalid: viewed.status });
              if (viewed.status === "foreign_writer") throw new Error("writer_changed");
              return;
            }
            // A duplicate settle must not destroy a journal that has already settled.
            if (loaded.openTurns === 0) return;
            await publish(session, { ...loaded, openTurns: loaded.openTurns - 1 });
          } finally { await session.handle.close(); }
        }).catch(error => { if (hasCode(error, "ENOENT")) return; throw error; }));
      } catch (error) { fail(error); }
    },
    async invalidate(key, reason) {
      key = snapshotKey(key);
      const code = reasonCode(reason);
      if (code === "foreign_writer") pendingInvalidations.set(lane(key), code);
      try {
        if (code === "foreign_writer") {
          // Persist before waiting for either serialization or the journal lock.
          const rootDirectory = await directory(root, true, trustedRoot);
          try {
            await writeForeignMarker(rootDirectory, keyHash(key));
            pendingInvalidations.delete(lane(key));
          } finally { await rootDirectory.handle.close(); }
        }
        await serialized(key, () => locked(false, key, async rootDirectory => {
          const session = await openSession(rootDirectory, keyHash(key));
          if (session === "missing") return;
          try {
            const loaded = await loadManifest(session, key, keyHash(key));
            if (typeof loaded === "string" || loaded.invalid) return;
            await publish(session, { ...loaded, invalid: code });
          } finally { await session.handle.close(); }
        }).catch(error => { if (hasCode(error, "ENOENT")) return; throw error; }));
      } catch (error) { fail(error); }
    },
    async read(key) {
      key = snapshotKey(key);
      try {
        const state = await serialized(key, () => locked(false, key, async rootDirectory => {
          const name = keyHash(key);
          if (await hasForeignMarker(rootDirectory, name)) return unusable("foreign_writer");
          const session = await openSession(rootDirectory, name);
          if (session === "missing") return await markerExists(rootDirectory, name) ? unusable("evicted") : unusable("missing");
          try {
            const loaded = await loadManifest(session, key, name);
            if (typeof loaded === "string") return unusable(loaded === "corrupt" ? "corrupt" : "schema_mismatch");
            const viewed = await viewEvents(session, loaded, maxBytesPerSession);
            const { total } = await listEntries(rootDirectory);
            if (total + USAGE_BYTES > maxBytesTotal && !loaded.invalid && viewed.status === "ok" && loaded.startedFromCreation && loaded.openTurns === 0) {
              return unusable("over_cap");
            }
            return judge(loaded, viewed);
          } finally { await session.handle.close(); }
        }, true).catch(error => { if (hasCode(error, "ENOENT")) return unusable("missing"); throw error; }));
        if (state.status !== "complete") return state;
        // Foreign fences bypass the lane and lock. Check after their cleanup
        // awaits as well as the event read, immediately before returning events.
        try { await lstat(join(root, foreignMarker(keyHash(key)))); }
        catch (error) { if (hasCode(error, "ENOENT")) return state; throw error; }
        return unusable("foreign_writer");
      } catch (error) {
        if (error instanceof Error && (error.message === "unsafe_history_directory" || error.message === "unsafe_history_file" || error.message === "unsafe_history_lock")) {
          return unusable("unsafe_path");
        }
        return unusable("unavailable");
      }
    },
  };
}
