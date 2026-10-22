import React from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { MarkdownView, type MarkdownVariant } from "../client/components/markdown/markdown-view";
import { AssistantFooter } from "../client/components/turn-footer";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { embedFonts } from "../client/components/embed-fonts";

const { replyLinkCases } = require("../test/helpers/reply-link-cases.cjs") as {
  replyLinkCases: Array<{ item: { text: string; messageId: string } }>;
};
const query = new URLSearchParams(location.search);
const dark = query.get("theme") === "dark";
const variant = (query.get("variant") ?? "document") as MarkdownVariant;
const tokens = buildThemeTokens({
  surface0: dark ? "#0f0f11" : "#f8fafc", surface1: dark ? "#17171a" : "#ffffff",
  surface2: dark ? "#1f1f23" : "#edf0f5", border: dark ? "#2a2a30" : "#d5dbe5",
  foreground: dark ? "#f2f3f5" : "#18202d", foregroundMuted: dark ? "#a3a6ad" : "#586579",
  accent: dark ? "#7aa2f7" : "#315fba", accentForeground: dark ? "#0f0f11" : "#ffffff",
  statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642",
});

embedFonts();
document.body.style.margin = "0";
document.body.style.background = tokens.surface0;
createRoot(document.getElementById("root")!).render(
  <View style={{ padding: 16, gap: 16 }}>
    {replyLinkCases.map(({ item }) => (
      <View key={item.messageId} testID={item.messageId} style={{ minWidth: 0 }}>
        <MarkdownView text={item.text} tokens={tokens} variant={variant} />
        <AssistantFooter text={item.text} at={new Date("2026-01-01T12:00:00Z")} tokens={tokens} />
      </View>
    ))}
  </View>,
);
