import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { toolExpansionSettingsRpc } from "../shared/tool-expansion-settings";
import { createToolExpansionStore, toolExpansionKey, type ToolExpansionIdentity, type ToolExpansionStore } from "./tool-expansion-store";

const stores = new Map<string, ToolExpansionStore>();

export function useToolExpansion(identity: ToolExpansionIdentity, defaultExpanded: boolean) {
  const read = useRpc(toolExpansionSettingsRpc.read);
  const write = useRpc(toolExpansionSettingsRpc.write);
  const store = useMemo(() => {
    let value = stores.get(identity.hostId);
    if (!value) { value = createToolExpansionStore(); stores.set(identity.hostId, value); }
    return value;
  }, [identity.hostId]);
  const key = toolExpansionKey(identity);
  useEffect(() => {
    void store.connect(read, write);
    // Navigation and history virtualization also flush the final debounced edit.
    return () => { void store.flush(); };
  }, [store, read, write]);
  const choice = useSyncExternalStore(store.subscribe, () => store.get(key), () => undefined);
  const error = useSyncExternalStore(store.subscribe, store.getError, store.getError);
  return {
    expanded: choice ?? defaultExpanded,
    onExpandedChange: (expanded: boolean) => store.set(key, expanded),
    error,
  };
}
