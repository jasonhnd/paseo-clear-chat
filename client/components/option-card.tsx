import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import { answerText, choose, clearChoice, dismiss, getOptionSession, missingQuestion, moveCursor, sendAnswer, setActiveQuestion, setNote, useOptionSession } from "../option-session";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function OptionCard({ agentId, at, tokens, popover = false, close }: { agentId: string; at: number; tokens: ExtendedThemeTokens; popover?: boolean; close?: () => void }) {
  const { t } = useTranslation(messages);
  const session = useOptionSession(agentId);
  const status = useAgent(agentId, agent => agent.status);
  const { height } = useWindowDimensions();
  const [collapsed, setCollapsed] = useState(false);
  const [noteOpen, setNoteOpen] = useState<Record<number, boolean>>({});
  if (!session || session.at !== at || session.dismissed || (!popover && status === "running")) return null;

  const index = session.activeQuestion;
  const question = session.set.questions[index]!;
  const number = (i: number) => session.set.questions[i]!.number ?? i + 1;
  const chosen = session.set.questions.map((_, i) => session.choices[i] ? `${session.set.questions[i]!.number ?? ""}${session.choices[i]}` : "").filter(Boolean).join(" ");
  const missing = missingQuestion(agentId);
  const answer = answerText(agentId);
  const labelStyle = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(13) };
  const mutedStyle = { ...labelStyle, color: tokens.foregroundMuted, fontSize: tokens.fs(12) };
  const buttonStyle = { minHeight: 44, justifyContent: "center" as const, alignItems: "center" as const, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: tokens.border };
  const send = async () => {
    if (session.sending || status === "running" || !answer) return;
    const pending = sendAnswer(agentId);
    const started = getOptionSession(agentId)?.at === at && getOptionSession(agentId)?.sending;
    const success = await pending;
    const current = getOptionSession(agentId);
    if (started && success) {
      if (current?.at === at) dismiss(agentId);
      close?.();
    }
  };
  if (collapsed && !popover) return (
    <Pressable testID="option-card-strip" accessibilityRole="button" accessibilityState={{ expanded: false }} accessibilityLabel={t("answerCard.reopen")} onPress={() => setCollapsed(false)}
      style={{ ...buttonStyle, marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 6, backgroundColor: tokens.surface1 }}>
      <Text style={labelStyle}>{t("answerCard.summary", { total: session.set.questions.length, chosen: chosen || t("answerCard.none"), question: number(index) })}</Text>
    </Pressable>
  );
  const end = /[!?。！？]|\.(?=\s|$)/.exec(question.text);
  const split = end ? end.index + 1 : question.text.length;
  const Container = popover ? View : ScrollView;
  return (
    <View testID={popover ? "option-popover" : "option-card"} style={popover ? {} : { marginTop: 10, borderWidth: 1, borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.surface1, overflow: "hidden", maxHeight: Math.max(100, height * 0.4) }}>
      <Container {...(popover ? {} : { keyboardShouldPersistTaps: "handled", nestedScrollEnabled: true })}>
        <View style={{ padding: 12, gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {session.set.questions.map((q, i) => <Pressable key={i} testID={`option-question-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === index }} accessibilityLabel={t("answerCard.questionTab", { question: number(i) })} onPress={() => setActiveQuestion(agentId, i)} style={{ minHeight: 44, justifyContent: "center", borderBottomWidth: i === index ? 2 : 0, borderColor: tokens.success, paddingHorizontal: 4 }}>
              <Text style={labelStyle}>{t("answerCard.question", { current: i + 1, total: session.set.questions.length })}</Text>
            </Pressable>)}
            {chosen ? <Text style={{ ...mutedStyle, color: tokens.success }}>· {chosen}</Text> : null}
            <Text style={{ ...mutedStyle, flexGrow: 1, textAlign: "right" }}>{t("answerCard.detected")}</Text>
            {!popover ? <Pressable testID="option-card-collapse" accessibilityRole="button" accessibilityState={{ expanded: true }} accessibilityLabel={t("answerCard.collapse")} onPress={() => setCollapsed(true)} style={buttonStyle}><Text style={mutedStyle}>{t("answerCard.collapse")}</Text></Pressable> : null}
          </View>
          {popover ? <Text selectable accessibilityRole="header" style={{ ...labelStyle, fontWeight: "700" }}>{question.text}</Text> : <Text selectable style={labelStyle}><Text style={{ fontWeight: "700" }}>{question.text.slice(0, split)}</Text>{question.text.slice(split)}</Text>}
          {question.options.map((option, i) => {
            const selected = session.choices[index] === option.letter;
            const focused = session.cursor[index] === i;
            const [first, ...rest] = option.text.split("\n");
            return <Pressable key={option.letter} testID={`option-row-${option.letter}`} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={t("answerCard.optionLabel", { letter: option.letter, text: option.text })} onPress={() => { moveCursor(agentId, index, i - (session.cursor[index] ?? 0)); if (selected) clearChoice(agentId, index); else choose(agentId, index, option.letter); }}
              style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: focused ? tokens.success : tokens.border, backgroundColor: selected ? tokens.successBg : tokens.surface2 }}>
              <Text style={{ ...labelStyle, color: tokens.success, fontWeight: "700" }}>{option.letter}</Text>
              <View style={{ flex: 1 }}><Text style={labelStyle}>{first}</Text>{rest.length ? <Text style={mutedStyle}>{rest.join("\n")}</Text> : null}</View>
              {option.recommended ? <Text style={{ ...mutedStyle, color: tokens.success, flexShrink: 1 }}>{t("answerCard.recommended")}</Text> : null}
              {selected ? <Text style={{ ...labelStyle, color: tokens.success }}>✓</Text> : null}
            </Pressable>;
          })}
          <Pressable testID="option-note-toggle" accessibilityRole="button" accessibilityState={{ expanded: !!noteOpen[index] }} onPress={() => setNoteOpen({ ...noteOpen, [index]: !noteOpen[index] })} style={buttonStyle}><Text style={labelStyle}>{t("answerCard.writeOwn")}</Text></Pressable>
          {noteOpen[index] ? <TextInput testID="option-note" accessibilityLabel={t("answerCard.noteLabel")} value={session.notes[index] ?? ""} onChangeText={(text: string) => setNote(agentId, index, text)} multiline={false} style={{ ...labelStyle, minHeight: 44, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border }} /> : null}
          {session.notes[index]?.trim() && !session.choices[index] ? <Text testID="option-note-warning" style={{ ...mutedStyle, color: tokens.warning }}>{t("answerCard.chooseFirst")}</Text> : null}
          {index < session.set.questions.length - 1 ? <Pressable testID="option-next" accessibilityRole="button" onPress={() => setActiveQuestion(agentId, index + 1)} style={buttonStyle}><Text style={labelStyle}>{t("answerCard.next")}</Text></Pressable> : null}
          <Pressable testID="option-dismiss" accessibilityRole="button" onPress={() => dismiss(agentId)} style={buttonStyle}><Text style={mutedStyle}>{t("answerCard.notOptions")}</Text></Pressable>
          {session.error ? <Text testID="option-send-error" accessibilityRole="alert" style={{ ...mutedStyle, color: tokens.danger }}>{t("answerCard.error", { reason: session.error })}</Text> : null}
          {status === "running" ? <Text testID="option-running" style={mutedStyle}>{t("answerCard.running")}</Text> : null}
          <Pressable testID="option-send" accessibilityRole="button" accessibilityState={{ disabled: answer === null || session.sending || status === "running" }} disabled={answer === null || session.sending || status === "running"} onPress={() => { void send(); }} style={{ ...buttonStyle, backgroundColor: answer === null || session.sending || status === "running" ? tokens.surface2 : tokens.success, borderColor: tokens.successBorder }}>
            <Text style={{ ...labelStyle, color: answer === null || session.sending || status === "running" ? tokens.foregroundMuted : (tokens.isDark ? "#000000" : "#ffffff"), fontWeight: "700" }}>{missing === null ? t("answerCard.send", { answer: answer ?? "" }) : t("answerCard.missing", { question: number(missing) })}</Text>
          </Pressable>
        </View>
      </Container>
    </View>
  );
}
