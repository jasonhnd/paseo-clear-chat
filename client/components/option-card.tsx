import React, { useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../messages";
import { answerText, choose, dismiss, getOptionSession, missingQuestion, moveCursor, sendAnswer, setActiveQuestion, useOptionSession } from "../option-session";
import { optionShortName } from "../option-short-name";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function OptionCard({ agentId, at, tokens }: { agentId: string; at: number; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const session = useOptionSession(agentId, at);
  const status = useAgent(agentId, agent => agent.status);
  const root = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const index = session?.activeQuestion ?? 0;
  useEffect(() => {
    fade.setValue(0.85);
    const animation = Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [fade, index]);
  if (!session || session.at !== at || session.dismissed || (status === "running" && !session.readOnly)) return null;

  const question = session.set.questions[index]!;
  const readOnly = session.readOnly;
  const disabled = readOnly || session.sending || status === "running";
  const missing = missingQuestion(agentId);
  const answer = answerText(agentId);
  const sendDisabled = disabled || answer === null;
  const number = (i: number) => session.set.questions[i]!.number ?? i + 1;
  const label = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(13) };
  const muted = { ...label, color: tokens.foregroundMuted, fontSize: tokens.fs(12) };
  const focusProps = (id: string) => Platform.OS === "web" ? {
    onFocus: () => setFocused(id),
    onBlur: () => setFocused(current => current === id ? null : current),
  } : {};
  const focusStyle = (id: string) => Platform.OS === "web" ? {
    outlineStyle: focused === id ? "solid" : "none", outlineWidth: 2, outlineOffset: 1, outlineColor: tokens.accent,
  } as ViewStyle : undefined;
  const focus = (testId: string) => {
    if (Platform.OS === "web") setTimeout(() => {
      const current = getOptionSession(agentId);
      if (current?.at === at && !current.readOnly && !current.sending) root.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
    }, 0);
  };
  const select = (letter: string) => {
    const before = getOptionSession(agentId);
    if (!before || before.at !== at || before.readOnly || before.sending || status === "running") return;
    const wasAnswered = before.choices[index] !== undefined;
    choose(agentId, index, letter);
    const after = getOptionSession(agentId);
    if (!after || wasAnswered) return;
    if (missingQuestion(agentId) === null) focus("option-send");
    else focus(`option-row-${after.set.questions[after.activeQuestion]!.options[after.cursor[after.activeQuestion] ?? 0]!.letter}`);
  };
  const keyboardProps = Platform.OS === "web" ? {
    ref: (node: View | null) => { root.current = node as unknown as HTMLElement | null; },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled || getOptionSession(agentId)?.at !== at || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const target = event.target as HTMLElement;
      if (!target.closest('[data-testid^="option-row-"]')) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault(); event.stopPropagation();
        const current = question.options.findIndex(option => target.getAttribute("data-testid") === `option-row-${option.letter}`);
        const next = Math.max(0, Math.min(question.options.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
        moveCursor(agentId, index, next - (session.cursor[index] ?? 0));
        focus(`option-row-${question.options[next]!.letter}`);
      }
    },
  } : {};
  return (
    <View {...keyboardProps} testID="option-card" accessibilityState={{ disabled: readOnly }} style={{ marginTop: 12, borderWidth: 1, borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.surface1, opacity: readOnly ? 0.55 : 1 }}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          {session.set.questions.map((q, i) => {
            const chosen = q.options.find(option => option.letter === session.choices[i]);
            const chosenText = chosen?.text.replace(/\s+/g, " ").trim();
            const tabText = (readOnly || i !== index) && chosenText
              ? `✓ ${chosenText.length > 18 ? `${chosenText.slice(0, 17).trimEnd()}…` : chosenText}`
              : `Q${number(i)} · ${optionShortName(q.title, number(i))}`;
            const tabStyle = { minHeight: 36, justifyContent: "center" as const, borderRadius: 18, paddingHorizontal: 12, backgroundColor: i === index ? tokens.surface2 : "transparent" };
            const tabLabel = <Text style={{ ...label, color: i === index ? tokens.foreground : tokens.foregroundMuted, fontWeight: i === index ? "700" : "400" }}>{tabText}</Text>;
            return readOnly
              ? <View key={i} testID={`option-question-${i}`} style={tabStyle}>{tabLabel}</View>
              : <Pressable key={i} testID={`option-question-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === index }} disabled={disabled} onPress={() => { if (getOptionSession(agentId)?.at === at) setActiveQuestion(agentId, i); }} style={tabStyle}>{tabLabel}</Pressable>;
          })}
          {!readOnly && !session.sending ? <Pressable testID="option-dismiss" accessibilityRole="button" onPress={() => { if (getOptionSession(agentId)?.at === at) dismiss(agentId); }} style={{ minHeight: 44, justifyContent: "center", marginLeft: "auto" }}><Text style={muted}>{t("answerCard.notOptions")}</Text></Pressable> : null}
        </View>
        <Animated.View style={{ opacity: fade, gap: 8 }}>
          <Text selectable style={{ ...label, fontWeight: "700", marginBottom: 4 }}>{question.text}</Text>
          {question.options.map(option => {
            const selected = session.choices[index] === option.letter;
            const [first, ...rest] = option.text.split("\n");
            const rowStyle = { minHeight: 48, flexDirection: "row" as const, alignItems: "center" as const, gap: 10, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: readOnly ? tokens.border : selected ? tokens.accent : tokens.border, backgroundColor: readOnly ? tokens.surface2 : selected ? tokens.accentBg : tokens.surface1 };
            const contents = <>
              <Text style={{ ...label, color: readOnly ? tokens.foregroundMuted : selected ? tokens.accent : tokens.foregroundMuted, fontWeight: "700", overflow: "hidden", borderWidth: 1, borderColor: readOnly ? tokens.border : selected ? tokens.accent : tokens.border, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>{option.letter}</Text>
              <View style={{ flex: 1 }}><Text style={label}>{first}</Text>{rest.length ? <Text style={muted}>{rest.join("\n")}</Text> : null}</View>
              {selected ? <Text style={{ ...label, color: readOnly ? tokens.foregroundMuted : tokens.accent, fontWeight: "700" }}>✓</Text> : null}
              {option.recommended ? <Text style={{ ...muted, color: readOnly ? tokens.foregroundMuted : tokens.accent, overflow: "hidden", borderRadius: 10, backgroundColor: tokens.accentBg, paddingHorizontal: 8, paddingVertical: 3 }}>{t("answerCard.recommended")}</Text> : null}
            </>;
            return readOnly
              ? <View key={option.letter} testID={`option-row-${option.letter}`} accessibilityState={{ selected, disabled: true }} style={rowStyle}>{contents}</View>
              : <Pressable key={option.letter} {...focusProps(`option-row-${option.letter}`)} testID={`option-row-${option.letter}`} accessibilityRole="button" accessibilityState={{ selected, disabled }} accessibilityLabel={t("answerCard.optionLabel", { letter: option.letter, text: option.text })} disabled={disabled} onPress={() => select(option.letter)} style={[rowStyle, focusStyle(`option-row-${option.letter}`)]}>{contents}</Pressable>;
          })}
        </Animated.View>
        {session.error ? <Text testID="option-send-error" accessibilityRole="alert" style={{ ...muted, color: tokens.danger }}>{t("answerCard.error", { reason: session.error })}</Text> : null}
      </View>
      {readOnly ? <View style={{ padding: 16, borderTopWidth: 1, borderColor: tokens.border }}><Text testID="option-answered" style={muted}>{`Answered in the chat: ${session.answeredText}`}</Text></View> : <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 16, borderTopWidth: 1, borderColor: tokens.border, borderBottomLeftRadius: 11, borderBottomRightRadius: 11, backgroundColor: tokens.surface2 }}>
        {Platform.OS === "web" ? <Text testID="option-hint" style={{ ...muted, fontFamily: tokens.fontMono, flexShrink: 1 }}>{focused === "option-send"
          ? t("answerCard.hintSend").replace(/^Tab →\s*/, "↵ ").toLowerCase()
          : `${t("answerCard.hintMove").replace(/^↑\s*↓/, "↑↓")} · ↵ ${t("answerCard.hintPick").replace(/^A B C D\s*/, "")}`}</Text> : <View />}
        <Pressable {...focusProps("option-send")} testID="option-send" accessibilityRole="button" accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled} focusable={!sendDisabled} onPress={() => { if (getOptionSession(agentId)?.at === at) void sendAnswer(agentId); }} style={[{ minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderStyle: sendDisabled ? "dashed" : "solid", borderColor: sendDisabled ? tokens.foregroundMuted : tokens.accent, backgroundColor: sendDisabled ? "transparent" : tokens.accent }, focusStyle("option-send")]}>
          <Text style={{ ...label, color: sendDisabled ? tokens.foregroundMuted : tokens.accentForeground, fontWeight: "700" }}>{missing === null ? t("answerCard.send", { answer: answer ?? "" }) : t("answerCard.missing", { question: number(missing) })}</Text>
        </Pressable>
      </View>}
    </View>
  );
}
