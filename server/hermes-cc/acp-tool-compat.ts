import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

type Tool = {
  kind?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown[];
  locations?: { path: string }[];
  error?: unknown;
  status: string;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const status = (value: string) => value === "pending" || value === "in_progress" ? "running" : value;
const json = (value: unknown) => z.json().safeParse(value);

/** One instance per public connector runtime, never per provider or tool title. */
class ToolRuntime {
  private native: string | undefined;
  private loading: string | number | null | undefined;
  private active = true;
  private newRequests = new Set<string | number | null>();
  private calls = new Map<string, { latest: Tool; pending: Tool[] }>();

  clear() {
    this.active = false;
    this.calls.clear();
    this.newRequests.clear();
  }

  private sent(message: AcpStreamMessage) {
    if (!this.active || !("method" in message) || !("id" in message)) return;
    const params = record(message.params);
    if (message.method === "session/new") this.newRequests.add(message.id);
    if (message.method === "session/load" && typeof params?.sessionId === "string") {
      this.native = params.sessionId;
      this.loading = message.id;
    }
  }

  // The caller's replay choice is explicit; ACP has no standard skip-history flag.
  constructor(private readonly history: "replay" | "skip") {}

  private received(message: AcpStreamMessage) {
    if (!this.active) return;
    if ("id" in message && !("method" in message)) {
      if (this.newRequests.delete(message.id) && "result" in message) {
        const result = record(message.result);
        if (typeof result?.sessionId === "string") this.native = result.sessionId;
      }
      if (message.id === this.loading) {
        this.loading = undefined;
      }
      return;
    }
    if (!("method" in message) || "id" in message || message.method !== "session/update") return;
    const params = record(message.params), update = record(params?.update);
    if (!this.native || params?.sessionId !== this.native ||
        (this.loading !== undefined && this.history === "skip") || !update ||
        !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) ||
        typeof update.toolCallId !== "string") return;
    if (update.sessionUpdate === "tool_call" && typeof update.title !== "string") return;
    const current = this.calls.get(update.toolCallId);
    const next: Tool = { ...current?.latest, status: current?.latest.status ?? "pending" };
    if (typeof update.kind === "string") next.kind = update.kind;
    if (["pending", "in_progress", "completed", "failed"].includes(String(update.status))) next.status = String(update.status);
    // Nullish optional fields in ACP sparse updates mean no replacement.
    if (update.rawInput !== undefined) next.input = structuredClone(update.rawInput);
    if (update.rawOutput !== undefined) next.output = structuredClone(update.rawOutput);
    if (Array.isArray(update.content)) next.content = structuredClone(update.content);
    if (Array.isArray(update.locations) && update.locations.every(location => typeof record(location)?.path === "string")) {
      next.locations = structuredClone(update.locations) as { path: string }[];
    }
    if (update.error !== undefined) next.error = structuredClone(update.error);
    const pending = current?.pending ?? [];
    pending.push(next);
    this.calls.set(update.toolCallId, { latest: next, pending });
  }

  observe(source: AcpStream): AcpStream {
    const reader = source.readable.getReader(), writer = source.writable.getWriter();
    return {
      readable: new ReadableStream({
        pull: async controller => {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else { this.received(next.value); controller.enqueue(next.value); }
          } catch (error) { controller.error(error); }
        },
        // Keep snapshots until the boundary has drained queued terminal events.
        cancel: reason => reader.cancel(reason),
      }),
      writable: new WritableStream({
        write: message => { this.sent(message); return writer.write(message); },
        close: () => writer.close(),
        abort: reason => writer.abort(reason),
      }),
    };
  }

  adapt(event: ProviderEvent): ProviderEvent {
    if (event.type !== "timeline.item" || event.item.type !== "tool_call") return event;
    const call = this.calls.get(event.item.callId);
    if (!call) return event;
    const queued = call.pending[0];
    // Wire reads can run ahead of the SDK's notification lane. Consume snapshots
    // in order, rather than projecting the last wire update onto earlier events.
    if (queued && status(queued.status) !== event.item.status) return event;
    const tool = queued ? call.pending.shift()! : call.latest;
    if (!queued && ["completed", "failed", "canceled"].includes(event.item.status)) {
      // The SDK also terminalizes pending calls at the end of a turn. Mirror
      // that status so a later sparse notification still matches its snapshot.
      call.latest = { ...tool, status: event.item.status === "canceled" ? "failed" : event.item.status };
    }
    const input = record(tool.input);
    const blocks = tool.content?.flatMap(part => {
      const block = record(part), content = record(block?.content);
      return block?.type === "content" && content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
    });
    const content = blocks?.length ? blocks.join("\n") : undefined;
    const output = record(tool.output);
    const text = content ?? (typeof tool.output === "string" ? tool.output
      : typeof output?.content === "string" ? output.content : typeof output?.text === "string" ? output.text : undefined);
    const retained = json(Object.fromEntries(Object.entries({
      kind: tool.kind, rawInput: tool.input, rawOutput: tool.output,
      content: tool.content, locations: tool.locations,
    }).filter(([, value]) => value !== undefined)));
    const metadata = retained.success ? { ...event.item.metadata, acp: retained.data } : event.item.metadata;
    let detail: ProviderToolCallDetail = event.item.detail;
    if (tool.kind === "read") {
      const path = tool.locations?.[0]?.path ?? (typeof input?.path === "string" ? input.path
        : typeof input?.filePath === "string" ? input.filePath : typeof input?.file === "string" ? input.file : undefined);
      if (path !== undefined) detail = {
        type: "read", filePath: path, ...(text !== undefined ? { content: text } : {}),
        ...(typeof input?.offset === "number" ? { offset: input.offset } : {}),
        ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
      };
    }
    if (detail.type === "unknown" && text !== undefined && tool.output == null) {
      detail = { ...detail, output: text };
    }
    if (event.item.status !== "failed") return { ...event, item: { ...event.item, detail, metadata } };
    // rawOutput and textual tool content are output, not an error description.
    // Only an explicit error field carries an actual error; otherwise use the
    // same generic fallback as the native ACP mapping.
    const explicit = tool.error ?? record(tool.output)?.error ?? (!queued ? event.item.error : undefined);
    const parsed = json(explicit);
    const error = parsed.success && parsed.data !== null ? parsed.data : { message: "Tool call failed" };
    return { ...event, item: { ...event.item, detail, metadata, error } };
  }
}

