import { isSystemEnvelope } from "./envelope";

/**
 * Who sent a user-side timeline row.
 *
 * A conversation's user side carries two kinds of row: what the person typed, and what
 * automation put there — bracketed envelopes, wrapped instruction tags, pasted context
 * headers. The "what I said" panel lists only the first kind, so this module decides the
 * kind from the text alone. The table is data rather than a rule so a new envelope shape
 * is one line, and so a test can pin every entry.
 *
 * Recognition is by leading text, so a message that opens with one of these strings for
 * another reason is counted as a machine message. `MACHINE_PREFIXES` stays narrow for that
 * reason: only shapes no person types at the start of a sentence are listed.
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
  /** The text a reader sees: an out-of-band body without its markers, else the trimmed text. */
  text: string;
}

/**
 * The body inside an out-of-band wrapper, or null when the text is not one.
 *
 * The wrapper is a marker line, the message, and a closing marker line. Both marker lines
 * go, and only the first and last line can be a marker: a message that quotes a marker
 * mid-body keeps it.
 */
export function outOfBandBody(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(OUT_OF_BAND_OPEN)) return null;
  const lines = trimmed.split(/\r?\n/);
  lines.shift();
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === OUT_OF_BAND_CLOSE) lines.pop();
  return lines.join("\n").trim();
}

/** Classifies a user-side row. `envelope` is the host-envelope check the answer feed uses. */
export function classifyUserMessage(text: string, envelope: boolean = isSystemEnvelope(text)): ClassifiedMessage {
  const body = outOfBandBody(text);
  if (body !== null) return { kind: "human", text: body };
  if (envelope) return { kind: "machine", text: text.trim() };
  const trimmed = text.trim();
  if (MACHINE_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return { kind: "machine", text: trimmed };
  return { kind: "human", text: trimmed };
}

/** The first `maxLines` lines of a message, and whether anything was left out. */
export function messagePreview(text: string, maxLines: number = 3): { preview: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { preview: text, truncated: false };
  return { preview: lines.slice(0, maxLines).join("\n"), truncated: true };
}
