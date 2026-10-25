import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { readImageHeader } from "./image-header";
import { openSqliteReadOnly, readLocalImageReadOnly } from "./read-only";
import type { FoundImages, PromptImageResolver, ResolverContext } from "./registry";

const BLOCK_START = "[The user sent an image~ Here's what I can see:\n";
const PATH_START = "]\n[If you need a closer look, use vision_analyze with image_url: ";
const BLOCK_END = " ~]";
// gateway/run_inbound.py::_enrich_message_with_vision failure branches. Each attachment is one note.
const FAILURE_PREFIXES = [
  "[The user sent an image but I couldn't quite see it this time (>_<) You can try looking at it yourself with vision_analyze using image_url: ",
  "[The user sent an image but something went wrong when I tried to look at it~ You can try examining it yourself with vision_analyze using image_url: ",
];
const MAX_CONFIG_BYTES = 64 * 1024;
const IMAGE_NOTE = /\[(?:The user sent an image|If you need a closer look|Image attached|screenshot)/;
const SCREENSHOT_LINE = /^\[screenshot(?: detail=(?:low|high|auto))?\]$/;
const MARKER_LINE = /^\[screenshot(?: detail=(low|high|auto))?\]$/;
const HINT_LINE = /^\[Image attached at: (\/[^\r\n\x00]+)\]$/;
// hermes_state_messages._encode_content: list/dict parts are "\0json:" + json.dumps.
const JSON_PREFIX = `${String.fromCharCode(0)}json:`;
const PLAIN_BLOCKED = [
  JSON_PREFIX,
  "[The user sent an image",
  "[If you need a closer look",
  "[Image attached",
  "[screenshot",
  "image_url",
  "vision_analyze",
];
// Original basenames are kept (`session_ingress_media.py` capture), including `Holiday [2026].png`.
// `]` still closes a failure note, so that delimiter cannot admit a bracketed filename.
const PATH_PATTERN = /^\/[^\r\n\x00]+$/;
const FAILURE_PATH_PATTERN = /^\/[^\r\n\[\]\x00]+$/;
const empty = (matchedMessages = 0): FoundImages => ({ matchedMessages, images: [] });

type ClassifiedMessage =
  | { kind: "plain"; text: string }
  | { kind: "image"; text: string; paths: string[] }
  | { kind: "uncertain"; text: string | null };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Bound descriptor reads even if config grows after stat; never wait on a FIFO. */
async function readConfig(path: string, signal: AbortSignal): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    signal.throwIfAborted();
    const entry = await file.stat();
    if (!entry.isFile() || entry.size > MAX_CONFIG_BYTES) return undefined;
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      signal.throwIfAborted();
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length <= MAX_CONFIG_BYTES ? JSON.parse(bytes.toString("utf8", 0, length)) : undefined;
  } finally {
    await file?.close();
  }
}

/** Only the two documented ACP invocations are accepted; never invoke a shell. */
function profile(command: unknown): { name?: string } | null {
  const tokens = typeof command === "string" ? command.trim().split(/\s+/) : command;
  if (!Array.isArray(tokens) || !tokens.every(token => typeof token === "string")) return null;
  if (tokens[0] !== "hermes" && !(isAbsolute(tokens[0] ?? "") && tokens[0]?.endsWith(`${sep}hermes`))) return null;
  if (tokens.length === 2 && tokens[1] === "acp") return {};
  const name = tokens[2];
  if (tokens.length === 4 && tokens[1] === "-p" && tokens[3] === "acp" &&
      typeof name === "string" && /^[a-z0-9_-][a-z0-9_.-]*$/i.test(name)) return { name };
  return null;
}

function messageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.replace(/-/g, "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

/**
 * Display visibility of one `display_metadata` value.
 * NULL stays visible. A missing column never reaches here.
 * Only the JSON literal `true` hides a merged carrier (`_is_model_only_row`).
 * Literal `false`, or a JSON object with no `model_only` key, stays visible.
 * Any other value is uncertain and is not hidden: empty list or dict, strings,
 * numbers, null, non-objects, and invalid JSON.
 */
function rowDisplay(raw: unknown): "visible" | "hidden" | "uncertain" {
  if (raw == null) return "visible";
  if (typeof raw !== "string") return "uncertain";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "uncertain";
  }
  const entry = record(parsed);
  if (!entry) return "uncertain";
  if (!Object.hasOwn(entry, "model_only")) return "visible";
  const flag = entry.model_only;
  if (flag === true) return "hidden";
  if (flag === false) return "visible";
  return "uncertain";
}