export type AcpToolRuntime = ToolRuntime;

/** Enrich before prompt capture and journaling using only public provider events. */
export function adaptAcpToolConnection(
  connection: ProviderConnection,
  run: (runtime: AcpToolRuntime, operation: () => Promise<void>) => Promise<void>,
): ProviderConnection {
  const sessions = new Map<string, ToolRuntime>();
  const requests = new Map<string, { sessionId: string; runtime: ToolRuntime }>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const forget = (sessionId: string) => {
    const runtime = sessions.get(sessionId);
    runtime?.clear(); sessions.delete(sessionId);
    for (const [id, open] of requests) if (open.runtime === runtime) requests.delete(id);
  };
  const unsubscribe = connection.onEvent(original => {
    const runtime = "sessionId" in original ? sessions.get(original.sessionId) : undefined;
    const event = runtime?.adapt(original) ?? original;
    if (original.type === "request.failed") {
      const open = requests.get(original.requestId);
      if (open && sessions.get(open.sessionId) === open.runtime) forget(open.sessionId);
      requests.delete(original.requestId);
    } else if (original.type === "session.ready" && original.requestId) requests.delete(original.requestId);
    else if (original.type === "session.closed" || original.type === "session.runtime_failed") forget(original.sessionId);
    for (const listener of listeners) listener(event);
  });
  return {
    version: connection.version,
    capabilities: connection.capabilities,
    async send(input) {
      if (input.type !== "session.open" || sessions.has(input.sessionId)) return connection.send(input);
      const runtime = new ToolRuntime(input.history);
      sessions.set(input.sessionId, runtime);
      requests.set(input.requestId, { sessionId: input.sessionId, runtime });
      try { await run(runtime, () => connection.send(input)); }
      catch (error) { forget(input.sessionId); requests.delete(input.requestId); throw error; }
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      try { await connection.close(); }
      finally {
        unsubscribe();
        for (const runtime of sessions.values()) runtime.clear();
        sessions.clear(); requests.clear(); listeners.clear();
      }
    },
  };
}
