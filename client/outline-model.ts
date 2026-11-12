import type { PaseoApi } from "@getpaseo/client";
import type { AgentRef } from "@getpaseo/plugin/client";
const JUMP_CHIPS_MIN_LENGTH = 1200; // Matches client/jump-chips.ts.

type Heading = { text: string; level: number; offset: number };
type Outline = { version: 1; replyId: string; at: string; headings: Heading[]; updatedAt: string };
type Entry = { item: { type: string; text?: string; id?: string }; at: string };
const MAX_HEADINGS = 64;
const MAX_TEXT = 160;
const MAX_ID = 512;

export function extractHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const part of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!part) continue;
    const line = part.replace(/\r?\n$/, "");
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opening && opening[1]![0] === fence.char && opening[1]!.length >= fence.length && new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
    } else if (opening) {
      fence = { char: opening[1]![0]!, length: opening[1]!.length };
    } else {
      const match = /^ {0,3}(#{1,3})(?:[ \t]+|$)(.*)$/.exec(line);
      if (match) {
        const title = (match[2] ?? "").replace(/(?:^|\s)#+\s*$/, "").trim();
        if (title && headings.length < MAX_HEADINGS) headings.push({ text: Array.from(title).slice(0, MAX_TEXT).join(""), level: match[1]!.length, offset: offset + line.indexOf("#") });
      }
    }
    offset += part.length;
  }
  return headings;
}

export function outlineFromEntries(entries: readonly Entry[], updatedAt: string): Outline | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const item = entry.item;
    if (item.type !== "assistant_message" || typeof item.text !== "string" || Array.from(item.text).length < JUMP_CHIPS_MIN_LENGTH) continue;
    if (typeof item.id !== "string" || !item.id || item.id.length > MAX_ID || typeof entry.at !== "string" || entry.at.length > MAX_ID || updatedAt.length > MAX_ID) return null;
    return { version: 1, replyId: item.id, at: entry.at, headings: extractHeadings(item.text), updatedAt };
  }
  return null;
}

export function parseOutline(value: unknown): Outline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(key => !["version", "replyId", "at", "headings", "updatedAt"].includes(key))) return null;
  if (o.version !== 1 || typeof o.replyId !== "string" || !o.replyId || o.replyId.length > MAX_ID || typeof o.at !== "string" || o.at.length > MAX_ID || typeof o.updatedAt !== "string" || o.updatedAt.length > MAX_ID || !Array.isArray(o.headings) || o.headings.length > MAX_HEADINGS) return null;
  const headings: Heading[] = [];
  for (const raw of o.headings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const h = raw as Record<string, unknown>;
    if (Object.keys(h).some(key => !["text", "level", "offset"].includes(key))) return null;
    if (typeof h.text !== "string" || !h.text.trim() || Array.from(h.text).length > MAX_TEXT || typeof h.level !== "number" || !Number.isInteger(h.level) || h.level < 1 || h.level > 3 || typeof h.offset !== "number" || !Number.isSafeInteger(h.offset) || h.offset < 0) return null;
    headings.push({ text: h.text, level: h.level, offset: h.offset });
  }
  return { version: 1, replyId: o.replyId, at: o.at, updatedAt: o.updatedAt, headings };
}

export async function syncOutline(hosts: readonly { serverId: string }[], agent: AgentRef, getClient: (serverId: string) => PaseoApi, now = () => new Date().toISOString(), isCurrent = () => true): Promise<Outline | null> {
  const serverId = hosts.find(h => h.serverId === agent.hostId)?.serverId;
  if (!serverId) return null;
  const handle = getClient(serverId).agents.ref(agent.id);
  await handle.refresh();
  let page = await handle.timeline.refetch();
  let marker: Outline | null = null;
  for (;;) {
    if (page.error || page.gap || page.staleCursor) throw new Error("Unable to read agent timeline");
    const entries: Entry[] = page.entries.map(entry => ({ at: entry.timestamp, item: entry.item.type === "assistant_message" ? { type: entry.item.type, text: entry.item.text, id: entry.item.messageId ?? `${page.epoch}:${entry.seqStart}` } : { type: entry.item.type } }));
    marker = outlineFromEntries(entries, now());
    if (marker || !page.hasOlder || !page.startCursor) break;
    const previous = page.startCursor;
    page = await handle.timeline.refetch({ direction: "before", cursor: previous });
    if (page.startCursor && page.startCursor.epoch === previous.epoch && page.startCursor.seq >= previous.seq) throw new Error("Timeline cursor did not advance");
  }
  const current = parseOutline(handle.metadata?.clearChatOutline);
  const content = (value: Outline | null) => value && JSON.stringify([value.replyId, value.at, value.headings]);
  if (isCurrent() && content(current) !== content(marker)) await handle.setMetadata({ clearChatOutline: marker });
  return marker;
}