function successNote(description: string, path: string): string {
  return `${BLOCK_START}${description}${PATH_START}${path}${BLOCK_END}`;
}

/**
 * One gateway success note (`_enrich_message_with_vision`) and the exact remainder.
 * The path ends at the first ` ~]`, so a filename containing that closer only
 * round-trips when the rebuilt note is the whole stored prefix.
 */
function takeSuccess(content: string): { note: string; path: string; rest: string } | null {
  if (!content.startsWith(BLOCK_START)) return null;
  const pathAt = content.indexOf(PATH_START, BLOCK_START.length);
  if (pathAt < 0) return null;
  const description = content.slice(BLOCK_START.length, pathAt);
  if (/\[(?:The user sent an image|If you need a closer look|Image attached)/.test(description)) return null;
  const end = content.indexOf(BLOCK_END, pathAt + PATH_START.length);
  if (end < 0) return null;
  const path = content.slice(pathAt + PATH_START.length, end);
  if (!PATH_PATTERN.test(path)) return null;
  const note = successNote(description, path);
  if (!content.startsWith(note)) return null;
  const next = content.slice(note.length);
  if (!next) return { note, path, rest: "" };
  if (!next.startsWith("\n\n")) return null;
  return { note, path, rest: next.slice(2) };
}

/** Byte length of a structurally complete success note at `at`, or -1. */
function successBlockLength(content: string, at: number): number {
  if (!content.startsWith(BLOCK_START, at)) return -1;
  const pathStart = content.indexOf(PATH_START, at + BLOCK_START.length);
  if (pathStart === -1) return -1;
  const end = content.indexOf(BLOCK_END, pathStart + PATH_START.length);
  if (end === -1) return -1;
  const path = content.slice(pathStart + PATH_START.length, end);
  if (!PATH_PATTERN.test(path)) return -1;
  return end + BLOCK_END.length - at;
}

/** Byte length of a structurally complete failure note at `at`, or 0. */
function failureBlockLength(content: string, at: number): number {
  for (const prefix of FAILURE_PREFIXES) {
    if (!content.startsWith(prefix, at)) continue;
    const end = content.indexOf("]", at + prefix.length);
    if (end === -1) continue;
    const path = content.slice(at + prefix.length, end);
    if (!FAILURE_PATH_PATTERN.test(path)) continue;
    return end + 1 - at;
  }
  return 0;
}

function earliestFailure(content: string, from: number): number {
  let best = -1;
  for (const prefix of FAILURE_PREFIXES) {
    let search = from;
    while (search < content.length) {
      const at = content.indexOf(prefix, search);
      if (at === -1) break;
      if (failureBlockLength(content, at) > 0) {
        if (best === -1 || at < best) best = at;
        break;
      }
      search = at + 1;
    }
  }
  return best;
}

/**
 * Best-effort caption of a row that looks like an image note but did not parse.
 * The count may include it. The row stays uncertain either way, so text fallback
 * cannot treat another row as the only match. A failure note contributes no paths.
 */
function unparsedImageCaption(content: string): string | null {
  let image = false;
  let out = "";
  let index = 0;
  while (index < content.length) {
    const successAt = content.indexOf(BLOCK_START, index);
    const failureAt = earliestFailure(content, index);
    const successFirst = successAt !== -1 && (failureAt === -1 || successAt <= failureAt);
    const next = successFirst ? successAt : failureAt;
    if (next === -1) {
      out += content.slice(index);
      break;
    }
    out += content.slice(index, next);
    const length = successFirst ? successBlockLength(content, next) : failureBlockLength(content, next);
    if (length <= 0) {
      out += content.slice(next, next + 1);
      index = next + 1;
      continue;
    }
    image = true;
    index = next + length;
  }
  // Image-first markers sit above the caption and hints below it. Drop both, plus any leftover
  // note line, so a partial note cannot change the caption or drop the row.
  const kept: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("[The user sent an image") || line.startsWith("[If you need a closer look") ||
        line.startsWith("[Image attached") || SCREENSHOT_LINE.test(line)) {
      image = true;
      continue;
    }
    kept.push(line);
  }
  if (!image) return null;
  const text = kept.join("\n").trim();
  if (IMAGE_NOTE.test(text)) return null;
  return text;
}

