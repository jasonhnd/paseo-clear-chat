import { useCallback, useSyncExternalStore } from "react";
import { parseOptionQuestions } from "./option-questions";
import type { OptionQuestionSet } from "./option-questions";
import { customAnswerLetter, formatCustomAnswers } from "./option-custom-answer";
import type { ConfirmedOptionAnswer } from "./option-custom-answer";
import { getEnhancerPreferences, onEnhancerPreferencesReady, saveDismissedOptionReply } from "./preferences";

export interface OptionSession {
  at: number;
  set: OptionQuestionSet;
  choices: Record<number, string | undefined>;
  notes: Record<number, string | undefined>;
  customDrafts: Record<number, string>;
  customConfirmed: Record<number, string>;
  customOpen: Record<number, boolean>;
  activeQuestion: number;
  cursor: number[];
  dismissed: boolean;
  readOnly: boolean;
  sending: boolean;
  error: string | null;
  answeredText: string | null;
  answerAt: number | null;
}

type Sender = (agentId: string, text: string) => Promise<unknown>;
const replies = new Map<string, number>();
const messages = new Map<string, Map<number, string>>();
const replyTimes = new Map<string, Set<number>>();
const snapshots = new Map<string, Map<number, OptionSession>>();
const listeners = new Set<() => void>();
const pending = new Set<string>();
let sender: Sender | null = null;

function notify(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* One subscriber must not block the rest. */ }
  }
}

export function subscribeOptionSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getOptionSessionAgents(): string[] { return [...snapshots.keys()]; }

export function getOptionSession(agentId: string, at = replies.get(agentId)): OptionSession | null {
  if (at === undefined) return null;
  const session = snapshots.get(agentId)?.get(at);
  return session && (at === replies.get(agentId) || session.readOnly) ? session : null;
}

function isDismissed(agentId: string, at: number): boolean {
  return getEnhancerPreferences().dismissedOptionReplies.some(entry => entry.agentId === agentId && entry.at === at);
}

onEnhancerPreferencesReady(() => {
  let changed = false;
  for (const [agentId, sessions] of snapshots) {
    for (const [at] of sessions) {
      if (isDismissed(agentId, at)) changed = sessions.delete(at) || changed;
    }
  }
  if (changed) notify();
});

export function useOptionSession(agentId: string, at?: number): OptionSession | null {
  const read = useCallback(() => getOptionSession(agentId, at), [agentId, at]);
  return useSyncExternalStore(subscribeOptionSession, read, read);
}

// Only recognize complete, unambiguous letter answers; arbitrary chat text remains prose.
function typedChoices(set: OptionQuestionSet, text: string): Record<number, string> {
  const parts = text.trim().toUpperCase().split(/\s+/);
  const choices: Record<number, string> = {};
  for (const part of parts) {
    const match = /^([A-Z]?[0-9]+)?([A-H])$/.exec(part);
    if (!match) return {};
    const index = match[1] === undefined && set.questions.length === 1 ? 0
      : set.questions.findIndex((question, i) => String(question.number ?? i + 1).toUpperCase() === match[1]);
    if (index < 0 || choices[index] !== undefined || !set.questions[index]!.options.some(option => option.letter === match[2])) return {};
    choices[index] = match[2]!;
  }
  return choices;
}

function reconcileAnswers(agentId: string): boolean {
  const sessions = snapshots.get(agentId);
  if (!sessions) return false;
  const times = [...(replyTimes.get(agentId) ?? [])].sort((a, b) => a - b);
  const userMessages = [...(messages.get(agentId) ?? [])].sort(([a], [b]) => a - b);
  let changed = false;
  for (const [at, session] of sessions) {
    const nextReply = times.find(time => time > at) ?? Infinity;
    const answer = userMessages.find(([time]) => time > at && time < nextReply);
    if (answer && (session.answeredText === null || (session.answerAt !== null && session.answerAt !== answer[0]))) {
      const sent = session.sending && sessionAnswerText(session) === answer[1];
      sessions.set(at, { ...session, choices: sent ? session.choices : typedChoices(session.set, answer[1]), customConfirmed: sent ? session.customConfirmed : {}, customOpen: sent ? session.customOpen : {}, readOnly: true, answeredText: answer[1], answerAt: answer[0], error: null });
      changed = true;
    } else if (!answer && session.answerAt !== null) {
      sessions.set(at, { ...session, choices: {}, customConfirmed: {}, customOpen: {}, readOnly: false, answeredText: null, answerAt: null });
      changed = true;
    }
  }
  return changed;
}

