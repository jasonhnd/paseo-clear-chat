import React, { useMemo, useRef } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { ViewStyle } from "react-native";
import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../messages";
import { jumpHeadingLines } from "../jump-chips";
import { MarkdownView, type MarkdownVariant } from "./markdown/markdown-view";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { hostFontEscape } from "./host-font-escape";

export function ReaderDialog({ text, cwd, tokens, variant, onClose }: {
  text: string;
  cwd?: string | null;
  tokens: ExtendedThemeTokens;
  variant: MarkdownVariant;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const headings = useMemo(() => jumpHeadingLines(text), [text]);
  const scroll = useRef<HTMLElement | null>(null);
  const jump = (index: number) => {
    const node = scroll.current;
    const heading = node?.querySelector<HTMLElement>(`[data-jump-heading="${index}"]`);
    if (node && heading) node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top;
  };

  return <Modal transparent visible onRequestClose={onClose}>
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.45)" }}>
      <View {...hostFontEscape} role="dialog" aria-modal accessibilityLabel={t("reader.title")}
        style={{ width: "100%", maxWidth: 900, height: "90%", minHeight: 0, borderRadius: 14, overflow: "hidden", backgroundColor: tokens.surface0, borderWidth: 1, borderColor: tokens.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderColor: tokens.border }}>
          <Text style={{ flex: 1, color: tokens.foreground, fontSize: tokens.fs(16), fontWeight: "600" }}>{t("reader.title")}</Text>
          <Pressable testID="reader-close" accessibilityRole="button" onPress={onClose} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}>
            <Text style={{ color: tokens.foreground }}>{t("reader.close")}</Text>
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0, borderBottomWidth: 1, borderColor: tokens.border }} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
          {headings.map(({ index, heading }) => <Pressable key={index} testID={`reader-toc-${index}`} accessibilityRole="button" onPress={() => jump(index)}
            style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}>
            <Text style={{ color: tokens.accent }}>{heading}</Text>
          </Pressable>)}
        </ScrollView>
        <ScrollView testID="reader-scroll" ref={node => { scroll.current = node as unknown as HTMLElement | null; }}
          style={[{ flex: 1, minHeight: 0 }, Platform.OS === "web" ? { overscrollBehavior: "contain", overflowAnchor: "none" } as unknown as ViewStyle : undefined]}
          contentContainerStyle={{ padding: 20 }}>
          <MarkdownView text={text} cwd={cwd} tokens={tokens} variant={variant} />
        </ScrollView>
      </View>
    </View>
  </Modal>;
}
