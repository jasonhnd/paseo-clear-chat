import type { CodeFontFamilyPreference, CodeFontPreference } from "../preferences";

/**
 * Code and inline code share this stack on web. The bundled faces left with the
 * font sheet, and a family nothing registers falls back to the browser's
 * default serif, which makes code read as prose. These are faces the host
 * machine already has.
 */
export const CODE_FONT_WEB =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

/**
 * One family per React Native style: a native `fontFamily` names one installed
 * face, never a CSS stack. Each platform picks a monospace face it ships with;
 * any other platform gets no family and keeps its own default instead of naming
 * something that is not installed.
 */
export function nativeCodeFont(platform: string): string | undefined {
  if (platform === "ios") return "Menlo";
  if (platform === "android") return "monospace";
  return undefined;
}

/**
 * `codeFont` and `codeFontFamily` are still parsed from stored settings so older
 * files keep loading, but with one stack behind them they no longer choose a
 * face: the keys are accepted and ignored.
 */
export function resolveCodeFonts(
  _preferences: { codeFont: CodeFontPreference; codeFontFamily?: CodeFontFamilyPreference },
  platform: string,
): { mono: string | undefined; code: string | undefined } {
  // Directory plugins cannot register native font assets through the plugin SDK
  // (checked on 0.12.0; not re-verified on 0.13.0).
  const family = platform === "web" ? CODE_FONT_WEB : nativeCodeFont(platform);
  return { mono: family, code: family };
}
