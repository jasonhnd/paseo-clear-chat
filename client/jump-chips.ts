export const JUMP_CHIPS_MIN_LENGTH = 1200;
export const JUMP_CHIPS_MIN_ANCHORS = 2;
export const JUMP_CHIPS_MAX = 8;
export const JUMP_CHIPS_LABEL_MAX = 24;

export type JumpChip = { index: number; label: string };

const RULE = /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,})[ \t]*$/;

/** Source lines counted by the chip builder, including anchors with empty labels. */
export function jumpHeadingLines(text: string): { line: number; index: number; heading: string }[] {
  const headings: { line: number; index: number; heading: string }[] = [];
  let inFence = false;
  let inList = false;
  let blankInList = false;
  let inTable = false;
  // A bold line is an anchor only when it starts its own paragraph: the previous line is empty
  // or ended a block, or the line is the first line of the text. The reader joins consecutive
  // ordinary lines into one paragraph, so a bold line inside a paragraph has no block of its own.
  let startsBlock = true;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, lineNumber) => {
    if (/^ {0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      inList = false;
      inTable = false;
      startsBlock = true;
      return;
    }
    if (inFence) {
      startsBlock = true;
      return;
    }
    if (inTable && line.includes("|")) {
      startsBlock = true;
      return;
    }
    inTable = false;
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    const startsParagraph = startsBlock;
    if (heading) {
      inList = false;
      inTable = false;
      startsBlock = true;
    } else {
      if (line.trim() === "") {
        if (inList) blankInList = true;
        inTable = false;
        startsBlock = true;
        return;
      }
      if (RULE.test(line)) {
        inList = false;
        blankInList = false;
        inTable = false;
        startsBlock = true;
        return;
      }
      if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line)) {
        inList = true;
        blankInList = false;
        startsBlock = true;
        return;
      }
      if (inList) {
        const endsList = /^ {0,3}(?:#{1,6}[ \t]+|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/.test(line) ||
          (blankInList && /^ {0,3}>/.test(line));
        const indented = /^(?: {2}|[ \t]*\t)/.test(line);
        if (!endsList && (!blankInList || indented)) {
          startsBlock = false;
          return;
        }
        inList = false;
        blankInList = false;
      }
      const next = lines[lineNumber + 1] ?? "";
      if (line.includes("|") && next.includes("|") &&
          /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(next)) {
        inTable = true;
      }
      if (inTable || /^ {0,3}>/.test(line)) {
        startsBlock = true;
        return;
      }
      startsBlock = false;
    }
    const bold = heading ? null : /^[ \t]*(\*\*|__)(.+)\1$/.exec(line);
    if (!heading && (!bold || !/\S/.test(bold[2] ?? "") || /\*\*|__/.test(bold[2] ?? ""))) return;
    if (!heading && !startsParagraph) return;
    const source = heading ? (heading[2] ?? "").replace(/#+\s*$/, "") : (bold?.[2] ?? "");
    const cleaned = source
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    headings.push({ line: lineNumber, index: headings.length, heading: cleaned });
  });
  return headings;
}

export function buildJumpChips(text: string): JumpChip[] {
  if (Array.from(text).length < JUMP_CHIPS_MIN_LENGTH) return [];
  const headings = jumpHeadingLines(text);
  if (headings.length < JUMP_CHIPS_MIN_ANCHORS) return [];
  return headings.slice(0, JUMP_CHIPS_MAX).flatMap(({ index, heading }) => {
    const characters = Array.from(heading);
    if (characters.length === 0) return [];
    const label = characters.length > JUMP_CHIPS_LABEL_MAX
      ? characters.slice(0, JUMP_CHIPS_LABEL_MAX).join("") + "…"
      : heading;
    return [{ index, label }];
  });
}
