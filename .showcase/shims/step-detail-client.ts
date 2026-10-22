import { useMemo } from "react";

const agent = { cwd: "/workspace/demo", workspaceId: "demo-workspace", status: "idle", updatedAt: "2026-01-01T12:00:00Z" };
const paseo = { agents: { ref: () => ({ refresh: async () => null, timeline: { refetch: async () => ({ entries: [] }) } }) } };
let expansion = { entries: {} };

export function useAgent<T>(_agentId: string, selector: (value: never) => T): T {
  return selector(agent as never);
}
export function usePaseo() { return paseo as never; }
export function useWorkspace() { return null; }
export function useRpc(contract: { name: string }) {
  return useMemo(() => async (input: { values?: typeof expansion }) => {
    if (contract.name === "file.image") return {
      dataUri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAABCAIAAABYG7kIAAAADElEQVR4nGO4QyIAAPL+KUFbAyzAAAAAAElFTkSuQmCC",
      width: 4096, height: 256, bytes: 68, error: null,
    };
    if (contract.name.endsWith(".read")) return { status: "ready", revision: "0", values: expansion };
    if (input.values) expansion = input.values;
    return { status: "saved", revision: "0", values: expansion };
  }, [contract.name]);
}
