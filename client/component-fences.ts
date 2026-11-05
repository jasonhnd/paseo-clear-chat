// Component fences belong to plugins that render them, rather than Markdown.
export function containsComponentFence(text: string): boolean {
  let openFence: { marker: string; length: number } | undefined;

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (openFence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]!.charAt(0) === openFence.marker && closing[1]!.length >= openFence.length) {
        openFence = undefined;
      }
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opening) continue;
    const language = (opening[2]!.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
    if (language === "ui" || language === "app") return true;
    openFence = { marker: opening[1]!.charAt(0), length: opening[1]!.length };
  }
  return false;
}
