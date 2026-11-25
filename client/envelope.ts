/**
 * The host's automation envelopes, recognized from the text of a user-side message.
 *
 * Some rows in a conversation's timeline come from the host rather than from the person
 * typing: a bracketed notification, a wrapped system tag, or a supervised-process line.
 * They are not the model's words and not the reader's words, so both the answer feed and
 * the "what I said" panel skip them.
 */

const ENVELOPE_TAGS = new Set([
  "system-notice", "system-reminder", "irc", "system-interrupt", "paseo-system", "agent-response",
]);
const PROCESS_LINE = /^Supervised process ([\w.-]+) ((?:exited|started|stopped|restarted|failed|is ready)\b.*)$/;

export function isSystemEnvelope(text: string): boolean {
  const trimmed = text.trim();
  const process = trimmed.match(PROCESS_LINE);
  if (process && !trimmed.includes("\n")) return true;
  const tag = trimmed.match(/^<([\w-]+)(?:\s[^>]*)?>/)?.[1]?.toLowerCase();
  return tag ? ENVELOPE_TAGS.has(tag) : false;
}