/**
 * Success notes only, joined the way `_enrich_message_with_vision` joins them:
 * `"\n\n".join(notes)` plus `"\n\n" + user_text` when the user text is non-empty.
 * A failure note is not an image row. Any split that does not rebuild the stored
 * bytes is not fully parsed.
 */
function parseVision(content: string): { text: string; paths: string[] } | null {
  if (!content.startsWith(BLOCK_START)) return null;
  const notes: string[] = [];
  const paths: string[] = [];
  let rest = content;
  while (rest.startsWith(BLOCK_START)) {
    const taken = takeSuccess(rest);
    if (!taken) return null;
    notes.push(taken.note);
    paths.push(taken.path);
    rest = taken.rest;
  }
  if (!paths.length || rest.startsWith("[The user sent an image")) return null;
  const rebuilt = notes.join("\n\n") + (rest ? `\n\n${rest}` : "");
  if (rebuilt !== content) return null;
  const text = rest.trim();
  if (IMAGE_NOTE.test(text)) return null;
  return { text, paths };
}

function screenshotMarker(detail: string | null): string {
  return detail ? `[screenshot detail=${detail}]` : "[screenshot]";
}

/**
 * Native rows from `build_native_content_parts` plus `_durable_content`.
 * The text part is `caption + "\n\n" + hints`. Each image part is one
 * `[screenshot]` / `[screenshot detail=…]` line, before that text (API image-first)
 * or after it (turn-time). Hints are `[Image attached at: <path>]`, one per line.
 * A `]\n[` inside a filename splits the hint, so the rebuild misses the stored bytes.
 */
function parseNative(content: string): { text: string; paths: string[] } | null {
  if (!content.includes("[Image attached") && !content.includes("[screenshot")) return null;
  const lines = content.split("\n");
  const hintAt: number[] = [];
  const markerAt: number[] = [];
  const paths: string[] = [];
  const details: (string | null)[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const marker = MARKER_LINE.exec(line);
    if (marker) {
      markerAt.push(index);
      details.push(marker[1] ?? null);
      continue;
    }
    if (!line.startsWith("[Image attached")) continue;
    const path = HINT_LINE.exec(line)?.[1];
    if (!path) return null;
    hintAt.push(index);
    paths.push(path);
  }
  const firstHint = hintAt[0];
  const lastHint = hintAt[hintAt.length - 1];
  if (firstHint === undefined || lastHint === undefined || !paths.length) return null;
  if (markerAt.length && markerAt.length !== paths.length) return null;
  for (let index = 1; index < hintAt.length; index++) {
    if (hintAt[index] !== (hintAt[index - 1] ?? -2) + 1) return null;
  }
  if (lines[firstHint - 1] !== "") return null;
  const before = markerAt.filter(index => index < firstHint);
  const after = markerAt.filter(index => index > lastHint);
  if (before.length + after.length !== markerAt.length || (before.length > 0 && after.length > 0)) return null;
  let caption: string;
  let imageFirst: boolean;
  if (before.length) {
    if (before.some((index, offset) => index !== offset) || lastHint !== lines.length - 1) return null;
    caption = lines.slice(before.length, firstHint - 1).join("\n");
    imageFirst = true;
  } else {
    if (after.length) {
      if (after[0] !== lastHint + 1 || after[after.length - 1] !== lines.length - 1) return null;
      if (after.some((index, offset) => index !== lastHint + 1 + offset)) return null;
    } else if (lastHint !== lines.length - 1) return null;
    caption = lines.slice(0, firstHint - 1).join("\n");
    imageFirst = false;
  }
  const hints = paths.map(path => `[Image attached at: ${path}]`).join("\n");
  const body = `${caption}\n\n${hints}`;
  const markerText = details.map(screenshotMarker).join("\n");
  const rebuilt = !details.length ? body : imageFirst ? `${markerText}\n${body}` : `${body}\n${markerText}`;
  if (rebuilt !== content) return null;
  const text = caption.trim();
  if (IMAGE_NOTE.test(text)) return null;
  return { text, paths };
}