export function publishAssistantReply(agentId: string, reply: { at: number; text: string }): void {
  if (!Number.isFinite(reply.at)) return;
  let times = replyTimes.get(agentId);
  if (!times) replyTimes.set(agentId, times = new Set());
  if (times.has(reply.at)) return;
  times.add(reply.at);
  const latest = replies.get(agentId) ?? -Infinity;
  if (reply.at > latest) replies.set(agentId, reply.at);
  const set = !isDismissed(agentId, reply.at) ? parseOptionQuestions(reply.text) : null;
  if (set) {
    let sessions = snapshots.get(agentId);
    if (!sessions) snapshots.set(agentId, sessions = new Map());
    sessions.set(reply.at, {
      at: reply.at, set, choices: {}, notes: {}, customDrafts: {}, customConfirmed: {}, customOpen: {}, activeQuestion: 0,
      cursor: set.questions.map(question => Math.max(0, question.options.findIndex(option => option.recommended))),
      dismissed: false, readOnly: false, sending: false, error: null, answeredText: null, answerAt: null,
    });
  }
  const changed = reconcileAnswers(agentId);
  if (reply.at > latest || changed) notify();
}

export function publishUserMessage(agentId: string, at: number, text = ""): void {
  if (!Number.isFinite(at)) return;
  let userMessages = messages.get(agentId);
  if (!userMessages) messages.set(agentId, userMessages = new Map());
  if (userMessages.has(at)) return;
  userMessages.set(at, text);
  if (reconcileAnswers(agentId)) notify();
}

function update(agentId: string, change: (snapshot: OptionSession) => OptionSession): void {
  const previous = getOptionSession(agentId);
  if (!previous) return;
  const next = change(previous);
  if (next === previous) return;
  snapshots.get(agentId)!.set(previous.at, next);
  notify();
}

export function choose(agentId: string, questionIndex: number, letter: string): void {
  update(agentId, snapshot => {
    if (snapshot.readOnly || snapshot.sending || !snapshot.set.questions[questionIndex]?.options.some(option => option.letter === letter) || snapshot.choices[questionIndex] === letter) return snapshot;
    const wasAnswered = snapshot.choices[questionIndex] !== undefined;
    const choices = { ...snapshot.choices, [questionIndex]: letter };
    const count = snapshot.set.questions.length;
    const next = Array.from({ length: count }, (_, offset) => (questionIndex + 1 + offset) % count)
      .find(i => choices[i] === undefined) ?? -1;
    const customConfirmed = { ...snapshot.customConfirmed };
    delete customConfirmed[questionIndex];
    return { ...snapshot, choices, customConfirmed, customOpen: { ...snapshot.customOpen, [questionIndex]: false }, activeQuestion: wasAnswered || next < 0 ? snapshot.activeQuestion : next };
  });
}

export function openCustom(agentId: string, questionIndex: number): void {
  update(agentId, snapshot => {
    if (snapshot.readOnly || snapshot.sending || !snapshot.set.questions[questionIndex]) return snapshot;
    if (snapshot.customOpen[questionIndex] && snapshot.choices[questionIndex] === undefined && snapshot.customConfirmed[questionIndex] === undefined) return snapshot;
    const choices = { ...snapshot.choices };
    const customConfirmed = { ...snapshot.customConfirmed };
    delete choices[questionIndex];
    delete customConfirmed[questionIndex];
    return { ...snapshot, choices, customConfirmed, customOpen: { ...snapshot.customOpen, [questionIndex]: true } };
  });
}

export function setCustomDraft(agentId: string, questionIndex: number, text: string): void {
  update(agentId, snapshot => {
    if (snapshot.readOnly || snapshot.sending || !snapshot.set.questions[questionIndex] || snapshot.customDrafts[questionIndex] === text) return snapshot;
    const customDrafts = { ...snapshot.customDrafts, [questionIndex]: text };
    if (snapshot.customConfirmed[questionIndex] === undefined || snapshot.customConfirmed[questionIndex] === text) return { ...snapshot, customDrafts };
    const customConfirmed = { ...snapshot.customConfirmed };
    const choices = { ...snapshot.choices };
    delete customConfirmed[questionIndex];
    delete choices[questionIndex];
    return { ...snapshot, customDrafts, customConfirmed, choices };
  });
}

export function confirmCustom(agentId: string, questionIndex: number): "confirmed" | "blank" | "ignored" {
  let result: "confirmed" | "blank" | "ignored" = "ignored";
  update(agentId, snapshot => {
    const question = snapshot.set.questions[questionIndex];
    if (snapshot.readOnly || snapshot.sending || !question) return snapshot;
    const draft = snapshot.customDrafts[questionIndex] ?? "";
    if (!draft.trim()) {
      result = "blank";
      if (snapshot.customConfirmed[questionIndex] === undefined) return snapshot;
      const customConfirmed = { ...snapshot.customConfirmed };
      delete customConfirmed[questionIndex];
      return { ...snapshot, customConfirmed };
    }
    result = "confirmed";
    const wasAnswered = snapshot.choices[questionIndex] !== undefined;
    const choices = { ...snapshot.choices, [questionIndex]: customAnswerLetter(question) };
    const count = snapshot.set.questions.length;
    const next = Array.from({ length: count }, (_, offset) => (questionIndex + 1 + offset) % count)
      .find(i => choices[i] === undefined) ?? -1;
    return { ...snapshot, choices, customConfirmed: { ...snapshot.customConfirmed, [questionIndex]: draft }, customOpen: { ...snapshot.customOpen, [questionIndex]: true }, activeQuestion: wasAnswered || next < 0 ? snapshot.activeQuestion : next };
  });
  return result;
}

