import { lstat, opendir, realpath } from "node:fs/promises";
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
 * locks, or writes files in that store. JSONL goes through `readJsonlReadOnly`.
 * Inline data URLs are limited to the shared 1.5 MiB cap.
 */

/** Bounds memory for one message. The registry still caps thumbnails at three. */
const MAX_IMAGES_PER_MESSAGE = 32;
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
 */
function acceptDataUrl(value: unknown): { mime: string; base64: string } | null {
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
  if (!Number.isSafeInteger(decodedLength) || decodedLength <= 0 || decodedLength > MAX_INLINE_IMAGE_BYTES) return null;
  const header = Buffer.from(base64.slice(0, 24), "base64");
  if (!magicMatches(header, mime)) return null;
  return { mime, base64 };
}

function parseUser(entry: unknown, includeImages: boolean): { ids: string[]; parts: string[]; images: FoundImage[] } | null {
  const line = asRecord(entry);
  if (!line || line.type !== "response_item") return null;
  const payload = asRecord(line.payload);
  if (!payload || payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return null;
  const parts: string[] = [];
  const images: FoundImage[] = [];
  let imageOrdinal = 0;
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
    if (!includeImages || images.length >= MAX_IMAGES_PER_MESSAGE) continue;
    const accepted = acceptDataUrl(part.image_url);
    if (!accepted) continue;
    const { mime, base64 } = accepted;
    images.push({
      id,
      mime,
      readBytes: async () => {
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length > MAX_INLINE_IMAGE_BYTES || !magicMatches(bytes, mime)) throw new Error("invalid_image");
        return bytes;
      },
    });
  }
  return { ids: storedIds(payload), parts, images };
}

function sameText(left: { ids: string[]; parts: string[] }, right: { ids: string[]; parts: string[] }): boolean {
  if (left.ids.length !== right.ids.length || left.parts.length !== right.parts.length) return false;
  for (let index = 0; index < left.ids.length; index += 1) {
    if (left.ids[index] !== right.ids[index]) return false;
  }
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] !== right.parts[index]) return false;
  }
  return true;
}

/**
 * Exact concatenated input_text first. If that misses, a unique input_text part
 * may still be the Paseo text (Codex wraps the prompt with image labels and
 * environment text). No trimming and no other normalisation.
 */
function selectMessages(messages: MessageText[], context: ResolverContext): MessageText[] {
  const needles = providedIds(context);
  if (needles.length > 0) {
    const byId = messages.filter(message => message.ids.some(id => needles.includes(id)));
    if (byId.length > 0) return byId;
  }
  const exact = messages.filter(message => message.parts.join("") === context.text);
  if (exact.length > 0) return exact;
  return messages.filter(message => message.parts.some(part => part === context.text));
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

async function containedDirectory(home: string, name: string): Promise<string | null> {
  const path = join(home, name);
  try {
    const info = await lstat(path);
    // Symlinks are not followed, including a sessions directory that points outside the store.
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    const real = await realpath(path);
    return isInside(home, real) ? real : null;
  } catch {
    return null;
  }
}

async function confirmedFile(root: string, path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const real = await realpath(path);
    if (!isInside(root, real)) return null;
    const again = await lstat(real);
    return again.isFile() && !again.isSymbolicLink() ? real : null;
  } catch {
    return null;
  }
}

async function rolloutFiles(root: string, threadId: string, signal: AbortSignal): Promise<string[] | "aborted"> {
  const suffix = `-${threadId}.jsonl`;
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<"ok" | "aborted"> => {
    if (signal.aborted) return "aborted";
    if (depth > MAX_WALK_DEPTH || found.length > 1) return "ok";
    let directory;
    try {
      directory = await opendir(dir);
    } catch {
      return "ok";
    }
    try {
      // `read()` does not close the handle. `for await` would, and a second close throws.
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        if (signal.aborted) return "aborted";
        if (found.length > 1) return "ok";
        const name = entry.name;
        if (name.includes("/") || name.includes("\\") || name.includes("\0") || entry.isSymbolicLink()) continue;
        const path = join(dir, name);
        if (entry.isDirectory()) {
          let info;
          try { info = await lstat(path); } catch { continue; }
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
          if (await walk(path, depth + 1) === "aborted") return "aborted";
          continue;
        }
        if (!entry.isFile() || !name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
        let info;
        try { info = await lstat(path); } catch { continue; }
        if (!info.isFile() || info.isSymbolicLink()) continue;
        found.push(path);
      }
    } finally {
      await directory.close();
    }
    return "ok";
  };
  if (await walk(root, 0) === "aborted") return "aborted";
  return found;
}

type ThreadHit = "none" | "ambiguous" | "aborted" | { path: string };

async function fileForThread(home: string, threadId: string, signal: AbortSignal): Promise<ThreadHit> {
  if (!THREAD_ID.test(threadId)) return "none";
  for (const name of ["sessions", "archived_sessions"] as const) {
    if (signal.aborted) return "aborted";
    const root = await containedDirectory(home, name);
    if (!root) continue;
    const found = await rolloutFiles(root, threadId, signal);
    if (found === "aborted") return "aborted";
    if (found.length > 1) return "ambiguous";
    const candidate = found[0];
    if (!candidate) continue;
    const confirmed = await confirmedFile(root, candidate);
    if (confirmed) return { path: confirmed };
  }
  return "none";
}

async function locateRollout(home: string, context: ResolverContext): Promise<string | null> {
  const ids: string[] = [];
  for (const value of [context.sessionId, context.nativeHandle]) {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  }
  const paths = new Set<string>();
  for (const id of ids) {
    const hit = await fileForThread(home, id, context.signal);
    if (hit === "ambiguous" || hit === "aborted") return null;
    if (typeof hit === "object") paths.add(hit.path);
  }
  if (paths.size !== 1) return null;
  const [path] = paths;
  return path ?? null;
}

async function collectMessages(path: string, signal: AbortSignal): Promise<MessageText[] | null> {
  const messages: MessageText[] = [];
  let index = 0;
  for await (const entry of readJsonlReadOnly(path)) {
    if (signal.aborted) return null;
    const parsed = parseUser(entry, false);
    if (!parsed) continue;
    messages.push({ index, ids: parsed.ids, parts: parsed.parts });
    index += 1;
  }
  return messages;
}

async function loadMatchedImages(path: string, target: MessageText, signal: AbortSignal): Promise<FoundImage[] | null> {
  let index = 0;
  for await (const entry of readJsonlReadOnly(path)) {
    if (signal.aborted) return null;
    const parsed = parseUser(entry, false);
    if (!parsed) continue;
    if (index !== target.index) {
      index += 1;
      continue;
    }
    if (!sameText(parsed, target)) return null;
    const withImages = parseUser(entry, true);
    if (!withImages || !sameText(withImages, target)) return null;
    return withImages.images;
  }
  return null;
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
      const path = await locateRollout(home, context);
      if (!path || context.signal.aborted) return none();
      const messages = await collectMessages(path, context.signal);
      if (!messages) return none();
      const selected = selectMessages(messages, context);
      if (selected.length !== 1) return { matchedMessages: selected.length, images: [] };
      const target = selected[0];
      if (!target) return none();
      const images = await loadMatchedImages(path, target, context.signal);
      if (!images) return none();
      return { matchedMessages: 1, images };
    } catch (error) {
      if (isFsMiss(error)) return none();
      throw new Error("lookup_failed");
    }
  },
};