/** Fully parsed image rows are exactly the upstream success-note or native durable strings. */
function annotations(content: string): { text: string; paths: string[] } | null {
  return parseVision(content) ?? parseNative(content);
}

function plainText(content: string): boolean {
  return PLAIN_BLOCKED.every(marker => !content.includes(marker));
}

const IMG_LEAF = /^img_[a-f0-9]{12}\.(?:png|jpg|jpeg|webp|gif)$/;
const API_LEAF = /^api_([a-f0-9]{32})\.(?:png|jpg|jpeg|webp|gif)$/;
const NATIVE_REL = /^[a-f0-9]{64}\/[A-Za-z0-9._-]+$/;
const SUCCESS_CLOSER = " ~]";
const IMAGE_URL = "image_url: ";
const HINT_INTRO = "[Image attached at: ";

function isPathChar(char: string): boolean {
  return /^[A-Za-z0-9._/-]$/.test(char);
}

function cacheRoots(home: string): { image: string; native: string } {
  return {
    image: join(home, "cache", "images"),
    native: join(home, "cache", "documents", "native-inputs"),
  };
}

/**
 * A stored image path is accepted only when every character after the cache root
 * is `[A-Za-z0-9._/-]` and the leaf is a known Hermes cache name:
 * `img_<12 hex>.<ext>`, `api_<32 hex>.<ext>`, or `native-inputs/<64 hex>/<leaf>`.
 * The leaf is one segment. Spaces, brackets, tildes, newlines and other characters are not names.
 */
function acceptedCachePath(path: string, home: string): boolean {
  if (!isAbsolute(path) || path.includes("\\") || normalize(path) !== path) return false;
  const { image, native } = cacheRoots(home);
  if (path.startsWith(`${image}${sep}`)) {
    const relative = path.slice(image.length + 1);
    return /^[A-Za-z0-9._/-]+$/.test(relative) && (IMG_LEAF.test(relative) || API_LEAF.test(relative));
  }
  if (path.startsWith(`${native}${sep}`)) {
    const relative = path.slice(native.length + 1);
    return /^[A-Za-z0-9._/-]+$/.test(relative) && NATIVE_REL.test(relative);
  }
  return false;
}

function cacheLocation(path: string, home: string): { root: string; digest?: string } | null {
  if (!acceptedCachePath(path, home)) return null;
  const { image, native } = cacheRoots(home);
  if (path.startsWith(`${native}${sep}`)) {
    return { root: native, digest: path.slice(native.length + 1, native.length + 1 + 64) };
  }
  const api = API_LEAF.exec(path.slice(image.length + 1));
  return api ? { root: image, digest: api[1] } : { root: image };
}

/** Longest cache path of whitelist characters starting at `start`, or null. */
function readCachePath(content: string, start: number, home: string): { path: string; end: number } | null {
  const { image, native } = cacheRoots(home);
  const root = [`${image}${sep}`, `${native}${sep}`].find(candidate => content.startsWith(candidate, start));
  if (!root) return null;
  let end = start + root.length;
  while (end < content.length && isPathChar(content[end] ?? "")) end++;
  const path = content.slice(start, end);
  return acceptedCachePath(path, home) ? { path, end } : null;
}

function hasImageSignal(content: string): boolean {
  return content.includes("[The user sent an image") || content.includes("[If you need a closer look") ||
    content.includes("[Image attached") || content.includes("[screenshot") ||
    content.includes("image_url") || content.includes("vision_analyze");
}

function closerIndexes(content: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (from < content.length) {
    const at = content.indexOf(SUCCESS_CLOSER, from);
    if (at < 0) break;
    found.push(at);
    from = at + SUCCESS_CLOSER.length;
  }
  return found;
}

/**
 * Every image-note path must be one accepted cache path glued to its closer.
 * A whitelist path cannot contain ` ~]`, so a closer that does not end an accepted
 * path means the stored name was split. That row is uncertain.
 */
