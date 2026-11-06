export const JUMP_CHIPS_MIN_LENGTH = 3000;
export const JUMP_CHIPS_MAX = 8;
export const JUMP_CHIPS_LABEL_MAX = 24;

export type JumpChip = { index: number; label: string };

/** Source lines counted by the chip builder, including headings with empty labels. */
export function jumpHeadingLines(text: string): { line: number; index: number; heading: string }[] {
  const headings: { line: number; index: number; heading: string }[] = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, lineNumber) => {
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (!heading) return;
    const cleaned = (heading[2] ?? "")
      .replace(/#+\s*$/, "")
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
  if (headings.length < 3) return [];
  return headings.slice(0, JUMP_CHIPS_MAX).flatMap(({ index, heading }) => {
    const characters = Array.from(heading);
    if (characters.length === 0) return [];
    const label = characters.length > JUMP_CHIPS_LABEL_MAX
      ? characters.slice(0, JUMP_CHIPS_LABEL_MAX).join("") + "…"
      : heading;
    return [{ index, label }];
  });
}
