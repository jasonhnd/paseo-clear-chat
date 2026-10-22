import React, { useMemo } from "react";
import { View, Text } from "react-native";
import { finalReplyOptionPrefix, parseFinalToolReply } from "../tool-final-reply";
import { MarkdownView, type MarkdownVariant } from "./markdown/markdown-view";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { extractGeneratedImages } from "../generated-images";
import { GeneratedImages } from "./generated-images";
import { ImageFallback } from "./markdown/markdown-image";
import type { ToolExpansionIdentity } from "../tool-expansion-store";

export function FinalToolReply({ text, tokens, variant, cwd, expansionIdentity }: {
  text: string;
  tokens: ExtendedThemeTokens;
  variant: MarkdownVariant;
  cwd?: string | null;
  expansionIdentity?: ToolExpansionIdentity;
}) {
  const content = useMemo(() => parseFinalToolReply(text), [text]);
  const markdown = (text: string, part: string) => (
    <MarkdownView text={text} cwd={cwd} tokens={tokens} variant={variant}
      expansionIdentity={expansionIdentity ? {
        ...expansionIdentity,
        callId: JSON.stringify([expansionIdentity.callId ?? expansionIdentity.name, part]),
      } : undefined} />
  );
  const heading = { fontFamily: tokens.fontUi, fontSize: tokens.fs(13), lineHeight: tokens.fs(20), fontWeight: "600" as const, color: tokens.foreground };
  const body = content.kind === "text" ? (
    <View style={{ gap: 8 }}>
      <Text testID="final-reply-plain-text" selectable style={{ ...heading, fontWeight: "400" }}>{content.text}</Text>
      {/* A final reply explicitly offers these paths, even inside a tool envelope. */}
      <GeneratedImages images={extractGeneratedImages(content.text)} cwd={cwd} tokens={tokens}
        renderUnavailable={(image) => <ImageFallback src={image.source} alt="" tokens={tokens} unsupported={false} />} />
    </View>
  ) : content.kind === "markdown" ? markdown(content.text, "body") : (
    <View testID="wrap-up-reply" style={{ gap: 12 }}>
      {content.recap.trim() ? (
        <View testID="wrap-up-recap">{markdown(content.recap, "recap")}</View>
      ) : null}
      {content.ask ? (
        <View testID="wrap-up-question" style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={heading}>Question</Text>
          {markdown(content.ask, "ask")}
        </View>
      ) : null}
      {content.actions.length ? (
        <View testID="wrap-up-options" style={{ gap: 8 }}>
          {content.actions.map((action, index) => (
            <View key={index} testID="wrap-up-option" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              {finalReplyOptionPrefix(action, index) ? (
                <Text style={[heading, { color: tokens.accent }]}>{finalReplyOptionPrefix(action, index)}</Text>
              ) : null}
              <View style={{ flex: 1 }}>{markdown(action, `action-${index}`)}</View>
            </View>
          ))}
        </View>
      ) : null}
      {content.isBlocked ? (
        <View testID="wrap-up-blocked" accessibilityRole="alert" style={{ gap: 4, padding: 10, borderLeftWidth: 3, borderLeftColor: tokens.danger, backgroundColor: tokens.dangerBg }}>
          <Text accessibilityRole="header" style={[heading, { color: tokens.danger }]}>Blocked</Text>
          {content.blocked.map((reason, index) => <View key={index}>{markdown(reason, `blocked-${index}`)}</View>)}
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
