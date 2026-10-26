import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readImageHeader } from "./image-header";
import { openSqliteReadOnly, readLocalImageReadOnly } from "./read-only";
import type { FoundImages, PromptImageResolver, ResolverContext } from "./registry";

/** The incoming ACP prompt id is persisted here by Hermes. */
export const HERMES_ORIGIN_ID_PATH = "paseo.clientMessageId";
const NATIVE_HINT = "[Image attached at: ";
const VISION_START = "[The user sent an image~ Here's what I can see:\n";
const VISION_PATH = "]\n[If you need a closer look, use vision_analyze with image_url: ";
const VISION_END = " ~]";
const IMAGE_MARKER = /\[(?:Image attached|The user sent an image|If you need a closer look|Image omitted|screenshot)/gi;
const empty = (): FoundImages => ({ matchedMessages: 0, images: [] });

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function hermesHome(context: ResolverContext): string | null {
  const override = context.providerEnv?.HERMES_HOME ?? process.env.HERMES_HOME;
  if (override === undefined) {
    const selected = context.providerCommand ? profile(context.providerCommand) : "";
    if (selected === null) return null;
    return selected ? join(homedir(), ".hermes", "profiles", selected) : join(homedir(), ".hermes");
  }
  if (!override || override.split(/[\\/]/).includes("..")) return null;
  const home = override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
  return isAbsolute(home) ? normalize(home) : null;
}

/** Recognize the documented CLI forms without invoking a shell. */
function profile(command?: readonly string[]): string | null {
  const executable = command?.[0];
  if (executable !== "hermes" && !(executable && isAbsolute(executable) && executable.endsWith(`${sep}hermes`))) return null;
  if (command?.length === 2 && command[1] === "acp") return "";
  const name = command?.[2];
  return command?.length === 4 && command[1] === "-p" && command[3] === "acp" &&
    name && /^[a-z0-9_-][a-z0-9_.-]*$/i.test(name) ? name : null;
}

function sessionId(value: string | null): string | null {
  if (!value) return null;
  try { return decodeURIComponent(value) || null; }
  catch { return null; }
}

function digestOf(path: string, root: string): string | null {
  if (!isAbsolute(path) || normalize(path) !== path || path.split(/[\\/]/).includes("..") ||
      !path.startsWith(`${root}${sep}`)) return null;
  const relative = path.slice(root.length + 1);
  // Only one leaf under a full content digest, with no partially parsed names.
  return /^([a-f0-9]{64})\/[A-Za-z0-9._-]+$/i.exec(relative)?.[1]?.toLowerCase() ?? null;
}

/** Every recognized marker must be consumed completely, including its closer. */
function imagePaths(content: unknown, root: string): string[] | null {
  if (typeof content !== "string" || content.startsWith("\0json:")) return null;
  if (/could(?:n['’]t| not) quite see|something went wrong/i.test(content)) return null;
  const paths: string[] = [];
  let screenshots = 0, nativeHints = 0, visionNotes = 0;
  // Use a lookup-local regex: simultaneous lookups cannot share lastIndex.
  const markers = new RegExp(IMAGE_MARKER);
  let marker: RegExpExecArray | null;
  while ((marker = markers.exec(content))) {
    const at = marker.index;
    if (content.startsWith(NATIVE_HINT, at)) {
      const end = content.indexOf("]", at + NATIVE_HINT.length);
      if (end < 0 || (end + 1 < content.length && content[end + 1] !== "\n")) return null;
      // Native hints follow the caption. A name split by a closer/newline must
      // not lend a valid prefix path to the message.
      const rest = content.slice(end + 1).trimStart();
      if (rest && !new RegExp(`^(?:${IMAGE_MARKER.source})`, "i").test(rest)) return null;
      const path = content.slice(at + NATIVE_HINT.length, end);
      if (!digestOf(path, root)) return null;
      paths.push(path);
      nativeHints++;
      markers.lastIndex = end + 1;
    } else if (content.startsWith(VISION_START, at)) {
      const pathAt = content.indexOf(VISION_PATH, at + VISION_START.length);
      if (pathAt < 0) return null;
      const description = content.slice(at + VISION_START.length, pathAt);
      if (new RegExp(IMAGE_MARKER).test(description)) return null;
      const end = content.indexOf(VISION_END, pathAt + VISION_PATH.length);
      if (end < 0) return null;
      const after = end + VISION_END.length;
      if (after < content.length && content[after] !== "\n") return null;
      const path = content.slice(pathAt + VISION_PATH.length, end);
      if (!digestOf(path, root)) return null;
      paths.push(path);
      visionNotes++;
      markers.lastIndex = end + VISION_END.length;
    } else {
      // Hermes can also persist a screenshot placeholder for each native hint.
      const screenshot = /^\[screenshot(?: detail=(?:low|high|auto))?\](?=\r?\n|$)/.exec(content.slice(at));
      if (!screenshot) return null; // Includes all failure and omission variants.
      screenshots++;
      markers.lastIndex = at + screenshot[0].length;
    }
  }
  if (screenshots && screenshots !== nativeHints) return null;
  if (content.split(VISION_END).length - 1 !== visionNotes) return null;
  return [...new Set(paths)].sort();
}

function absorbed(raw: unknown): boolean {
  if (raw === null || raw === "") return false;
  if (typeof raw !== "string") return true;
  try {
    const value: unknown = JSON.parse(raw);
    return !Array.isArray(value) || value.length !== 0;
  } catch { return true; }
}

async function find(context: ResolverContext): Promise<FoundImages> {
  const ids = new Set([context.messageId, context.clientMessageId]
    .filter((id): id is string => typeof id === "string" && id.length > 0));
  const sessions = [...new Set([sessionId(context.sessionId), sessionId(context.nativeHandle)]
    .filter((id): id is string => id !== null))];
  if (!ids.size || !sessions.length || context.signal.aborted) return empty();
  const home = hermesHome(context);
  if (!home) return empty();
  const root = join(home, "cache", "documents", "native-inputs");
  let paths: string[] | null;
  try {
    paths = await openSqliteReadOnly(join(home, "state.db"), database => {
      // A read transaction keeps scope and rows in the same snapshot with a live writer.
      database.exec("BEGIN");
      const resolved = sessions.filter(id => database.prepare("SELECT id FROM sessions WHERE id = ?").get(id));
      if (!resolved.length) return null;
      // Walk both directions: the persisted ACP id can name a pre-compaction head.
      const lineage = database.prepare(`WITH RECURSIVE lineage(id) AS (
        SELECT id FROM sessions WHERE id = ?
        UNION SELECT p.id FROM sessions s JOIN lineage l ON s.id = l.id
          JOIN sessions p ON p.id = s.parent_session_id
        UNION SELECT s.id FROM sessions s JOIN lineage l ON s.parent_session_id = l.id
      ) SELECT id FROM lineage`).all(resolved[0]!);
      const scope = new Set(lineage.map(row => row.id));
      if (resolved.some(id => !scope.has(id))) return null;
      // Missing visibility, origin, lineage or compaction columns fail closed.
      const rows = database.prepare(`SELECT content, display_metadata, message_uid, absorbed_message_uids
        FROM messages WHERE session_id IN (${lineage.map(() => "?").join(",")})
        AND role = 'user' AND (active = 1 OR compacted = 1)`).all(...lineage.map(row => row.id!));
      const displayed = [];
      const matches = new Set<string>();
      for (const row of rows) {
        context.signal.throwIfAborted();
        let metadata: Record<string, unknown> | null = null;
        if (row.display_metadata !== null) {
          if (typeof row.display_metadata !== "string") return null;
          metadata = record(JSON.parse(row.display_metadata));
          if (!metadata) return null;
        }
        if (metadata?.model_only === true) continue;
        displayed.push(row);
        let origin: unknown = metadata;
        for (const key of HERMES_ORIGIN_ID_PATH.split(".")) origin = record(origin)?.[key];
        if (typeof origin !== "string" || !ids.has(origin)) continue;
        if (typeof row.message_uid !== "string" || !row.message_uid) return null;
        matches.add(row.message_uid);
      }
      if (matches.size !== 1) return null;
      let selected: string[] | null = null;
      // Check every displayed physical copy, including copies without origin metadata.
      for (const row of displayed) {
        if (!matches.has(row.message_uid as string)) continue;
        if (absorbed(row.absorbed_message_uids)) return null;
        const current = imagePaths(row.content, root);
        if (!current || (selected && JSON.stringify(selected) !== JSON.stringify(current))) return null;
        selected = current;
      }
      return selected;
    }, { beforeOpen({ immutable, uri }) {
      if (immutable) return;
      // A plain read-only WAL connection can create missing coordination files.
      // Only join an existing live WAL; uncertain sidecar states yield no image.
      const path = fileURLToPath(uri);
      for (const suffix of ["-wal", "-shm"]) {
        if (!lstatSync(`${path}${suffix}`).isFile()) throw new Error("invalid_store");
      }
    } });
  } catch { return empty(); }
  if (!paths || context.signal.aborted) return empty();
  const images: FoundImages["images"] = [];
  for (const [index, path] of paths.entries()) {
    if (context.signal.aborted) return empty();
    const digest = digestOf(path, root)!;
    const read = async () => {
      const bytes = await readLocalImageReadOnly(path, [root]);
      return bytes && createHash("sha256").update(bytes).digest("hex") === digest ? bytes : null;
    };
    const bytes = await read();
    if (!bytes) continue;
    const header = readImageHeader(bytes);
    if (!header) continue;
    images.push({ id: `hermes-${index}`, mime: header.mime, async readBytes() {
      const current = await read();
      if (!current) throw new Error("invalid_image");
      return current;
    } });
  }
  return context.signal.aborted ? empty() : { matchedMessages: 1, images };
}

export const hermesPromptImageResolver: PromptImageResolver = {
  matches: (provider, command) => /^hermes(?:-[a-z0-9_-]+)?$/i.test(provider) &&
    profile(command) !== null,
  find,
};
