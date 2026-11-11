import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, View, useWindowDimensions, type TextInput as NativeTextInput, type ViewStyle } from "react-native";
import * as pluginClient from "@getpaseo/plugin/client";
import { useAgent, useTranslation } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "../messages";
import { resumeAnswerDraft, initializeAnswerState, answerIndex, answerText, choose, confirmCustom, customLetterFor, dismiss, getOptionSessionAt, getOptionSession, missingQuestion, moveCursor, openCustom, sendAnswer, setActiveQuestion, setCustomDraft, useOptionSession } from "../option-session";
import { customAnswerLetter } from "../option-custom-answer";
import { areEnhancerPreferencesReady, getEnhancerPreferencesError, getOptionAnswerDraft, saveOptionAnswerDraft } from "../preferences";
import { questionNumber } from "../option-questions";
import { withAlpha } from "./theme-tokens";
import { optionShortName } from "../option-short-name";
import type { ExtendedThemeTokens } from "./theme-tokens";

// This optional surface is supplied by newer hosts; older hosts retain card sending.
interface Composer {
  readonly prompt: string;
  setPrompt(text: string): void | Promise<void>;
  insertText(text: string): void;
  focus(options?: { selection?: { start: number; end: number } }): Promise<void>;
}
const useComposers = (pluginClient as unknown as { useComposers?: (selector: { agentId: string }) => readonly Composer[] }).useComposers;

const pendingSendFocusAgents = new Map<string, number>();
const focusCardKey = (agentId: string, at: number) => `${agentId}\u0000${at}`;

/**
 * The Recommended badge sits on a tinted accent background. On dark themes the
 * accent itself falls below 4.5:1 against that tint, so the badge uses the host
 * foreground there. Light themes keep the accent exactly as before.
 */
export function recommendedBadgeColor(tokens: ExtendedThemeTokens): string {
  return tokens.isDark ? tokens.foreground : tokens.accent;
}

