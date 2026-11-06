import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import { answerText, choose, clearChoice, dismiss, getOptionSession, missingQuestion, moveCursor, sendAnswer, setActiveQuestion, setNote, useOptionSession } from "../option-session";
import { installOptionKeyboard, optionComposer } from "./option-keyboard";
import { installOptionComposer } from "../option-composer";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function OptionCard({ agentId, at, tokens, popover = false, onSent }: { agentId: string; at: number; tokens: ExtendedThemeTokens; popover?: boolean; onSent?: () => void }) {
  const { t } = useTranslation(messages);
  const session = useOptionSession(agentId);
  const status = useAgent(agentId, agent => agent.status);
  const { height } = useWindowDimensions();
  const [collapsed, setCollapsed] = useState(false);
  const [noteOpen, setNoteOpen] = useState<Record<number, boolean>>({});
  const root = useRef<HTMLElement | null>(null);
  const entered = useRef(false);
  const sendFocused = useRef(false);
  const [keyboardEntered, setKeyboardEntered] = useState(false);
  const [keyboardSend, setKeyboardSend] = useState(false);
  const sendRef = useRef<() => void>(() => {});
  const visible = !!session && session.at === at && !session.dismissed && (popover || status !== "running");
  const setEntered = (value: boolean) => { entered.current = value; setKeyboardEntered(value); };
  const setSendFocus = (value: boolean) => { sendFocused.current = value; setKeyboardSend(value); };
  useEffect(() => {
    if (popover || Platform.OS !== "web" || !visible || typeof window === "undefined") return;
    return installOptionKeyboard({
      agentId, at, root: () => root.current,
      entered: () => entered.current,
      enter: () => { setEntered(true); setSendFocus(false); setCollapsed(false); },
      leave: () => { setEntered(false); setSendFocus(false); setCollapsed(true); },
      send: () => sendRef.current(),
      sendFocused: () => sendFocused.current,
      setSendFocused: setSendFocus,
      focusSend: () => root.current?.querySelector<HTMLElement>('[data-testid="option-send"]')?.focus(),
    });
  }, [agentId, at, visible, popover]);
  useEffect(() => {
    if (popover || Platform.OS !== "web" || typeof document === "undefined" || !visible) return;
    return installOptionComposer(document, agentId, at);
  }, [agentId, at, visible, popover]);
  if (!session || !visible) return null;

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
    if (status === "running" || getOptionSession(agentId)?.sending || !answerText(agentId)) return;
    const pending = sendAnswer(agentId);
    const started = getOptionSession(agentId)?.at === at && getOptionSession(agentId)?.sending;
    await pending;
    const current = getOptionSession(agentId);
    if (started && current?.at === at && !current.sending && !current.error) { onSent?.(); dismiss(agentId); }
  };
  sendRef.current = () => { void send(); };
  const webProps = Platform.OS === "web" && !popover ? {
    ref: (node: View | null) => { root.current = node as unknown as HTMLElement | null; },
    onPointerDown: (event: import("react-native").PointerEvent) => {
      if ((event.target as unknown as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
      const input = optionComposer(root.current);
      if (!input || input.value) return;
      if (!entered.current) {
        const recommended = question.options.findIndex(option => option.recommended);
        moveCursor(agentId, index, Math.max(0, recommended) - (session.cursor[index] ?? 0));
      }
      setEntered(true); setSendFocus(false);
    },
  } : {};
  if (collapsed) return (
    <Pressable {...webProps} testID="option-card-strip" accessibilityRole="button" accessibilityState={{ expanded: false }} accessibilityLabel={t("answerCard.reopen")} onPress={() => setCollapsed(false)}
      style={{ ...buttonStyle, marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 6, backgroundColor: tokens.surface1 }}>
      <Text style={labelStyle}>{t("answerCard.summary", { total: session.set.questions.length, chosen: chosen || t("answerCard.none"), question: number(index) })}</Text>
      {Platform.OS === "web" ? <Text style={mutedStyle}>{t("answerCard.hintReopen")}</Text> : null}
    </Pressable>
  );
  const end = /[!?。！？]|\.(?=\s|$)/.exec(question.text);
  const split = end ? end.index + 1 : question.text.length;
  return (
    <View {...webProps} testID={popover ? "option-popover" : "option-card"} style={popover ? {} : { marginTop: 10, borderWidth: 1, borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.surface1, overflow: "hidden", maxHeight: Math.max(100, height * 0.4) }}>
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        <View style={{ padding: 12, gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {session.set.questions.map((q, i) => <Pressable key={i} testID={`option-question-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === index }} accessibilityLabel={t("answerCard.questionTab", { question: number(i) })} onPress={() => setActiveQuestion(agentId, i)} style={{ minHeight: 44, justifyContent: "center", borderBottomWidth: i === index ? 2 : 0, borderColor: tokens.success, paddingHorizontal: 4 }}>
              <Text style={labelStyle}>{t("answerCard.question", { current: i + 1, total: session.set.questions.length })}</Text>
            </Pressable>)}
            {chosen ? <Text style={{ ...mutedStyle, color: tokens.success }}>· {chosen}</Text> : null}
            <Text style={{ ...mutedStyle, flexGrow: 1, textAlign: "right" }}>{t("answerCard.detected")}</Text>
            {!popover ? <Pressable testID="option-card-collapse" accessibilityRole="button" accessibilityState={{ expanded: true }} accessibilityLabel={t("answerCard.collapse")} onPress={() => { setEntered(false); setSendFocus(false); setCollapsed(true); }} style={buttonStyle}><Text style={mutedStyle}>{t("answerCard.collapse")}</Text></Pressable> : null}
          </View>
          <Text selectable style={labelStyle}><Text style={{ fontWeight: "700" }}>{question.text.slice(0, split)}</Text>{question.text.slice(split)}</Text>
          {question.options.map((option, i) => {
            const selected = session.choices[index] === option.letter;
            const focused = keyboardEntered && !keyboardSend && session.cursor[index] === i;
            const [first, ...rest] = option.text.split("\n");
            return <Pressable key={option.letter} testID={`option-row-${option.letter}`} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={t("answerCard.optionLabel", { letter: option.letter, text: option.text })} onPress={() => { moveCursor(agentId, index, i - (getOptionSession(agentId)?.cursor[index] ?? 0)); if (selected) clearChoice(agentId, index); else choose(agentId, index, option.letter); }}
              style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: focused ? tokens.success : tokens.border, backgroundColor: selected ? tokens.successBg : tokens.surface2 }}>
              <Text style={{ ...labelStyle, color: tokens.success, fontWeight: "700" }}>{option.letter}</Text>
              <View style={{ flex: 1 }}><Text style={labelStyle}>{first}</Text>{rest.length ? <Text style={mutedStyle}>{rest.join("\n")}</Text> : null}</View>
              {option.recommended ? <Text style={{ ...mutedStyle, color: tokens.success, flexShrink: 1 }}>{t("answerCard.recommended")}</Text> : null}
              {selected ? <Text style={{ ...labelStyle, color: tokens.success }}>✓</Text> : null}
              {focused ? <Text style={{ ...mutedStyle, color: tokens.success, borderWidth: 1, borderColor: tokens.success, borderRadius: 4, paddingHorizontal: 4 }}>{t("answerCard.hintEnter")}</Text> : null}
            </Pressable>;
          })}
          <Pressable testID="option-note-toggle" accessibilityRole="button" accessibilityState={{ expanded: !!noteOpen[index] }} onPress={() => setNoteOpen({ ...noteOpen, [index]: !noteOpen[index] })} style={buttonStyle}><Text style={labelStyle}>{t("answerCard.writeOwn")}</Text></Pressable>
          {noteOpen[index] ? <TextInput testID="option-note" accessibilityLabel={t("answerCard.noteLabel")} value={session.notes[index] ?? ""} onChangeText={(text: string) => setNote(agentId, index, text)} multiline={false} style={{ ...labelStyle, minHeight: 44, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border }} /> : null}
          {session.notes[index]?.trim() && !session.choices[index] ? <Text testID="option-note-warning" style={{ ...mutedStyle, color: tokens.warning }}>{t("answerCard.chooseFirst")}</Text> : null}
          {index < session.set.questions.length - 1 ? <Pressable testID="option-next" accessibilityRole="button" onPress={() => setActiveQuestion(agentId, index + 1)} style={buttonStyle}><Text style={labelStyle}>{t("answerCard.next")}</Text></Pressable> : null}
          <Pressable testID="option-dismiss" accessibilityRole="button" onPress={() => dismiss(agentId)} style={buttonStyle}><Text style={mutedStyle}>{t("answerCard.notOptions")}</Text></Pressable>
          {session.error ? <Text testID="option-send-error" accessibilityRole="alert" style={{ ...mutedStyle, color: tokens.danger }}>{t("answerCard.error", { reason: session.error })}</Text> : null}
          {Platform.OS === "web" && !popover ? <Text testID="option-key-hints" style={mutedStyle}>{[t("answerCard.hintMove"), t("answerCard.hintPick"), index === session.set.questions.length - 1 ? t("answerCard.hintSend") : t("answerCard.hintNext"), t("answerCard.hintBack")].join("  ·  ")}</Text> : null}
          {status === "running" ? <Text testID="option-running" style={mutedStyle}>{t("answerCard.running")}</Text> : null}
          <Pressable testID="option-send" accessibilityRole="button" accessibilityState={{ disabled: answer === null || session.sending || status === "running" }} disabled={(popover || Platform.OS !== "web") && (answer === null || session.sending || status === "running")} onFocus={() => { if (entered.current) setSendFocus(true); }} onPress={() => { void send(); }} style={{ ...buttonStyle, backgroundColor: answer === null || session.sending || status === "running" ? tokens.surface2 : tokens.success, borderColor: keyboardSend ? tokens.success : tokens.successBorder, borderWidth: keyboardSend ? 2 : 1 }}>
            <Text style={{ ...labelStyle, color: answer === null || session.sending || status === "running" ? tokens.foregroundMuted : (tokens.isDark ? "#000000" : "#ffffff"), fontWeight: "700" }}>{missing === null ? t("answerCard.send", { answer: answer ?? "" }) : t("answerCard.missing", { question: number(missing) })}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
