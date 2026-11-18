type Listener = (agentId: string) => void;
type AgentWrites = {
  generation: number;
  latest: () => Promise<void>;
  queue: Promise<void>;
  pending: number;
};
const listeners = new Set<Listener>();
const writes = new Map<string, AgentWrites>();

/** Test-only visibility into retained per-agent generation state. */
export function __testHasAnswerMetadataState(agentId: string): boolean {
  return writes.has(agentId);
}

export function subscribeAnswerMetadata(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function enqueue(agentId: string, state: AgentWrites, select: () => { generation: number; write: () => Promise<void> }): Promise<void> {
  const next = state.queue.catch(() => {}).then(async () => {
    const { generation, write } = select();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    state.pending++;
    const operation = Promise.resolve().then(write);
    void operation.then(
      () => settled(true),
      error => { if (timedOut) console.warn("Clear Chat answer metadata write failed after timeout", error); settled(false); },
    );
    function settled(succeeded: boolean) {
      state.pending--;
      if (timedOut && state.generation > generation) {
        void enqueue(agentId, state, () => ({ generation: state.generation, write: state.latest }))
          .catch(error => console.warn("Clear Chat answer metadata reapply failed", error));
      } else if (timedOut && succeeded) {
        for (const listener of listeners) listener(agentId);
      }
      cleanup();
    }
    try {
      const completed = await Promise.race([
        operation.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, 10_000); }),
      ]);
      if (!completed) {
        timedOut = true;
        console.warn("Clear Chat answer metadata write timed out");
        return;
      }
      for (const listener of listeners) listener(agentId);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
  state.queue = next;
  function cleanup() {
    if (state.pending === 0 && state.queue === next && writes.get(agentId) === state) writes.delete(agentId);
  }
  void next.then(cleanup, cleanup);
  return next;
}

export function publishAnswerMetadata(agentId: string, write: () => Promise<void>): Promise<void> {
  let state = writes.get(agentId);
  if (!state) {
    state = { generation: 0, latest: write, queue: Promise.resolve(), pending: 0 };
    writes.set(agentId, state);
  }
  const generation = ++state.generation;
  state.latest = write;
  return enqueue(agentId, state, () => ({ generation, write }));
}
