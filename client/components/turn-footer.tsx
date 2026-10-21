import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CopyFallbackDialog, copyTouchTarget, useCopyText } from "./copy-feedback";
import { Glyph } from "./glyph";
import { unselectable } from "./selection";
import { radius } from "./theme-tokens";
import type { ExtendedThemeTokens } from "./theme-tokens";

/**
 * Reply-local copy and timestamp for content owned by the plugin. These must
 * not depend on which conversation or item currently owns the hub dock.
 * The host owns turn duration and fork controls; this component does not add
 * another turn-duration label or infer elapsed work from message timestamps.
 */
interface AssistantFooterProps {
  /** The reply, copied verbatim — the same text the host would copy. */
  text: string;
  at: Date;
  tokens: ExtendedThemeTokens;
}

/**
 * Matches `utils/time.ts:formatMessageTimestamp`: bare time today, weekday and
 * time within the week, and a dated label beyond it.
 */
export function formatReplyTime(date: Date, now: Date = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return time;

  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days >= 0 && days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  }

  const label = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${label} ${time}`;
}

export function AssistantFooter({ text, at, tokens }: AssistantFooterProps) {
  const { copied, handleCopy, fallbackText, setFallbackText } = useCopyText(text);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
        },
        copyButton: {
          ...copyTouchTarget,
          // Pull the button's own padding back so its icon starts on the text
          // column, the way the host footer does.
          marginLeft: -6,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 6,
          paddingVertical: 3,
          borderRadius: radius.block,
          backgroundColor: copied ? tokens.successBg : "transparent",
        },
        copyLabel: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(11),
          fontWeight: "500",
          color: copied ? tokens.success : tokens.foregroundMuted,
          ...unselectable,
        },
        time: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(11),
          color: tokens.foregroundSubtle,
          ...unselectable,
        },
      }),
    [tokens, copied],
  );

  // The label is recomputed on each render rather than ticked: the footer
  // re-renders whenever the turn does, and a stale minute is not worth a timer.
  const time = formatReplyTime(at);

  return (
    <View style={styles.container}>
      <CopyFallbackDialog text={fallbackText} onClose={() => setFallbackText(null)} tokens={tokens} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? "Reply copied" : "Copy reply"}
        onPress={handleCopy}
        style={styles.copyButton}
      >
        <Glyph
          name={copied ? "Check" : "Copy"}
          size={12}
          color={copied ? tokens.success : tokens.foregroundMuted}
        />
        <Text style={styles.copyLabel}>{copied ? "Copied" : "Copy"}</Text>
      </Pressable>
      <Text style={styles.time}>{time}</Text>
    </View>
  );
}
