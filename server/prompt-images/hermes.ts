import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { readImageHeader } from "./image-header";
import { openSqliteReadOnly, readLocalImageReadOnly } from "./read-only";
import type { FoundImages, PromptImageResolver, ResolverContext } from "./registry";

const MAX_IMAGES_PER_MESSAGE = 16;
const BLOCK_START = "[The user sent an image~ Here's what I can see: ";
const BLOCK_END = " ~]";
const empty = (matchedMessages = 0): FoundImages => ({ matchedMessages, images: [] });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
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

/** Annotations must form a leading sequence; an incomplete/changed block fails closed. */
function annotations(content: string): { text: string; paths: string[] } | null {
  let rest = content.trimStart();
  const paths: string[] = [];
  while (rest.startsWith("[The user sent an image")) {
    if (!rest.startsWith(BLOCK_START)) return null;
    const end = rest.indexOf(BLOCK_END, BLOCK_START.length);
    if (end === -1) return null;
    const body = rest.slice(BLOCK_START.length, end);
    if (body.includes("[The user sent an image")) return null;
    const path = body.match(/(?:^|\s)(\/\S+)$/)?.[1];
    if (!path) return null;
    paths.push(path);
    rest = rest.slice(end + BLOCK_END.length).trimStart();
  }
  return { text: rest.trim(), paths };
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
        const config = record(JSON.parse(await readFile(join(paseoHome, "config.json"), "utf8")));
        const providers = record(record(config?.agents)?.providers);
        if (providers && Object.hasOwn(providers, context.provider)) provider = record(providers[context.provider]);
      } catch { /* Missing or malformed config cannot supply launch hints. */ }
    }
    const selected = profile(context.providerCommand ?? provider?.command);
    if (!selected) return null;
    const env = context.providerEnv ?? record(provider?.env);
    const override = env?.HERMES_HOME;
    if (override !== undefined) {
      if (typeof override !== "string" || !override) return null;
      const home = override.startsWith("~/") ? join(userHome, override.slice(2)) : override;
      return isAbsolute(home) && !home.split(/[\\/]/).includes("..") ? home : null;
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
      let match: { matchedMessages: number; content: unknown } | null;
      try {
        match = await openSqliteReadOnly(join(home, "state.db"), database => {
          // Keep the scan synchronous and retry-local so the helper can validate
          // an immutable read and discard it before retrying on the plain path.
          let idMatches = 0, textMatches = 0;
          let idContent: unknown, textContent: unknown;
          if (!database.prepare("SELECT id FROM sessions WHERE id = ?").get(context.sessionId)) return null;
          const rows = database.prepare("SELECT content, platform_message_id, message_uid FROM messages WHERE session_id = ? AND role = 'user'");
          for (const row of rows.iterate(context.sessionId)) {
            if (context.signal.aborted) return null;
            if ([messageId(row.platform_message_id), messageId(row.message_uid)].some(id => id !== null && ids.has(id))) {
              idMatches++;
              idContent = row.content;
            }
            if (typeof row.content !== "string") continue;
            const stripped = annotations(row.content);
            if (context.text.trim() === row.content.trim() || (stripped && context.text.trim() === stripped.text)) {
              textMatches++;
              textContent = row.content;
            }
          }
          return { matchedMessages: idMatches || textMatches, content: idMatches ? idContent : textContent };
        });
      } catch { return empty(); }
      await setImmediate();
      if (!match) return empty();
      const { matchedMessages, content } = match;
      if (matchedMessages !== 1 || typeof content !== "string" || context.signal.aborted) return empty(matchedMessages);
      const parsed = annotations(content);
      if (!parsed) return empty(1);
      const images: FoundImages["images"] = [];
      const nativeRoot = join(home, "cache", "documents", "native-inputs");
      const imageRoot = join(home, "cache", "images");
      for (const [index, path] of parsed.paths.entries()) {
        if (images.length === MAX_IMAGES_PER_MESSAGE || context.signal.aborted) break;
        let root: string | null = null;
        if (path.startsWith(`${nativeRoot}${sep}`) && /^[a-f0-9]{64}\/img_[a-f0-9]{12}\.png$/i.test(path.slice(nativeRoot.length + 1))) root = nativeRoot;
        if (path.startsWith(`${imageRoot}${sep}`) && /^img_[a-f0-9]{12}\.(jpg|png)$/i.test(path.slice(imageRoot.length + 1))) root = imageRoot;
        if (!root) continue;
        const bytes = await readLocalImageReadOnly(path, [root]);
        if (!bytes) continue;
        const header = readImageHeader(bytes);
        if (!header || !["image/png", "image/jpeg"].includes(header.mime) ||
            header.width < 1 || header.height < 1 || header.width * header.height > 24_000_000) continue;
        // Revalidate through O_NOFOLLOW on every RPC read, including after cache cleanup.
        images.push({ id: `hermes-${index}`, mime: header.mime, async readBytes() {
          const current = await readLocalImageReadOnly(path, [root]);
          if (!current) throw new Error("invalid_image");
          return current;
        } });
      }
      return { matchedMessages: 1, images };
    },
  };
}

export const hermesPromptImageResolver = createHermesPromptImageResolver();