export function customLetterFor(agentId: string, questionIndex: number): string | null {
  const question = getOptionSession(agentId)?.set.questions[questionIndex];
  return question ? customAnswerLetter(question) : null;
}

export function clearChoice(agentId: string, questionIndex: number): void {
  update(agentId, snapshot => {
    if (snapshot.readOnly || snapshot.sending || snapshot.choices[questionIndex] === undefined) return snapshot;
    const choices = { ...snapshot.choices };
    const customConfirmed = { ...snapshot.customConfirmed };
    delete choices[questionIndex];
    delete customConfirmed[questionIndex];
    return { ...snapshot, choices, customConfirmed };
  });
}

export function setNote(agentId: string, questionIndex: number, note: string): void {
  update(agentId, snapshot => {
    if (snapshot.readOnly || snapshot.sending || !snapshot.set.questions[questionIndex] || (snapshot.notes[questionIndex] ?? "") === note) return snapshot;
    return { ...snapshot, notes: { ...snapshot.notes, [questionIndex]: note } };
  });
}

export function setActiveQuestion(agentId: string, questionIndex: number): void {
  update(agentId, snapshot => {
    if (snapshot.readOnly || snapshot.sending || !Number.isInteger(questionIndex) || !snapshot.set.questions[questionIndex] || snapshot.activeQuestion === questionIndex) return snapshot;
    return { ...snapshot, activeQuestion: questionIndex };
  });
}

export function moveCursor(agentId: string, questionIndex: number, delta: number): void {
  update(agentId, snapshot => {
    const question = snapshot.set.questions[questionIndex];
    const current = snapshot.cursor[questionIndex];
    if (snapshot.readOnly || snapshot.sending || !question || current === undefined || !Number.isInteger(delta)) return snapshot;
    const next = Math.max(0, Math.min(question.options.length - 1, current + delta));
    if (next === current) return snapshot;
    const cursor = snapshot.cursor.slice();
    cursor[questionIndex] = next;
    return { ...snapshot, cursor };
  });
}

export function retireOptionSession(agentId: string): void {
  const at = replies.get(agentId);
  if (at !== undefined && snapshots.get(agentId)?.delete(at)) notify();
}

export function dismiss(agentId: string): void {
  const session = getOptionSession(agentId);
  if (!session || session.readOnly || session.sending) return;
  retireOptionSession(agentId);
  void saveDismissedOptionReply(agentId, session.at);
}

export function missingQuestion(agentId: string): number | null {
  const snapshot = getOptionSession(agentId);
  if (!snapshot) return null;
  const index = snapshot.set.questions.findIndex((_, i) => snapshot.choices[i] === undefined);
  return index < 0 ? null : index;
}

function sessionAnswer(snapshot: OptionSession): ReturnType<typeof formatCustomAnswers> {
  const choices: Record<number, ConfirmedOptionAnswer> = {};
  snapshot.set.questions.forEach((_, index) => {
    const letter = snapshot.choices[index];
    const content = snapshot.customConfirmed[index];
    if (letter !== undefined) choices[index] = content !== undefined
      ? { kind: "custom", letter, content }
      : { kind: "option", letter, note: snapshot.notes[index] };
  });
  return formatCustomAnswers(snapshot.set, choices);
}

function sessionAnswerText(snapshot: OptionSession): string | null {
  return sessionAnswer(snapshot)?.message ?? null;
}

export function answerText(agentId: string): string | null {
  const snapshot = getOptionSession(agentId);
  return snapshot ? sessionAnswerText(snapshot) : null;
}

export function answerIndex(agentId: string): string | null {
  const snapshot = getOptionSession(agentId);
  return snapshot ? sessionAnswer(snapshot)?.index ?? null : null;
}

export function setOptionSender(next: Sender | null): void { sender = next; }

export async function sendAnswer(agentId: string): Promise<void> {
  const snapshot = getOptionSession(agentId);
  const text = answerText(agentId);
  if (!snapshot || snapshot.readOnly || text === null || pending.has(agentId)) return;
  const send = sender;
  if (!send) {
    update(agentId, current => current.error === "Sender unavailable" ? current : { ...current, error: "Sender unavailable" });
    return;
  }
  pending.add(agentId);
  update(agentId, current => ({ ...current, sending: true }));
  try {
    await send(agentId, text);
    const current = snapshots.get(agentId)?.get(snapshot.at);
    if (current) {
      snapshots.get(agentId)!.set(snapshot.at, { ...current, sending: false, readOnly: true, answeredText: current.answeredText ?? text, error: null });
      notify();
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 160) || "Send failed";
    const current = snapshots.get(agentId)?.get(snapshot.at);
    if (current) {
      snapshots.get(agentId)!.set(snapshot.at, { ...current, sending: false, error: message });
      notify();
    }
  } finally {
    pending.delete(agentId);
  }
}
