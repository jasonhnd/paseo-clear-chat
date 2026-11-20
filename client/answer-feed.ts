import { useCallback, useSyncExternalStore } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import {
  listOptionSessions,
  publishAssistantReply,
  publishUserMessage,
  subscribeOptionSession,
  type OptionSession,
} from "./option-session";

/**
 * Feeds answer-card state from an agent's timeline.
 *
 * A committed projected row is published with its timestamp and full text, the
 * same pair the old assistant renderer passed in. While that row's turn is
 * still open the host treats the reply as streaming, so it is withheld: the
 * first partial text would stick, because a later text at the same time is ignored.
 * System envelopes are not the model's words and are not published.
 */

const ENVELOPE_TAGS = new Set([
  "system-notice", "system-reminder", "irc", "system-interrupt", "paseo-system", "agent-response",
]);
const PROCESS_LINE = /^Supervised process ([\w.-]+) ((?:exited|started|stopped|restarted|failed|is ready)\b.*)$/;

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];

export interface AnswerCardSummary {
  agentId: string;
  at: number;
  questionCount: number;
  answeredCount: number;
}

export interface AnswerFeed {
  ready: Promise<void>;
  stop(): void;
  currentCard(): AnswerCardSummary | null;
}

function isSystemEnvelope(text: string): boolean {
  const trimmed = text.trim();
  const process = trimmed.match(PROCESS_LINE);
  if (process && !trimmed.includes("\n")) return true;
  const tag = trimmed.match(/^<([\w-]+)(?:\s[^>]*)?>/)?.[1]?.toLowerCase();
  return tag ? ENVELOPE_TAGS.has(tag) : false;
}

function answeredCount(session: OptionSession): number {
  const total = session.set.questions.length;
  let answered = 0;
  for (let i = 0; i < total; i += 1) {
    if (session.choices[i] !== undefined || session.customConfirmed[i] !== undefined) answered += 1;
  }
  return answered;
}

/** Latest finished, recognized, unanswered card. Dismissed cards are already gone. */
export function currentAnswerCard(agentId: string): AnswerCardSummary | null {
  let best: OptionSession | null = null;
  for (const session of listOptionSessions(agentId)) {
    if (session.dismissed || session.superseded || session.readOnly) continue;
    if (!best || session.at > best.at) best = session;
  }
  if (!best) return null;
  return { agentId, at: best.at, questionCount: best.set.questions.length, answeredCount: answeredCount(best) };
}

export function useCurrentAnswerCard(agentId: string): AnswerCardSummary | null {
  const read = useCallback(() => currentAnswerCard(agentId), [agentId]);
  return useSyncExternalStore(subscribeOptionSession, read, read);
}

function publishEntries(agentId: string, entries: readonly TimelineEntry[], streamingTurnId: string | null): void {
  const ordered = [...entries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.seqStart - b.seqStart);
  for (const entry of ordered) {
    const at = Date.parse(entry.timestamp);
    const item = entry.item;
    if (item.type === "user_message") {
      if (!isSystemEnvelope(item.text)) publishUserMessage(agentId, at, item.text);
    } else if (item.type === "assistant_message") {
      if (streamingTurnId && entry.turnId === streamingTurnId) continue;
      if (!item.text.trim() || isSystemEnvelope(item.text)) continue;
      publishAssistantReply(agentId, { at, text: item.text });
    }
  }
}

async function readPages(handle: AgentHandle, full: boolean): Promise<TimelineEntry[]> {
  const collected: TimelineEntry[] = [];
  const seen = new Set<string>();
  let page = await handle.timeline.refetch({
    direction: "tail",
    projection: "projected",
    ...(full ? {} : { wholeTurns: true }),
  });
  for (;;) {
    if (page.error || page.gap || page.staleCursor) throw new Error(page.error || "Timeline page is incomplete");
    collected.unshift(...page.entries);
    if (!full || !page.hasOlder || !page.startCursor) break;
    const cursor = page.startCursor;
    const key = `${cursor.epoch}:${cursor.seq}`;
    if (seen.has(key)) break;
    seen.add(key);
    page = await handle.timeline.refetch({ direction: "before", cursor, projection: "projected" });
  }
  return collected;
}

export function startAnswerFeed(input: { serverId: string; agentId: string; client?: PaseoApi }): AnswerFeed {
  const api = input.client ?? getPaseoClient(input.serverId);
  const handle = api.agents.ref(input.agentId);
  let stopped = false;
  let accepting = false;
  let streamingTurnId: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const queued: PaseoAgentTimelineEvent[] = [];

  const enqueue = (full: boolean) => {
    chain = chain.then(() => (stopped ? undefined : readPages(handle, full).then(entries => {
      if (!stopped) publishEntries(input.agentId, entries, streamingTurnId);
    }))).catch(() => undefined);
  };

  const onMessage = (message: PaseoAgentTimelineEvent) => {
    if (stopped || message.agentId !== input.agentId) return;
    if (!accepting) {
      queued.push(message);
      return;
    }
    const event = message.event;
    if (event.type === "turn_started") {
      streamingTurnId = event.turnId ?? streamingTurnId;
      return;
    }
    if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") {
      streamingTurnId = null;
      enqueue(false);
      return;
    }
    if (event.type === "replacement") {
      streamingTurnId = null;
      enqueue(true);
      return;
    }
    if (event.type === "subscription_restored") {
      enqueue(false);
      return;
    }
    if (event.type === "timeline") {
      if (event.item.type === "user_message") enqueue(false);
      else if (event.item.type === "assistant_message" && streamingTurnId === null) enqueue(false);
    }
  };

  const unsubscribe = handle.timeline.subscribe(onMessage);
  const ready = (async () => {
    await unsubscribe.ready;
    if (stopped) return;
    const refreshed = await handle.refresh();
    streamingTurnId = refreshed?.agent.activeTurn?.turnId ?? null;
    const entries = await readPages(handle, true);
    if (stopped) return;
    publishEntries(input.agentId, entries, streamingTurnId);
    accepting = true;
    for (const message of queued.splice(0)) onMessage(message);
    await chain;
  })();

  return {
    ready,
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
    currentCard: () => currentAnswerCard(input.agentId),
  };
}
