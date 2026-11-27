import { isSystemEnvelope } from "./envelope";

/**
 * Who sent a user-side timeline row, and what a row copies.
 *
 * A conversation's user side carries two kinds of row: what the person typed, and what
 * automation put there — bracketed envelopes, wrapped instruction tags, pasted context
 * headers. The "What I said" screen lists only the first kind, so this module decides the
 * kind from the text alone. The table is data rather than a rule so a new envelope shape
 * is one line, and so a test can pin every entry.
 *
 * Recognition is by leading text, so a message that opens with one of these strings for
 * another reason is counted as a machine message. `MACHINE_PREFIXES` stays narrow for that
 * reason: only shapes no person types at the start of a sentence are listed.
 *
 * The text a row carries is the message as it was sent. Trimming is for deciding a kind and
 * for asking whether there is anything to copy; it never edits the copy.
 */
export const MACHINE_PREFIXES: readonly string[] = [
  "【",
  "[ASYNC DELEGATION",
  "[IMPORTANT",
  "[System:",
  "[T3 Code",
  "<t3_code_instructions>",
  "CONTEXT:",
  "You've reached the maximum number",
  "发件：",
];

/** A message a person inserted mid-turn. Counted as the person's own words. */
export const OUT_OF_BAND_OPEN = "[OUT-OF-BAND USER MESSAGE";
export const OUT_OF_BAND_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";

export type UserMessageKind = "human" | "machine";

export interface ClassifiedMessage {
  kind: UserMessageKind;
  /** What a row shows and copies: an unwrapped body, else the message as sent. */
  text: string;
}

/**
 * The body inside an out-of-band wrapper, or null when the text is not a complete wrapper.
 *
 * A wrapper is an opening marker line, a body, and a closing marker line, and it only counts
 * when both markers are real lines: the first line starts with the opening marker and ends
 * with `]`, and the closing marker stands alone on its own line. Anything else —
 * a sentence that mentions the marker, an opener with no closer — is not a wrapper, and the
 * whole text stays the person's own words, to read and to copy.
 *
 * The body between the markers is returned exactly as it stands, line endings included.
 * Only the line break that separates the body from the closing marker is dropped, because it
 * belongs to the wrapper's layout.
 */
export function outOfBandBody(text: string): string | null {
  if (!text.startsWith(OUT_OF_BAND_OPEN)) return null;
  const openEnd = text.indexOf("\n");
  if (openEnd < 0 || !text.slice(0, openEnd).replace(/\r$/, "").endsWith("]")) return null;
  const bodyStart = openEnd + 1;
  // Use the last standalone marker so quoted markers inside the body are preserved.
  for (let closeAt = text.lastIndexOf(OUT_OF_BAND_CLOSE); closeAt >= bodyStart;
    closeAt = text.lastIndexOf(OUT_OF_BAND_CLOSE, closeAt - 1)) {
    const end = closeAt + OUT_OF_BAND_CLOSE.length;
    if (text[closeAt - 1] !== "\n") continue;
    if (end !== text.length && text[end] !== "\n" && !text.startsWith("\r\n", end)) continue;
    const bodyEnd = closeAt === bodyStart ? bodyStart : closeAt - (text[closeAt - 2] === "\r" ? 2 : 1);
    return text.slice(bodyStart, bodyEnd);
  }
  return null;
}

/** True when there is nothing a person could read in a message (spaces and blank lines only). */
export function isEmptyMessageText(text: string): boolean {
  return text.trim().length === 0;
}

/** Classifies a user-side row. `envelope` is the host-envelope check the answer feed uses. */
export function classifyUserMessage(text: string, envelope: boolean = isSystemEnvelope(text)): ClassifiedMessage {
  const body = outOfBandBody(text);
  if (body !== null) return { kind: "human", text: body };
  if (envelope) return { kind: "machine", text };
  const trimmed = text.trim();
  if (MACHINE_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return { kind: "machine", text };
  return { kind: "human", text };
}

/** The first `maxLines` lines of a message, and whether anything was left out. */
export function messagePreview(text: string, maxLines: number = 3): { preview: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { preview: text, truncated: false };
  return { preview: lines.slice(0, maxLines).join("\n"), truncated: true };
}
