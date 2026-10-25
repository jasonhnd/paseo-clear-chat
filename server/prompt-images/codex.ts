import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FoundImage, FoundImages, ResolverContext } from "./registry";
import { MAX_INLINE_IMAGE_BYTES } from "./registry";
import { readJsonlReadOnly } from "./read-only";

/**
 * Codex pasted-image resolver.
 *
 * `find()` returns `{ matchedMessages, images }`. Images are filled only when
 * exactly one user message matched. The registry reports any other count as
 * `no_match` or `ambiguous`.
 *
 * Reads `${CODEX_HOME:-~/.codex}` rollout JSONL only. It never creates, copies,
 * locks, or writes files in that store. JSONL goes through `readJsonlReadOnly`
 * on a descriptor this module already opened. Inline data URLs are limited to
 * the shared 1.5 MiB cap.
 *
 * A rollout is used only when both the live and archived trees were fully
 * scanned and exactly one confirmed file exists between them. That file is
 * opened with O_NOFOLLOW. The descriptor must be a regular file, its real path
 * must stay inside the session root, and its device and inode must match the
 * confirmed file. Messages and images come from one read of that descriptor,
 * bounded by the size at open. A second open must report the same device,
 * inode, size, mtime, and ctime. Any mismatch returns no image. A JSONL record the
 * reader skipped is an incomplete scan and also returns no image. Text matches
 * from concatenated input_text and from a single part are one set. An
 * incomplete scan, a changed file, or more than one qualifying message
 * returns no image.
 */

/** Payloads kept for one message. Further accepted images are counted without their bytes. */
const MAX_IMAGES_PER_MESSAGE = 32;
const ROLLOUT_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_WALK_DEPTH = 6;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ID_FIELDS = ["id", "message_id", "messageId", "client_message_id", "clientMessageId"] as const;
const IGNORED_CONTENT_TYPES = new Set([
  "environment_context",
  "developer",
  "system",
  "developer_message",
  "system_message",
]);
const MIME_BY_TYPE: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

interface MessageText {
  index: number;
  ids: string[];
  parts: string[];
  images: FoundImage[];
}

