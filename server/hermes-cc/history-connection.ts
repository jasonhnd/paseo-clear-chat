import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { HermesCcHistoryStore, HermesCcJournalKey } from "./history-store";
import { nativeKey } from "./session-key";

type Open = Extract<ProviderInput, { type: "session.open" }>;
type HistoryEvent = Extract<ProviderEvent, { type: "timeline.item" | "session.turn" }>;
interface Session {
  open: Open;
  key: HermesCcJournalKey | null;
  recording: boolean;
  namespaced: boolean;
  pendingPrompts: Set<string>;
  turns: Map<string, string>;
  replay: HistoryEvent[] | null;
  generation: number;
  opened: boolean;
  ready: boolean;
  failed: boolean;
  lane: Promise<void>;
}

const namespace = "hermes-cc:";
const historyItems = new Set(["user_message", "assistant_message", "reasoning", "tool_call", "todo", "compaction"]);
function isHistory(event: ProviderEvent): event is HistoryEvent {
  return event.type === "session.turn" || (event.type === "timeline.item" && historyItems.has(event.item.type));
}

/** Keep cumulative snapshots intact; reject a journal with unbalanced turns. */
function project(events: readonly unknown[]): { events: HistoryEvent[]; generation: number } | null {
  const result: HistoryEvent[] = [], turns = new Set<string>();
  let generation = 0;
  for (const value of events) {
    const parsed = ProviderEventSchema.safeParse(value);
    if (!parsed.success) return null;
    const event = parsed.data;
    if (!isHistory(event)) continue;
    const id = event.type === "session.turn" ? event.turnId : event.item.id;
    const match = /^hermes-cc:(\d+):/.exec(id);
    if (match) {
      const next = Number(match[1]) + 1;
      if (!Number.isSafeInteger(next)) return null;
      generation = Math.max(generation, next);
    }
    if (event.type === "session.turn") {
      if (event.state === "started") {
        if (turns.has(event.turnId)) return null;
        turns.add(event.turnId);
      } else if (!turns.delete(event.turnId)) return null;
    }
    result.push(event);
  }
  return turns.size ? null : { events: result, generation };
}

/** SDK counters restart with each runtime. The generation lives in the journal's IDs. */
function withRuntimeIds(event: ProviderEvent, generation: number): ProviderEvent {
  const id = (value: string) => `${namespace}${generation}:${value}`;
  if (event.type === "timeline.item" && event.item.type !== "user_message") {
    const item = { ...event.item, id: id(event.item.id) };
    if (item.type === "assistant_message" && item.messageId) item.messageId = id(item.messageId);
    if (item.type === "tool_call") item.callId = id(item.callId);
    return { ...event, item };
  }
  if (event.type === "session.turn") return { ...event, turnId: id(event.turnId) };
  if (event.type === "session.usage" && event.turnId) return { ...event, turnId: id(event.turnId) };
  if (event.type === "session.prompt_result" && (event.result.type === "turn" || event.result.type === "steer")) {
    return { ...event, result: { ...event.result, turnId: id(event.result.turnId) } };
  }
  return event;
}

function isCommand(input: Extract<ProviderInput, { type: "session.prompt" }>): boolean {
  if (input.prompt.input.type === "command") return true;
  // Match the text actually sent by the SDK, without trimming or changing it.
  return input.prompt.input.content.filter(part => part.type === "text").map(part => part.text).join("\n").startsWith("/");
}

