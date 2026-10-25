import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FoundImage, FoundImages, PromptImageResolver, ResolverContext } from "./registry";
import { MAX_IMAGE_BYTES, readJsonlReadOnly } from "./read-only";
import { readImageHeader } from "./image-header";

const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const MAX_IMAGES = 20;
const MAX_PIXELS = 24_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

interface UserMessage {
  ids: string[];
  text: string | null;
  images: Record<string, unknown>[];
}

function userMessage(value: unknown, sessionId: string): UserMessage | null {
  const line = record(value);
  if (!line || line.type !== "user" || line.isSidechain === true || line.isMeta === true ||
      (line.sessionId !== undefined && line.sessionId !== sessionId)) return null;
  const message = record(line.message);
  if (!message || message.role !== "user") return null;
  if ([line.uuid, line.promptId].some(id => id !== undefined && typeof id !== "string")) return null;
  const ids = [line.uuid, line.promptId].filter((id): id is string => typeof id === "string" && id.length > 0);
  const unreadable = { ids, text: null, images: [] };
  if (typeof message.content === "string") return { ids, text: message.content, images: [] };
  if (!Array.isArray(message.content) || !message.content.length) return unreadable;
  if (message.content.some(value => record(value)?.type === "tool_result")) return null;
  const texts: string[] = [];
  const images: Record<string, unknown>[] = [];
  for (const value of message.content) {
    const block = record(value);
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "image") images.push(block);
    // Reserve IDs on unknown shapes so text fallback cannot select a different
    // message when the requested message has an unreadable content format.
    else return unreadable;
  }
  return { ids, text: texts.join("\n"), images };
}

function image(block: Record<string, unknown>, index: number): FoundImage | null {
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
  return { id: `claude-image-${index}`, mime: source.media_type, readBytes: async () => Buffer.from(bytes) };
}

async function sessionFiles(projects: string, cwd: string, sessionId: string, signal: AbortSignal): Promise<string[]> {
  // Claude's documented escaping is per character (including spaces/dots).
  // https://code.claude.com/docs/en/sessions#where-transcripts-are-stored
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length > 0 && encoded.length <= 200) {
    const expected = join(projects, encoded, `${sessionId}.jsonl`);
    try {
      const entry = await lstat(expected);
      return entry.isFile() ? [expected] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
  let idMessage: UserMessage | null = null, textMessage: UserMessage | null = null;
  try {
    const files = await sessionFiles(projects, context.cwd, context.sessionId, context.signal);
    for (const path of files) {
      context.signal.throwIfAborted();
      for await (const value of readJsonlReadOnly(path, { allowedRoots: [projects], signal: context.signal })) {
        context.signal.throwIfAborted();
        const message = userMessage(value, context.sessionId);
        if (!message) continue;
        if (message.ids.some(id => requestedIds.includes(id))) {
          idCount++;
          idMessage = idCount === 1 ? message : null;
        }
        if (message.text === context.text) {
          textCount++;
          textMessage = textCount === 1 ? message : null;
        }
      }
    }
    const matchedMessages = idCount || textCount;
    const selected = idCount ? idMessage : textMessage;
    if (matchedMessages !== 1 || !selected) return { matchedMessages, images: [] };
    const images: FoundImage[] = [];
    for (let index = 0; index < selected.images.length && images.length < MAX_IMAGES; index++) {
      context.signal.throwIfAborted();
      const found = image(selected.images[index]!, index);
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
