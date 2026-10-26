import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { HermesCcHistoryStore, HermesCcJournalKey, HermesCcWriterLease } from "./history-store";
import { nativeKey } from "./session-key";

type Open = Extract<ProviderInput, { type: "session.open" }>;
type HistoryEvent = Extract<ProviderEvent, { type: "timeline.item" | "session.turn" }>;
interface Session {
  open: Open;
  key: HermesCcJournalKey | null;
  recording: boolean;
  claimRefused: boolean;
  lease: HermesCcWriterLease | null;
  namespaced: boolean;
  pendingPrompts: Set<string>;
  clientMessageIds: Set<string>;
  opening: ProviderEvent[];
  openingHistory: boolean;
  invalidated: boolean;
  turns: Map<string, string>;
  replay: HistoryEvent[] | null;
  generation: number;
  opened: boolean;
  ready: boolean;
  failed: boolean;
  lane: Promise<void>;
}

const namespace = "hermes-cc:";
// Opening notifications go in Paseo's initialTimeline (SDK plugin-provider.ts:
// 1117-1119); journaling them would repeat runtime notices on hydration. Error
// and plugin items likewise stay runtime-only and are not restored by replay.
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
  // Be conservative about parsers that ignore leading whitespace.
  return input.prompt.input.content.filter(part => part.type === "text").map(part => part.text).join("\n").trimStart().startsWith("/");
}

