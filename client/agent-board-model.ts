type Activity = { status: string; lastActivityAt: string };

// Calendar boundaries use the user's local timezone, including DST transitions.
export function localDayBounds(now: number) {
  const day = new Date(now);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return { start, end };
}

export function lastActivityTime(agent: Activity) {
  return Date.parse(agent.lastActivityAt);
}

export function boardSection(agent: Activity, bounds: { start: number; end: number }): "running" | "finished" | null {
  if (agent.status === "running") return "running";
  const time = lastActivityTime(agent);
  return time >= bounds.start && time < bounds.end ? "finished" : null;
}

/** Only valid pending markers produce a sidebar entry. */
export function pendingSummary(metadata: unknown): { pending: number; total: number; updatedAt: string; time: number } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const marker = (metadata as { clearChat?: unknown }).clearChat;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const { pending, total, updatedAt } = marker as Record<string, unknown>;
  if (typeof pending !== "number" || !Number.isInteger(pending) || pending <= 0 || typeof total !== "number" || !Number.isInteger(total) || total < pending || typeof updatedAt !== "string") return null;
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return null;
  return { pending, total, updatedAt, time };
}
