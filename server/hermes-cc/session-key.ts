/** Native identity emitted on session.opened / session.persistence by the ACP SDK. */
export function nativeKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const persistence = value as Record<string, unknown>;
  if (persistence.version !== 1 || Object.keys(persistence).some(key => key !== "version" && key !== "data") ||
      !persistence.data || typeof persistence.data !== "object" || Array.isArray(persistence.data)) return null;
  const id = (persistence.data as Record<string, unknown>).sessionId;
  return typeof id === "string" && !!id.trim() && id.length <= 512 && !id.includes("\0") ? id : null;
}

/** Decode only unambiguous SDK ACP handles; boundary capture uses nativeKey too. */
export function nativeSessionKeyFromPersistence(handle: unknown, nativeHandle: unknown = null): string | null {
  let result: string | null = null;
  for (const candidate of [handle, nativeHandle]) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate !== "string" || !candidate.startsWith("plugin:")) return null;
    try {
      // Paseo v0.13.0 server/agent/plugin-provider.ts:1722-1735 wraps persistence;
      // plugin/src/server/acp-internal/connection.ts:1357-1369 stores data.sessionId.
      const key = nativeKey(JSON.parse(candidate.slice("plugin:".length)));
      if (key === null || (result !== null && result !== key)) return null;
      result = key;
    } catch { return null; }
  }
  return result;
}
