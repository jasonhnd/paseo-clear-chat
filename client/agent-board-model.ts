type Activity = { status: string; lastActivityAt: string; attentionReason?: string | null };

// Node's native TypeScript loader requires the extension; the plugin bundler also accepts it.
// @ts-expect-error TypeScript restricts explicit .ts extensions without allowImportingTsExtensions.
export { observeAgentTime, getObservedAgentTimes, type ObservedAgentTimeState } from "./observed-agent-times.ts";

// Calendar boundaries use the user's local timezone, including DST transitions.
export function localDayBounds(now: number) {
  const day = new Date(now);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return { start, end };
}

export function finishedClock(finishedAt: number | undefined, bounds: { start: number; end: number }): string | null {
  if (finishedAt === undefined || !Number.isFinite(finishedAt) || !(finishedAt >= bounds.start && finishedAt < bounds.end)) return null;
  const time = new Date(finishedAt);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
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
type WaitingAgent = { readonly id: string; readonly title: string | null; readonly metadata?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function answerMarker(agent: WaitingAgent): { pending: number; total: number; answered: number; time: number | null } | null {
  const marker = record(record(agent.metadata)?.clearChat);
  const pending = marker?.pending;
  if (typeof pending !== "number" || !Number.isFinite(pending) || pending <= 0) return null;
  const total = typeof marker?.total === "number" && Number.isFinite(marker.total) && marker.total >= 0 ? marker.total : 0;
  const parsed = typeof marker?.updatedAt === "string" ? Date.parse(marker.updatedAt) : NaN;
  return { pending, total, answered: Math.max(0, Math.min(total, total - pending)), time: Number.isFinite(parsed) ? parsed : null };
}

export function compareWaitingAgents(a: WaitingAgent, b: WaitingAgent): number {
  const at = answerMarker(a)?.time ?? null;
  const bt = answerMarker(b)?.time ?? null;
  if (at === null && bt !== null) return 1;
  if (bt === null && at !== null) return -1;
  if (at !== null && bt !== null && at !== bt) return bt - at;
  return (a.title?.trim() || a.id.slice(0, 8)).localeCompare(b.title?.trim() || b.id.slice(0, 8)) || a.id.localeCompare(b.id);
}