interface FileStamp {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function none(): FoundImages {
  return { matchedMessages: 0, images: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function codexHomePath(): string {
  const configured = process.env.CODEX_HOME;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  return join(homedir(), ".codex");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isFsMiss(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code);
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ELOOP" || code === "ENOTDIR";
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function storedIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const field of ID_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

function providedIds(context: ResolverContext): string[] {
  const ids: string[] = [];
  for (const value of [context.messageId, context.clientMessageId]) {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

function magicMatches(bytes: Buffer, mime: string): boolean {
  const at = (offset: number) => bytes[offset];
  if (mime === "image/png") {
    return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
      && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a;
  }
  if (mime === "image/jpeg") return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  if (mime === "image/gif") {
    const signature = bytes.toString("ascii", 0, 6);
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mime === "image/webp") {
    return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

/**
 * Accepts an inline data URL only. Encoded length is checked before any decode
 * of the payload; a 24-character prefix is enough to read the magic bytes.
 * An image over the inline cap is kept so it can be counted, and its payload
 * is not returned.
 */
function acceptDataUrl(value: unknown): { mime: string; base64: string | null } | null {
  if (typeof value !== "string") return null;
  const comma = value.indexOf(",");
  if (!value.startsWith("data:") || comma < 0) return null;
  const segments = value.slice(5, comma).split(";").map(segment => segment.trim().toLowerCase());
  const mime = MIME_BY_TYPE[segments[0] ?? ""];
  if (!mime || !segments.includes("base64")) return null;
  const base64 = value.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const decodedLength = (base64.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(decodedLength) || decodedLength <= 0) return null;
  const header = Buffer.from(base64.slice(0, 24), "base64");
  if (!magicMatches(header, mime)) return null;
  if (decodedLength > MAX_INLINE_IMAGE_BYTES) return { mime, base64: null };
  return { mime, base64 };
}

function imageBytes(mime: string, base64: string | null): FoundImage["readBytes"] {
  return async () => {
    // Over the inline cap: tell the registry without decoding or returning the payload.
    if (base64 === null) return Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_INLINE_IMAGE_BYTES || !magicMatches(bytes, mime)) throw new Error("invalid_image");
    return bytes;
  };
}

function parseUser(entry: unknown, includeImages: boolean): { ids: string[]; parts: string[]; images: FoundImage[] } | null {
  const line = asRecord(entry);
  if (!line || line.type !== "response_item") return null;
  const payload = asRecord(line.payload);
  if (!payload || payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return null;
  const parts: string[] = [];
  const images: FoundImage[] = [];
  let imageOrdinal = 0;
  let retained = 0;
  for (const item of payload.content) {
    const part = asRecord(item);
    if (!part || typeof part.type !== "string" || IGNORED_CONTENT_TYPES.has(part.type)) continue;
    if (part.type === "input_text") {
      if (typeof part.text === "string") parts.push(part.text);
      continue;
    }
    if (part.type !== "input_image") continue;
    const id = String(imageOrdinal);
    imageOrdinal += 1;
    if (!includeImages) continue;
    const accepted = acceptDataUrl(part.image_url);
    if (!accepted) continue;
    // The registry total is the array length, so every accepted image is counted.
    // Only the first payloads are kept. An oversized image has no payload and is
    // still returned so a later fetch reports image_too_large.
    if (accepted.base64 !== null && retained >= MAX_IMAGES_PER_MESSAGE) {
      images.push({ id, mime: accepted.mime, readBytes: async () => { throw new Error("invalid_image"); } });
      continue;
    }
    if (accepted.base64 !== null) retained += 1;
    const base64 = accepted.base64;
    images.push({ id, mime: accepted.mime, readBytes: imageBytes(accepted.mime, base64) });
  }
  return { ids: storedIds(payload), parts, images };
}

/**
 * Stored message ids win. Otherwise a message qualifies when its input_text
 * parts concatenate to the prompt or any one part equals it (Codex wraps the
 * prompt with image labels and environment text). Both forms are one set,
 * deduped by message index. No trimming and no other normalisation.
 */
function selectMessages(messages: MessageText[], context: ResolverContext): MessageText[] {
  const needles = providedIds(context);
  if (needles.length > 0) {
    const byId = messages.filter(message => message.ids.some(id => needles.includes(id)));
    if (byId.length > 0) return byId;
  }
  const seen = new Set<number>();
  const matched: MessageText[] = [];
  const add = (message: MessageText) => {
    if (seen.has(message.index)) return;
    seen.add(message.index);
    matched.push(message);
  };
  for (const message of messages) {
    if (message.parts.join("") === context.text) add(message);
  }
  for (const message of messages) {
    if (message.parts.some(part => part === context.text)) add(message);
  }
  return matched;
}

async function resolveHome(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    const info = await lstat(real);
    return info.isDirectory() && !info.isSymbolicLink() ? real : null;
  } catch {
    return null;
  }
}

/** ENOENT means this optional tree is absent. Any other failure means it could not be inspected. */
async function containedDirectory(home: string, name: string): Promise<string | null | "incomplete"> {
  const path = join(home, name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    return "incomplete";
  }
  // Symlinks are not followed, including a sessions directory that points outside the store.
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  try {
    const real = await realpath(path);
    return isInside(home, real) ? real : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    return "incomplete";
  }
}

interface ConfirmedRollout {
  path: string;
  root: string;
  dev: bigint;
  ino: bigint;
}

async function confirmedFile(root: string, path: string): Promise<Omit<ConfirmedRollout, "root"> | null | "incomplete"> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const real = await realpath(path);
    if (!isInside(root, real)) return null;
    const again = await lstat(real, { bigint: true });
    if (!again.isFile() || again.isSymbolicLink()) return null;
    return { path: real, dev: again.dev, ino: again.ino };
  } catch (error) {
    // A vanished file is not a candidate. Any other lstat or realpath failure
    // means this tree could not be confirmed.
    if (isEnoent(error)) return null;
    return "incomplete";
  }
}

type WalkResult = "ok" | "aborted" | "incomplete";
type RolloutScan = string[] | "aborted" | "incomplete";

async function rolloutFiles(root: string, threadId: string, signal: AbortSignal): Promise<RolloutScan> {
  const suffix = `-${threadId}.jsonl`;
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<WalkResult> => {
    if (signal.aborted) return "aborted";
    // Two files already prove the thread is not unique. An unvisited directory does not.
    if (found.length > 1) return "ok";
    if (depth > MAX_WALK_DEPTH) return "incomplete";
    let directory;
    try {
      directory = await opendir(dir);
    } catch {
      return "incomplete";
    }
    try {
      // `read()` does not close the handle. `for await` would, and a second close throws.
      while (true) {
        if (signal.aborted) return "aborted";
        let entry;
        try {
          entry = await directory.read();
        } catch {
          return "incomplete";
        }
        if (!entry) break;
        if (found.length > 1) return "ok";
        const name = entry.name;
        if (name.includes("/") || name.includes("\\") || name.includes("\0") || entry.isSymbolicLink()) continue;
        const path = join(dir, name);
        if (entry.isDirectory()) {
          let info;
          try { info = await lstat(path); } catch { return "incomplete"; }
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
          const nested = await walk(path, depth + 1);
          if (nested !== "ok") return nested;
          continue;
        }
        if (!entry.isFile() || !name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
        let info;
        try { info = await lstat(path); } catch { return "incomplete"; }
        if (!info.isFile() || info.isSymbolicLink()) continue;
        found.push(path);
      }
    } finally {
      await directory.close();
    }
    return "ok";
  };
  const outcome = await walk(root, 0);
  if (outcome !== "ok") return outcome;
  return found;
}

type ThreadHit = "none" | "ambiguous" | "aborted" | "incomplete" | ConfirmedRollout;

async function fileForThread(home: string, threadId: string, signal: AbortSignal): Promise<ThreadHit> {
  if (!THREAD_ID.test(threadId)) return "none";
  const confirmedPaths: ConfirmedRollout[] = [];
  for (const name of ["sessions", "archived_sessions"] as const) {
    if (signal.aborted) return "aborted";
    const root = await containedDirectory(home, name);
    if (root === "incomplete") return "incomplete";
    if (!root) continue;
    const found = await rolloutFiles(root, threadId, signal);
    if (found === "aborted" || found === "incomplete") return found;
    if (found.length > 1) return "ambiguous";
    const candidate = found[0];
    if (!candidate) continue;
    const confirmed = await confirmedFile(root, candidate);
    if (confirmed === "incomplete") return "incomplete";
    if (confirmed) confirmedPaths.push({ ...confirmed, root });
  }
  if (confirmedPaths.length > 1) return "ambiguous";
  return confirmedPaths[0] ?? "none";
}

async function locateRollout(home: string, context: ResolverContext): Promise<ConfirmedRollout | null | "ambiguous"> {
  const ids: string[] = [];
  for (const value of [context.sessionId, context.nativeHandle]) {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  const matches = new Map<string, ConfirmedRollout>();
  for (const id of ids) {
    const hit = await fileForThread(home, id, context.signal);
    if (hit === "aborted") return null;
    if (hit === "incomplete") throw new Error("lookup_failed");
    if (hit === "ambiguous") return "ambiguous";
    if (typeof hit === "object") matches.set(hit.path, hit);
  }
  if (matches.size !== 1) return null;
  const [match] = matches.values();
  return match ?? null;
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/**
 * The open descriptor is the file we read. realpath/dev/ino must still name
 * that same regular file inside the session root and the confirmed rollout.
 */
async function descriptorStamp(file: FileHandle, ref: ConfirmedRollout): Promise<FileStamp> {
  const info = await file.stat({ bigint: true });
  if (!info.isFile()) throw new Error("lookup_failed");
  const real = await realpath(ref.path);
  if (!isInside(ref.root, real)) throw new Error("lookup_failed");
  const linked = await lstat(real, { bigint: true });
  if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== info.dev || linked.ino !== info.ino) {
    throw new Error("lookup_failed");
  }
  if (info.dev !== ref.dev || info.ino !== ref.ino) throw new Error("lookup_failed");
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}

async function openRollout(ref: ConfirmedRollout): Promise<{ file: FileHandle; stamp: FileStamp }> {
  const file = await open(ref.path, ROLLOUT_OPEN_FLAGS);
  try {
    return { file, stamp: await descriptorStamp(file, ref) };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readMessages(ref: ConfirmedRollout, file: FileHandle, byteLength: number, signal: AbortSignal): Promise<MessageText[] | null | "skipped"> {
  const messages: MessageText[] = [];
  let skipped = false;
  let index = 0;
  for await (const entry of readJsonlReadOnly(ref.path, {
    fd: file.fd,
    byteLength,
    onSkipped: () => { skipped = true; },
  })) {
    if (signal.aborted) return null;
    const parsed = parseUser(entry, true);
    if (!parsed) continue;
    messages.push({ index, ids: parsed.ids, parts: parsed.parts, images: parsed.images });
    index += 1;
  }
  // A dropped line could have been another match. Do not guess from what parsed.
  if (skipped) return "skipped";
  return messages;
}

/**
 * One descriptor supplies every message and image. Its fstat before and after
 * that read, and a second open of the same path, must agree on device, inode,
 * size, mtime, and ctime. A swapped path fails the second open even if the first
 * descriptor still holds the original file.
 */
async function readUniqueMatch(ref: ConfirmedRollout, context: ResolverContext): Promise<FoundImages> {
  const opened = await openRollout(ref);
  try {
    if (opened.stamp.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("lookup_failed");
    const messages = await readMessages(ref, opened.file, Number(opened.stamp.size), context.signal);
    if (messages === "skipped") throw new Error("lookup_failed");
    if (!messages || context.signal.aborted) return none();
    const after = await descriptorStamp(opened.file, ref);
    if (!sameStamp(opened.stamp, after)) throw new Error("lookup_failed");
    const again = await openRollout(ref);
    let matches = false;
    try {
      matches = sameStamp(opened.stamp, again.stamp);
    } finally {
      await again.file.close();
    }
    if (!matches) throw new Error("lookup_failed");
    const selected = selectMessages(messages, context);
    if (selected.length !== 1) return { matchedMessages: selected.length, images: [] };
    const chosen = selected[0];
    if (!chosen) return none();
    return { matchedMessages: 1, images: chosen.images };
  } finally {
    await opened.file.close();
  }
}

export const codexPromptImages = {
  /** Paseo provider id, not the wrapper command that launched Codex. */
  matches(provider: string): boolean {
    return provider === "codex";
  },
  async find(context: ResolverContext): Promise<FoundImages> {
    const configuredHome = codexHomePath();
    if (context.provider !== "codex" || context.signal.aborted) return none();
    try {
      const home = await resolveHome(configuredHome);
      if (!home || context.signal.aborted) return none();
      const rollout = await locateRollout(home, context);
      if (rollout === "ambiguous") return { matchedMessages: 2, images: [] };
      if (!rollout || context.signal.aborted) return none();
      return await readUniqueMatch(rollout, context);
    } catch (error) {
      if (isFsMiss(error)) return none();
      throw new Error("lookup_failed");
    }
  },
};
