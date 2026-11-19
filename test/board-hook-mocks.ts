import type { AgentRef, WorkspaceRef } from "@getpaseo/plugin/client";
import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type * as pluginClient from "@getpaseo/plugin/client";

// These empty mocks check both SDK overloads without relying on a partial snapshot.
export const boardHookMocks = {
  useAgent: (_ref: string | AgentRef, _selector?: (agent: PluginAgentSnapshot) => unknown) => null,
  useWorkspace: (_ref: string | WorkspaceRef, _selector?: (workspace: PluginWorkspaceSnapshot) => unknown) => null,
} satisfies Pick<typeof pluginClient, "useAgent" | "useWorkspace">;
