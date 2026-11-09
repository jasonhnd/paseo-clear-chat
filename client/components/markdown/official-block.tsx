import React from "react";
import { Text, View } from "react-native";
import * as PaseoUI from "@getpaseo/plugin/client/ui";
import { radius, type ExtendedThemeTokens } from "../theme-tokens";

const { Markdown } = PaseoUI as typeof PaseoUI & {
  Markdown?: (props: { children: string }) => React.ReactElement;
};

export function fencedSource(code: string, language: string): string {
  const marker = language.includes("`") ? "~" : "`";
  let longest = 0;
  for (const run of code.matchAll(marker === "`" ? /`+/g : /~+/g)) longest = Math.max(longest, run[0].length);
  const fence = marker.repeat(Math.max(3, longest + 1));
  const separator = language.startsWith(marker) ? " " : "";
  return `${fence}${separator}${language}\n${code}\n${fence}`;
}

class MarkdownBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function OfficialMarkdownBlock({ text, language, tokens, fallback }: { text: string; language: string; tokens: ExtendedThemeTokens; fallback: React.ReactNode }) {
  if (typeof Markdown !== "function") return fallback;
  return <MarkdownBoundary key={text} fallback={fallback}>
    {language && language.toLowerCase() !== "mermaid" ? <View testID="official-code-language" style={{
      backgroundColor: tokens.surface2,
      borderBottomWidth: 1,
      borderBottomColor: tokens.borderSubtle,
      borderTopLeftRadius: radius.block,
      borderTopRightRadius: radius.block,
      paddingVertical: 6,
      paddingHorizontal: 12,
    }}><Text style={{ fontSize: 12, color: tokens.foregroundMuted }}>{language}</Text></View> : null}
    <Markdown>{text}</Markdown>
  </MarkdownBoundary>;
}
