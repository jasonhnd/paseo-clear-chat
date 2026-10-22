import { EMBEDDED_FONTS } from "./font-data";
import { fontMono, fontUi } from "./theme-tokens";
import { errorText } from "../error-text";
import { LOCAL_CODE_FONTS, codeFontAlias } from "./code-fonts";

const STYLE_ELEMENT_ID = "clear-chat-fonts";

/**
 * Host faces to try if the embedded bytes ever fail to decode. These belong in
 * the `src` chain rather than in `fontFamily`, because a comma-separated
 * family list is not a valid React Native style value.
 */
const LOCAL_FALLBACKS: Record<string, readonly string[]> = {
  "OMP Iosevka": ["Iosevka", "Cascadia Code", "Consolas", "Menlo"],
  "OMP Iosevka Code": ["Iosevka", "Cascadia Code", "Fira Code", "Consolas"],
  "OMP Inter": ["Inter", "Segoe UI", "Roboto", "Helvetica Neue"],
};
/**
 * Installs the bundled Inter and Iosevka faces.
 *
 * The plugin sandbox exposes no font loader, so on web and Electron the faces
 * are declared with `@font-face` against embedded woff2 data and the browser
 * takes it from there. React Native has no `document`, so on iOS and Android
 * this is a no-op and code tokens use platform monospace —
 * embedding native assets needs a build step a directory plugin does not have.
 *
 * Injection is idempotent: a second client mounting reuses the existing style
 * element rather than parsing 75 KB of font data again.
 */
export function embedFonts(): () => void {
  if (typeof document === "undefined") return () => {};
  if (document.getElementById(STYLE_ELEMENT_ID)) return () => {};

  const aliases = Object.entries(LOCAL_CODE_FONTS).flatMap(([id, local]) =>
    EMBEDDED_FONTS.filter(face => face.family === fontMono).map(face => ({
      ...face, family: codeFontAlias(id as keyof typeof LOCAL_CODE_FONTS), local,
    })),
  );
  const rules = [...EMBEDDED_FONTS, ...aliases].map((face) => {
    const { family, weight, woff2Base64 } = face;
    const sources = [
      // Prefer the installed face; the bundled literal Iosevka cut guarantees
      // monospace if a named font is absent, including on another device.
      ...("local" in face ? [`local("${face.local}")`] : []),
      `url(data:font/woff2;base64,${woff2Base64}) format("woff2")`,
      ...(LOCAL_FALLBACKS[family] ?? []).map((name) => `local("${name}")`),
    ].join(",\n    ");
    return `@font-face {
  font-family: "${family}";
  font-style: normal;
  font-weight: ${weight};
  font-display: block;
  src: ${sources};
}`;
  }).join("\n");

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = rules;
  document.head.appendChild(style);

  return () => {
    style.remove();
  };
}

/**
 * Measures whether a family renders with a uniform advance. This is the only
 * check that proves a face is actually in use: `FontFaceSet.check` reports
 * load state, so it answers false for any face nothing has painted yet.
 */
function advanceWidths(family: string): number[] | null {
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return null;
    context.font = `14px "${family}"`;
    return [..."iWM1l.@#"].map((character) => context.measureText(character).width);
  } catch {
    return null;
  }
}

/**
 * Loads the embedded faces and reports what happened, in one line fit for the
 * surface header. Written as a probe rather than a boolean because the useful
 * information is *why* a face did not resolve: a missing style element, a
 * rejected `data:` URL, or a face that loads but is never applied.
 */
export async function probeFonts(): Promise<string> {
  if (typeof document === "undefined") return "Fonts: native, system default";
  if (!document.getElementById(STYLE_ELEMENT_ID)) {
    return "Fonts: style element missing — embedFonts did not run";
  }

  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return "Fonts: FontFaceSet unavailable on this host";

  const parts: string[] = [];
  for (const family of [fontUi, fontMono]) {
    try {
      const faces = await fonts.load(`400 14px "${family}"`);
      parts.push(`${family}: ${faces.length > 0 ? "loaded" : "no match"}`);
    } catch (error) {
      const message = errorText(error) ?? "Font could not be loaded.";
      parts.push(`${family}: ${message.slice(0, 48)}`);
    }
  }

  const widths = advanceWidths(fontMono);
  if (widths) {
    const uniform = new Set(widths.map((w) => w.toFixed(2))).size === 1;
    const firstWidth = widths[0] ?? 0;
    parts.push(`mono ${uniform ? "uniform" : "proportional"} @${firstWidth.toFixed(2)}px`);
  }

  // The host forces its own font over every plugin class, so report whether
  // that rule is live. Without the data-pmono escape it wins regardless of
  // what loaded.
  const hostRule = document.getElementById("paseo-ui-font") !== null;
  parts.push(`host rule ${hostRule ? "present" : "absent"}`);

  return `Fonts: ${parts.join(" · ")}`;
}
