import { useCallback, useSyncExternalStore } from "react";
import { formatOptionAnswer, parseOptionQuestions } from "./option-questions";
import type { OptionChoice, OptionQuestionSet } from "./option-questions";
import { getEnhancerPreferences, onEnhancerPreferencesReady, saveDismissedOptionReply } from "./preferences";

export interface OptionSession {
  at: number;
  set: OptionQuestionSet;
  choices: Record<number, string | undefined>;
  notes: Record<number, string | undefined>;
  activeQuestion: number;
  cursor: number[];
  dismissed: boolean;
  readOnly: boolean;
  sending: boolean;
  error: string | null;
}

type Sender = (agentId: string, text: string) => Promise<unknown>;
const replies = new Map<string, number>();
const messages = new Map<string, number>();
const snapshots = new Map<string, OptionSession>();
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

export function getOptionSession(agentId: string): OptionSession | null {
  return snapshots.get(agentId) ?? null;
}

function isDismissed(agentId: string, at: number): boolean {
  return getEnhancerPreferences().dismissedOptionReplies.some(entry => entry.agentId === agentId && entry.at === at);
}

onEnhancerPreferencesReady(() => {
  let changed = false;
  for (const [agentId, session] of snapshots) {
    if (isDismissed(agentId, session.at)) changed = snapshots.delete(agentId) || changed;
  }
  if (changed) notify();
});

export function useOptionSession(agentId: string): OptionSession | null {
  const read = useCallback(() => getOptionSession(agentId), [agentId]);
  return useSyncExternalStore(subscribeOptionSession, read, read);
}

export function publishAssistantReply(agentId: string, reply: { at: number; text: string }): void {
  if (!Number.isFinite(reply.at) || reply.at <= (replies.get(agentId) ?? -Infinity)) return;
  replies.set(agentId, reply.at);
  const set = !isDismissed(agentId, reply.at) ? parseOptionQuestions(reply.text) : null;
  if (!set) {
    if (snapshots.delete(agentId)) notify();
    return;
  }
  snapshots.set(agentId, {
    at: reply.at, set, choices: {}, notes: {}, activeQuestion: 0,
    cursor: set.questions.map(question => Math.max(0, question.options.findIndex(option => option.recommended))),
    dismissed: false, readOnly: reply.at < (messages.get(agentId) ?? -Infinity), sending: false, error: null,
  });
  notify();
}

export function publishUserMessage(agentId: string, at: number): void {
  if (!Number.isFinite(at) || at <= (messages.get(agentId) ?? -Infinity)) return;
  messages.set(agentId, at);
  const snapshot = snapshots.get(agentId);
  if (snapshot && at > snapshot.at) {
    if (!snapshot.readOnly) { snapshots.set(agentId, { ...snapshot, readOnly: true }); notify(); }
  }
}

function update(agentId: string, change: (snapshot: OptionSession) => OptionSession): void {
  const previous = snapshots.get(agentId);
  if (!previous) return;
  const next = change(previous);
  if (next === previous) return;
  snapshots.set(agentId, next);
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
    return { ...snapshot, choices, activeQuestion: wasAnswered || next < 0 ? snapshot.activeQuestion : next };
  });
}

export function clearChoice(agentId: string, questionIndex: number): void {
  update(agentId, snapshot => {
    if (snapshot.choices[questionIndex] === undefined) return snapshot;
    const choices = { ...snapshot.choices };
    delete choices[questionIndex];
    return { ...snapshot, choices };
  });
}

export function setNote(agentId: string, questionIndex: number, note: string): void {
  update(agentId, snapshot => {
    if (!snapshot.set.questions[questionIndex] || (snapshot.notes[questionIndex] ?? "") === note) return snapshot;
    return { ...snapshot, notes: { ...snapshot.notes, [questionIndex]: note } };
  });
}

export function setActiveQuestion(agentId: string, questionIndex: number): void {
  update(agentId, snapshot => {
    if (!Number.isInteger(questionIndex) || !snapshot.set.questions[questionIndex] || snapshot.activeQuestion === questionIndex) return snapshot;
    return { ...snapshot, activeQuestion: questionIndex };
  });
}

export function moveCursor(agentId: string, questionIndex: number, delta: number): void {
  update(agentId, snapshot => {
    const question = snapshot.set.questions[questionIndex];
    const current = snapshot.cursor[questionIndex];
    if (!question || current === undefined || !Number.isInteger(delta)) return snapshot;
    const next = Math.max(0, Math.min(question.options.length - 1, current + delta));
    if (next === current) return snapshot;
    const cursor = snapshot.cursor.slice();
    cursor[questionIndex] = next;
    return { ...snapshot, cursor };
  });
}

export function retireOptionSession(agentId: string): void {
  if (snapshots.delete(agentId)) notify();
}

export function dismiss(agentId: string): void {
  const session = snapshots.get(agentId);
  if (!session) return;
  retireOptionSession(agentId);
  void saveDismissedOptionReply(agentId, session.at);
}

export function missingQuestion(agentId: string): number | null {
  const snapshot = snapshots.get(agentId);
  if (!snapshot) return null;
  const index = snapshot.set.questions.findIndex((_, i) => snapshot.choices[i] === undefined);
  return index < 0 ? null : index;
}

export function answerText(agentId: string): string | null {
  const snapshot = snapshots.get(agentId);
  if (!snapshot) return null;
  const choices: Record<number, OptionChoice> = {};
  snapshot.set.questions.forEach((_, index) => {
    const letter = snapshot.choices[index];
    if (letter !== undefined) choices[index] = { letter, note: snapshot.notes[index] };
  });
  return formatOptionAnswer(snapshot.set, choices);
}

export function setOptionSender(next: Sender | null): void { sender = next; }

export async function sendAnswer(agentId: string): Promise<void> {
  const snapshot = snapshots.get(agentId);
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
    update(agentId, current => current.at === snapshot.at ? { ...current, sending: false, readOnly: true, error: null } : current);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 160) || "Send failed";
    update(agentId, current => current.at === snapshot.at ? { ...current, sending: false, error: message } : current);
  } finally {
    pending.delete(agentId);
  }
}
