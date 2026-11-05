import React, { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useAgent, usePaseo, useTranslation } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import { useEnhancerPreferences } from "../preferences";
import { copyTouchTarget } from "./copy-feedback";
import { Glyph } from "./glyph";
import { hostFontEscape } from "./host-font-escape";
import { MarkdownView } from "./markdown/markdown-view";
import { radius, withAlpha } from "./theme-tokens";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function composeQuoteReply(quote: string, reply: string): string {
  return "> " + quote.replace(/\r\n|\r|\n/g, "$&> ") + "\n\n" + reply;
}

/** A draft belongs to one rendered message and never touches the host composer. */
export function QuoteReply({ text, agentId, tokens, userMessage = false }: { text: string; agentId: string; tokens: ExtendedThemeTokens; userMessage?: boolean }) {
  const { t } = useTranslation(messages);
  const paseo = usePaseo();
  const status = useAgent(agentId, agent => agent.status);
  const cwd = useAgent(agentId, agent => agent.cwd);
  const { markdownVariant } = useEnhancerPreferences();
  const { height } = useWindowDimensions();
  const [quote, setQuote] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [quoteHeight, setQuoteHeight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"busy" | "failed" | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const available = status === "idle";

  function close() {
    generation.current++;
    setQuote(null);
    setReply("");
    setExpanded(false);
    setQuoteHeight(0);
    setError(null);
  }

  async function send() {
    if (!available || quote === null || !reply.trim() || pending.current) return;
    pending.current = true;
    setSending(true);
    setError(null);
    const current = generation.current;
    try {
      const handle = paseo.agents.ref(agentId);
      const snapshot = await handle.refresh();
      if (current !== generation.current) return;
      if (snapshot?.agent.status !== "idle") {
        setError("busy");
        return;
      }
      const latest = await handle.refresh();
      if (current !== generation.current) return;
      if (latest?.agent.status !== "idle") {
        setError("busy");
        return;
      }
      await handle.send(composeQuoteReply(quote, reply));
      if (current === generation.current) close();
    } catch {
      if (current === generation.current) setError("failed");
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  if (!text.trim()) return null;
  return (
    <>
      <Pressable testID="quote-action" accessibilityRole="button" accessibilityLabel={t("quote.action")}
        ref={element => {
          // React Native Web does not forward the title prop from Pressable.
          if (Platform.OS === "web" && element) (element as unknown as HTMLElement).title = t("quote.action");
        }}
        accessibilityState={{ disabled: !available }} disabled={!available}
        onPress={() => { if (available) { setQuote(text); setReply(""); setError(null); } }}
        style={{ ...copyTouchTarget, ...(userMessage ? {} : { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: -6 }),
          paddingHorizontal: userMessage ? 4 : 6, paddingVertical: userMessage ? 2 : 3,
          borderRadius: userMessage ? undefined : radius.block, opacity: available ? 1 : 0.5 }}>
        <Glyph name="Quote" size={userMessage ? 11 : 12} color={userMessage ? tokens.userTextMuted : tokens.foregroundMuted} />
        {!userMessage ? <Text style={{ fontFamily: tokens.fontUi, fontSize: tokens.fs(11), fontWeight: "500", color: tokens.foregroundMuted }}>{t("quote.label")}</Text> : null}
      </Pressable>
      {quote !== null ? (
        <Modal title={t("quote.title")} open onOpenChange={open => { if (!open && !sending) close(); }}>
          <Modal.Content>
            <View style={{ gap: 12 }}>
              <Text style={{ color: tokens.foreground, fontSize: tokens.fs(13) }}>{t("quote.quoted")}</Text>
              <ScrollView testID="quote-preview" onContentSizeChange={(_, contentHeight) => setQuoteHeight(contentHeight)}
                style={{ maxHeight: expanded ? Math.max(240, Math.min(480, height * 0.45)) : 180, backgroundColor: tokens.surface0 }}>
                <View testID="quote-original" {...hostFontEscape} style={{ padding: 12, borderLeftWidth: 2, borderLeftColor: withAlpha(tokens.foregroundMuted, 0.5) }}>
                  <MarkdownView text={quote} cwd={cwd} tokens={tokens} variant={markdownVariant} />
                </View>
              </ScrollView>
              {quoteHeight > 180 ? (
                <Pressable testID="quote-expand" accessibilityRole="button"
                  accessibilityLabel={t(expanded ? "quote.collapse" : "quote.expand")}
                  accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ alignSelf: "flex-start", padding: 8 }}>
                  <Text style={{ color: tokens.accent }}>{t(expanded ? "quote.collapse" : "quote.expand")}</Text>
                </Pressable>
              ) : null}
              <TextInput testID="quote-reply-input" accessibilityLabel={t("quote.reply")} placeholder={t("quote.reply")}
                value={reply} onChangeText={setReply} multiline editable={!sending}
                style={{ color: tokens.foreground, backgroundColor: tokens.surface0, minHeight: 120, padding: 12, textAlignVertical: "top" }} />
              {!available || error === "busy" ? <Text style={{ color: tokens.foregroundMuted }}>{t("quote.busy")}</Text> : null}
              {error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{t("quote.failed")}</Text> : null}
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
                <Pressable testID="quote-cancel" accessibilityRole="button" disabled={sending} onPress={close} style={{ padding: 8 }}>
                  <Text style={{ color: tokens.foreground }}>{t("quote.cancel")}</Text>
                </Pressable>
                <Pressable testID="quote-send" accessibilityRole="button" disabled={!available || sending || !reply.trim()}
                  accessibilityState={{ disabled: !available || sending || !reply.trim() }} onPress={send} style={{ padding: 8, opacity: !available || sending || !reply.trim() ? 0.5 : 1 }}>
                  <Text style={{ color: tokens.accent }}>{t("quote.send")}</Text>
                </Pressable>
              </View>
            </View>
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
