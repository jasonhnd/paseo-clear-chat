type Listener = (agentId: string) => void;
const listeners = new Set<Listener>();
const writes = new Map<string, Promise<void>>();

export function subscribeAnswerMetadata(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishAnswerMetadata(agentId: string, write: () => Promise<void>): Promise<void> {
  const previous = writes.get(agentId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(write).then(() => {
    for (const listener of listeners) listener(agentId);
  });
  writes.set(agentId, next);
  void next.then(() => { if (writes.get(agentId) === next) writes.delete(agentId); }, () => { if (writes.get(agentId) === next) writes.delete(agentId); });
  return next;
}
