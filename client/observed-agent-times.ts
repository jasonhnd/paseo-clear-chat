export type ObservedAgentStatus = {
  readonly status: string;
  readonly attentionReason?: string | null;
};

export type ObservedAgentTimes = {
  readonly startedAt?: number;
  readonly finishedAt?: number;
};

type Observation = ObservedAgentTimes & { readonly status: string };
export type ObservedAgentTimeState = ReadonlyMap<string, Observation>;

/** Times are observation instants in epoch milliseconds, not agent metadata. */
export function observeAgentTime(
  state: ObservedAgentTimeState,
  agentKey: string,
  agent: ObservedAgentStatus,
  observedAt: number,
): ObservedAgentTimeState {
  const previous = state.get(agentKey);
  let times: ObservedAgentTimes = previous ?? {};
  if (previous && previous.status !== "running" && agent.status === "running") {
    times = { startedAt: observedAt };
  } else if (previous?.status === "running" && agent.status !== "running") {
    times = agent.status === "idle" && agent.attentionReason === "finished"
      ? { startedAt: previous.startedAt, finishedAt: observedAt }
      : { startedAt: previous.startedAt };
  }
  const next = new Map(state);
  next.set(agentKey, { ...times, status: agent.status });
  return next;
}

/** Discard the baseline when observations may have been missed. */
export function forgetAgentTime(state: ObservedAgentTimeState, agentKey: string): ObservedAgentTimeState {
  const next = new Map(state);
  next.delete(agentKey);
  return next;
}

export function getObservedAgentTimes(state: ObservedAgentTimeState, agentKey: string): ObservedAgentTimes | undefined {
  const observation = state.get(agentKey);
  if (!observation) return undefined;
  const { startedAt, finishedAt } = observation;
  return { startedAt, finishedAt };
}
