import { useCallback, useSyncExternalStore } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { isSystemEnvelope } from "../shared/envelope";
import {
  hasNewerAnswerCard,
  listOptionSessions,
  publishAssistantReply,
  publishUserMessage,
  subscribeOptionSession,
  type OptionSession,
} from "./option-session";

/**
 * Feeds answer-card state from an agent's timeline.
 *
 * A committed projected row is published with its timestamp and text, including
 * a blank assistant row: the old renderer published that text, and the row's
 * time keeps a later user message from answering the previous card. A row whose
 * turn is still the agent's active turn is withheld. The active turn is read
 * again on every reload, so a missed end event cannot hide the finished reply.
 * System envelopes are not the model's words and are not published.
 */

const READ_RETRY_DELAYS_MS = [10, 20, 40];
// One summary object per agent while the card's identity does not change (see below).
const cardSnapshots = new Map<string, AnswerCardSummary | null>();
const RESUBSCRIBE_DELAYS_MS = [10, 20, 40];

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];
type Unsubscribe = ReturnType<AgentHandle["timeline"]["subscribe"]>;

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

function warnFeed(message: string, error: unknown): void {
  console.warn(`Clear Chat answer feed ${message}`, error);
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
    if (session.dismissed || session.superseded) continue;
    // A card with a valid draft that an ordinary follow-up message pushed into the
    // waiting state is read-only until the reader continues it, but it must stay
    // reachable: the composer button is the only way back to the card. A card that a
    // newer answer card replaced is ended and stays off the button.
    if (session.readOnly && !(session.followupStatus === "waiting" && !hasNewerAnswerCard(agentId, session.at))) continue;
    if (!best || session.at > best.at) best = session;
  }
  const next = best ? { agentId, at: best.at, questionCount: best.set.questions.length, answeredCount: answeredCount(best) } : null;
  // `useCurrentAnswerCard` hands this straight to `useSyncExternalStore`, which re-reads it
  // after every commit and compares by identity: a fresh object each read re-renders until
  // React throws error #185. The same card keeps the same summary object.
  const cached = cardSnapshots.get(agentId) ?? null;
  if (cached && next && cached.at === next.at && cached.questionCount === next.questionCount && cached.answeredCount === next.answeredCount) return cached;
  if (!cached && !next) return null;
  cardSnapshots.set(agentId, next);
  return next;
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
      if (isSystemEnvelope(item.text)) continue;
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

export function startAnswerFeed(input: { serverId: string; agentId: string; client?: PaseoApi; history?: "tail" | "full" }): AnswerFeed {
  // A surface that only needs the newest reply reads the tail page first; `full` (the default)
  // walks every older page up front for surfaces that list earlier cards.
  const firstSyncFull = (input.history ?? "full") !== "tail";
  const api = input.client ?? getPaseoClient(input.serverId);
  const handle = api.agents.ref(input.agentId);
  let stopped = false;
  let accepting = false;
  let streamingTurnId: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let resubscribeAttempt = 0;
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeSleep: (() => void) | null = null;
  const queued: PaseoAgentTimelineEvent[] = [];

  const sync = async (full: boolean) => {
    const refreshed = await handle.refresh();
    streamingTurnId = refreshed?.agent.activeTurn?.turnId ?? null;
    const entries = await readPages(handle, full);
    if (!stopped) publishEntries(input.agentId, entries, streamingTurnId);
  };

  const sleep = (ms: number) => new Promise<void>(resolve => {
    wakeSleep = resolve;
    const timer = setTimeout(() => {
      if (wakeSleep === resolve) wakeSleep = null;
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    wakeSleep = finish;
  });

  const syncWithRetry = async (full: boolean) => {
    for (let attempt = 0; ; attempt += 1) {
      if (stopped) return;
      try {
        await sync(full);
        return;
      } catch (error) {
        warnFeed("could not read the timeline", error);
        const delay = READ_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || stopped) return;
        await sleep(delay);
      }
    }
  };

  const enqueue = (full: boolean) => {
    chain = chain.then(() => (stopped ? undefined : syncWithRetry(full))).catch(error => {
      warnFeed("could not read the timeline", error);
    });
  };

  const scheduleResubscribe = () => {
    if (stopped || resubscribeAttempt >= RESUBSCRIBE_DELAYS_MS.length) {
      if (!stopped) warnFeed("stopped retrying the timeline subscription", "retry limit");
      return;
    }
    const delay = RESUBSCRIBE_DELAYS_MS[resubscribeAttempt] ?? 40;
    resubscribeAttempt += 1;
    if (resubscribeTimer) clearTimeout(resubscribeTimer);
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null;
      if (stopped) return;
      current = handle.timeline.subscribe(onMessage);
      void current.ready.then(() => {
        resubscribeAttempt = 0;
        if (!stopped) enqueue(true);
      }).catch(error => {
        warnFeed("could not resubscribe to the timeline", error);
        scheduleResubscribe();
      });
    }, delay);
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
      if (streamingTurnId && event.turnId !== streamingTurnId) return;
      enqueue(false);
      return;
    }
    if (event.type === "replacement" || event.type === "subscription_restored") {
      enqueue(event.type === "replacement");
      return;
    }
    if (event.type === "error") {
      warnFeed("lost the timeline subscription", event.error);
      scheduleResubscribe();
      return;
    }
    if (event.type === "timeline") {
      if (event.item.type === "user_message") enqueue(false);
      else if (event.item.type === "assistant_message" && streamingTurnId === null) enqueue(false);
    }
  };

  let current: Unsubscribe = handle.timeline.subscribe(onMessage);
  const ready = (async () => {
    try {
      await current.ready;
    } catch (error) {
      warnFeed("could not subscribe to the timeline", error);
      if (!stopped) scheduleResubscribe();
    }
    if (stopped) return;
    await syncWithRetry(firstSyncFull);
    if (stopped) return;
    accepting = true;
    for (const message of queued.splice(0)) onMessage(message);
    await chain;
  })();

  return {
    ready,
    stop() {
      if (stopped) return;
      stopped = true;
      if (resubscribeTimer) clearTimeout(resubscribeTimer);
      resubscribeTimer = null;
      wakeSleep?.();
      wakeSleep = null;
      current();
    },
    currentCard: () => currentAnswerCard(input.agentId),
  };
}
