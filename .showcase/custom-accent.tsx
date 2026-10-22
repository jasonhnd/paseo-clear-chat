/** Offline interaction replay; never connects to a Paseo host. */
import React from "react";
import { createRoot } from "react-dom/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ClearChatSettingsPage } from "../client/settings-page";
import { initializeEnhancerPreferences, useEnhancerPreferences } from "../client/preferences";
import { presentationSettings } from "../shared/settings";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { MarkdownView } from "../client/components/markdown/markdown-view";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
const colors = dark ? {
  surface0: "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
  foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11",
  statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
} : {
  surface0: "#f8fafc", surface1: "#ffffff", surface2: "#edf0f5", border: "#d5dbe5",
  foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff",
  statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642",
};

async function start() {
  await initializeEnhancerPreferences(async (contract, input) => {
    const saved = JSON.parse(localStorage.getItem("accent-replay") ?? '{"preferences":{},"legacyMigrated":true}');
    if (contract.name.endsWith(".read")) return { status: "ready", revision: "1", values: saved } as never;
    const values = presentationSettings.schema.parse((input as { values: unknown }).values);
    localStorage.setItem("accent-replay", JSON.stringify(values));
    return { status: "saved", revision: "1", values } as never;
  });
  document.body.style.background = colors.surface0;
  createRoot(document.getElementById("root")!).render(<Replay />);
}

function Replay() {
  const preferences = useEnhancerPreferences();
  const tokens = buildThemeTokens(colors, preferences);
  return <>
    <div id="accent-preview" data-accent={tokens.accent} style={{ padding: 16, background: colors.surface0 }}>
      <MarkdownView text="[Sample link](https://example.com)" tokens={tokens} variant="document" />
    </div>
    <ClearChatSettingsPage {...{ theme: { colors } } as PluginSurfaceProps} />
  </>;
}

void start();
