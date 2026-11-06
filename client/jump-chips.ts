export const JUMP_CHIPS_MIN_LENGTH = 3000;
export const JUMP_CHIPS_MAX = 8;
export const JUMP_CHIPS_LABEL_MAX = 24;

export type JumpChip = { index: number; label: string };

export function buildJumpChips(text: string): JumpChip[] {
  if (Array.from(text).length < JUMP_CHIPS_MIN_LENGTH) return [];

  const chips: JumpChip[] = [];
  let headingCount = 0;
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (!heading) continue;

    const index = headingCount++;
    if (index >= JUMP_CHIPS_MAX) continue;

    const cleaned = (heading[2] ?? "")
      .replace(/#+\s*$/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    const characters = Array.from(cleaned);
    if (characters.length === 0) continue;
    const label = characters.length > JUMP_CHIPS_LABEL_MAX
      ? characters.slice(0, JUMP_CHIPS_LABEL_MAX).join("") + "…"
      : cleaned;
    chips.push({ index, label });
  }

  return headingCount >= 3 ? chips : [];
}
