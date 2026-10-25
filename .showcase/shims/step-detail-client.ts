import { useMemo, useSyncExternalStore } from "react";
export { defineTranslations, useTranslation, PluginTranslationProvider, PluginTranslationRuntime } from "../../node_modules/@getpaseo/plugin/dist/client/translations.js";

const agent = { cwd: "/workspace/demo", workspaceId: "demo-workspace", status: "idle", updatedAt: "2026-01-01T12:00:00Z" };
const paseo = { agents: { ref: () => ({ refresh: async () => null, timeline: { refetch: async () => ({ entries: [] }) } }) } };
let expansion = { entries: {} };
let workspaceReady = location.pathname !== "/host-context";
const workspaceListeners = new Set<() => void>();
export const previewWorkspaceReady = () => workspaceReady;
export function hydratePreviewWorkspace() {
  workspaceReady = true;
  for (const listener of workspaceListeners) listener();
}

export function useAgent<T>(_agentId: string, selector: (value: never) => T): T {
  return selector(agent as never);
}
export function usePaseo() { return paseo as never; }
export function useWorkspace<T>(workspaceId: string, selector: (value: never) => T): T | null {
  const ready = useSyncExternalStore(listener => {
    workspaceListeners.add(listener);
    return () => { workspaceListeners.delete(listener); };
  }, previewWorkspaceReady);
  return ready && workspaceId ? selector({ id: agent.workspaceId } as never) : null;
}
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
