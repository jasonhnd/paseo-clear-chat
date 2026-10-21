import React, { useMemo } from "react";
import { View, Text } from "react-native";
import { parseFinalToolReply } from "../tool-final-reply";
import { MarkdownView, type MarkdownVariant } from "./markdown/markdown-view";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { extractGeneratedImages } from "../generated-images";
import { GeneratedImages } from "./generated-images";

function optionLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + (value - 1) % 26) + label;
  }
  return label;
}

export function FinalToolReply({ text, tokens, variant, cwd }: {
  text: string;
  tokens: ExtendedThemeTokens;
  variant: MarkdownVariant;
  cwd?: string | null;
}) {
  const content = useMemo(() => parseFinalToolReply(text), [text]);
  const heading = { fontFamily: tokens.fontUi, fontSize: tokens.fs(13), lineHeight: tokens.fs(20), fontWeight: "600" as const, color: tokens.foreground };
  const body = content.kind === "text" ? (
    <View style={{ gap: 8 }}>
      <Text testID="final-reply-plain-text" selectable style={{ ...heading, fontWeight: "400" }}>{content.text}</Text>
      <GeneratedImages images={extractGeneratedImages(content.text)} cwd={cwd} tokens={tokens} />
    </View>
  ) : content.kind === "markdown" ? <MarkdownView text={content.text} cwd={cwd} tokens={tokens} variant={variant} /> : (
    <View testID="wrap-up-reply" style={{ gap: 12 }}>
      {content.recap.trim() ? (
        <View testID="wrap-up-recap"><MarkdownView text={content.recap} cwd={cwd} tokens={tokens} variant={variant} /></View>
      ) : null}
      {content.ask ? (
        <View testID="wrap-up-question" style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={heading}>Question</Text>
          <MarkdownView text={content.ask} cwd={cwd} tokens={tokens} variant={variant} />
        </View>
      ) : null}
      {content.actions.length ? (
        <View testID="wrap-up-options" style={{ gap: 8 }}>
          {content.actions.map((action, index) => (
            <View key={index} testID="wrap-up-option" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              {/^[A-Z](?:$|[\s.):\u3001])/.test(action) ? null : (
                <Text style={[heading, { color: tokens.accent }]}>{`${optionLabel(index)}.`}</Text>
              )}
              <View style={{ flex: 1 }}><MarkdownView text={action} cwd={cwd} tokens={tokens} variant={variant} /></View>
            </View>
          ))}
        </View>
      ) : null}
      {content.isBlocked ? (
        <View testID="wrap-up-blocked" accessibilityRole="alert" style={{ gap: 4, padding: 10, borderLeftWidth: 3, borderLeftColor: tokens.danger, backgroundColor: tokens.dangerBg }}>
          <Text accessibilityRole="header" style={[heading, { color: tokens.danger }]}>Blocked</Text>
          {content.blocked.map((reason, index) => <MarkdownView key={index} text={reason} cwd={cwd} tokens={tokens} variant={variant} />)}
        </View>
      ) : null}
    </View>
  );
  return (
    <View testID="final-reply-card" style={{ marginVertical: 8, borderWidth: 1, borderColor: tokens.borderSubtle, borderRadius: 8, backgroundColor: tokens.surfaceGlass }}>
      <View testID="final-reply-header" style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: tokens.borderSubtle, backgroundColor: tokens.surface1 }}>
        <Text accessibilityRole="header" style={heading}>Wrap up</Text>
      </View>
      <View testID="final-reply-body" style={{ padding: 12 }}>{body}</View>
    </View>
  );
}
