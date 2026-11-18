type Listener = (agentId: string) => void;
const listeners = new Set<Listener>();
const writes = new Map<string, Promise<void>>();

export function subscribeAnswerMetadata(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishAnswerMetadata(agentId: string, write: () => Promise<void>): Promise<void> {
  const previous = writes.get(agentId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        Promise.resolve().then(write).then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      if (!completed) {
        console.warn("Clear Chat answer metadata write timed out");
        return;
      }
      for (const listener of listeners) listener(agentId);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
  writes.set(agentId, next);
  void next.then(() => { if (writes.get(agentId) === next) writes.delete(agentId); }, () => { if (writes.get(agentId) === next) writes.delete(agentId); });
  return next;
}
