import React, { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAgent, usePaseo, useTranslation } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function composeQuoteReply(quote: string, reply: string): string {
  return "> " + quote.replace(/\r\n|\r|\n/g, "$&> ") + "\n\n" + reply;
}

/** A draft belongs to one rendered message and never touches the host composer. */
export function QuoteReply({ text, agentId, tokens }: { text: string; agentId: string; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const paseo = usePaseo();
  const status = useAgent(agentId, agent => agent.status);
  const [quote, setQuote] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"busy" | "failed" | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const available = status === "idle";

  function close() {
    generation.current++;
    setQuote(null);
    setReply("");
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
        accessibilityState={{ disabled: !available }} disabled={!available}
        onPress={() => { if (available) { setQuote(text); setReply(""); setError(null); } }}
        style={{ padding: 6, opacity: available ? 1 : 0.5 }}>
        <Text style={{ color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>{t("quote.action")}</Text>
      </Pressable>
      {quote !== null ? (
        <Modal title={t("quote.title")} open onOpenChange={open => { if (!open && !sending) close(); }}>
          <Modal.Content>
            <View style={{ gap: 12 }}>
              <Text style={{ color: tokens.foreground, fontSize: tokens.fs(13) }}>{t("quote.quoted")}</Text>
              <ScrollView style={{ maxHeight: 180, backgroundColor: tokens.surface0 }}>
                <Text selectable testID="quote-original" style={{ color: tokens.foreground, padding: 12 }}>{quote}</Text>
              </ScrollView>
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
