type Activity = { status: string; lastActivityAt: string; attentionReason?: string | null };

// Calendar boundaries use the user's local timezone, including DST transitions.
export function localDayBounds(now: number) {
  const day = new Date(now);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return { start, end };
}

/** PluginAgentSnapshot has no reliable agent start field in 0.13.0; callers pass undefined until the host exposes one. */
export function runningMinutes(startedAt: string | undefined | null, now: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || start > now) return null;
  return Math.floor((now - start) / 60000);
}

export function isBackgroundAgent(agent: unknown): boolean {
  return (agent as { background?: unknown } | null)?.background === true;
}

export function lastActivityTime(agent: Activity) {
  return Date.parse(agent.lastActivityAt);
}

export function boardSection(agent: Activity, bounds: { start: number; end: number }): "running" | "finished" | null {
  if (agent.status === "initializing" || agent.status === "running") return "running";
  if (agent.status !== "error" && !(agent.status === "idle" && agent.attentionReason === "finished")) return null;
  const time = lastActivityTime(agent);
  return time >= bounds.start && time < bounds.end ? "finished" : null;
}

/** Errors lead the finished section; other rows retain last-activity ordering. */
export function compareBoardAgents(a: Activity, b: Activity): number {
  const priority = Number(b.status === "error") - Number(a.status === "error");
  return priority || lastActivityTime(b) - lastActivityTime(a);
}
