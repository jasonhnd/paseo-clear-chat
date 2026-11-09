import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import * as PaseoUI from "@getpaseo/plugin/client/ui";
import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../../messages";
import { CopyFallbackDialog, copyTouchTarget, useCopyText } from "../copy-feedback";
import { selectionCodeSurface } from "../selection-actions";
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

/** Preserve trailing lines in both the selectable text and the copy target. */
export function ExactCodeBlock({ code, language, tokens }: { code: string; language: string; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const { copied, handleCopy, fallbackText, setFallbackText } = useCopyText(code);
  return <View style={{ backgroundColor: tokens.surface2, borderRadius: radius.block, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 6 }}>
      <Text style={{ color: tokens.foregroundMuted, fontSize: 12 }}>{language}</Text>
      <Pressable onPress={handleCopy} accessibilityRole="button" accessibilityLabel={copied ? t("code.copiedA11y") : t("code.copyA11y")} style={copyTouchTarget}>
        <Text style={{ color: tokens.foregroundMuted, fontSize: 12 }}>{copied ? t("selection.copied") : t("code.copy")}</Text>
      </Pressable>
    </View>
    <ScrollView horizontal><Text {...selectionCodeSurface} selectable testID="exact-code-body" style={{ color: tokens.foreground, fontFamily: tokens.fontMono, fontSize: tokens.fs(13), lineHeight: tokens.fs(20), padding: 12 }}>{code}</Text></ScrollView>
    <CopyFallbackDialog text={fallbackText} onClose={() => setFallbackText(null)} tokens={tokens} />
  </View>;
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
