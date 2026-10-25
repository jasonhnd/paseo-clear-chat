import React from "react";
import { createRoot } from "react-dom/client";
import { PluginTranslationProvider, PluginTranslationRuntime } from "./shims/plugin-client";
import { embedFonts } from "../client/components/embed-fonts";
import { installFrostedGlass } from "../client/components/frosted";
import { installCompactToolSpacing } from "../client/tool-row-spacing";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { Demo } from "./demo";
import { DEFAULT_PREFERENCES } from "../client/preferences";

const params = new URLSearchParams(location.search);
const colors = params.get("theme") === "dark" ? {
  surface0: "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
  foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11",
  statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
} : {
  surface0: "#f8fafc", surface1: "#ffffff", surface2: "#edf0f5", border: "#d5dbe5",
  foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff",
  statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642",
};
embedFonts();
installFrostedGlass();
installCompactToolSpacing();
document.documentElement.style.background = colors.surface0;
document.body.style.background = colors.surface0;
document.documentElement.style.overflow = "hidden";
document.getElementById("root")!.style.display = "block";
const translations = new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} });
const textScale = Number(params.get("textScale") || 1);
createRoot(document.getElementById("root")!).render(<PluginTranslationProvider runtime={translations}><Demo tokens={buildThemeTokens(colors, { ...DEFAULT_PREFERENCES, textScale })} animate={params.has("animate")} /></PluginTranslationProvider>);
