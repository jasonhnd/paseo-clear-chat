import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderCatalog } from "@getpaseo/plugin/server/provider";

const MAX_BYTES = 1024 * 1024;
const text = z.string().max(4096);
const choice = z.object({ value: text, name: text, description: text.nullish() });
const select = z.object({
  type: z.literal("select"), category: text.nullish(), currentValue: text,
  options: z.array(z.union([choice, z.object({ group: text, options: z.array(choice) })])),
}).refine((option) => option.category === "model" || option.options.reduce((count, entry) =>
  count + ("value" in entry ? 1 : entry.options.length), 0) <= 256);
const nativeModelsSchema = z.object({
  currentModelId: text, availableModels: z.array(z.object({
    modelId: text, name: text, description: text.nullish(),
  })),
}).nullish();
const responseSchema = z.object({
  modes: z.object({ currentModeId: text.nullish(), availableModes: z.array(z.object({
    id: text, name: text, description: text.nullish(),
  })).max(256).nullish() }).nullish(),
  models: z.unknown().optional(),
  configOptions: z.array(z.unknown()).max(256).nullish().catch(undefined),
});
const selector = z.object({
  id: text, label: text, description: text.optional(), isDefault: z.boolean().optional(),
  metadata: z.object({ group: text }).strict().optional(),
}).strict();
const catalogSchema = z.object({
  modes: z.array(z.object({ id: text, label: text, description: text.optional() }).strict()).max(256),
  models: z.array(selector.extend({
    thinkingOptions: z.array(selector).max(256).optional(), defaultThinkingOptionId: text.optional(),
  }).strict()),
  defaultMode: text.optional(), defaultModel: text.optional(),
}).strict();
const envelopeSchema = z.object({ version: z.literal(1), providerId: text, catalog: catalogSchema }).strict();

/**
 * Port of Paseo v0.13.1 packages/server/src/server/agent/providers/acp-agent.ts:
 * deriveModesFromACP (773-806), deriveModelDefinitionsFromACP (808-842),
 * findSelectConfigOption, flattenSelectOptions and deriveSelectorOptions (3470-3596).
 * ProviderCatalog omits the host-owned `provider` field; the host adds the CC id.
 * No fallback modes: generic Hermes ACP has no static mode definitions.
 */
export function deriveHermesCcCatalog(response: unknown): ProviderCatalog | undefined {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) return;
  const state = parsed.data;
  if (!state.modes && !state.models && !state.configOptions) return;
  const options: z.infer<typeof select>[] = [];
  for (const entry of state.configOptions ?? []) {
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "select") continue;
    const parsed = select.safeParse(entry);
    if (!parsed.success) continue;
    options.push(parsed.data);
  }
  const find = (category: string) => options.find((entry) => entry.category === category);
  const flatten = (option: z.infer<typeof select>) => option.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options.map((item) => ({ ...item, group: entry.group })));
  const selectors = (category: string) => {
    const option = find(category);
    return option ? flatten(option).map((entry) => ({
      id: entry.value, label: entry.name, description: entry.description ?? undefined,
      isDefault: entry.value === option.currentValue,
      metadata: "group" in entry && entry.group ? { group: entry.group } : undefined,
    })) : [];
  };
  const modeOption = find("mode");
  const modes = state.modes?.availableModes?.length ? state.modes.availableModes.map((mode) => ({
    id: mode.id, label: mode.name, description: mode.description ?? undefined,
  })) : modeOption ? flatten(modeOption).map((entry) => ({
    id: entry.value, label: entry.name, description: entry.description ?? undefined,
  })) : [];
  const thinkingOptions = selectors("thought_level");
  const thinking = thinkingOptions.length ? {
    thinkingOptions, defaultThinkingOptionId: thinkingOptions.find((entry) => entry.isDefault)?.id,
  } : {};
  // A doubtful model list is discarded in full without losing valid modes.
  const nativeModels = nativeModelsSchema.safeParse(state.models);
  const modelState = nativeModels.success ? nativeModels.data : undefined;
  const models = !nativeModels.success ? [] : modelState?.availableModels?.length ? modelState.availableModels.map((model) => ({
    id: model.modelId, label: model.name, description: model.description ?? undefined,
    isDefault: model.modelId === modelState.currentModelId, ...thinking,
  })) : selectors("model").map((model) => ({ ...model, ...thinking }));
  // The source snapshot leaves defaultMode to the host; currentModeId is session state.
  const catalog = catalogSchema.safeParse({ modes, models,
    ...(models.some((model) => model.isDefault) ? { defaultModel: models.find((model) => model.isDefault)!.id } : {}),
  });
  if (catalog.success) return catalog.data;
  const modesOnly = catalogSchema.safeParse({ modes, models: [] });
  return modesOnly.success ? modesOnly.data : undefined;
}

