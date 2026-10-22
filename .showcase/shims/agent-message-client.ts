import entries from "../../test/fixtures/real-claude-agent-message.json";
export { useRpc, useWorkspace } from "./step-detail-client";
const agent = { status: "idle", updatedAt: "2026-01-01T12:00:30Z", cwd: "/workspace/demo", workspaceId: "demo-workspace" };
const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries, error: null }) } }) } };
export function usePaseo() { return paseo as never; }
export function useAgent<T>(id: string, selector: (value: never) => T): T | null {
  return id === "sample-agent" ? selector(agent as never) : null;
}
