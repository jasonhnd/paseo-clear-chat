"use strict";

// In-memory provider fixture. Controls are deliberately separate from the provider protocol.
function createIdleLifecycleFixture() {
  const sessions = new Map(), listeners = new Set(), inputs = [];
  let connected = false;
  const emit = event => { for (const listener of listeners) listener(structuredClone(event)); };
  const session = id => {
    const value = sessions.get(id);
    if (!value) throw new Error("Unknown synthetic session");
    return value;
  };
  const tool = (id, status) => emit({ type: "timeline.item", sessionId: id, item: {
    type: "tool_call", id: "background", callId: "background", name: "synthetic background work",
    status, error: null, detail: { type: "plain_text", text: "Synthetic work" },
  } });
  const connection = {
    version: 1, capabilities: ["prompt.message", "permission", "session.subsession"],
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(input) {
      inputs.push(structuredClone(input));
      if (input.type === "session.open") {
        if (sessions.has(input.sessionId)) throw new Error("Duplicate synthetic session");
        sessions.set(input.sessionId, { cwd: input.config.cwd, pending: false, background: false, refuse: false });
        emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
          cwd: input.config.cwd, capabilities: connection.capabilities, restoration: "core" });
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      } else if (input.type === "session.prompt") {
        session(input.sessionId);
        const turnId = input.prompt.clientMessageId;
        emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: turnId,
          result: { type: "turn", turnId } });
        emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
        emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
      } else if (input.type === "session.permission") {
        const state = session(input.sessionId);
        if (!state.pending || input.permissionId !== "approval") throw new Error("Unknown synthetic approval");
        state.pending = false;
        emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
      } else if (input.type === "session.close") {
        const state = session(input.sessionId);
        if (state.refuse) {
          emit({ type: "request.failed", requestId: input.requestId,
            error: { code: "synthetic_refusal", message: "Synthetic close refusal" } });
        } else {
          sessions.delete(input.sessionId);
          emit({ type: "session.closed", sessionId: input.sessionId });
          emit({ type: "request.completed", requestId: input.requestId });
        }
      } else throw new Error("Unsupported synthetic input");
    },
    async close() { sessions.clear(); listeners.clear(); },
  };
  return {
    registration: { id: "synthetic-idle-lifecycle", label: "Synthetic lifecycle fixture",
      async connect() { if (connected) throw new Error("Fixture already connected"); connected = true; return connection; } },
    inputs,
    startBackground(id) { const state = session(id); if (state.background) throw new Error("Work already running"); state.background = true; tool(id, "running"); },
    finishBackground(id) { const state = session(id); if (!state.background) throw new Error("No work running"); state.background = false; tool(id, "completed"); },
    requestApproval(id) {
      const state = session(id); if (state.pending) throw new Error("Approval already pending"); state.pending = true;
      emit({ type: "session.permission", sessionId: id, request: { id: "approval", name: "synthetic approval", kind: "other" } });
    },
    openChild(parentId, childId) {
      const parent = session(parentId);
      if (sessions.has(childId)) throw new Error("Duplicate synthetic session");
      sessions.set(childId, { cwd: parent.cwd, pending: false, background: false, refuse: false });
      emit({ type: "session.opened", sessionId: childId, parentSessionId: parentId, toolCallId: "child-call",
        cwd: parent.cwd, capabilities: connection.capabilities, restoration: "parent" });
      emit({ type: "session.ready", sessionId: childId });
    },
    setCloseRefusal(id, refuse) { session(id).refuse = refuse; },
    hasSession(id) { return sessions.has(id); },
  };
}
module.exports = { createIdleLifecycleFixture };
