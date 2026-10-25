import { translate as t } from "./translation";
import type { usePaseo } from "@getpaseo/plugin/client";
import { buildLiveToolCallData } from "./tool-call-data";
import { parseSystemEnvelope } from "./system-envelope";

type Paseo = ReturnType<typeof usePaseo>;
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type Entry = TimelinePage["entries"][number];

export type ReplyIdentity =
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; callId?: string; name: string };

export function replyKey(item: ReplyIdentity, at: number): string {
  return JSON.stringify([item.type, at, item.type === "assistant_message" ? item.text : item.callId ?? item.name]);
}

/** Same flooring and units as the host's utils/time.ts:formatDuration. */
export function formatWorkedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return t("duration.workedZero");
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return t("duration.workedSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? t("duration.workedMinutesSeconds", { minutes, seconds: seconds % 60 }) : t("duration.workedMinutes", { minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? t("duration.workedHoursMinutes", { hours, minutes: minutes % 60 }) : t("duration.workedHours", { hours });
}

/**
 * Match host turn membership and elapsed time using the canonical timeline,
 * before replacements erase assistant_message. Only the last reply in each
 * visible response gets a label. Intermediate messages keep their own Copy.
 */
export function createReplyTiming() {
  const completed = new Map<string, number>();
  let previous: { turnId?: string } | undefined;
  let userAt: number | null = null;
  let lastAt = NaN;
  let responseReply: string | undefined;
  let responseDuration: number | undefined;
  let turnReplies = new Set<string>();
  const closeTurn = () => {
    if (responseReply && turnReplies.has(responseReply)) {
      responseDuration = userAt !== null && Number.isFinite(userAt) && Number.isFinite(lastAt)
        ? Math.max(0, lastAt - userAt) : undefined;
    }
  };
  return {
    append(entries: readonly Entry[]) {
      for (const entry of entries) {
        const sameTurn = previous && (previous.turnId !== undefined && entry.turnId !== undefined
          ? previous.turnId === entry.turnId : entry.item.type !== "user_message");
        if (!sameTurn) {
          closeTurn();
          if (entry.item.type === "user_message") {
            if (responseReply && responseDuration !== undefined) completed.set(responseReply, responseDuration);
            responseReply = undefined;
            responseDuration = undefined;
          }
          userAt = entry.item.type === "user_message" ? Date.parse(entry.timestamp) : null;
          turnReplies = new Set();
        }
        lastAt = Date.parse(entry.timestamp);
        const item = entry.item;
        const isReply = item.type === "assistant_message" ? !parseSystemEnvelope(item.text)
          : item.type === "tool_call" && Boolean(buildLiveToolCallData(item).finalReply);
        if (isReply) {
          responseReply = replyKey(item as ReplyIdentity, lastAt);
          responseDuration = undefined;
          turnReplies.add(responseReply);
        }
        previous = { turnId: entry.turnId };
      }
    },
    snapshot(running = false): Map<string, number> {
      const result = new Map(completed);
      if (!running) {
        closeTurn();
        if (responseReply && responseDuration !== undefined) result.set(responseReply, responseDuration);
      }
      return result;
    },
  };
}

export function deriveReplyDurations(entries: readonly Entry[], running = false): Map<string, number> {
  const timing = createReplyTiming();
  timing.append(entries);
  return timing.snapshot(running);
}
