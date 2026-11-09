import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, View, useWindowDimensions, type TextInput as NativeTextInput, type ViewStyle } from "react-native";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import { answerIndex, answerText, choose, confirmCustom, customLetterFor, dismiss, getOptionSession, missingQuestion, moveCursor, openCustom, sendAnswer, setActiveQuestion, setCustomDraft, useOptionSession } from "../option-session";
import { customAnswerLetter } from "../option-custom-answer";
import { optionShortName } from "../option-short-name";
import type { ExtendedThemeTokens } from "./theme-tokens";

export function OptionCard({ agentId, at, tokens }: { agentId: string; at: number; tokens: ExtendedThemeTokens }) {
  const { t } = useTranslation(messages);
  const session = useOptionSession(agentId, at);
  const status = useAgent(agentId, agent => agent.status);
  const root = useRef<HTMLElement | null>(null);
  const customInput = useRef<NativeTextInput | null>(null);
  const customKeyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  const customKeyListener = useRef((event: KeyboardEvent) => customKeyHandler.current(event)).current;
  const setCustomInput = useCallback((node: NativeTextInput | null) => {
    const previous = customInput.current as unknown as HTMLElement | null;
    if (Platform.OS === "web") previous?.removeEventListener("keydown", customKeyListener);
    customInput.current = node;
    if (Platform.OS === "web") (node as unknown as HTMLElement | null)?.addEventListener("keydown", customKeyListener);
  }, [customKeyListener]);
  const { width } = useWindowDimensions();
  const [viewed, setViewed] = useState<{ agentId: string; at: number; index: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [inputState, setInputState] = useState({ agentId, at, index: 0, height: 0, empty: false });
  const fade = useRef(new Animated.Value(1)).current;
  const index = session?.readOnly && viewed?.agentId === agentId && viewed.at === at
    ? viewed.index : session?.activeQuestion ?? 0;
  useEffect(() => {
    setInputState({ agentId, at, index, height: 0, empty: false });
  }, [agentId, at, index]);
  useEffect(() => {
    fade.setValue(0.85);
    const animation = Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [fade, index]);
  if (!session || session.at !== at || session.dismissed || (status === "running" && !session.readOnly)) return null;

  const question = session.set.questions[index]!;
  const customLetter = getOptionSession(agentId)?.at === at ? customLetterFor(agentId, index)! : customAnswerLetter(question);
  const customOpen = !!session.customOpen[index];
  const customConfirmed = session.customConfirmed[index];
  const currentInputState = inputState.agentId === agentId && inputState.at === at && inputState.index === index
    ? inputState : { agentId, at, index, height: 0, empty: false };
  const updateInputState = (change: Partial<Pick<typeof inputState, "height" | "empty">>) => {
    setInputState(state => ({ ...(state.agentId === agentId && state.at === at && state.index === index
      ? state : { agentId, at, index, height: 0, empty: false }), ...change }));
  };
  const readOnly = session.readOnly;
  const disabled = readOnly || session.sending || status === "running";
  const missing = missingQuestion(agentId);
  const answer = answerText(agentId);
  const hasCustomAnswer = Object.keys(session.customConfirmed).length > 0;
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
    setTimeout(() => {
      const current = getOptionSession(agentId);
      if (current?.at !== at || current.readOnly || current.sending || status === "running") return;
      if (Platform.OS === "web") root.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
      else if (testId === "option-custom-input") customInput.current?.focus();
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
  const openAndFocusCustom = () => {
    const current = getOptionSession(agentId);
    if (!current || current.at !== at || current.activeQuestion !== index || current.readOnly || current.sending || status === "running") return;
    if (!current.customOpen[index]) openCustom(agentId, index);
    focus("option-custom-input");
  };
  const handleCustomKey = (event: KeyboardEvent | React.KeyboardEvent<HTMLElement>) => {
    const isComposing = "nativeEvent" in event && event.nativeEvent ? event.nativeEvent.isComposing : (event as KeyboardEvent).isComposing;
    if (disabled || event.defaultPrevented || event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isComposing) return;
    const current = getOptionSession(agentId);
    if (current?.at !== at || current.activeQuestion !== index || !current.customOpen[index] || current.readOnly || current.sending) return;
    event.preventDefault(); event.stopPropagation();
    const wasAnswered = current.choices[index] !== undefined;
    const result = confirmCustom(agentId, index);
    if (result === "blank") updateInputState({ empty: true });
    else if (result === "confirmed") {
      updateInputState({ empty: false });
      if (!wasAnswered) {
        const after = getOptionSession(agentId);
        if (after && missingQuestion(agentId) === null) focus("option-send");
        else if (after) focus(`option-row-${after.set.questions[after.activeQuestion]!.options[0]!.letter}`);
      }
    }
  };
  customKeyHandler.current = handleCustomKey;
  const keyboardProps = Platform.OS === "web" ? {
    ref: (node: View | null) => { root.current = node as unknown as HTMLElement | null; },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled || event.defaultPrevented || getOptionSession(agentId)?.at !== at || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const target = event.target as HTMLElement;
      if (target.getAttribute?.("data-testid") === "option-custom-input") {
        handleCustomKey(event);
        return;
      }
      if (event.key.length === 1 && (/^[a-h]$/i.test(event.key) || event.key.toUpperCase() === customLetter)) {
        if (target.isContentEditable || target.closest("input, textarea")) return;
        const letter = event.key.toUpperCase();
        if (letter === customLetter) {
          event.preventDefault(); event.stopPropagation();
          openAndFocusCustom();
        } else if (question.options.some(option => option.letter === letter)) {
          event.preventDefault(); event.stopPropagation();
          select(letter);
        }
        return;
      }
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
        <View testID="option-tabs" style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          {session.set.questions.map((q, i) => {
            const chosen = q.options.find(option => option.letter === session.choices[i]);
            const chosenText = chosen?.text.replace(/\s+/g, " ").trim();
            const customText = session.customConfirmed[i];
            const customPoints = customText === undefined ? [] : Array.from(customText);
            const tabText = customText !== undefined
              ? `✓ ${customPoints.slice(0, 9).join("").replace(/[\r\n]/g, " ")}${customPoints.length > 9 ? "…" : ""}`
              : (readOnly || i !== index) && chosenText
              ? `✓ ${chosenText.length > 18 ? `${chosenText.slice(0, 17).trimEnd()}…` : chosenText}`
              : `Q${number(i)} · ${optionShortName(q.title, number(i))}`;
            const tabStyle = { minHeight: 36, justifyContent: "center" as const, borderRadius: 18, paddingHorizontal: 12, backgroundColor: i === index ? tokens.surface2 : "transparent" };
            const tabLabel = <Text style={{ ...label, color: i === index ? tokens.foreground : tokens.foregroundMuted, fontWeight: i === index ? "700" : "400" }}>{tabText}</Text>;
            return <Pressable key={i} testID={`option-question-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === index }} disabled={!readOnly && disabled} {...(Platform.OS === "web" && readOnly ? { onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { if (event.key === " ") { event.preventDefault(); setViewed({ agentId, at, index: i }); } } } : {})} onPress={() => { if (readOnly) setViewed({ agentId, at, index: i }); else if (getOptionSession(agentId)?.at === at) setActiveQuestion(agentId, i); }} style={tabStyle}>{tabLabel}</Pressable>;
          })}
          {readOnly ? <Text testID="option-read-only-status" style={{ ...muted, marginLeft: "auto" }}>{t("answerCard.readOnlyStatus")}</Text> : null}
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
              {option.recommended ? <Text style={{ ...muted, color: readOnly ? tokens.foregroundMuted : tokens.accent, overflow: "hidden", borderRadius: 10, backgroundColor: readOnly ? "transparent" : tokens.accentBg, paddingHorizontal: 8, paddingVertical: 3 }}>{t("answerCard.recommended")}</Text> : null}
              {selected ? <Text style={{ ...label, color: readOnly ? tokens.foregroundMuted : tokens.accent, fontWeight: "700" }}>✓</Text> : null}
            </>;
            return readOnly
              ? <View key={option.letter} testID={`option-row-${option.letter}`} accessibilityState={{ selected, disabled: true }} style={rowStyle}>{contents}</View>
              : <Pressable key={option.letter} {...focusProps(`option-row-${option.letter}`)} testID={`option-row-${option.letter}`} accessibilityRole="button" accessibilityState={{ selected, disabled }} accessibilityLabel={t("answerCard.optionLabel", { letter: option.letter, text: option.text })} disabled={disabled} onPress={() => select(option.letter)} style={[rowStyle, focusStyle(`option-row-${option.letter}`)]}>{contents}</Pressable>;
          })}
          {(() => {
            const rowId = `option-row-${customLetter}`;
            const rowStyle = { minHeight: 48, flexDirection: "row" as const, alignItems: "center" as const, gap: 10, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: readOnly ? tokens.border : customOpen ? tokens.accent : tokens.border, backgroundColor: readOnly ? tokens.surface2 : customOpen ? tokens.accentBg : tokens.surface1 };
            const contents = <>
              <Text style={{ ...label, color: !readOnly && customOpen ? tokens.accent : tokens.foregroundMuted, fontWeight: "700", overflow: "hidden", borderWidth: 1, borderColor: !readOnly && customOpen ? tokens.accent : tokens.border, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>{customLetter}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                {readOnly ? <Text selectable style={label}>{customConfirmed ?? t("answerCard.other")}</Text> : customOpen ? <>
                  <TextInput ref={setCustomInput} {...(Platform.OS === "web" ? { onFocus: (event: { stopPropagation(): void }) => { event.stopPropagation(); setFocused("option-custom-input"); }, onBlur: (event: { stopPropagation(): void }) => { event.stopPropagation(); setFocused(current => current === "option-custom-input" ? null : current); } } : {})} testID="option-custom-input" accessibilityLabel={t("answerCard.other")} value={session.customDrafts[index] ?? ""} onChangeText={text => { if (getOptionSession(agentId)?.at === at) { setCustomDraft(agentId, index, text); if (text.trim()) updateInputState({ empty: false }); } }} multiline numberOfLines={2} editable={!disabled} onContentSizeChange={event => { const current = getOptionSession(agentId); if (current?.at === at && current.activeQuestion === index) updateInputState({ height: event.nativeEvent.contentSize.height }); }} style={[{ ...label, padding: 0, borderWidth: 0, minHeight: width <= 390 ? Math.max(44, tokens.fs(36)) : tokens.fs(36), maxHeight: tokens.fs(72), height: Math.max(tokens.fs(36), Math.min(tokens.fs(72), currentInputState.height)), textAlignVertical: "top" }, focusStyle("option-custom-input")]} />
                  {currentInputState.empty ? <Text testID="option-custom-empty" style={{ ...muted, color: tokens.danger }}>{t("answerCard.otherEmpty")}</Text> : null}
                  {!readOnly && customConfirmed === undefined ? <Text style={muted}>{t("answerCard.otherHint")}</Text> : null}
                </> : <><Text style={label}>{t("answerCard.other")}</Text><Text style={muted}>{t("answerCard.otherHint")}</Text></>}
              </View>
              {readOnly && customConfirmed !== undefined ? <Text style={{ ...label, color: tokens.foregroundMuted, fontWeight: "700" }}>✓</Text> : null}
            </>;
            return readOnly
              ? <View testID={rowId} accessibilityState={{ selected: customOpen, disabled: true }} style={rowStyle}>{contents}</View>
              : <Pressable {...focusProps(rowId)} testID={rowId} accessibilityRole="button" accessibilityState={{ selected: customOpen, disabled }} disabled={disabled} onPress={openAndFocusCustom} style={[rowStyle, focusStyle(rowId)]}>{contents}</Pressable>;
          })()}
        </Animated.View>
        {session.error ? <Text testID="option-send-error" accessibilityRole="alert" style={{ ...muted, color: tokens.danger }}>{t("answerCard.error", { reason: session.error })}</Text> : null}
      </View>
      {readOnly ? <View style={{ padding: 16, borderTopWidth: 1, borderColor: tokens.border }}><Text testID="option-answered" style={muted}>{`Answered in the chat: ${session.answeredText}`}</Text></View> : <View style={{ flexDirection: hasCustomAnswer ? "column" : "row", alignItems: hasCustomAnswer ? "stretch" : "center", justifyContent: "space-between", gap: 8, padding: 16, borderTopWidth: 1, borderColor: tokens.border, borderBottomLeftRadius: 11, borderBottomRightRadius: 11, backgroundColor: tokens.surface2 }}>
        {hasCustomAnswer && answer !== null ? <Text testID="option-send-preview" selectable style={{ ...label, color: tokens.foregroundMuted }}>{answer}</Text> : null}
        {Platform.OS === "web" ? <Text testID="option-hint" style={{ ...muted, fontFamily: tokens.fontMono, flexShrink: 1 }}>{customOpen && customConfirmed === undefined
          ? `${t("answerCard.hintEnter")} · ${t("answerCard.otherHint")}`
          : focused === "option-send"
          ? t("answerCard.hintSend").replace(/^Tab →\s*/, "↵ ").toLowerCase()
          : `${t("answerCard.hintMove").replace(/^↑\s*↓/, "↑↓")} · ↵ ${t("answerCard.hintPick").replace(/^A B C D\s*/, "")}`}</Text> : <View />}
        <Pressable {...focusProps("option-send")} testID="option-send" accessibilityRole="button" accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled} focusable={!sendDisabled} onPress={() => { if (getOptionSession(agentId)?.at === at) void sendAnswer(agentId); }} style={[{ minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderStyle: sendDisabled ? "dashed" : "solid", borderColor: sendDisabled ? tokens.foregroundMuted : tokens.accent, backgroundColor: sendDisabled ? "transparent" : tokens.accent }, focusStyle("option-send")]}>
          <Text style={{ ...label, color: sendDisabled ? tokens.foregroundMuted : tokens.accentForeground, fontWeight: "700" }}>{missing === null ? t("answerCard.send", { answer: answerIndex(agentId) ?? "" }) : t("answerCard.missing", { question: number(missing) })}</Text>
        </Pressable>
      </View>}
    </View>
  );
}
