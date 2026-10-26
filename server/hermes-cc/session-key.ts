/** Decode only a native ACP session persisted by the Paseo v0.13.0 plugin bridge. */
export function nativeSessionKeyFromPersistence(handle: unknown): string | null {
  if (typeof handle !== "string" || !handle.startsWith("plugin:")) return null;
  try {
    // packages/server/src/server/agent/plugin-provider.ts:1722-1751 wraps persistence as plugin:<JSON>.
    const value: unknown = JSON.parse(handle.slice("plugin:".length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const persistence = value as Record<string, unknown>;
    // packages/plugin/src/server/acp-internal/connection.ts:1357-1369 stores {version:1,data:{sessionId}}.
    if (persistence.version !== 1 || Object.keys(persistence).some(key => key !== "version" && key !== "data") ||
        !persistence.data || typeof persistence.data !== "object" || Array.isArray(persistence.data)) return null;
    const id = (persistence.data as Record<string, unknown>).sessionId;
    return typeof id === "string" && !!id.trim() && id.length <= 512 && !id.includes("\0") ? id : null;
  } catch { return null; }
}