/** Observe only replies to opens on a user-requested session transport. */
export function hermesCcCatalogObserver(capture: (result: unknown) => void) {
  const pending = new Set<string | number>();
  return {
    sent(message: AcpStreamMessage) {
      if ("method" in message && "id" in message && message.id !== null &&
          (message.method === "session/new" || message.method === "session/load")) pending.add(message.id);
    },
    received(message: AcpStreamMessage) {
      if (!("id" in message) || message.id === null || "method" in message || !pending.delete(message.id)) return;
      if ("result" in message) {
        // Learning is best effort and must never fail an open or prompt.
        try { capture(message.result); } catch { console.debug("[clear-chat] hermes_cc: catalog_capture_failed"); }
      }
    },
  };
}

export function createHermesCcCatalogStore(root: string) {
  const cache = new Map<string, ProviderCatalog | undefined>();
  let writes = Promise.resolve();
  const pathFor = (id: string) => join(root, `${createHash("sha256").update(id).digest("hex")}.json`);
  return {
    read(id: string): ProviderCatalog | undefined {
      if (!cache.has(id)) {
        let fd: number | undefined;
        let catalog: ProviderCatalog | undefined;
        try {
          fd = openSync(pathFor(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("catalog_size");
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          let size = 0, count: number;
          while ((count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
          if (size > MAX_BYTES) throw new Error("catalog_size");
          const envelope = envelopeSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
          if (envelope.providerId !== id) throw new Error("catalog_identity");
          catalog = envelope.catalog;
        } catch { /* Missing, malformed or doubtful catalogs are ignored. */ }
        finally { if (fd !== undefined) closeSync(fd); }
        cache.set(id, catalog);
      }
      return structuredClone(cache.get(id));
    },
    capture(id: string, response: unknown) {
      let catalog = deriveHermesCcCatalog(response);
      if (!catalog) return;
      let data = JSON.stringify({ version: 1, providerId: id, catalog });
      if (Buffer.byteLength(data) > MAX_BYTES) {
        // Keep all models or none; the persisted envelope is the size boundary.
        catalog = { modes: catalog.modes, models: [] };
        data = JSON.stringify({ version: 1, providerId: id, catalog });
      }
      if (Buffer.byteLength(data) > MAX_BYTES) return;
      if (JSON.stringify(catalog) === JSON.stringify(this.read(id))) return;
      cache.set(id, catalog);
      // Publish to memory immediately; disk latency/failure never delays an open.
      writes = writes.then(async () => {
        const temporary = join(root, `.${randomUUID()}.tmp`);
        try {
          await mkdir(root, { recursive: true, mode: 0o700 });
          await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
          await rename(temporary, pathFor(id));
        } finally { await unlink(temporary).catch(() => {}); }
      }).catch(() => { console.debug("[clear-chat] hermes_cc: catalog_save_failed"); });
    },
    flush: () => writes,
  };
}
export type HermesCcCatalogStore = ReturnType<typeof createHermesCcCatalogStore>;