function pathsAccepted(content: string, home: string): boolean {
  if (!hasImageSignal(content)) return true;
  const consumed: number[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const imageAt = content.indexOf(IMAGE_URL, cursor);
    const hintAt = content.indexOf(HINT_INTRO, cursor);
    const hint = hintAt >= 0 && (imageAt < 0 || hintAt < imageAt);
    const at = hint ? hintAt : imageAt;
    if (at < 0) break;
    const pathStart = at + (hint ? HINT_INTRO.length : IMAGE_URL.length);
    const read = readCachePath(content, pathStart, home);
    if (!read) return false;
    if (hint) {
      if (!content.startsWith("]", read.end)) return false;
      cursor = read.end + 1;
      continue;
    }
    const success = at >= 5 && content.startsWith("with ", at - 5);
    const failure = at >= 6 && content.startsWith("using ", at - 6);
    if (success) {
      if (!content.startsWith(SUCCESS_CLOSER, read.end)) return false;
      consumed.push(read.end);
      cursor = read.end + SUCCESS_CLOSER.length;
      continue;
    }
    if (failure) {
      if (!content.startsWith("]", read.end)) return false;
      cursor = read.end + 1;
      continue;
    }
    return false;
  }
  const closers = closerIndexes(content);
  return closers.length === consumed.length && closers.every((index, offset) => index === consumed[offset]);
}

/**
 * An image row is a byte-for-byte upstream success note or native hint whose
 * every path is an accepted cache name. `\0json:` is always uncertain.
 * A note whose path is not accepted is uncertain and keeps no caption.
 * Other image-shaped rows stay uncertain, and may still carry a recovered caption.
 */
function classifyMessage(content: string, home: string): ClassifiedMessage {
  if (content.startsWith(JSON_PREFIX)) return { kind: "uncertain", text: null };
  if (!pathsAccepted(content, home)) return { kind: "uncertain", text: null };
  const parsed = annotations(content);
  if (parsed && parsed.paths.length > 0 && !IMAGE_NOTE.test(parsed.text) &&
      parsed.paths.every(path => acceptedCachePath(path, home))) {
    return { kind: "image", text: parsed.text, paths: parsed.paths };
  }
  if (plainText(content)) return { kind: "plain", text: content.trim() };
  return { kind: "uncertain", text: unparsedImageCaption(content) };
}

