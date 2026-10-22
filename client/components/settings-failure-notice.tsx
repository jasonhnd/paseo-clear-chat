import React from "react";
import { Pressable, Text, View } from "react-native";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function SettingsFailureNotice({ message, onRetry, tokens }: {
  message: string;
  onRetry(): void | Promise<void>;
  tokens: ExtendedThemeTokens;
}) {
  return (
    <View style={{ minWidth: 0, maxWidth: "100%", gap: 8, padding: 14, borderWidth: 1, borderRadius: 12, borderColor: tokens.borderSubtle }}>
      <Text accessibilityRole="alert" style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: tokens.foreground, fontFamily: tokens.fontUi }}>
        {message}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry}
        style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderRadius: 8, borderColor: tokens.borderSubtle }}>
        <Text style={{ fontSize: 13, color: tokens.foreground, fontFamily: tokens.fontUi }}>Retry</Text>
      </Pressable>
    </View>
  );
}
