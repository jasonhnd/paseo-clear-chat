import React, { useEffect, useRef } from "react";
import { Animated, Platform, Pressable, Text, View } from "react-native";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../messages";
import { answerText, choose, getOptionSession, missingQuestion, moveCursor, sendAnswer, setActiveQuestion, useOptionSession } from "../option-session";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function OptionCard({ agentId, at, tokens }: { agentId: string; at: number; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const session = useOptionSession(agentId);
  const status = useAgent(agentId, agent => agent.status);
  const root = useRef<HTMLElement | null>(null);
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
  const number = (i: number) => session.set.questions[i]!.number ?? i + 1;
  const label = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(13) };
  const muted = { ...label, color: tokens.foregroundMuted, fontSize: tokens.fs(12) };
  const focus = (testId: string) => {
    if (Platform.OS === "web") setTimeout(() => root.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus(), 0);
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
      if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
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
    <View {...keyboardProps} testID="option-card" accessibilityState={{ disabled: readOnly }} style={{ marginTop: 12, borderWidth: 1, borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.surface1, padding: 16, gap: 12, opacity: readOnly ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {session.set.questions.map((q, i) => <Pressable key={i} testID={`option-question-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === index }} accessibilityLabel={t("answerCard.questionTab", { question: number(i) })} onPress={() => setActiveQuestion(agentId, i)} style={{ minHeight: 36, justifyContent: "center", borderBottomWidth: i === index ? 2 : 0, borderColor: tokens.accent, paddingHorizontal: 4 }}>
          <Text style={{ ...label, fontWeight: i === index ? "700" : "400" }}>{t("answerCard.question", { current: i + 1, total: session.set.questions.length })}{session.choices[i] ? ` · ${session.choices[i]}` : ""}</Text>
        </Pressable>)}
        <Text style={{ ...muted, flexGrow: 1, textAlign: "right" }}>{t("answerCard.detected")}</Text>
      </View>
      <Animated.View style={{ opacity: fade, gap: 8 }}>
        <Text selectable style={{ ...label, fontWeight: "700", marginBottom: 4 }}>{question.text}</Text>
        {question.options.map(option => {
          const selected = session.choices[index] === option.letter;
          const [first, ...rest] = option.text.split("\n");
          return <Pressable key={option.letter} testID={`option-row-${option.letter}`} accessibilityRole="button" accessibilityState={{ selected, disabled }} accessibilityLabel={t("answerCard.optionLabel", { letter: option.letter, text: option.text })} disabled={disabled} onPress={() => select(option.letter)} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: selected ? tokens.accent : tokens.border, backgroundColor: selected ? tokens.accentBg : tokens.surface1 }}>
            <Text style={{ ...label, color: selected ? tokens.accent : tokens.foregroundMuted, fontWeight: "700", overflow: "hidden", borderWidth: 1, borderColor: selected ? tokens.accent : tokens.border, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>{option.letter}</Text>
            <View style={{ flex: 1 }}><Text style={label}>{first}</Text>{rest.length ? <Text style={muted}>{rest.join("\n")}</Text> : null}</View>
            {selected ? <Text style={{ ...label, color: tokens.accent, fontWeight: "700" }}>✓</Text> : null}
            {option.recommended ? <Text style={{ ...muted, color: tokens.accent, overflow: "hidden", borderRadius: 10, backgroundColor: tokens.accentBg, paddingHorizontal: 8, paddingVertical: 3 }}>{t("answerCard.recommended")}</Text> : null}
          </Pressable>;
        })}
      </Animated.View>
      {session.error ? <Text testID="option-send-error" accessibilityRole="alert" style={{ ...muted, color: tokens.danger }}>{t("answerCard.error", { reason: session.error })}</Text> : null}
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Pressable testID="option-send" accessibilityRole="button" accessibilityState={{ disabled: disabled || answer === null }} disabled={disabled || answer === null} onPress={() => { void sendAnswer(agentId); }} style={{ minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: answer === null || disabled ? tokens.border : tokens.accent, backgroundColor: answer === null || disabled ? tokens.surface2 : tokens.accent }}>
          <Text style={{ ...label, color: answer === null || disabled ? tokens.foreground : tokens.accentForeground, fontWeight: "700" }}>{missing === null ? t("answerCard.send", { answer: answer ?? "" }) : t("answerCard.missing", { question: number(missing) })}</Text>
        </Pressable>
      </View>
    </View>
  );
}