/** Injectable base directories keep all tests synthetic, including provider config. */
export function createHermesPromptImageResolver(options: { userHome?: string; paseoHome?: string } = {}): PromptImageResolver {
  // The matcher and finder share the resolved home for this lookup, even if config changes.
  const homes = new WeakMap<ResolverContext, string>();

  async function resolveHome(context: ResolverContext): Promise<string | null> {
    const userHome = options.userHome ?? homedir();
    let provider: Record<string, unknown> | undefined;
    if (context.providerCommand === undefined || context.providerEnv === undefined) {
      try {
        const paseoHome = options.paseoHome ?? (process.env.PASEO_HOME || join(userHome, ".paseo"));
        const config = record(await readConfig(join(paseoHome, "config.json"), context.signal));
        const providers = record(record(config?.agents)?.providers);
        if (providers && Object.hasOwn(providers, context.provider)) provider = record(providers[context.provider]);
      } catch { /* Missing or malformed config cannot supply launch hints. */ }
    }
    const selected = profile(context.providerCommand ?? provider?.command);
    if (!selected) return null;
    const env = context.providerEnv ?? record(provider?.env);
    const override = env?.HERMES_HOME;
    if (override !== undefined) {
      if (typeof override !== "string" || !override || override.split(/[\\/]/).includes("..")) return null;
      const home = override.startsWith("~/") ? join(userHome, override.slice(2)) : override;
      return isAbsolute(home) ? normalize(home) : null;
    }
    return selected.name ? join(userHome, ".hermes", "profiles", selected.name) : join(userHome, ".hermes");
  }

  return {
    async matches(_provider, context) {
      if (context.signal.aborted) return false;
      const home = await resolveHome(context);
      if (!home || context.signal.aborted) return false;
      homes.set(context, home);
      return true;
    },
    async find(context) {
      if (!context.sessionId || context.signal.aborted) return empty();
      const home = homes.get(context) ?? await resolveHome(context);
      if (!home || context.signal.aborted) return empty();
      const ids = new Set([messageId(context.messageId), messageId(context.clientMessageId)].filter(id => id !== null));
      let match: {
        matchedMessages: number; content: unknown; uncertain: boolean; byId: boolean;
        sessionUncertain: boolean; parsedMatches: number; plainMatches: number;
      } | null;
      try {
        match = await openSqliteReadOnly(join(home, "state.db"), database => {
          // Keep the scan synchronous and retry-local so the helper can validate
          // an immutable read and discard it before retrying on the plain path.
          let idMatches = 0, textMatches = 0, parsedMatches = 0, plainMatches = 0;
          let idContent: unknown, textContent: unknown;
          let idUncertain = false, textUncertain = false, sessionUncertain = false;
          if (!database.prepare("SELECT id FROM sessions WHERE id = ?").get(context.sessionId)) return null;
          // hermes_state_messages.py shows active=1 or compacted=1 and skips model_only carriers.
          // A schema without active or compacted is not a transcript this reader understands.
          const names = new Set(database.prepare("PRAGMA table_info(messages)").all().map(column => column.name));
          if (!names.has("active") || !names.has("compacted")) return null;
          const hasDisplayMetadata = names.has("display_metadata");
          const rows = database.prepare(`SELECT content, platform_message_id, message_uid${hasDisplayMetadata ? ", display_metadata" : ""} FROM messages WHERE session_id = ? AND role = 'user' AND (active = 1 OR compacted = 1)`);
          const prompt = context.text.trim();
          for (const row of rows.iterate(context.sessionId)) {
            if (context.signal.aborted) return null;
            const visibility = hasDisplayMetadata ? rowDisplay(row.display_metadata) : "visible";
            if (visibility === "hidden") continue;
            const displayUncertain = visibility === "uncertain";
            if ([messageId(row.platform_message_id), messageId(row.message_uid)].some(id => id !== null && ids.has(id))) {
              idMatches++;
              idContent = row.content;
              if (displayUncertain) idUncertain = true;
            }
            if (typeof row.content !== "string") continue;
            const kind = classifyMessage(row.content, home);
            // A note that did not parse completely poisons text fallback for every caption.
            if (kind.kind === "uncertain") sessionUncertain = true;
            const caption = kind.text;
            if (prompt === row.content.trim() || (caption !== null && prompt === caption)) {
              textMatches++;
              textContent = row.content;
              if (displayUncertain) textUncertain = true;
              if (kind.kind === "image") parsedMatches++;
              if (kind.kind === "plain") plainMatches++;
            }
          }
          return {
            matchedMessages: idMatches || textMatches,
            content: idMatches ? idContent : textContent,
            uncertain: idMatches ? idUncertain : textUncertain,
            byId: idMatches > 0,
            sessionUncertain, parsedMatches, plainMatches,
          };
        });
      } catch { return empty(); }
      await setImmediate();
      if (!match) return empty();
      const { matchedMessages, content, uncertain, byId, sessionUncertain, parsedMatches, plainMatches } = match;
      if (context.signal.aborted) return empty(matchedMessages);
      // Id hits stay row-local. Text fallback needs one clean image caption, no identical
      // plain-text row, and no uncertain image row anywhere in the scanned session.
      if (!byId && sessionUncertain) {
        const uniqueImage = parsedMatches === 1 && plainMatches === 0 && matchedMessages === 1;
        return empty(uniqueImage ? 2 : matchedMessages);
      }
      if (matchedMessages !== 1 || typeof content !== "string" || uncertain) return empty(matchedMessages);
      const parsed = classifyMessage(content, home);
      if (parsed.kind !== "image") return empty(1);
      const images: FoundImages["images"] = [];
      for (const [index, path] of parsed.paths.entries()) {
        if (context.signal.aborted) break;
        const located = cacheLocation(path, home);
        if (!located) continue;
        const { root, digest } = located;
        const validDigest = (bytes: Buffer) => !digest || createHash("sha256").update(bytes).digest("hex").startsWith(digest);
        const bytes = await readLocalImageReadOnly(path, [root]);
        if (!bytes || !validDigest(bytes)) continue;
        const header = readImageHeader(bytes);
        if (!header ||
            header.width < 1 || header.height < 1 || header.width * header.height > 24_000_000) continue;
        // Revalidate through O_NOFOLLOW on every RPC read, including after cache cleanup.
        images.push({ id: `hermes-${index}`, mime: header.mime, async readBytes() {
          const current = await readLocalImageReadOnly(path, [root]);
          return current && validDigest(current) ? current : null;
        } });
      }
      return { matchedMessages: 1, images };
    },
  };
}

export const hermesPromptImageResolver = createHermesPromptImageResolver();
