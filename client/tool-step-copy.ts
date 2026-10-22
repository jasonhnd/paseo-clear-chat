/** Strings remain verbatim; text blocks keep every block and its whitespace. */
export function stepResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  const blocks = Array.isArray(value) ? value : (value as { content?: unknown }).content;
  if (Array.isArray(blocks) && blocks.length > 0 && blocks.every(block =>
    block && typeof block === "object" && block.type === "text" && typeof block.text === "string")) {
    // Preserve additional structured result fields instead of dropping them.
    if (Array.isArray(value) || Object.keys(value).every(key => key === "content")) {
      return blocks.map(block => block.text).join("\n");
    }
  }
  return JSON.stringify(value, null, 2);
}
