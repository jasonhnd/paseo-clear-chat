import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { hermesCcTransport } from "./transport";
import type { HermesCcLaunch } from "./transport";
import { nativeKey } from "./session-key";
import { journalHermesCcConnection } from "./history-connection";
import type { HermesCcHistoryStore } from "./history-store";
export { nativeSessionKeyFromPersistence } from "./session-key";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderContent,
  ProviderModel,
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
  historyStore?: HermesCcHistoryStore,
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
    // The connector runs asynchronously after send() returns. AsyncLocalStorage
    // keeps launch context isolated across concurrent sessions and discovery.
    const context = new AsyncLocalStorage<HermesCcLaunch & { env?: Readonly<Record<string, string>> }>();
    const models = hermesCcConfiguredModels(source);
    const defaultModel = models.find((model) => model.isDefault)?.id;
    const provider = runAcpProvider({
      id, label: `${typeof source.label === "string" && source.label.trim() ? source.label : sourceId}·CC`,
      // SDK v0.13.0 acp-internal/connection.ts:72-89 probes with initialize
      // only. discover():564-574 otherwise creates a persistent session/new.
      // acp.ts:47-48 supports an initialization-only global catalog; route all
      // catalogs through it below; configured models need no ACP session.
      acpOptions: { workspaceOnlyCatalog: true },
      transformers: [{ discover: (catalog) => ({
        ...catalog,
        models,
        ...(defaultModel ? { defaultModel } : {}),
      }) }],
      connector: () => {
        const launch = context.getStore();
        // Rebuild from the worker's inherited daemon env, not the -cc launch
        // env, whose overrides belong to a different provider ID.
        return hermesCcTransport(command, hermesCcSourceEnv(process.env, { ...env, ...launch?.env }), launch);
      },
    });
    registrations.push({
      ...provider,
      async connect(request) {
        const captured = captureHermesCcPrompts(await provider.connect(request), hook);
        const connection = historyStore ? journalHermesCcConnection(captured, id, historyStore) : captured;
        return {
          ...connection,
          send(input) {
            const launch = input.type === "session.open" ? {
              cwd: input.config.cwd, env: input.config.env, history: input.history,
              existingSession: nativeKey(input.persistence) !== null,
            } : {};
            // A workspace cwd bypasses workspaceOnlyCatalog in SDK
            // connection.ts:565. Listing sessions still forwards its cwd filter.
            const request = input.type === "catalog" ? { type: input.type, requestId: input.requestId } : input;
            return context.run(launch, () => connection.send(request));
          },
        };
      },
    });
  }
  return registrations;
}

// Paseo v0.13.1 protocol/provider-config.ts:35-49 defines these config fields.
const configuredModelSchema = z.object({
  id: z.string().min(1), label: z.string().min(1),
  description: z.string().optional(), isDefault: z.boolean().optional(),
  thinkingOptions: z.array(z.object({
    id: z.string(), label: z.string(), description: z.string().optional(),
    isDefault: z.boolean().optional(),
  })).optional(),
});

/** Match source model replacement/addition semantics without probing Hermes. */
function hermesCcConfiguredModels(source: Record<string, unknown>): ProviderModel[] {
  const read = (value: unknown): ProviderModel[] => {
    const parsed = z.array(configuredModelSchema).safeParse(value);
    return parsed.success ? parsed.data.map((model) => ({
      ...model,
      ...(model.thinkingOptions?.some((option) => option.isDefault) ? {
        defaultThinkingOptionId: model.thinkingOptions.find((option) => option.isDefault)!.id,
      } : {}),
    })) : [];
  };
  const models = read(source.models), additions = read(source.additionalModels);
  // provider-registry.ts:390-435 merges additions by ID, preserving order, and
  // clears previous defaults when an addition declares a new default.
  for (const model of additions) {
    const index = models.findIndex((candidate) => candidate.id === model.id);
    if (index < 0) models.push(model);
    else models[index] = { ...models[index]!, ...model };
  }
  if (!additions.some((model) => model.isDefault)) return models;
  const defaults = new Set(additions.filter((model) => model.isDefault).map((model) => model.id));
  return models.map((model) => defaults.has(model.id) ? model : { ...model, isDefault: false });
}

/** Paseo 0.13 provider-launch-config.ts:238-252 and paseo-env.ts:21-34. */
export function hermesCcSourceEnv(base: NodeJS.ProcessEnv, overlay: Record<string, string>): Record<string, string> {
  const env = { ...base, ...overlay };
  // The plugin is forked (plugins/runtime.ts:233-238); ACP is not. Never pass
  // the worker's IPC channel to Hermes, including future NODE_CHANNEL_* keys.
  for (const key of Object.keys(env)) if (key.startsWith("NODE_CHANNEL_")) delete env[key];
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
