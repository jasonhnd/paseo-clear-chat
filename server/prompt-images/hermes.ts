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
const SCREENSHOT_ROW = /(?:^|\n)\[screenshot(?: detail=(?:low|high|auto))?\](?:\n|$)/;
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

/** Python `bool` for a JSON `model_only` flag: only JSON-falsy values stay on screen. */
function modelOnlyFlag(flag: unknown): boolean {
  if (flag == null || flag === false || flag === 0 || flag === "") return false;
  if (typeof flag === "number") return !Number.isNaN(flag);
  return true;
}

/**
 * Display visibility of one `display_metadata` value.
 * NULL stays visible. A missing column never reaches here.
 * Invalid JSON is uncertain (`hermes_state_messages._decode_display_metadata` cannot prove the row is real).
 * `model_only` is the hidden merged carrier (`_is_model_only_row`, `micro_compaction._merge_adjacent_user_turns`).
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
  // Pre-guard rows store one extra JSON string layer.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return "visible";
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "visible";
  return modelOnlyFlag((parsed as Record<string, unknown>).model_only) ? "hidden" : "visible";
}

/**
 * Durable native rows pair each `[screenshot]` with an `[Image attached …]` hint in order,
 * the same way `agent/image_replay.py::_split_rebuilt_row` does. API callers put the marker
 * before the caption; turn-time hints stay a blank line above the hint list.
 */
function nativeImage(content: string): { text: string; paths: string[] } | null {
  if (!content.includes("[Image attached") && !SCREENSHOT_ROW.test(content)) return null;
  const lines = content.trimEnd().split("\n");
  const markerAt: number[] = [];
  const hintAt: number[] = [];
  const paths: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (SCREENSHOT_LINE.test(line)) {
      markerAt.push(index);
      continue;
    }
    if (!line.startsWith("[Image attached")) continue;
    const path = /^\[Image attached at: (\/[^\r\n\x00]+)\]$/.exec(line)?.[1];
    if (!path) return null;
    hintAt.push(index);
    paths.push(path);
  }
  if (!paths.length || (markerAt.length && markerAt.length !== paths.length)) return null;
  const first = hintAt[0];
  // build_native_content_parts separates the caption and hint list by a blank line.
  if (first === undefined || (first > 0 && lines[first - 1] !== "")) return null;
  const drop = new Set([...markerAt, ...hintAt]);
  const text = lines.filter((_, index) => !drop.has(index)).join("\n");
  if (IMAGE_NOTE.test(text)) return null;
  return { text: text.trim(), paths };
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

/** Gateway descriptions precede the caption; native hints follow it, unless the image was stored first. */
function annotations(content: string): { text: string; paths: string[] } | null {
  let rest = content.trimStart();
  const paths: string[] = [];
  while (rest.startsWith("[The user sent an image")) {
    if (!rest.startsWith(BLOCK_START)) return null;
    const pathStart = rest.indexOf(PATH_START, BLOCK_START.length);
    if (pathStart === -1) return null;
    const description = rest.slice(BLOCK_START.length, pathStart);
    if (/\[(?:The user sent an image|If you need a closer look|Image attached)/.test(description)) return null;
    const end = rest.indexOf(BLOCK_END, pathStart + PATH_START.length);
    if (end === -1) return null;
    const path = rest.slice(pathStart + PATH_START.length, end);
    if (!PATH_PATTERN.test(path)) return null;
    paths.push(path);
    rest = rest.slice(end + BLOCK_END.length).trimStart();
  }
  if (!paths.length) {
    const native = nativeImage(rest);
    if (native) return native;
    // An image note we could not read must not fall through as ordinary text.
    if (rest.includes("[Image attached") || SCREENSHOT_ROW.test(rest) || rest.startsWith("[The user sent an image")) return null;
  }
  if (IMAGE_NOTE.test(rest)) return null;
  return { text: rest.trim(), paths };
}

/**
 * Plain text has no Hermes image note. An image row is one whose notes all parsed and
 * whose paths were accepted. Any other note, marker or hint is uncertain: its caption
 * is not trusted, and one such row blocks text fallback for the whole session.
 */
function classifyMessage(content: string): ClassifiedMessage {
  if (!IMAGE_NOTE.test(content)) return { kind: "plain", text: content.trim() };
  const parsed = annotations(content);
  if (parsed && parsed.paths.length > 0 && !IMAGE_NOTE.test(parsed.text)) {
    return { kind: "image", text: parsed.text, paths: parsed.paths };
  }
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
            const kind = classifyMessage(row.content);
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
      const parsed = annotations(content);
      if (!parsed) return empty(1);
      const images: FoundImages["images"] = [];
      const nativeRoot = join(home, "cache", "documents", "native-inputs");
      const imageRoot = join(home, "cache", "images");
      for (const [index, path] of parsed.paths.entries()) {
        if (context.signal.aborted) break;
        if (normalize(path) !== path || path.includes("\\")) continue;
        let root: string | null = null;
        let digest: string | undefined;
        if (path.startsWith(`${nativeRoot}${sep}`)) {
          // capture_native_media preserves the original basename under the byte digest.
          const native = path.slice(nativeRoot.length + 1).match(/^([a-f0-9]{64})\/[^/\\\x00]+\.(?:png|jpe?g|gif|webp)$/i);
          if (native) { root = nativeRoot; digest = native[1]; }
        }
        if (path.startsWith(`${imageRoot}${sep}`)) {
          const leaf = path.slice(imageRoot.length + 1);
          if (/^img_[a-f0-9]{12}\.(?:png|jpe?g|gif|webp)$/i.test(leaf)) root = imageRoot;
          const api = leaf.match(/^api_([a-f0-9]{32})\.(?:png|jpg|gif|webp)$/);
          if (api) { root = imageRoot; digest = api[1]; }
        }
        if (!root) continue;
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
