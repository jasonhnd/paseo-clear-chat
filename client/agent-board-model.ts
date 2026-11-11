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
