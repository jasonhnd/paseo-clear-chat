import { useCallback, useSyncExternalStore } from "react";
import { currentAnswerCard, type AnswerCardSummary } from "./answer-feed";
import { getOptionSession, subscribeOptionSession } from "./option-session";

/**
 * The answer card as a composer pill.
 *
 * The pin sits above the input of the conversation in front of the user and opens the whole
 * card in the host's popover (a sheet on compact layouts). The card body only draws the
 * conversation's current reply, so a card from an older reply cannot be shown in the popover:
 * `currentPillCard` drops it and the pin stays away instead of opening onto nothing.
 *
 * The host matches a composer pill to a composer by agent id, so one registration can never
 * show a card from another conversation.
 */

export const ANSWER_PILL_ID = "clear-chat-answer-card";

/** The newest unanswered card the card body can actually draw. */
export function currentPillCard(agentId: string): AnswerCardSummary | null {
  const card = currentAnswerCard(agentId);
  if (!card) return null;
  // `getOptionSession` is null for a card whose reply is no longer the conversation's last
  // one; `OptionCard` refuses to render that card, so neither does the pin.
  return getOptionSession(agentId, card.at) ? card : null;
}

export function useCurrentPillCard(agentId: string): AnswerCardSummary | null {
  const read = useCallback(() => currentPillCard(agentId), [agentId]);
  return useSyncExternalStore(subscribeOptionSession, read, read);
}

export interface AnswerPillFocus {
  workspaceId: string;
  agentId: string;
}

export interface AnswerPillRegistration {
  update(patch: AnswerPillRegistrationPatch): void;
  remove(): void;
}

export interface AnswerPillButton {
  id: string;
  workspaceId: string;
  agentId: string;
  button: {
    /** Plugin text: the host resolves a message in the app language, a string is used as is. */
    title: unknown;
    label: unknown;
    icon: string;
    visible: boolean;
    behavior: { kind: "popover"; Content: unknown };
  };
}

export interface AnswerPillRegistrationPatch {
  visible?: boolean;
  title?: unknown;
  label?: unknown;
}

/** Everything the pin reads outside itself, so a test can drive it without a host. */
export interface AnswerPillDeps {
  /** The conversation in front of the user, or null when none is. */
  focusedAgent(): AnswerPillFocus | null | Promise<AnswerPillFocus | null>;
  register(input: AnswerPillButton): AnswerPillRegistration;
  showAnswerCard(): boolean;
  /** Reads the conversation's timeline into the card store; returns its stop function. */
  startFeed(agentId: string): (() => void) | undefined;
  /** Plugin text, so a language switch re-resolves the pin without a count change. */
  title(): unknown;
  label(card: AnswerCardSummary | null): unknown;
  /** The popover body, handed to the host untouched. */
  content: unknown;
  /** Card store changes: an answer, a send, a new reply. */
  subscribe(listener: () => void): () => void;
}

export interface AnswerPillController {
  /** Re-read where the user is and what is in front of them. Never throws. */
  refresh(): Promise<void>;
  stop(): void;
}

export function createAnswerPill(deps: AnswerPillDeps): AnswerPillController {
  let stopped = false;
  let registration: AnswerPillRegistration | null = null;
  let registeredFor: AnswerPillFocus | null = null;
  let stopFeed: (() => void) | null = null;
  let feedAgentId: string | null = null;
  // The counts the pin last published; plugin text has no stable identity to compare.
  let lastCounts: { at: number; answered: number; total: number } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const dropRegistration = () => {
    if (registration) {
      try { registration.remove(); } catch { /* The host may already have released it. */ }
    }
    registration = null;
    registeredFor = null;
    lastCounts = null;
  };

  const dropFeed = () => {
    if (stopFeed) {
      try { stopFeed(); } catch { /* Stopping a finished feed is not an error. */ }
    }
    stopFeed = null;
    feedAgentId = null;
  };

  const dropConversation = () => {
    dropRegistration();
    dropFeed();
  };

  const apply = (focus: AnswerPillFocus | null) => {
    if (stopped) return;
    if (!focus || !deps.showAnswerCard()) {
      dropConversation();
      return;
    }
    // The feed is what discovers a card, so it follows the conversation, not the card.
    if (feedAgentId !== focus.agentId) {
      dropFeed();
      try { stopFeed = deps.startFeed(focus.agentId) ?? null; } catch { stopFeed = null; }
      feedAgentId = focus.agentId;
    }
    if (registeredFor && (registeredFor.agentId !== focus.agentId || registeredFor.workspaceId !== focus.workspaceId)) {
      dropRegistration();
    }
    const card = currentPillCard(focus.agentId);
    if (!card) {
      dropRegistration();
      return;
    }
    if (!registration) {
      try {
        registration = deps.register({
          id: ANSWER_PILL_ID,
          workspaceId: focus.workspaceId,
          agentId: focus.agentId,
          button: {
            title: deps.title(),
            label: deps.label(card),
            icon: "ListChecks",
            visible: true,
            behavior: { kind: "popover", Content: deps.content },
          },
        });
        registeredFor = focus;
        lastCounts = { at: card.at, answered: card.answeredCount, total: card.questionCount };
      } catch (error) {
        warn("could not register the card pin", error);
        registration = null;
        registeredFor = null;
        return;
      }
    }
    if (!lastCounts || lastCounts.at !== card.at || lastCounts.answered !== card.answeredCount || lastCounts.total !== card.questionCount) {
      try {
        // Every update republishes the button row, so only a real change is pushed.
        registration.update({ visible: true, label: deps.label(card) });
        lastCounts = { at: card.at, answered: card.answeredCount, total: card.questionCount };
      } catch (error) {
        warn("could not update the card pin", error);
      }
    }
  };

  const run = async () => {
    let focus: AnswerPillFocus | null = null;
    try {
      focus = await deps.focusedAgent();
    } catch (error) {
      warn("could not read the conversation in front of the user", error);
      focus = null;
    }
    apply(focus);
  };

  const unsubscribe = { stop: null as null | (() => void) };

  const controller: AnswerPillController = {
    refresh() {
      chain = chain.then(() => (stopped ? undefined : run())).catch(error => warn("could not refresh the card pin", error));
      return chain;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe.stop?.();
      unsubscribe.stop = null;
      dropConversation();
    },
  };
  unsubscribe.stop = deps.subscribe(() => { void controller.refresh(); });
  return controller;
}

function warn(message: string, error: unknown): void {
  console.warn(`Clear Chat answer pin ${message}`, error);
}