// Shared across connections and store instances in this process. The
// local reservation is acquired before awaiting the store's cross-process lease.
// Stores without claimWriter still exclude competing lanes in this process.
const recorders = new Map<string, Session>();
const recorderId = (key: HermesCcJournalKey) => JSON.stringify([key.providerId, key.nativeSessionId]);
// An invalidation failure must never let another local connection certify this
// key again. Retry persistence on its next open or mutation, without blocking
// the user's prompt if storage remains unavailable.
const failedInvalidations = new Set<string>();

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
  const claim = async (session: Session) => {
    if (!session.key) return false;
    const id = recorderId(session.key);
    if (recorders.has(id)) { session.claimRefused = true; return false; }
    recorders.set(id, session);
    try {
      if (store.claimWriter) {
        session.lease = await store.claimWriter(session.key);
        if (!session.lease) {
          session.claimRefused = true;
          recorders.delete(id);
          return false;
        }
      }
      return true;
    } catch (error) {
      recorders.delete(id);
      throw error;
    }
  };
  const release = async (session: Session) => {
    const lease = session.lease;
    session.lease = null;
    try { await lease?.release(); }
    finally {
      if (session.key && recorders.get(recorderId(session.key)) === session) recorders.delete(recorderId(session.key));
    }
  };
  const mutate = async (session: Session, operation: () => Promise<void>): Promise<boolean> => {
    if (session.key && failedInvalidations.has(recorderId(session.key))) {
      await invalidateForeignWriter(session);
      return false;
    }
    try { await operation(); return true; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "writer_changed") throw error;
      // The store has durably invalidated replay. Keep delivering the live
      // session, but never record or settle anything else with this lease.
      session.recording = false;
      session.invalidated = true;
      session.pendingPrompts.clear();
      session.turns.clear();
      try { await release(session); } catch { /* Recording has already stopped. */ }
      return false;
    }
  };
  const invalidate = async (session: Session, reason: string, appending = false) => {
    // Opening alone is harmless. Foreign mutations use the durable send fence
    // below; identity/open failures must leave the owner's transcript alone.
    if (session.claimRefused && !appending) return;
    session.recording = false;
    if (session.key && !session.invalidated) {
      await store.invalidate(session.key, reason);
      session.invalidated = true;
    }
    await release(session);
  };
  const invalidateForeignWriter = async (session: Session) => {
    if (!session.key) return;
    session.recording = false;
    session.invalidated = true;
    session.pendingPrompts.clear();
    session.turns.clear();
    try {
      // Always await this fence, even after losing a lease or the owner closing.
      await store.invalidate(session.key, "foreign_writer");
    } catch {
      failedInvalidations.add(recorderId(session.key));
      // Keep live prompts usable. The disk store syncs an independent marker
      // before attempting the journal lock/manifest, so the owner sees failures
      // there too. If even marker writes fail, retry locally as storage recovers;
      // a crash while all writes are unavailable cannot preserve a new fence.
    }
    try { await release(session); } catch { /* The key is already unusable. */ }
  };
  const fail = async (session: Session) => {
    session.failed = true;
    session.recording = false;
    session.replay = null;
    session.opening = [];
    try { await release(session); } catch { /* Still finish failure cleanup if storage is unavailable. */ }
  };
  const enqueue = (session: Session, operation: () => Promise<void>): Promise<void> => {
    const work = session.lane.then(operation);
    session.lane = work.catch(async () => {
      if (session.failed) return;
      // A failed start/read/open is not evidence against an existing journal.
      // A failed recording operation may already have persisted an unseen row.
      if (session.ready && session.recording) {
        try { await invalidate(session, "journal operation failed"); } catch { /* Fail closed if storage is unavailable. */ }
      }
      await fail(session);
      const error = { message: "Hermes·CC session journal failed" };
      emit(session.ready
        ? { type: "session.runtime_failed", sessionId: session.open.sessionId, error }
        : { type: "request.failed", requestId: session.open.requestId, error });
    });
    return work;
  };

  const accept = async (session: Session, original: ProviderEvent) => {
    if (session.failed) {
      // The SDK can acknowledge close/configure after a terminal session event.
      if (session.ready && (original.type === "request.failed" || original.type === "request.completed")) {
        requests.delete(original.requestId);
        emit(original);
      }
      return;
    }
    if (original.type === "request.failed" || original.type === "request.completed") {
      requests.delete(original.requestId);
      if (original.type === "request.failed" && original.requestId === session.open.requestId) {
        await fail(session);
        emit(original);
        return;
      }
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
          if (await claim(session)) {
            // start() rejects existing journals: only own it after success.
            session.recording = await mutate(session, () => store.start(session.key!, session.lease ?? undefined));
            session.namespaced = session.recording;
          }
          if (session.openingHistory) await invalidate(session, "history arrived during session open");
        }
        session.opened = true;
      }
    }
    if (original.type === "session.runtime_failed" || original.type === "session.closed") {
      // The durable open-turn flag already rejects an interrupted prompt.
      // An idle runtime failure/close says nothing about a settled transcript.
      const ready = session.ready;
      await fail(session);
      if (ready && original.type === "session.closed") sessions.delete(session.open.sessionId);
      requests.delete(session.open.requestId);
      emit(ready ? original : { type: "request.failed", requestId: session.open.requestId,
        error: { message: original.type === "session.runtime_failed"
          ? original.error?.message ?? "Session runtime failed before ready" : "Session closed before ready" } });
      return;
    }
    if (!session.ready) {
      if (original.type !== "session.ready") {
        if (isHistory(original)) {
          session.openingHistory = true;
          if (session.recording) await invalidate(session, "history arrived during session open");
        }
        session.opening.push(original);
        return;
      }
      if (!session.opened) throw new Error("Session became ready without a successful open");
      // Preserve the selected snapshot even if a config-time update invalidated
      // future replay: the inner open already suppressed Hermes's history.
      for (const event of session.replay ?? []) emit({ ...event, sessionId: original.sessionId });
      session.replay = null;
      session.ready = true;
      requests.delete(session.open.requestId);
      for (const event of session.opening) emit(session.namespaced ? withRuntimeIds(event, session.generation) : event);
      session.opening = [];
      emit(original);
      return;
    }
    const event = session.namespaced ? withRuntimeIds(original, session.generation) : original;
    if (session.recording && session.key) {
      if (isHistory(event)) {
        if (!await mutate(session, () => store.append(session.key!, event, session.lease ?? undefined))) {
          emit(event);
          return;
        }
        if (event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId) {
          session.clientMessageIds.add(event.item.clientMessageId);
        }
      }
      // prompt_result {type:turn} is an admission ACK, not the ACP result.
      // SDK connection.ts:623-647 emits the terminal boundary after draining it.
      if (original.type === "session.prompt_result") {
        if (original.result.type === "turn" || original.result.type === "steer") {
          session.turns.set(original.result.turnId, original.clientMessageId);
        } else {
          // No terminal turn means we cannot certify this admission as settled.
          await invalidate(session, "prompt ended without a terminal turn");
        }
      }
      if (original.type === "session.turn" && original.state !== "started") {
        const clientMessageId = session.turns.get(original.turnId);
        if (clientMessageId === undefined) await invalidate(session, "unrecognized terminal turn");
        else {
          session.pendingPrompts.delete(clientMessageId);
          session.turns.delete(original.turnId);
          if (!session.pendingPrompts.size) await mutate(session, () => store.turnSettled(session.key!, session.lease ?? undefined));
        }
      }
    } else if (isHistory(event)) {
      // Also cover unsolicited history that did not follow a local send.
      await invalidate(session, session.claimRefused ? "writer_changed" : "history appended outside the recorder", true);
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
          recording: false, claimRefused: false, lease: null, namespaced: false, pendingPrompts: new Set(), turns: new Map(),
          clientMessageIds: new Set(), opening: [], openingHistory: false, invalidated: false,
          replay: null, generation: 0, opened: false, ready: false, failed: false, lane: Promise.resolve(),
        };
        sessions.set(input.sessionId, session);
        requests.set(input.requestId, session);
        try {
          // Persisted skip is a caller-owned transcript: pass it through without
          // reading, claiming, starting or otherwise changing the journal.
          if (session.key && input.history === "replay" && await claim(session)) {
            const poisoned = failedInvalidations.has(recorderId(session.key));
            if (poisoned) await invalidateForeignWriter(session);
            const state = poisoned ? { status: "unusable" as const, reason: "foreign_writer" }
              : await store.read(session.key).catch(async () => {
                await invalidate(session, "journal read failed");
                return { status: "unusable" as const, reason: "journal read failed" };
              });
            if (state.status === "complete") {
              const projection = project(state.events);
              if (projection) {
                session.replay = projection.events;
                session.generation = projection.generation;
                session.recording = true;
                session.namespaced = true;
                for (const event of projection.events) {
                  if (event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId) {
                    session.clientMessageIds.add(event.item.clientMessageId);
                  }
                }
              } else await invalidate(session, "journal projection is invalid");
            }
            if (!session.recording) await release(session);
          }
          await connection.send(session.replay ? { ...input, history: "skip" } : input);
        } catch (error) {
          await fail(session);
          requests.delete(input.requestId);
          throw error;
        }
        return;
      }
      const session = "sessionId" in input ? sessions.get(input.sessionId) : undefined;
      if (session && "requestId" in input) requests.set(input.requestId, session);
      const forward = async () => {
        try { await connection.send(input); }
        catch (error) {
          if ("requestId" in input) requests.delete(input.requestId);
          throw error;
        }
      };
      if (!session) { await forward(); return; }
      let sendFailed = false, sendError: unknown;
      await enqueue(session, async () => {
        if (session.failed) throw new Error("Hermes·CC session journal failed");
        const changesHistory = input.type === "session.prompt" || input.type === "session.revert";
        if (changesHistory && session.key && (!session.recording || recorders.get(recorderId(session.key)) !== session
          || failedInvalidations.has(recorderId(session.key)))) {
          await invalidateForeignWriter(session);
        } else if (input.type === "session.revert" || (input.type === "session.prompt" && isCommand(input))) {
          await invalidate(session, "history-mutating command");
        } else if (input.type === "session.prompt") {
          if (session.recording && session.key) {
            const id = input.prompt.clientMessageId;
            if (session.clientMessageIds.has(id)) await invalidate(session, "duplicate prompt identity");
            else {
              // Persist the busy marker BEFORE the inner SDK can send anything
              // to Hermes. Keep it open across overlapping prompt admissions.
              if (!session.pendingPrompts.size) await mutate(session, () => store.turnStarted(session.key!, session.lease ?? undefined));
              // A fenced mutation relinquishes ownership before this send.
              if (!session.recording) await invalidateForeignWriter(session);
              if (session.recording) {
                session.pendingPrompts.add(id);
                session.clientMessageIds.add(id);
              }
            }
          }
        }
        // Forward every session send on the lane, including interrupts. Otherwise
        // an interrupt could overtake a prompt still waiting for turnStarted fsync.
        // SDK send failures leave the busy flag open; they are not storage errors.
        try { await forward(); } catch (error) {
          sendFailed = true;
          sendError = error;
          await fail(session);
        }
      });
      if (sendFailed) throw sendError;
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      try {
        await connection.close();
      } finally {
        await Promise.all([...sessions.values()].map(session => session.lane));
        closed = true;
        try { await Promise.all([...sessions.values()].map(release)); }
        finally {
          unsubscribe();
          listeners.clear();
          sessions.clear();
          requests.clear();
        }
      }
    },
  };
}
