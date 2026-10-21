import {
  pruneExpansionEntries,
  toolExpansionSettings,
  type ExpansionEntries,
  type ToolExpansionSettings,
} from "../shared/tool-expansion-settings";

type Read = (input: Record<string, never>) => Promise<
  { status: "ready"; revision: string; values: unknown } | { status: "invalid"; error: string }
>;
type Write = (input: { revision: string; values: ToolExpansionSettings }) => Promise<
  { status: "saved"; values: unknown } | { status: "invalid"; error: string } | { status: "conflict"; error: string }
>;

export interface ToolExpansionIdentity {
  hostId: string;
  agentId: string;
  callId?: string;
  name: string;
  timestamp: number;
  providerSessionId?: string;
}

export function toolExpansionKey(identity: ToolExpansionIdentity): string {
  // The timeline timestamp is stable across streaming and history replay, and
  // distinguishes reused call IDs. JSON encoding avoids delimiter collisions.
  return JSON.stringify([
    identity.hostId, identity.agentId, identity.providerSessionId ?? "",
    identity.callId ?? identity.name, identity.timestamp,
  ]);
}

export function createToolExpansionStore() {
  let read: Read | undefined;
  let write: Write | undefined;
  let saved: ExpansionEntries = {};
  let dirty: ExpansionEntries = {};
  let connected = false;
  let error: string | null = null;
  let updatedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const report = (cause: unknown) => {
    error = cause instanceof Error ? cause.message : String(cause);
    publish();
  };

  function schedule() {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 200);
  }

  function connect(nextRead: Read, nextWrite: Write): Promise<void> {
    read = nextRead;
    write = nextWrite;
    if (!connected) {
      connected = true;
      queue = queue.then(async () => {
        const result = await nextRead({});
        if (result.status !== "ready") throw new Error(result.error);
        saved = toolExpansionSettings.schema.parse(result.values).entries;
        updatedAt = Math.max(updatedAt, ...Object.values(saved).map(entry => entry.updatedAt));
        error = null;
        publish();
      }).catch((cause: unknown) => { connected = false; report(cause); });
    }
    if (Object.keys(dirty).length) schedule();
    return queue;
  }

  function flush(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    queue = queue.then(async () => {
      if (!Object.keys(dirty).length) return;
      if (!read || !write) throw new Error("Tool expansion storage is not connected to a host.");
      const patch = { ...dirty };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await read({});
        if (current.status !== "ready") throw new Error(current.error);
        const entries = toolExpansionSettings.schema.parse(current.values).entries;
        const result = await write({
          revision: current.revision,
          values: { entries: pruneExpansionEntries({ ...entries, ...patch }) },
        });
        if (result.status === "invalid") throw new Error(result.error);
        if (result.status === "conflict") continue;
        saved = toolExpansionSettings.schema.parse(result.values).entries;
        updatedAt = Math.max(updatedAt, ...Object.values(saved).map(entry => entry.updatedAt));
        // A click made during this write belongs to the next batch, even when
        // it changes the same call. Never replace it with the older response.
        for (const [key, entry] of Object.entries(patch)) {
          if (dirty[key] === entry) delete dirty[key];
        }
        error = null;
        publish();
        return;
      }
      throw new Error("Tool choices changed in another client. Try toggling the call again.");
    }).catch(report);
    return queue;
  }

  return {
    connect,
    flush,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get(key: string): boolean | undefined { return (dirty[key] ?? saved[key])?.expanded; },
    getError: () => error,
    set(key: string, expanded: boolean) {
      updatedAt = Math.max(Date.now(), updatedAt + 1);
      dirty = pruneExpansionEntries({ ...dirty, [key]: { expanded, updatedAt } });
      publish();
      schedule();
    },
  };
}

export type ToolExpansionStore = ReturnType<typeof createToolExpansionStore>;