/** Journal final provider events before Paseo observes them, including readiness. */
export function journalHermesCcConnection(
  connection: ProviderConnection,
  providerId: string,
  store: HermesCcHistoryStore,
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const requests = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  const invalidate = async (session: Session, reason: string) => {
    session.recording = false;
    session.replay = null;
    if (session.key) await store.invalidate(session.key, reason);
  };
  const enqueue = (session: Session, operation: () => Promise<void>): Promise<void> => {
    const work = session.lane.then(operation);
    session.lane = work.catch(async () => {
      if (session.failed) return;
      session.failed = true;
      try { await invalidate(session, "journal operation failed"); } catch { /* Fail closed even if storage is unavailable. */ }
      const error = { message: "Hermes·CC session journal failed" };
      emit(session.ready
        ? { type: "session.runtime_failed", sessionId: session.open.sessionId, error }
        : { type: "request.failed", requestId: session.open.requestId, error });
    });
    return work;
  };

  const accept = async (session: Session, original: ProviderEvent) => {
    if (session.failed) return;
    if (original.type === "request.failed" || original.type === "request.completed") {
      requests.delete(original.requestId);
      if (original.type === "request.failed" && original.requestId === session.open.requestId) {
        await invalidate(session, "session load failed");
        session.failed = true;
      }
      emit(original);
      return;
    }
    if (original.type === "session.opened" || original.type === "session.persistence") {
      const nativeSessionId = nativeKey(original.persistence);
      if (session.key && session.key.nativeSessionId !== nativeSessionId) {
        await invalidate(session, "native session identity changed");
        throw new Error("Native session identity changed");
      }
      if (original.type === "session.opened") {
        if (session.open.history === "skip" && session.open.persistence === undefined && nativeSessionId !== null) {
          session.key = { providerId, nativeSessionId };
          await store.start(session.key);
          session.recording = true;
          session.namespaced = true;
        }
        session.opened = true;
      }
    }
    if (original.type === "session.ready") {
      if (!session.opened) throw new Error("Session became ready without a successful open");
      // opened is emitted only after session/load succeeds (SDK connection.ts:507-560).
      if (session.replay) {
        for (const event of session.replay) emit({ ...event, sessionId: original.sessionId });
        session.replay = null;
      }
      session.ready = true;
      requests.delete(session.open.requestId);
    }
    const event = session.namespaced ? withRuntimeIds(original, session.generation) : original;
    if (session.recording && session.key) {
      if (isHistory(event)) await store.append(session.key, event);
      // prompt_result {type:turn} is an admission ACK, not the ACP result.
      // SDK connection.ts:623-647 emits the terminal boundary after draining it.
      if (original.type === "session.prompt_result") {
        if (original.result.type === "turn" || original.result.type === "steer") {
          session.turns.set(original.result.turnId, original.clientMessageId);
        } else {
          session.pendingPrompts.delete(original.clientMessageId);
          if (!session.pendingPrompts.size) await store.turnSettled(session.key);
        }
      }
      if (original.type === "session.turn" && original.state !== "started") {
        const clientMessageId = session.turns.get(original.turnId);
        if (clientMessageId === undefined) await invalidate(session, "unrecognized terminal turn");
        else {
          session.pendingPrompts.delete(clientMessageId);
          session.turns.delete(original.turnId);
          if (!session.pendingPrompts.size) await store.turnSettled(session.key);
        }
      }
    }
    if (original.type === "session.runtime_failed" || original.type === "session.closed") {
      // An interrupted runtime must not make an unfinished journal complete.
      if (original.type === "session.runtime_failed") await invalidate(session, "session runtime failed");
      sessions.delete(session.open.sessionId);
      requests.delete(session.open.requestId);
    }
    emit(event);
  };

  const unsubscribe = connection.onEvent(event => {
    const session = "sessionId" in event ? sessions.get(event.sessionId)
      : "requestId" in event && event.requestId ? requests.get(event.requestId) : undefined;
    if (!session) { emit(event); return; }
    // SDK listeners are synchronous. Snapshot now and serialize every event,
    // not just appends: ready/config/ACKs must never overtake a durable append.
    const snapshot = structuredClone(event);
    void enqueue(session, () => accept(session, snapshot)).catch(() => undefined);
  });

  return {
    version: connection.version,
    capabilities: connection.capabilities,
    async send(input) {
      if (closed) throw new Error("Hermes·CC connection is closed");
      if (input.type === "session.open") {
        if (sessions.has(input.sessionId)) throw new Error("Hermes·CC session already exists");
        const nativeSessionId = nativeKey(input.persistence);
        const session: Session = {
          open: input, key: nativeSessionId === null ? null : { providerId, nativeSessionId },
          recording: false, namespaced: false, pendingPrompts: new Set(), turns: new Map(),
          replay: null, generation: 0, opened: false, ready: false, failed: false, lane: Promise.resolve(),
        };
        sessions.set(input.sessionId, session);
        requests.set(input.requestId, session);
        try {
          if (session.key) {
            const state = await store.read(session.key).catch(async () => {
              await invalidate(session, "journal read failed");
              return { status: "unusable" as const, reason: "journal read failed" };
            });
            if (input.history === "replay" && state.status === "complete") {
              const projection = project(state.events);
              if (projection) {
                session.replay = projection.events;
                session.generation = projection.generation;
                session.recording = true;
                session.namespaced = true;
              } else await invalidate(session, "journal projection is invalid");
            } else if (state.status === "complete") await invalidate(session, "session opened without journal replay");
          }
          await connection.send(session.replay ? { ...input, history: "skip" } : input);
        } catch (error) {
          await invalidate(session, "session open failed");
          sessions.delete(input.sessionId);
          requests.delete(input.requestId);
          throw error;
        }
        return;
      }
      const session = "sessionId" in input ? sessions.get(input.sessionId) : undefined;
      if (session && "requestId" in input) requests.set(input.requestId, session);
      if (session && (input.type === "session.prompt" || input.type === "session.revert")) {
        await enqueue(session, async () => {
          if (input.type === "session.revert" || isCommand(input)) await invalidate(session, "history-mutating command");
          else if (session.recording && session.key && input.type === "session.prompt") {
            if (session.pendingPrompts.has(input.prompt.clientMessageId)) await invalidate(session, "duplicate prompt identity");
            else {
              // Persist the busy marker BEFORE the inner SDK can send anything
              // to Hermes. Keep it open across overlapping prompt admissions.
              if (!session.pendingPrompts.size) await store.turnStarted(session.key);
              session.pendingPrompts.add(input.prompt.clientMessageId);
            }
          }
        });
        if (session.failed) throw new Error("Hermes·CC session journal failed");
      }
      try { await connection.send(input); }
      catch (error) {
        if ("requestId" in input) requests.delete(input.requestId);
        throw error;
      }
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      await connection.close();
      await Promise.all([...sessions.values()].map(session => session.lane));
      closed = true;
      unsubscribe();
      listeners.clear();
      sessions.clear();
      requests.clear();
    },
  };
}
