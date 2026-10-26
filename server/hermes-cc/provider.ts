import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderPersistence,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

/** Structural match for the image store's input; this shell owns no storage. */
export interface HermesCcImageInput { mime: string; data: Buffer }

export type HermesCcPromptHook = (info: {
  sessionKey: string;
  clientMessageId: string | null;
  images: HermesCcImageInput[];
}) => Promise<void>;

/** Match the executable and the complete argument grammar, never an ID/label. */
export function isHermesAcpCommand(command: unknown): command is [string, ...string[]] {
  if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) return false;
  const executable = command[0]?.replace(/\\/g, "/").split("/").pop();
  if (!/^(?:hermes|hermes\.exe|hermes\.cmd)$/.test(executable ?? "")) return false;
  if (command[command.length - 1] !== "acp") return false;
  if (command.length === 2) return true;
  if (command.length === 3) return /^--profile=\S.*$/.test(command[1] ?? "");
  return command.length === 4 && (command[1] === "-p" || command[1] === "--profile")
    && (command[2]?.trim().length ?? 0) > 0 && !command[2]?.startsWith("-");
}

function nativeKey(persistence: unknown): string | null {
  if (!persistence || typeof persistence !== "object" || Array.isArray(persistence)) return null;
  const { version, data } = persistence as Partial<ProviderPersistence>;
  if (version !== 1 || !data || typeof data !== "object" || Array.isArray(data)) return null;
  return typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : null;
}

/**
 * Paseo v0.13.0 packages/server/src/server/agent/plugin-provider.ts:1721-1760
 * stores sessionId as `plugin:${JSON.stringify(persistence)}`. The ACP adapter
 * writes { version: 1, data: { sessionId: nativeAcpId } } in
 * packages/plugin/src/server/acp-internal/connection.ts:1357-1369. This is the
 * same native ID captured from session.opened below, including restored sessions.
 * Decode only SDK handles; opaque IDs and conflicting handles select nothing.
 */
export function nativeSessionKeyFromPersistence(
  sessionId: string | null,
  nativeHandle: string | null,
): string | null {
  let result: string | null = null;
  for (const handle of [sessionId, nativeHandle]) {
    if (handle === null) continue;
    if (!handle.startsWith("plugin:")) return null;
    let key: string | null;
    try { key = nativeKey(JSON.parse(handle.slice("plugin:".length))); }
    catch { return null; }
    if (key === null || (result !== null && result !== key)) return null;
    result = key;
  }
  return result;
}

/** Observe the provider boundary without rewriting any outgoing prompt. */
export function captureHermesCcPrompts(
  connection: ProviderConnection,
  hook: HermesCcPromptHook,
): ProviderConnection {
  const sessions = new Map<string, string>();
  // SDK v0.13.0 packages/plugin/src/server/acp-internal/connection.ts:546-552
  // emits the boundary ID plus native persistence before session.ready.
  const unsubscribe = connection.onEvent((event) => {
    if (event.type === "session.opened" || event.type === "session.persistence") {
      const key = nativeKey(event.persistence);
      if (key === null) sessions.delete(event.sessionId);
      else sessions.set(event.sessionId, key);
    } else if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      sessions.delete(event.sessionId);
    }
  });
  return {
    version: connection.version,
    capabilities: connection.capabilities,
    async send(input) {
      if (input.type === "session.prompt") {
        const sessionKey = sessions.get(input.sessionId);
        if (sessionKey !== undefined) {
          try {
            // SDK v0.13.0 packages/plugin/src/server/provider.ts:131-139,228-230:
            // image data is base64 and the client identity is on ProviderPrompt.
            // Empty-image and command prompts also call the hook with []. Buffers
            // are separate allocations so even a mutating hook cannot edit input.
            const images = input.prompt.input.type === "message"
              ? input.prompt.input.content.flatMap((part) => part.type === "image"
                ? [{ mime: part.mimeType, data: Buffer.from(part.data, "base64") }] : [])
              : [];
            await hook({ sessionKey, clientMessageId: input.prompt.clientMessageId ?? null, images });
          } catch {
            console.debug("[clear-chat] hermes_cc: capture_failed");
          }
        } else {
          console.debug("[clear-chat] hermes_cc: session_key_unavailable");
        }
      }
      // SDK v0.13.0 packages/plugin/src/server/acp-internal/connection.ts:1344-1354
      // passes text/image blocks to ACP unchanged. Preserve that contract here.
      return connection.send(input);
    },
    onEvent: (listener) => connection.onEvent(listener),
    async close() {
      unsubscribe();
      sessions.clear();
      await connection.close();
    },
  };
}

/** Build registrations synchronously from the startup config snapshot. */
export function hermesCcProvidersFromConfig(
  providers: Readonly<Record<string, unknown>>,
  enabled: boolean,
  hook: HermesCcPromptHook,
): ProviderRegistration[] {
  if (!enabled) return [];
  const registrations: ProviderRegistration[] = [];
  for (const [sourceId, value] of Object.entries(providers)) {
    const id = `${sourceId}-cc`;
    if (Object.hasOwn(providers, id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Record<string, unknown>;
    if (source.extends !== "acp" || !isHermesAcpCommand(source.command)) continue;
    const command: [string, ...string[]] = [source.command[0], ...source.command.slice(1)];
    const env: Record<string, string> = {};
    if (source.env && typeof source.env === "object" && !Array.isArray(source.env)) {
      for (const [name, entry] of Object.entries(source.env)) {
        if (typeof entry === "string") env[name] = entry;
      }
    }
    // SDK v0.13.0 packages/plugin/src/server/acp.ts:106-124 returns a public
    // registration; no manifest provider entry or host config mutation is needed.
    const provider = runAcpProvider({ id, label: `${typeof source.label === "string" && source.label.trim() ? source.label : sourceId}·CC`, command });
    registrations.push({
      ...provider,
      async connect(request) {
        // SDK v0.13.0 packages/server/src/server/agent/plugin-provider.ts:150-162
        // resolves the executable and complete host env. The source provider's
        // env is absent for a new ID, so copy its explicit overlay into launch.
        // ACP connection.ts:405-413 consumes that launch without re-parsing args.
        const launch = request.launch ?? {
          command: command[0], args: command.slice(1),
          env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        };
        const connection = await provider.connect({ ...request, launch: { ...launch, env: { ...launch.env, ...env } } });
        return captureHermesCcPrompts(connection, hook);
      },
    });
  }
  return registrations;
}
