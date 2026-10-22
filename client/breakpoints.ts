export const PHONE_MAX = 743;
export const TABLET_MIN = 744;
export const DESKTOP_MIN = 1024;

export type StepDetailPresentation = "sheet" | "popover" | "side";

export function stepDetailPresentation(width: number): StepDetailPresentation {
  if (width < TABLET_MIN) return "sheet";
  if (width < DESKTOP_MIN) return "popover";
  return "side";
}