export function OptionCard({ agentId, at, tokens }: { agentId: string; at: number; tokens: ExtendedThemeTokens }) {
  const { t, locale } = useTranslation(messages);
  const composers = useComposers ? useComposers({ agentId }) : [];
  const composer = composers[0];
  const latestComposer = useRef(composer);
  latestComposer.current = composer;
  const insertedAnswer = useRef<{ agentId: string; at: number } | null>(null);
  const prefillPending = useRef(false);
  const [prefillBusy, setPrefillBusy] = useState(false);
  const [prefillNotice, setPrefillNotice] = useState<"edited" | "changed" | "unavailable" | null>(null);
  const session = useOptionSession(agentId, at);
  useEffect(() => { if (session && !session.readOnly) initializeAnswerState(agentId, at); }, [agentId, at, !!session, session?.readOnly]);
  const status = useAgent(agentId, agent => agent.status);
  const root = useRef<HTMLElement | null>(null);
  const mountedFocusKey = useRef(focusCardKey(agentId, at));
  mountedFocusKey.current = focusCardKey(agentId, at);
  const customInput = useRef<NativeTextInput | null>(null);
  const pendingCustomFocus = useRef(false);
  const customKeyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  const customKeyListener = useRef((event: KeyboardEvent) => customKeyHandler.current(event)).current;
  const setCustomInput = useCallback((node: NativeTextInput | null) => {
    const previous = customInput.current as unknown as HTMLElement | null;
    if (Platform.OS === "web") previous?.removeEventListener("keydown", customKeyListener);
    customInput.current = node;
    if (Platform.OS === "web") (node as unknown as HTMLElement | null)?.addEventListener("keydown", customKeyListener);
    if (node && pendingCustomFocus.current && typeof node.focus === "function") {
      pendingCustomFocus.current = false;
      if (Platform.OS === "web") (node as unknown as HTMLElement).focus({ preventScroll: true });
      else node.focus();
    }
  }, [customKeyListener]);
  const { width } = useWindowDimensions();
  const [viewed, setViewed] = useState<{ agentId: string; at: number; index: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [resumeRetry, setResumeRetry] = useState(false);
  const [inputState, setInputState] = useState({ agentId, at, index: 0, height: 0, empty: false });
  const fade = useRef(new Animated.Value(1)).current;
  const transition = useRef<{ index: number; height: number; old: HTMLElement | null; card: HTMLElement; scroller: HTMLElement | null; scrollTop: number; restore: () => void; readOnly: boolean } | null>(null);
  const activeTransition = useRef<(() => void) | null>(null);
  const readOnlyTransition = useRef<(() => void) | null>(null);
  const pendingSend = useRef<{ card: HTMLElement; old: HTMLElement | null; height: number; scroller: HTMLElement | null; scrollTop: number; stop: () => void } | null>(null);
  const pendingPreview = useRef<{ card: HTMLElement; height: number; scroller: HTMLElement | null; scrollTop: number; anchor: string; previousHeight: string; previousOverflow: string } | null>(null);
  const pendingResize = useRef<{ card: HTMLElement; row: HTMLElement; input: HTMLElement | null; opening: boolean; height: number; rowHeight: number; inputHeight: number; scroller: HTMLElement | null; scrollTop: number; anchor: string; previousHeight: string; previousOverflow: string } | null>(null);
  const scrollSpace = useRef<{ card: HTMLElement; scroller: HTMLElement; original: string; base: number; amount: number; stop: () => void; trim: () => void } | null>(null);
  const clearScrollSpace = () => {
    const space = scrollSpace.current;
    if (!space) return;
    scrollSpace.current = null;
    space.stop();
    space.card.style.marginBottom = space.original;
  };
  const reserveScrollSpace = (card: HTMLElement, scroller: HTMLElement, amount: number) => {
    if (amount <= 0) return;
    let space = scrollSpace.current;
    if (space && (space.card !== card || space.scroller !== scroller)) {
      clearScrollSpace();
      space = null;
    }
    if (!space) {
      const original = card.style.marginBottom;
      const base = Number.parseFloat(globalThis.getComputedStyle?.(card).marginBottom ?? original) || 0;
      const trim = () => {
        const current = scrollSpace.current;
        if (!current || current.card !== card || current.scroller !== scroller || activeTransition.current || transition.current) return;
        const available = scroller.scrollTop === 0 ? current.amount
          : Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
        if (!Number.isFinite(available)) return;
        current.amount -= Math.min(current.amount, available);
        if (current.amount <= 0) clearScrollSpace();
        else card.style.marginBottom = `${current.base + current.amount}px`;
      };
      scroller.addEventListener?.("scroll", trim, { passive: true });
      space = { card, scroller, original, base, amount: 0, stop: () => scroller.removeEventListener?.("scroll", trim), trim };
      scrollSpace.current = space;
    }
    space.amount += amount;
    card.style.marginBottom = `${space.base + space.amount}px`;
  };
  const index = session?.readOnly && viewed?.agentId === agentId && viewed.at === at
    ? viewed.index : session?.activeQuestion ?? 0;
  useEffect(() => {
    setInputState({ agentId, at, index, height: 0, empty: false });
  }, [agentId, at, index]);
  useEffect(() => {
    if (Platform.OS === "web") {
      fade.setValue(1);
      return;
    }
    fade.setValue(0.85);
    const animation = Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [fade, index]);
  // A layout effect starts the transition before the newly selected question is painted.
  // The fallback also lets non-DOM renderers use the component without a layout hook.
  const useCommitEffect = React.useLayoutEffect ?? useEffect;
  useCommitEffect(() => {
    const pending = pendingPreview.current;
    if (!pending) return;
    pendingPreview.current = null;
    const { card, height, scroller, scrollTop, anchor, previousHeight, previousOverflow } = pending;
    const preview = card.querySelector<HTMLElement>('[data-testid="option-send-preview"]');
    if (!preview) {
      card.style.height = previousHeight;
      card.style.overflow = previousOverflow;
      if (scroller) scroller.style.overflowAnchor = anchor;
      return;
    }
    card.style.height = "auto";
    const nextHeight = card.getBoundingClientRect().height;
    if (scroller && scroller.clientHeight > 0) {
      const margin = card.style.marginBottom;
      const base = Number.parseFloat(globalThis.getComputedStyle?.(card).marginBottom ?? margin) || 0;
      card.style.marginBottom = `${base + scroller.clientHeight}px`;
      const contentHeight = scroller.scrollHeight - scroller.clientHeight;
      card.style.marginBottom = margin;
      const deficit = Math.max(0, scrollTop + scroller.clientHeight - contentHeight);
      if (Number.isFinite(deficit)) reserveScrollSpace(card, scroller, deficit);
    }
    if (scroller) scroller.scrollTop = scrollTop;
    card.querySelector<HTMLElement>('[data-testid="option-send"]')?.focus({ preventScroll: true });
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof card.animate !== "function" || typeof preview.animate !== "function") {
      card.style.height = previousHeight;
      card.style.overflow = previousOverflow;
      if (scroller) scroller.style.overflowAnchor = anchor;
      scrollSpace.current?.trim();
      return;
    }
    card.style.height = `${height}px`;
    card.style.overflow = "hidden";
    const expand = card.animate([{ height: `${height}px` }, { height: `${nextHeight}px` }], { duration: 180, easing: "ease-out", fill: "both" });
    const incoming = preview.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear", fill: "both" });
    const check = card.querySelector<HTMLElement>('[data-testid="option-confirmed-check"]');
    const pop = check?.animate?.([{ transform: "scale(0.9)" }, { transform: "scale(1)" }], { duration: 120, easing: "linear", fill: "both" });
    const finish = () => {
      if (activeTransition.current !== finish) return;
      activeTransition.current = null;
      expand.cancel(); incoming.cancel(); pop?.cancel();
      card.style.height = previousHeight;
      card.style.overflow = previousOverflow;
      if (scroller) scroller.style.overflowAnchor = anchor;
      scrollSpace.current?.trim();
    };
    activeTransition.current = finish;
    expand.finished.then(finish, finish);
  }, [session?.choices, session?.customConfirmed]);
  useCommitEffect(() => {
    const pending = pendingResize.current;
    if (!pending) return;
    pendingResize.current = null;
    const { card, row, input, opening, height, rowHeight, inputHeight, scroller, scrollTop, anchor, previousHeight, previousOverflow } = pending;
    card.style.height = "auto";
    const nextHeight = card.getBoundingClientRect().height;
    const nextRowHeight = row.getBoundingClientRect().height;
    const nextInputHeight = input?.getBoundingClientRect().height ?? 0;
    if (scroller && scroller.clientHeight > 0) {
      const margin = card.style.marginBottom;
      const base = Number.parseFloat(globalThis.getComputedStyle?.(card).marginBottom ?? margin) || 0;
      card.style.marginBottom = `${base + scroller.clientHeight}px`;
      const contentHeight = scroller.scrollHeight - scroller.clientHeight;
      card.style.marginBottom = margin;
      const deficit = Math.max(0, scrollTop + scroller.clientHeight - contentHeight);
      if (Number.isFinite(deficit)) reserveScrollSpace(card, scroller, deficit);
    }
    if (scroller) scroller.scrollTop = scrollTop;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof card.animate !== "function") {
      card.style.height = previousHeight;
      card.style.overflow = previousOverflow;
      if (scroller) scroller.style.overflowAnchor = anchor;
      scrollSpace.current?.trim();
      return;
    }
    card.style.height = `${height}px`;
    card.style.overflow = "hidden";
    const cardAnimation = card.animate([{ height: `${height}px` }, { height: `${nextHeight}px` }], { duration: opening ? 200 : 180, easing: "linear", fill: "both" });
    const rowOverflow = row.style.overflow;
    if (opening) row.style.overflow = "hidden";
    const rowAnimation = opening && typeof row.animate === "function" ? row.animate([
      { height: `${rowHeight}px`, backgroundColor: tokens.surface1, borderColor: tokens.border },
      { height: `${nextRowHeight}px`, backgroundColor: tokens.accentBg, borderColor: tokens.isDark ? tokens.foreground : tokens.accent },
    ], { duration: 200, easing: "linear", fill: "both" }) : null;
    const inputAnimation = !opening && input && typeof input.animate === "function" && inputHeight !== nextInputHeight
      ? input.animate([{ height: `${inputHeight}px` }, { height: `${nextInputHeight}px` }], { duration: 120, easing: "linear", fill: "both" }) : null;
    const finish = () => {
      if (activeTransition.current !== finish) return;
      activeTransition.current = null;
      cardAnimation.cancel(); rowAnimation?.cancel(); inputAnimation?.cancel();
      if (opening) row.style.overflow = rowOverflow;
      card.style.height = previousHeight;
      card.style.overflow = previousOverflow;
      if (scroller) scroller.style.overflowAnchor = anchor;
      scrollSpace.current?.trim();
    };
    activeTransition.current = finish;
    cardAnimation.finished.then(finish, finish);
  }, [session?.customOpen, inputState.height]);
  useCommitEffect(() => {
    const pending = transition.current;
    if (!pending || pending.index === index) return;
    transition.current = null;
    const { card, old, height, scroller, scrollTop, restore } = pending;
    const content = card.querySelector<HTMLElement>('[data-testid="option-question-content"]');
    if (pending.readOnly) {
      if (scroller) scroller.scrollTop = scrollTop;
      if (!old || !content || typeof old.animate !== "function" || typeof content.animate !== "function") {
        restore();
        return;
      }
      const out = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "linear", fill: "both" });
      const incoming = content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear", fill: "both" });
      const finish = () => {
        if (readOnlyTransition.current !== finish) return;
        readOnlyTransition.current = null;
        out.cancel(); incoming.cancel(); restore();
      };
      readOnlyTransition.current = finish;
      out.finished.then(finish, finish);
      return;
    }
    const inlineMargin = card.style.marginBottom;
    const previousMargin = Number.parseFloat(globalThis.getComputedStyle?.(card).marginBottom ?? inlineMargin) || 0;
    card.style.height = "auto";
    const nextHeight = card.getBoundingClientRect().height;
    let deficit = 0;
    if (scroller && scroller.clientHeight > 0) {
      // scrollHeight is at least clientHeight even when the content is shorter.
      // A temporary margin exposes the otherwise hidden shortfall before paint.
      card.style.marginBottom = `${previousMargin + scroller.clientHeight}px`;
      const contentHeight = scroller.scrollHeight - scroller.clientHeight;
      card.style.marginBottom = inlineMargin;
      deficit = Math.max(0, scrollTop + scroller.clientHeight - contentHeight);
    }
    if (scroller && Number.isFinite(deficit)) reserveScrollSpace(card, scroller, deficit);
    const nextMargin = previousMargin + (Number.isFinite(deficit) ? deficit : 0);
    card.style.height = `${height}px`;
    if (scroller) scroller.scrollTop = scrollTop;
    if (!old || !content || typeof card.animate !== "function" || typeof content.animate !== "function") {
      restore();
      scrollSpace.current?.trim();
      return;
    }
    const frames = deficit > 0
      ? [{ height: `${height}px`, marginBottom: `${previousMargin}px` }, { height: `${nextHeight}px`, marginBottom: `${nextMargin}px` }]
      : [{ height: `${height}px` }, { height: `${nextHeight}px` }];
    const heightAnimation = card.animate(frames, {
      duration: 180, easing: "cubic-bezier(.2,0,0,1)", fill: "both",
    });
    const out = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-out", fill: "both" });
    const incoming = content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out", fill: "both" });
    const finish = () => {
      if (activeTransition.current !== finish) return;
      activeTransition.current = null;
      heightAnimation.cancel(); out.cancel(); incoming.cancel();
      restore();
      scrollSpace.current?.trim();
    };
    activeTransition.current = finish;
    heightAnimation.finished.then(finish, finish);
  }, [index]);
  useCommitEffect(() => {
    if (!session?.readOnly || !pendingSend.current) return;
    const { card, old, height, scroller, scrollTop, stop } = pendingSend.current;
    pendingSend.current = null;
    stop();
    const previous = { height: card.style.height, overflow: card.style.overflow, position: card.style.position };
    const anchor = scroller?.style.overflowAnchor;
    if (scroller) scroller.style.overflowAnchor = "none";
    const hasGeometry = !!scroller && typeof scroller.getBoundingClientRect === "function" && typeof scroller.scrollBy === "function";
    // Keep the live offset reachable while measuring the new height. A layout read
    // after switching to auto can otherwise clamp it before a deficit is known.
    const temporary = scroller && scroller.clientHeight > 0 ? scroller.clientHeight + Math.max(0, height) : 0;
    if (scroller && temporary) reserveScrollSpace(card, scroller, temporary);
    card.style.height = "auto";
    const nextHeight = card.getBoundingClientRect().height;
    if (scroller && temporary && scrollSpace.current) {
      const currentScroll = hasGeometry ? scroller.scrollTop : scrollTop;
      const contentHeight = scroller.scrollHeight - temporary;
      const deficit = Math.max(0, currentScroll + scroller.clientHeight - contentHeight);
      const space = scrollSpace.current;
      space.amount -= temporary - (Number.isFinite(deficit) ? deficit : temporary);
      if (space.amount <= 0) clearScrollSpace();
      else card.style.marginBottom = `${space.base + space.amount}px`;
    }
    let previousHeight = height;
    const compensate = (currentHeight: number) => {
      if (!hasGeometry || !scroller || !Number.isFinite(currentHeight)) return;
      const lost = Math.max(0, previousHeight - currentHeight);
      const top = card.getBoundingClientRect().top;
      const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
      const above = Math.min(lost, Math.max(0, viewportTop - (top + currentHeight)));
      previousHeight = currentHeight;
      if (Number.isFinite(above) && above > 0) scroller.scrollBy(0, -above);
    };
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !old || typeof card.animate !== "function" || typeof old.animate !== "function") {
      compensate(nextHeight);
      if (scroller) scroller.style.overflowAnchor = anchor ?? "";
      scrollSpace.current?.trim();
      return;
    }
    card.style.height = `${height}px`;
    card.style.overflow = "hidden";
    card.style.position = "relative";
    Object.assign(old.style, { position: "absolute", top: "-1px", left: "-1px", width: "100%", margin: "0", pointerEvents: "none", zIndex: "1" });
    card.appendChild(old);
    const out = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "linear", fill: "both" });
    const grey = card.animate([{ opacity: 1 }, { opacity: 0.55 }], { duration: 120, easing: "linear", fill: "both" });
    let collapse: Animation | null = null;
    let frame: number | null = null;
    const tick = () => {
      if (activeTransition.current !== finish || !collapse) return;
      compensate(card.getBoundingClientRect().height);
      frame = globalThis.requestAnimationFrame?.(tick) ?? null;
    };
    const finish = () => {
      if (activeTransition.current !== finish) return;
      if (collapse) compensate(card.getBoundingClientRect().height);
      activeTransition.current = null;
      if (frame !== null) globalThis.cancelAnimationFrame?.(frame);
      out.cancel(); grey.cancel(); collapse?.cancel(); old.remove();
      card.style.height = previous.height;
      card.style.overflow = previous.overflow;
      card.style.position = previous.position;
      compensate(card.getBoundingClientRect().height);
      if (scroller) scroller.style.overflowAnchor = anchor ?? "";
      scrollSpace.current?.trim();
    };
    activeTransition.current = finish;
    out.finished.then(() => {
      if (activeTransition.current !== finish) return;
      old.remove();
      collapse = card.animate([{ height: `${height}px` }, { height: `${nextHeight}px` }], { duration: 200, easing: "linear", fill: "both" });
      frame = globalThis.requestAnimationFrame?.(tick) ?? null;
      collapse.finished.then(finish, finish);
    }, finish);
  }, [session?.readOnly]);
  useEffect(() => {
    const key = focusCardKey(agentId, at);
    return () => { pendingSendFocusAgents.delete(key); };
  }, [agentId, at]);
  useCommitEffect(() => {
    const key = focusCardKey(agentId, at);
    const armedAt = pendingSendFocusAgents.get(key);
    if (!session?.readOnly || !armedAt) return;
    if (Date.now() - armedAt > 10000) { pendingSendFocusAgents.delete(key); return; }
    if (Platform.OS !== "web") { pendingSendFocusAgents.delete(key); return; }
    const deadline = Date.now() + 1500;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      pendingSendFocusAgents.delete(key);
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const testId = (node: { getAttribute?: (name: string) => string | null } | null) => node?.getAttribute?.("data-testid") ?? "";
    const tick = () => {
      if (Date.now() >= deadline) { stop(); return; }
      const rootNode = root.current as unknown as { querySelector?: (selector: string) => HTMLElement | null } | null;
      const scoped = typeof rootNode?.querySelector === "function" ? rootNode.querySelector('[data-testid="option-question-0"]') : null;
      const tab = scoped && (scoped as { isConnected?: boolean }).isConnected !== false ? scoped : null;
      const doc = (globalThis as { document?: { activeElement?: HTMLElement | null; body?: HTMLElement | null } }).document;
      const active = doc?.activeElement ?? null;
      const onBody = !active || active === doc?.body || (active as { tagName?: string }).tagName === "BODY";
      const onSend = testId(active) === "option-send";
      if (tab && active === tab) { stop(); return; }
      if (doc && active && !onBody && !onSend) { stop(); return; }
      if (!tab || typeof (tab as { focus?: unknown }).focus !== "function") { timer = setTimeout(tick, 100); return; }
      tab.focus({ preventScroll: true });
      const now = doc?.activeElement ?? null;
      if (!doc || now === tab) { stop(); return; }
      const nowBody = !now || now === doc?.body || (now as { tagName?: string }).tagName === "BODY";
      const nowSend = testId(now) === "option-send";
      if (nowBody || nowSend) {
        if (Date.now() < deadline) timer = setTimeout(tick, 100);
        else stop();
        return;
      }
      stop();
    };
    timer = setTimeout(tick, 0);
    return () => { if (timer) clearTimeout(timer); };
  }, [agentId, at, session?.readOnly]);
  useEffect(() => () => {
    pendingSendFocusAgents.delete(mountedFocusKey.current);
    pendingSend.current?.stop();
    pendingSend.current = null;
    if (pendingResize.current) {
      pendingResize.current.card.style.height = pendingResize.current.previousHeight;
      pendingResize.current.card.style.overflow = pendingResize.current.previousOverflow;
      if (pendingResize.current.scroller) pendingResize.current.scroller.style.overflowAnchor = pendingResize.current.anchor;
    }
    pendingResize.current = null;
    if (pendingPreview.current) {
      pendingPreview.current.card.style.height = pendingPreview.current.previousHeight;
      pendingPreview.current.card.style.overflow = pendingPreview.current.previousOverflow;
      if (pendingPreview.current.scroller) pendingPreview.current.scroller.style.overflowAnchor = pendingPreview.current.anchor;
    }
    pendingPreview.current = null;
    transition.current?.restore();
    activeTransition.current?.();
    readOnlyTransition.current?.();
    clearScrollSpace();
  }, []);
  if (!session || session.at !== at || session.dismissed || session.superseded || (!session.resumed && !getOptionSession(agentId, at)) || (status === "running" && !session.readOnly)) return null;

  const question = session.set.questions[index]!;
  const customLetter = getOptionSessionAt(agentId, at)?.at === at ? customLetterFor(agentId, index, at)! : customAnswerLetter(question);
  const customOpen = !!session.customOpen[index];
  const customConfirmed = session.customConfirmed[index];
  const currentInputState = inputState.agentId === agentId && inputState.at === at && inputState.index === index
    ? inputState : { agentId, at, index, height: 0, empty: false };
  const updateInputState = (change: Partial<Pick<typeof inputState, "height" | "empty">>) => {
    setInputState(state => ({ ...(state.agentId === agentId && state.at === at && state.index === index
      ? state : { agentId, at, index, height: 0, empty: false }), ...change }));
  };
  const readOnly = session.readOnly;
  const disabled = readOnly || session.sending || prefillBusy || status === "running";
  const missing = missingQuestion(agentId, at);
  const answer = answerText(agentId, at);
  const answeredCount = session.set.questions.filter((_, i) => session.choices[i] !== undefined || session.customConfirmed[i] !== undefined).length;
  const hasCustomAnswer = Object.keys(session.customConfirmed).length > 0;
  const draftReady = customOpen && customConfirmed === undefined && !!session.customDrafts[index]?.trim();
  const sendDisabled = disabled || (answer === null && !draftReady);
  const number = (i: number) => questionNumber(session.set, i);
  const label = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(13) };
  const muted = { ...label, color: tokens.foregroundMuted, fontSize: tokens.fs(12) };
  // Reserve one hint row so the card does not jump when the hint appears or clears.
  // A hint that needs a second line grows once, on purpose.
  const hintHeight = tokens.fs(16);
  const focusProps = (id: string) => Platform.OS === "web" ? {
    onFocus: () => setFocused(id),
    onBlur: () => setFocused(current => current === id ? null : current),
  } : {};
  const focusStyle = (id: string) => Platform.OS === "web" ? {
    outlineStyle: focused === id ? "solid" : "none", outlineWidth: 2, outlineOffset: 1, outlineColor: tokens.accent,
  } as ViewStyle : undefined;
  const focus = (testId: string) => {
    setTimeout(() => {
      const current = getOptionSessionAt(agentId, at);
      if (current?.at !== at || current.readOnly || current.sending || status === "running") return;
      if (Platform.OS === "web") root.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus({ preventScroll: true });
      else if (testId === "option-custom-input") customInput.current?.focus();
    }, 0);
  };
  const prepareQuestionSwitch = () => {
    if (Platform.OS !== "web") return;
    const card = root.current;
    if (!card?.style || typeof card.getBoundingClientRect !== "function") return;
    const switchingReadOnly = !!session?.readOnly;
    const interruptedHeight = !switchingReadOnly && activeTransition.current ? card.getBoundingClientRect().height : null;
    const scroller = card.closest?.<HTMLElement>('[data-testid="agent-chat-scroll"]') ?? null;
    const scrollTop = scroller?.scrollTop ?? 0;
    const sendTransitionActive = switchingReadOnly && !!activeTransition.current;
    if (switchingReadOnly) readOnlyTransition.current?.();
    else activeTransition.current?.();
    transition.current?.restore();
    transition.current = null;
    const anchor = scroller?.style.overflowAnchor;
    if (scroller && !sendTransitionActive) scroller.style.overflowAnchor = "none";
    const previous = { height: card.style.height, overflow: card.style.overflow, position: card.style.position };
    const cardRect = card.getBoundingClientRect();
    const height = interruptedHeight ?? cardRect.height;
    const content = card.querySelector<HTMLElement>('[data-testid="option-question-content"]');
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let old: HTMLElement | null = null;
    if (!reduced && content && typeof card.animate === "function") {
      const contentRect = content.getBoundingClientRect();
      old = content.cloneNode(true) as HTMLElement;
      old.setAttribute("aria-hidden", "true");
      old.setAttribute("inert", "");
      old.setAttribute("data-testid", "");
      old.querySelectorAll("[data-testid], [id]").forEach(node => { node.removeAttribute("data-testid"); node.removeAttribute("id"); });
      Object.assign(old.style, { position: "absolute", top: `${contentRect.top - cardRect.top - card.clientTop}px`, left: `${contentRect.left - cardRect.left - card.clientLeft}px`, width: `${contentRect.width}px`, pointerEvents: "none", margin: "0", zIndex: "1" });
      if (!switchingReadOnly) {
        card.style.position = "relative";
        card.style.height = `${height}px`;
        card.style.overflow = "hidden";
      }
      card.appendChild(old);
    }
    const restore = () => {
      old?.remove();
      if (!switchingReadOnly) {
        card.style.height = previous.height;
        card.style.overflow = previous.overflow;
        card.style.position = previous.position;
      }
      if (scroller && !sendTransitionActive) scroller.style.overflowAnchor = anchor ?? "";
    };
    if (scroller) scroller.scrollTop = scrollTop;
    transition.current = { index, height, old, card, scroller, scrollTop, restore, readOnly: switchingReadOnly };
  };
  const cancelUnchangedSwitch = (nextIndex: number) => {
    if (nextIndex !== index) return;
    transition.current?.restore();
    transition.current = null;
  };
  const switchQuestion = (nextIndex: number) => {
    if (nextIndex === index) return;
    if (readOnly) {
      prepareQuestionSwitch();
      setViewed({ agentId, at, index: nextIndex });
      return;
    }
    const current = getOptionSessionAt(agentId, at);
    if (!current || (!current.resumed && !getOptionSession(agentId, at)) || current.at !== at || current.readOnly || current.sending || current.activeQuestion === nextIndex) return;
    prepareQuestionSwitch();
    setActiveQuestion(agentId, nextIndex, at);
  };
  const prepareSend = (clearSendFocus = false) => {
    if (Platform.OS !== "web") return;
    const card = root.current;
    if (!card?.style || typeof card.getBoundingClientRect !== "function") return;
    activeTransition.current?.();
    const scroller = card.closest?.<HTMLElement>('[data-testid="agent-chat-scroll"]') ?? null;
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const old = !reduced && typeof card.cloneNode === "function" ? card.cloneNode(true) as HTMLElement : null;
    if (old) {
      if (clearSendFocus) {
        const send = old.querySelector<HTMLElement>('[data-testid="option-send"]');
        if (send) send.style.outlineStyle = "none";
      }
      old.setAttribute("aria-hidden", "true"); old.setAttribute("inert", "");
      old.removeAttribute?.("data-testid"); old.removeAttribute?.("id");
      old.querySelectorAll("[data-testid], [id]").forEach(node => { node.removeAttribute("data-testid"); node.removeAttribute("id"); });
    }
    pendingSend.current?.stop();
    const pending = { card, old, height: card.getBoundingClientRect().height, scroller, scrollTop: scroller?.scrollTop ?? 0, stop: () => {} };
    const observer = typeof globalThis.ResizeObserver === "function" ? new globalThis.ResizeObserver(() => {
      if (pendingSend.current === pending && !getOptionSessionAt(agentId, at)?.readOnly) pending.height = card.getBoundingClientRect().height;
    }) : null;
    pending.stop = () => observer?.disconnect();
    pendingSend.current = pending;
    observer?.observe(card);
  };
  const answerBlock = () => Object.keys(getOptionSessionAt(agentId, at)?.customConfirmed ?? {}).length ? answerText(agentId, at) : answerIndex(agentId, at);
  const prefill = (text: string, clickPrompt: string | undefined, replaceEdited = false, firstInsertion = false) => {
    const current = getOptionSessionAt(agentId, at);
    const target = latestComposer.current;
    if (!current || current.at !== at || current.readOnly || prefillPending.current || status === "running") return;
    if (!target || typeof target.setPrompt !== "function" || !areEnhancerPreferencesReady() || typeof clickPrompt !== "string") {
      setPrefillNotice("unavailable");
      return;
    }
    if (!firstInsertion && !getOptionAnswerDraft(agentId, at)
        && (insertedAnswer.current?.agentId !== agentId || insertedAnswer.current.at !== at)) {
      // Persist the card identity before the first write. If the app reloads
      // before the block is saved, the empty record requires confirmation.
      prefillPending.current = true;
      setPrefillBusy(true);
      void saveOptionAnswerDraft(agentId, at, null, {
        schema: 1, choices: Object.fromEntries(Object.entries(current.choices).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        customDrafts: { ...current.customDrafts }, customOpen: { ...current.customOpen }, activeQuestion: current.activeQuestion,
      }).then(() => {
        prefillPending.current = false;
        setPrefillBusy(false);
        if (getEnhancerPreferencesError()) { setPrefillNotice("unavailable"); return; }
        prefill(text, clickPrompt, false, true);
      }, () => {
        prefillPending.current = false;
        setPrefillBusy(false);
        setPrefillNotice("unavailable");
      });
      return;
    }
    try {
      const prompt = target.prompt;
      if (prompt !== clickPrompt) {
        setPrefillNotice("changed");
        return;
      }
      const record = getOptionAnswerDraft(agentId, at);
      let next: string;
      if (firstInsertion) {
        next = prompt ? `${text}\n${prompt}` : text;
      } else if (record?.block && prompt.startsWith(record.block)
          && (record.block.endsWith("\n") || prompt.length === record.block.length || prompt[record.block.length] === "\n")) {
        next = text + prompt.slice(record.block.length);
      } else if (replaceEdited) {
        // The extent of an edited block is unknown. Replace only the first
        // line that the user explicitly chose to replace; preserve the rest.
        const newline = prompt.indexOf("\n");
        next = text + (newline < 0 ? "" : prompt.slice(newline));
      } else {
        setPrefillNotice("edited");
        return;
      }
      const write = target.setPrompt(next);
      const recordWrite = () => {
        insertedAnswer.current = { agentId, at };
        void saveOptionAnswerDraft(agentId, at, text);
        setPrefillNotice(null);
      };
      if (write) {
        prefillPending.current = true;
        setPrefillBusy(true);
        void write.then(recordWrite, () => setPrefillNotice("unavailable")).finally(() => {
          prefillPending.current = false;
          setPrefillBusy(false);
        });
      } else recordWrite();
    } catch {
      setPrefillNotice("unavailable");
    }
  };
  const select = (letter: string) => {
    const before = getOptionSessionAt(agentId, at);
    if (!before || before.at !== at || before.readOnly || before.sending || prefillPending.current || status === "running") return;
    const clickPrompt = latestComposer.current?.prompt;
    const wasAnswered = before.choices[index] !== undefined;
    const previewPending = !wasAnswered && Object.keys(before.customConfirmed).length > 0 && before.set.questions.every((_, i) => i === index || before.choices[i] !== undefined) && preparePreview();
    if (!wasAnswered && !previewPending) prepareQuestionSwitch();
    choose(agentId, index, letter, at);
    const after = getOptionSessionAt(agentId, at);
    if (useComposers && (getOptionAnswerDraft(agentId, at) || (insertedAnswer.current?.agentId === agentId && insertedAnswer.current.at === at)) && after && !after.readOnly) {
      const nextText = answerBlock();
      if (nextText !== null) prefill(nextText, clickPrompt);
    }
    cancelUnchangedSwitch(after?.activeQuestion ?? index);
    if (!after || wasAnswered) return;
    if (missingQuestion(agentId, at) === null) { if (!previewPending) focus("option-send"); }
    else focus(`option-row-${after.set.questions[after.activeQuestion]!.options[after.cursor[after.activeQuestion] ?? 0]!.letter}`);
  };
  const preparePreview = () => {
    if (Platform.OS !== "web") return false;
    const card = root.current;
    if (!card?.style || typeof card.getBoundingClientRect !== "function") return false;
    activeTransition.current?.();
    const scroller = card.closest?.<HTMLElement>('[data-testid="agent-chat-scroll"]') ?? null;
    const anchor = scroller?.style.overflowAnchor ?? "";
    if (scroller) scroller.style.overflowAnchor = "none";
    const height = card.getBoundingClientRect().height;
    pendingPreview.current = { card, height, scroller, scrollTop: scroller?.scrollTop ?? 0, anchor, previousHeight: card.style.height, previousOverflow: card.style.overflow };
    card.style.height = `${height}px`;
    card.style.overflow = "hidden";
    return true;
  };
  const openAndFocusCustom = () => {
    const current = getOptionSessionAt(agentId, at);
    if (!current || current.at !== at || current.activeQuestion !== index || current.readOnly || current.sending || status === "running") return;
    if (!current.customOpen[index]) {
      prepareResize(true);
      pendingCustomFocus.current = true;
      openCustom(agentId, index, at);
      setTimeout(() => {
        if (!pendingCustomFocus.current) return;
        pendingCustomFocus.current = false;
        const latest = getOptionSessionAt(agentId, at);
        if (latest?.at !== at || latest.activeQuestion !== index || !latest.customOpen[index] || latest.readOnly || latest.sending) return;
        if (Platform.OS === "web") root.current?.querySelector<HTMLElement>('[data-testid="option-custom-input"]')?.focus({ preventScroll: true });
        else customInput.current?.focus();
      }, 0);
    } else if (customInput.current && typeof customInput.current.focus === "function") {
      if (Platform.OS === "web") (customInput.current as unknown as HTMLElement).focus({ preventScroll: true });
      else customInput.current.focus();
    } else focus("option-custom-input");
  };
  const prepareResize = (opening: boolean) => {
    if (Platform.OS !== "web") return;
    const card = root.current;
    if (!card?.style || typeof card.getBoundingClientRect !== "function") return;
    // Keep the opening snapshot when a size callback arrives before its commit.
    if (pendingResize.current) return;
    const row = card.querySelector<HTMLElement>(`[data-testid="option-row-${customLetter}"]`);
    if (!row || typeof row.getBoundingClientRect !== "function") return;
    const input = opening ? null : customInput.current as unknown as HTMLElement | null;
    const height = card.getBoundingClientRect().height;
    const rowHeight = row.getBoundingClientRect().height;
    const inputHeight = input?.getBoundingClientRect?.().height ?? 0;
    activeTransition.current?.();
    const scroller = card.closest?.<HTMLElement>('[data-testid="agent-chat-scroll"]') ?? null;
    const anchor = scroller?.style.overflowAnchor ?? "";
    if (scroller) scroller.style.overflowAnchor = "none";
    pendingResize.current = { card, row, input, opening, height, rowHeight, inputHeight, scroller, scrollTop: scroller?.scrollTop ?? 0, anchor, previousHeight: card.style.height, previousOverflow: card.style.overflow };
    card.style.height = `${height}px`;
    card.style.overflow = "hidden";
  };
  const resizeCustomInput = (height: number) => {
    const current = getOptionSessionAt(agentId, at);
    if (current?.at !== at || current.activeQuestion !== index) return;
    const min = Math.max(44, tokens.fs(44));
    const capped = (value: number) => Math.max(min, Math.min(tokens.fs(72), value));
    if (capped(height) === capped(currentInputState.height)) return;
    prepareResize(false);
    updateInputState({ height });
  };
  const confirmCustomInput = () => {
    const current = getOptionSessionAt(agentId, at);
    if (current?.at !== at || current.activeQuestion !== index || !current.customOpen[index] || current.readOnly || current.sending || prefillPending.current) return;
    pendingCustomFocus.current = false;
    const clickPrompt = latestComposer.current?.prompt;
    const wasAnswered = current.choices[index] !== undefined;
    const previewPending = !wasAnswered && !!current.customDrafts[index]?.trim() && current.set.questions.every((_, i) => i === index || current.choices[i] !== undefined) && preparePreview();
    if (!wasAnswered && !previewPending) prepareQuestionSwitch();
    const result = confirmCustom(agentId, index, at);
    cancelUnchangedSwitch(getOptionSessionAt(agentId, at)?.activeQuestion ?? index);
    if (result === "blank") updateInputState({ empty: true });
    else if (result === "confirmed") {
      if (useComposers && (getOptionAnswerDraft(agentId, at) || (insertedAnswer.current?.agentId === agentId && insertedAnswer.current.at === at))) {
        const text = answerBlock();
        if (text !== null) prefill(text, clickPrompt);
      }
      updateInputState({ empty: false });
      if (!wasAnswered) {
        const after = getOptionSessionAt(agentId, at);
        if (after && missingQuestion(agentId, at) === null) { if (!previewPending) focus("option-send"); }
        else if (after) focus(`option-row-${after.set.questions[after.activeQuestion]!.options[after.cursor[after.activeQuestion] ?? 0]!.letter}`);
      }
    }
  };
  const handleCustomKey = (event: KeyboardEvent) => {
    if (disabled || event.defaultPrevented || event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    const current = getOptionSessionAt(agentId, at);
    if (current?.at !== at || current.activeQuestion !== index || !current.customOpen[index] || current.readOnly || current.sending) return;
    event.preventDefault(); event.stopPropagation();
    confirmCustomInput();
  };
  customKeyHandler.current = handleCustomKey;
  const keyboardProps = Platform.OS === "web" ? {
    ref: (node: View | null) => { root.current = node as unknown as HTMLElement | null; },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled || event.defaultPrevented || getOptionSessionAt(agentId, at)?.at !== at || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const target = event.target as HTMLElement;
      if (target.getAttribute?.("data-testid") === "option-custom-input" || target.closest?.('[data-testid="option-custom-input"]')?.getAttribute?.("data-testid") === "option-custom-input") return;
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
        moveCursor(agentId, index, next - (session.cursor[index] ?? 0), at);
        focus(`option-row-${question.options[next]!.letter}`);
      }
    },
  } : {};
  const renderQuestion = (index: number, measure = false) => {
    const question = session.set.questions[index]!;
    const customLetter = getOptionSessionAt(agentId, at)?.at === at ? customLetterFor(agentId, index, at)! : customAnswerLetter(question);
    const customOpen = !!session.customOpen[index];
    const customConfirmed = session.customConfirmed[index];
    return (
        <Animated.View key={index} testID={measure ? undefined : "option-question-content"} style={{ opacity: Platform.OS !== "web" ? fade : 1, gap: 8 }}>
          <Text selectable style={{ ...label, fontWeight: "700", marginBottom: 4 }}>{question.text}</Text>
          {question.options.map(option => {
            const selected = session.choices[index] === option.letter;
            const [first, ...rest] = option.text.split("\n");
            const rowStyle = { minHeight: 48, flexDirection: "row" as const, alignItems: "center" as const, gap: 10, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: readOnly ? tokens.border : selected ? tokens.accent : tokens.border, backgroundColor: readOnly ? tokens.surface2 : selected ? tokens.accentBg : tokens.surface1 };
            const contents = <>
              <Text style={{ ...label, color: readOnly ? tokens.foregroundMuted : selected ? tokens.accent : tokens.foregroundMuted, fontWeight: "700", overflow: "hidden", borderWidth: 1, borderColor: readOnly ? tokens.border : selected ? tokens.accent : tokens.border, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>{option.letter}</Text>
              <View style={{ flex: 1 }}><Text style={label}>{first}</Text>{rest.length ? <Text style={muted}>{rest.join("\n")}</Text> : null}</View>
              {option.recommended ? <Text style={{ ...muted, color: readOnly ? tokens.foregroundMuted : recommendedBadgeColor(tokens), overflow: "hidden", borderRadius: 10, backgroundColor: readOnly ? "transparent" : tokens.accentBg, paddingHorizontal: 8, paddingVertical: 3 }}>{t("answerCard.recommended")}</Text> : null}
              {selected ? <Text style={{ ...label, color: readOnly ? tokens.foregroundMuted : tokens.accent, fontWeight: "700" }}>✓</Text> : null}
            </>;
            return readOnly
              ? <View key={option.letter} testID={measure ? undefined : `option-row-${option.letter}`} accessibilityState={{ selected, disabled: true }} style={rowStyle}>{contents}</View>
              : <Pressable key={option.letter} {...focusProps(`option-row-${option.letter}`)} testID={`option-row-${option.letter}`} accessibilityRole="button" accessibilityState={{ selected, disabled }} accessibilityLabel={t("answerCard.optionLabel", { letter: option.letter, text: option.text })} disabled={disabled} onPress={() => select(option.letter)} style={[rowStyle, focusStyle(`option-row-${option.letter}`)]}>{contents}</Pressable>;
          })}
          {(() => {
            const rowId = `option-row-${customLetter}`;
            const customFocused = focused === rowId || focused === "option-custom-input";
            const rowStyle = { minHeight: 44, flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10, paddingHorizontal: customFocused ? 9 : 10, paddingVertical: 0, borderRadius: 8, borderWidth: customFocused ? 2 : 1, borderColor: readOnly ? tokens.border : customFocused ? (tokens.isDark ? tokens.foreground : tokens.accent) : customOpen ? (tokens.isDark ? tokens.foreground : withAlpha(tokens.accent, 0.55)) : tokens.border, backgroundColor: readOnly ? tokens.surface2 : customOpen ? tokens.accentBg : tokens.surface1 };
            const contents = <>
              <Text style={{ ...label, color: !readOnly && customOpen ? tokens.accent : tokens.foregroundMuted, fontWeight: "700", overflow: "hidden", borderWidth: 1, borderColor: !readOnly && customOpen ? tokens.accent : tokens.border, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3, marginTop: customFocused ? 8 : 9 }}>{customLetter}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                {readOnly ? <Text selectable style={label}>{customConfirmed ?? t("answerCard.other")}</Text> : customOpen ? <>
                  <TextInput ref={setCustomInput} {...(Platform.OS === "web" ? { onFocus: (event: { stopPropagation(): void }) => { event.stopPropagation(); setFocused("option-custom-input"); }, onBlur: (event: { stopPropagation(): void }) => { event.stopPropagation(); setFocused(current => current === "option-custom-input" ? null : current); } } : {})} testID="option-custom-input" accessibilityLabel={t("answerCard.other")} placeholder={t("answerCard.otherHint")} value={session.customDrafts[index] ?? ""} onChangeText={text => { if (getOptionSessionAt(agentId, at)?.at === at) { setCustomDraft(agentId, index, text, at); if (text.trim()) updateInputState({ empty: false }); } }} multiline numberOfLines={1} editable={!disabled} onContentSizeChange={event => resizeCustomInput(event.nativeEvent.contentSize.height)} style={[{ ...label, fontSize: width <= 390 ? Math.max(16, tokens.fs(16)) : label.fontSize, padding: 0, borderWidth: 0, lineHeight: tokens.fs(20), paddingVertical: Math.max(0, (Math.max(44, tokens.fs(44)) - tokens.fs(20)) / 2), minHeight: Math.max(44, tokens.fs(44)), maxHeight: Math.max(44, tokens.fs(72)), height: Math.max(44, tokens.fs(44), Math.min(tokens.fs(72), currentInputState.height)), marginVertical: customFocused ? -2 : -1, textAlignVertical: "top" }, Platform.OS === "web" ? { outlineStyle: "none" } as unknown as ViewStyle : undefined]} />
                  {currentInputState.empty ? <Text testID="option-custom-empty" accessibilityLiveRegion="polite" style={{ ...muted, color: tokens.danger }}>{t("answerCard.otherEmpty")}</Text> : null}
                </> : <><Text style={label}>{t("answerCard.other")}</Text><Text style={muted}>{t("answerCard.otherHint")}</Text></>}
              </View>
              {readOnly && customConfirmed !== undefined ? <Text style={{ ...label, color: tokens.foregroundMuted, fontWeight: "700" }}>✓</Text> : null}
            </>;
            return readOnly
              ? <View testID={measure ? undefined : rowId} accessibilityState={{ selected: customOpen, disabled: true }} style={rowStyle}>{contents}</View>
              : <Pressable {...focusProps(rowId)} {...(Platform.OS === "web" ? { "aria-pressed": customOpen } : {})} testID={rowId} accessibilityRole="button" accessibilityState={{ selected: customOpen, disabled }} disabled={disabled} onPress={openAndFocusCustom} style={[rowStyle, Platform.OS === "web" ? { outlineStyle: "none" } as unknown as ViewStyle : undefined]}>{contents}</Pressable>;
          })()}
          {!readOnly && customOpen ? <Pressable {...focusProps("option-custom-confirm")} testID="option-custom-confirm" accessibilityRole="button" disabled={disabled} onPress={confirmCustomInput} style={[{ minHeight: 44, justifyContent: "center", alignItems: "center" }, focusStyle("option-custom-confirm")]}><Text style={label}>{t("answerCard.next")}</Text></Pressable> : null}
        </Animated.View>
    );
  };
  return (
    <View {...keyboardProps} testID="option-card" accessibilityState={{ disabled: readOnly }} style={{ marginTop: 12, borderWidth: 1, borderColor: tokens.border, borderRadius: 12, backgroundColor: session.followupStatus === "waiting" ? (tokens.isDark ? tokens.surface0 : "#ffffff") : session.followupStatus === "ended" ? (tokens.isDark ? tokens.surface1 : "#f0f0f0") : tokens.surface1, opacity: readOnly && !session.followupStatus ? 0.55 : 1 }}>
      <View style={{ padding: 16, gap: 12 }}>
        {session.followupStatus === "waiting" ? <Text testID="option-followup-heading" style={muted}>{locale?.startsWith("zh") ? `答题卡 · 已答 ${answeredCount}/${session.set.questions.length} · 未完成` : `Answer card · ${answeredCount} / ${session.set.questions.length} answered · Incomplete`}</Text> : null}
        {session.followupStatus === "ended" ? <Text testID="option-followup-heading" style={muted}>{locale?.startsWith("zh") ? `答题卡 · 已答 ${answeredCount}/${session.set.questions.length} · 已结束` : `Answer card · ${answeredCount} / ${session.set.questions.length} answered · Ended`}</Text> : null}
        {session.followupStatus === "waiting" ? <Text testID="option-saved-position" style={muted}>{locale?.startsWith("zh") ? `上次停在 Q${number(session.activeQuestion)}，进度已保存。` : `You stopped at Q${number(session.activeQuestion)}. Your progress is saved.`}</Text> : null}
        {session.followupStatus === "ended" ? <Text testID="option-ended-message" style={muted}>{locale?.startsWith("zh") ? "这组题已结束，不能再修改。" : "This card has ended and can't be edited."}</Text> : null}
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
            const tabLabel = <Text style={{ ...label, color: i === index ? tokens.foreground : tokens.foregroundMuted, fontWeight: i === index ? "700" : "400" }}>{Platform.OS === "web" && !readOnly && i === index && answer !== null && customText !== undefined ? <><Text testID="option-confirmed-check" style={{ display: "inline-block" } as unknown as ViewStyle}>✓</Text>{tabText.slice(1)}</> : tabText}</Text>;
            if (session.followupStatus === "ended") return <View key={i} testID={`option-question-${i}`} accessibilityState={{ selected: i === index, disabled: true }} style={tabStyle}>{tabLabel}</View>;
            return <Pressable key={i} testID={`option-question-${i}`} accessibilityRole="tab" accessibilityState={{ selected: i === index }} disabled={!readOnly && disabled} {...(Platform.OS === "web" && readOnly ? { focusable: true, tabIndex: 0, onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { if (event.key === " ") { event.preventDefault(); switchQuestion(i); } } } : {})} onPress={() => switchQuestion(i)} style={tabStyle}>{tabLabel}</Pressable>;
          })}
          {useComposers && !readOnly && answer !== null ? <Text testID="option-prefill-status" style={muted}>{locale?.startsWith("zh") ? `已选 ${answerIndex(agentId, at)} · 还没发送` : locale?.startsWith("ja") ? `選択済み ${answerIndex(agentId, at)} · 未送信` : `Selected ${answerIndex(agentId, at)} · Not sent`}</Text> : null}
          {session.followupStatus === "waiting" && getOptionSession(agentId)?.at === at ? <Pressable testID="option-resume" accessibilityRole="button" onPress={() => { void resumeAnswerDraft(agentId, at).then(ok => {
            setResumeRetry(!ok);
            if (ok && Platform.OS === "web") setTimeout(() => {
              const card = root.current;
              card?.scrollIntoView?.({ block: "nearest" });
              const active = getOptionSessionAt(agentId, at);
              if (!active || active.readOnly) return;
              const first = active.set.questions[active.activeQuestion]?.options[0];
              if (first) card?.querySelector<HTMLElement>(`[data-testid="option-row-${first.letter}"]`)?.focus({ preventScroll: true });
            }, 0);
          }).catch(() => setResumeRetry(true)); }} style={{ minHeight: 44, justifyContent: "center" }}><Text>{locale?.startsWith("zh") ? "继续作答" : "Continue answering"}</Text></Pressable> : null}
          {resumeRetry ? <Text testID="option-resume-retry" accessibilityRole="alert">{locale?.startsWith("zh") ? "请再点一次" : "Please try again"}</Text> : null}
          {readOnly && !session.followupStatus ? <Text testID="option-read-only-status" style={{ ...muted, marginLeft: "auto" }}>{t("answerCard.readOnlyStatus")}</Text> : null}
          {!readOnly && !session.sending ? <Pressable testID="option-dismiss" accessibilityRole="button" onPress={() => { if (getOptionSessionAt(agentId, at)?.at === at) dismiss(agentId, at); }} style={{ minHeight: 44, justifyContent: "center", marginLeft: "auto" }}><Text style={muted}>{t("answerCard.notOptions")}</Text></Pressable> : null}
        </View>
        {session.followupStatus === "waiting" ? <Text testID="option-current-question" style={muted}>{locale?.startsWith("zh") ? `Q${number(session.activeQuestion)} · 当前题` : `Q${number(session.activeQuestion)} · Current question`}</Text> : null}
        <Text testID="option-progress" style={muted}>{t("answerCard.progress", { chosen: answeredCount, total: session.set.questions.length, remaining: session.set.questions.length - answeredCount })}</Text>
        {prefillNotice ? <View>
          <Text testID="option-prefill-notice" accessibilityRole="alert" style={{ ...muted, color: tokens.danger }}>{prefillNotice === "edited" ? "The answer block was edited or its record is missing." : prefillNotice === "changed" ? "The composer changed meanwhile. Please try again." : (locale?.startsWith("zh") ? "无法更新输入框，请稍后重试。" : locale?.startsWith("ja") ? "入力欄を更新できません。後でもう一度お試しください。" : "Could not update the composer. Please try again.")}</Text>
          {prefillNotice === "edited" ? <><Text testID="option-prefill-limitation" style={muted}>{locale?.startsWith("zh") ? "你改过答案后再点「替换第一行」，只换第一行；多行答案的其余部分会留着，请自己删。" : "If you edited the answer and then choose Replace first line, only the first line is replaced; the rest of a multi-line answer stays for you to remove."}</Text><View style={{ flexDirection: "row", gap: 12 }}>
            <Pressable testID="option-replace-first-line" accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }} onPress={() => { const clickPrompt = latestComposer.current?.prompt; const text = answerBlock(); if (text !== null) prefill(text, clickPrompt, true); }}><Text style={label}>Replace first line</Text></Pressable>
            <Pressable testID="option-keep-edited-first-line" accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center" }} onPress={() => setPrefillNotice(null)}><Text style={label}>Keep edited text</Text></Pressable>
          </View></> : null}
        </View> : null}
        {readOnly && Platform.OS === "web" ? <View style={{ backgroundColor: tokens.surface1 }} ref={(node: View | null) => {
          const frame = node as unknown as HTMLElement | null;
          if (!frame?.style) return;
          frame.style.display = "grid";
          Array.from(frame.children).forEach(child => { (child as HTMLElement).style.gridArea = "1 / 1"; });
        }}>
          {session.set.questions.map((_, i) => i === index ? renderQuestion(i) : <View key={i} testID="option-question-measure" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...({ "aria-hidden": true } as object)} style={{ visibility: "hidden", pointerEvents: "none" } as ViewStyle}>{renderQuestion(i, true)}</View>)}
        </View> : renderQuestion(index)}
        {session.error ? <Text testID="option-send-error" accessibilityRole="alert" style={{ ...muted, color: tokens.danger }}>{t("answerCard.error", { reason: session.error })}</Text> : null}
      </View>
      {readOnly ? <View style={{ padding: 16, borderTopWidth: 1, borderColor: tokens.border }}><Text testID="option-answered" style={muted}>{`Answered in the chat: ${session.answeredText}`}</Text></View> : <View style={{ flexDirection: hasCustomAnswer ? "column" : "row", alignItems: hasCustomAnswer ? "stretch" : "center", justifyContent: "space-between", gap: 8, padding: 16, borderTopWidth: 1, borderColor: tokens.border, borderBottomLeftRadius: 11, borderBottomRightRadius: 11, backgroundColor: tokens.surface2 }}>
        {hasCustomAnswer && answer !== null ? <Text testID="option-send-preview" selectable style={{ ...label, color: tokens.foregroundMuted }}>{answer}</Text> : null}
        {Platform.OS === "web" || (customOpen && customConfirmed === undefined) ? <Text testID="option-hint" style={{ ...muted, lineHeight: hintHeight, minHeight: hintHeight, fontFamily: customOpen && customConfirmed === undefined ? tokens.fontUi : tokens.fontMono, flexShrink: 1 }}>{customOpen && customConfirmed === undefined
          ? t("answerCard.hintCustom")
          : focused === "option-send"
          ? useComposers ? (locale?.startsWith("zh") ? "↵ 放入输入框" : locale?.startsWith("ja") ? "↵ 入力欄に追加" : "↵ put in composer") : t("answerCard.hintSend").replace(/^Tab →\s*/, "↵ ").toLowerCase()
          : `${t("answerCard.hintMove").replace(/^↑\s*↓/, "↑↓")} · ↵ ${t("answerCard.hintPick").replace(/^A B C D\s*/, "")}`}</Text> : <View testID="option-hint-slot" style={{ minHeight: hintHeight }} />}
        <Pressable {...focusProps("option-send")} testID="option-send" accessibilityRole="button" accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled} focusable={!sendDisabled} onPress={() => {
          const clickPrompt = latestComposer.current?.prompt;
          const current = getOptionSessionAt(agentId, at);
          if (!current || current.at !== at || sendDisabled) return;
          if (draftReady) {
            if (Platform.OS === "web") root.current?.querySelector<HTMLElement>('[data-testid="option-send"]')?.blur();
            setFocused(null);
            confirmCustom(agentId, index, at);
            const next = missingQuestion(agentId, at);
            if (next !== null) {
              setActiveQuestion(agentId, next, at);
              const after = getOptionSessionAt(agentId, at);
              if (after) {
                // Always start at the first control, regardless of cursor or recommendation.
                const first = after.set.questions[next]!.options[0];
                focus(first ? `option-row-${first.letter}` : after.customOpen[next] ? "option-custom-input" : `option-question-${next}`);
              }
              return;
            }
          }
          if (useComposers) {
            const text = answerBlock();
            if (text !== null) prefill(text, clickPrompt);
            return;
          }
          if (missingQuestion(agentId, at) === null) {
            pendingSendFocusAgents.set(focusCardKey(agentId, at), Date.now());
          }
          prepareSend(draftReady);
          const pending = pendingSend.current;
          const finishSend = () => {
            if (!getOptionSessionAt(agentId, at)?.readOnly) {
              pendingSendFocusAgents.delete(focusCardKey(agentId, at));
              if (pendingSend.current === pending) { pending?.stop(); pendingSend.current = null; }
              if (Platform.OS === "web") setTimeout(() => {
                const current = getOptionSessionAt(agentId, at);
                if (!current || current.at !== at || current.readOnly || current.sending) return;
                const send = root.current?.querySelector<HTMLElement>('[data-testid="option-send"]');
                if (send && !(send as HTMLButtonElement).disabled && send.getAttribute?.("aria-disabled") !== "true") send.focus({ preventScroll: true });
              }, 0);
            }
          };
          void sendAnswer(agentId, at).then(finishSend).catch(finishSend);
        }} style={[{ minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderStyle: "solid", borderColor: sendDisabled ? tokens.foregroundMuted : tokens.accent, backgroundColor: sendDisabled ? "transparent" : tokens.accent }, focusStyle(sendDisabled ? "" : "option-send")]}>
          <Text style={{ ...label, color: sendDisabled ? tokens.foregroundMuted : tokens.accentForeground, fontWeight: "700" }}>{customOpen && customConfirmed === undefined ? t("answerCard.sendAction") : missing === null ? useComposers ? (locale?.startsWith("zh") ? `放入输入框 ${answerIndex(agentId, at) ?? ""}` : locale?.startsWith("ja") ? `入力欄に追加 ${answerIndex(agentId, at) ?? ""}` : `Put in composer ${answerIndex(agentId, at) ?? ""}`) : t("answerCard.send", { answer: answerIndex(agentId, at) ?? "" }) : t("answerCard.missing", { question: number(missing) })}</Text>
        </Pressable>
      </View>}
    </View>
  );
}
