import { nativeKey } from "./session-key";
export { nativeSessionKeyFromPersistence } from "./session-key";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderContent,
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
  if (!/^(?:hermes|hermes\.exe|hermes\.cmd)$/i.test(executable ?? "")) return false;
  if (command[command.length - 1] !== "acp") return false;
  if (command.length === 2) return true;
  if (command.length === 3) return /^--profile=[^-\s].*$/.test(command[1] ?? "");
  return command.length === 4 && (command[1] === "-p" || command[1] === "--profile")
    && (command[2]?.trim().length ?? 0) > 0 && !command[2]?.startsWith("-");
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
            // Malformed image parts are skipped individually, never decoded with
            // Buffer's permissive base64 parser. No substitution or guessing.
            const images = input.prompt.input.type === "message"
              ? input.prompt.input.content.flatMap(capturedImage) : [];
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
    if (source.enabled === false || source.extends !== "acp" || !isHermesAcpCommand(source.command)) continue;
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
      // ProviderRegistration.command is optional (SDK server/provider.ts:33-36).
      // Host resolution is keyed by the new -cc ID and cannot see source env/PATH.
      // Keep the source command in the ACP adapter; supply its exact launch below.
      command: undefined,
      async connect(request) {
        // The worker inherits the daemon env (server/plugins/runtime.ts:233-238).
        // Reproduce the source provider's env from that base, including stripping
        // AFTER overlays: agent/provider-launch-config.ts:211-216,237-253 and
        // server/paseo-env.ts:4-11,25-40. The SDK exports no env builder. Using the
        // -cc launch env as a base would retain unrelated -cc overrides.
        const launch = { command: command[0], args: command.slice(1), env: hermesCcSourceEnv(process.env, env) };
        // ACP connection.ts:405-416 accepts an explicit launch. Its spawn uses
        // source PATH, as GenericACPAgentClient.resolveLaunchCommand does in
        // server/agent/providers/generic-acp-agent.ts:72-77.
        const connection = await provider.connect({ ...request, launch });
        return captureHermesCcPrompts(connection, hook);
      },
    });
  }
  return registrations;
}

/** Exact Paseo 0.13 source-provider env policy; no daemon controls reach ACP. */
export function hermesCcSourceEnv(base: NodeJS.ProcessEnv, overlay: Record<string, string>): Record<string, string> {
  const env = { ...base, ...overlay };
  for (const key of [
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION",
    "PASEO_NODE_ENV", "PASEO_DESKTOP_MANAGED", "PASEO_SUPERVISED", "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ATTACH_CONSOLE", "ESBUILD_BINARY_PATH",
  ]) delete env[key];
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function capturedImage(part: ProviderContent): HermesCcImageInput[] {
  if (!part || part.type !== "image" || typeof part.mimeType !== "string" || typeof part.data !== "string" ||
      part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) return [];
  const bytes = Buffer.from(part.data, "base64");
  if (bytes.toString("base64") !== part.data) return [];
  return [{ mime: part.mimeType, data: bytes }];
}
