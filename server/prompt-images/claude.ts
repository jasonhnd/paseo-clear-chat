import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FoundImage, FoundImages, PromptImageResolver, ResolverContext } from "./registry";
import { MAX_IMAGE_BYTES, readJsonlReadOnly } from "./read-only";
import { readImageHeader } from "./image-header";

const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 20;
const MAX_PIXELS = 24_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

interface UserMessage {
  uuid: string | null;
  ids: string[];
  text: string | null;
  images: Record<string, unknown>[];
  /** Tool-result lines reserve their own uuid but are not unknown content. */
  toolResult: boolean;
}

function userMessage(value: unknown, sessionId: string): UserMessage | null {
  const line = record(value);
  if (!line) return null;
  const attachment = line.type === "attachment" ? record(line.attachment) : null;
  if (line.type !== "user" && attachment?.type !== "queued_command") return null;
  // Even rejected user lines reserve their readable IDs. Otherwise a lookup
  // for that line could fall back to an unrelated message with the same text.
  const rawIds = [line.uuid, line.promptId, ...(attachment ? [attachment.source_uuid] : [])];
  const ids = rawIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const uuid = typeof line.uuid === "string" && line.uuid.length > 0 ? line.uuid : null;
  const unreadable: UserMessage = { uuid, ids, text: null, images: [], toolResult: false };
  const message = record(line.message);
  if (!attachment && (!message || message.role !== "user")) return unreadable;
  const rejected = line.isSidechain === true || line.isMeta === true || attachment?.isMeta === true ||
    (line.sessionId !== undefined && line.sessionId !== sessionId) ||
    rawIds.some(id => id !== undefined && typeof id !== "string");
  const content = attachment ? attachment.prompt : message!.content;
  if (typeof content === "string") return { uuid, ids, text: content, images: [], toolResult: false };
  if (!Array.isArray(content) || !content.length) return unreadable;
  // Claude copies the turn promptId onto every tool_result line. That copy is
  // not another message. Reserve only this line's uuid: a lookup of the uuid
  // still selects nothing, and the prompt id still selects the user turn.
  if (content.some(value => record(value)?.type === "tool_result")) {
    return { uuid, ids: uuid ? [uuid] : [], text: null, images: [], toolResult: true };
  }
  const texts: string[] = [];
  const images: Record<string, unknown>[] = [];
  for (const value of content) {
    const block = record(value);
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "image") images.push(block);
    // Reserve IDs on unknown shapes so text fallback cannot select a different
    // message when the requested message has an unreadable content format.
    else return unreadable;
  }
  return { uuid, ids, text: texts.join("\n"), images: rejected ? [] : images, toolResult: false };
}

function image(block: Record<string, unknown>, id: string): FoundImage | null {
  const source = record(block.source);
  if (!source || source.type !== "base64" || typeof source.media_type !== "string" ||
      !MIME_TYPES.has(source.media_type) || typeof source.data !== "string") return null;
  const data = source.data;
  // Bound allocation before decoding. Buffer's permissive base64 decoder must
  // never silently accept whitespace, invalid characters or noncanonical bits.
  if (!data.length || data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length / 4 * 3 - padding > MAX_IMAGE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return null;
  const header = readImageHeader(bytes);
  if (!header || header.mime !== source.media_type || header.width < 1 || header.height < 1 ||
      header.width * header.height > MAX_PIXELS) return null;
  return { id, mime: source.media_type, readBytes: async () => Buffer.from(bytes) };
}

async function sessionFiles(projects: string, sessionId: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  // Long paths may be hashed; resumed sessions may live under another cwd.
  // Inspect immediate project directories only, never subagent transcripts.
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (!entry.isDirectory()) continue;
    const path = join(projects, entry.name, `${sessionId}.jsonl`);
    try {
      if ((await lstat(path)).isFile()) files.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

async function fileIdentity(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile()) throw new Error("invalid_store");
  return [entry.dev, entry.ino, entry.size, entry.mtimeNs].join(":");
}

async function find(context: ResolverContext): Promise<FoundImages> {
  const empty = { matchedMessages: 0, images: [] };
  if (!context.sessionId || !SESSION_ID.test(context.sessionId) || context.signal.aborted) return empty;
  const env = context.providerEnv;
  // Provider overrides win over the daemon environment, including the owner's
  // secure-storage override. Never search other accounts after a missing file.
  const configDir = env?.CLAUDE_CONFIG_DIR || env?.CLAUDE_SECURESTORAGE_CONFIG_DIR ||
    process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || join(homedir(), ".claude");
  const projects = resolve(context.cwd, configDir, "projects");
  const requestedIds = [context.messageId, context.clientMessageId].filter((id): id is string => !!id);
  let idCount = 0, textCount = 0;
  let unreadableText = false;
  let idMessage: UserMessage | null = null, textMessage: UserMessage | null = null;
  try {
    const files = await sessionFiles(projects, context.sessionId, context.signal);
    // A copied session is ambiguous even if only one copy contains the lookup.
    if (files.length > 1) return { matchedMessages: files.length, images: [] };
    let identity = "";
    for (const path of files) {
      context.signal.throwIfAborted();
      identity = await fileIdentity(path);
      for await (const value of readJsonlReadOnly(path, { allowedRoots: [projects], signal: context.signal })) {
        context.signal.throwIfAborted();
        const message = userMessage(value, context.sessionId);
        if (!message) continue;
        // Tool results are a known non-prompt shape. They must not make every
        // session that used a tool fail closed on text fallback.
        if (message.text === null && !message.toolResult) unreadableText = true;
        if (message.ids.some(id => requestedIds.includes(id))) {
          idCount++;
          idMessage = idCount === 1 ? message : null;
        }
        if (message.text === context.text) {
          textCount++;
          textMessage = textCount === 1 ? message : null;
        }
      }
      if (identity !== await fileIdentity(path)) return empty;
    }
    const matchedMessages = idCount || textCount;
    const selected = idCount ? idMessage : textMessage;
    if ((!idCount && unreadableText) || matchedMessages !== 1 || !selected?.uuid) return { matchedMessages, images: [] };
    // prompt.image repeats the lookup. Binding the opaque IDs to both the
    // message UUID and transcript identity makes an old list ID fail to match
    // after replacement, edits or appends, without keeping transcript caches.
    const binding = createHash("sha256").update(JSON.stringify([files[0], identity, selected.uuid])).digest("hex");
    const images: FoundImage[] = [];
    for (let index = 0; index < selected.images.length && images.length < MAX_IMAGES; index++) {
      context.signal.throwIfAborted();
      const found = image(selected.images[index]!, `claude-image-${binding}-${index}`);
      if (found) images.push(found);
    }
    return { matchedMessages, images };
  } catch {
    // Missing/cleaned stores, denied reads and cancellations contain no images.
    // Exceptions can contain paths or record data, so never log them.
    return empty;
  }
}

export const claudePromptImageResolver: PromptImageResolver = {
  matches: (provider, command) => provider === "claude" ||
    /^(?:claude|claude\.exe|claude\.cmd)$/i.test(command?.[0]?.split(/[\\/]/).pop() ?? ""),
  find,
};
