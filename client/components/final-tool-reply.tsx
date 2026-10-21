import React, { useMemo } from "react";
import { View, Text } from "react-native";
import { parseFinalToolReply } from "../tool-final-reply";
import { MarkdownView, type MarkdownVariant } from "./markdown/markdown-view";
import type { ExtendedThemeTokens } from "./theme-tokens";

function optionLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + (value - 1) % 26) + label;
  }
  return label;
}

export function FinalToolReply({ text, tokens, variant }: {
  text: string;
  tokens: ExtendedThemeTokens;
  variant: MarkdownVariant;
}) {
  const content = useMemo(() => parseFinalToolReply(text), [text]);
  const heading = { fontFamily: tokens.fontUi, fontSize: tokens.fs(13), lineHeight: tokens.fs(20), fontWeight: "600" as const, color: tokens.foreground };
  if (content.kind === "text") return (
    <Text testID="final-reply-plain-text" selectable style={{ ...heading, fontWeight: "400" }}>{content.text}</Text>
  );
  if (content.kind === "markdown") return <MarkdownView text={content.text} tokens={tokens} variant={variant} />;
  return (
    <View testID="wrap-up-reply" style={{ gap: 12 }}>
      {content.recap.trim() ? (
        <View testID="wrap-up-recap"><MarkdownView text={content.recap} tokens={tokens} variant={variant} /></View>
      ) : null}
      {content.ask ? (
        <View testID="wrap-up-question" style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={heading}>Question</Text>
          <MarkdownView text={content.ask} tokens={tokens} variant={variant} />
        </View>
      ) : null}
      {content.actions.length ? (
        <View testID="wrap-up-options" style={{ gap: 8 }}>
          {content.actions.map((action, index) => (
            <View key={index} testID="wrap-up-option" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <Text style={[heading, { color: tokens.accent }]}>{`${optionLabel(index)}.`}</Text>
              <View style={{ flex: 1 }}><MarkdownView text={action} tokens={tokens} variant={variant} /></View>
            </View>
          ))}
        </View>
      ) : null}
      {content.blocked.length ? (
        <View testID="wrap-up-blocked" style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={[heading, { color: tokens.danger }]}>Blocked</Text>
          {content.blocked.map((reason, index) => <MarkdownView key={index} text={reason} tokens={tokens} variant={variant} />)}
        </View>
      ) : null}
    </View>
  );
}
