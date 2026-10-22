import type { CodeFontFamilyPreference, CodeFontPreference } from "../preferences";

export const fontMono = "OMP Iosevka";
export const fontCode = "OMP Iosevka Code";

export const CODE_FONT_OPTIONS: ReadonlyArray<{ value: CodeFontFamilyPreference; label: string }> = [
  { value: "host", label: "Default (Iosevka)" },
  { value: "iosevka", label: "Iosevka" },
  { value: "menlo", label: "Menlo" },
  { value: "consolas", label: "Consolas" },
  { value: "fira-code", label: "Fira Code" },
  { value: "cascadia-code", label: "Cascadia Code" },
];

export const LOCAL_CODE_FONTS = {
  menlo: "Menlo",
  consolas: "Consolas",
  "fira-code": "Fira Code",
  "cascadia-code": "Cascadia Code",
} as const;

export function codeFontAlias(family: keyof typeof LOCAL_CODE_FONTS): string {
  return `Clear Chat ${family}`;
}

/** One family per React Native style; web fallbacks are registered by embedFonts. */
export function resolveCodeFonts(
  preferences: { codeFont: CodeFontPreference; codeFontFamily?: CodeFontFamilyPreference },
  platform: string,
): { mono: string; code: string } {
  // Directory plugins cannot register native font assets through the plugin SDK
  // (checked through 0.12.0).
  if (platform !== "web") {
    const family = platform === "ios" ? "Menlo" : "monospace";
    return { mono: family, code: family };
  }
  const family = preferences.codeFontFamily ?? "host";
  if (family !== "host" && family !== "iosevka") {
    const resolved = codeFontAlias(family);
    return { mono: resolved, code: resolved };
  }
  // The plugin SDK exposes no host code-font preference.
  // Default (Iosevka) keeps the existing Iosevka glyph choice.
  return { mono: fontMono, code: preferences.codeFont === "plain" ? fontMono : fontCode };
}
