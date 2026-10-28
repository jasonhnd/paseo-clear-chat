import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const modelsSchema = z.object({
  currentModelId: z.string(),
  availableModels: z.array(z.object({ modelId: z.string(), name: z.string(), description: z.string().nullish() })),
});
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

/** Adapt native ACP model control to the SDK 0.13 public config-option transport. */
export function hermesCcModelProtocol(capture?: (response: unknown) => void) {
  type State = { models: z.infer<typeof modelsSchema>; options: unknown[]; id: string; modes?: unknown };
  const sessions = new Map<string, State>();
  const pending = new Map<string | number, { method: string; params: RecordValue; model?: string }>();
  const options = (state: State) => [...state.options, {
    id: state.id, name: "Model", category: "model", type: "select",
    currentValue: state.models.currentModelId,
    options: state.models.availableModels.map(model => ({ value: model.modelId, name: model.name,
      ...(model.description != null ? { description: model.description } : {}) })),
  }];
  const snapshot = (state: State) => ({ models: state.models, modes: state.modes, configOptions: options(state) });
  return {
    sent(message: AcpStreamMessage): AcpStreamMessage {
      if (!("method" in message) || !("id" in message) || message.id === null) return message;
      const params = record(message.params) ?? {};
      const state = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
      const model = message.method === "session/set_config_option" && state && params.configId === state.id
        && typeof params.value === "string" ? params.value : undefined;
      if (["session/new", "session/load", "session/set_config_option", "session/set_mode"].includes(message.method)) {
        pending.set(message.id, { method: message.method, params, model });
      }
      // Reuse the caller's ID: there are no adapter-generated requests or IDs.
      return model === undefined ? message : { ...message, method: "session/set_model",
        params: { sessionId: params.sessionId, modelId: model } };
    },
    received(message: AcpStreamMessage): AcpStreamMessage {
      if ("method" in message) {
        if (message.method !== "session/update") return message;
        const params = record(message.params), update = record(params?.update);
        const state = typeof params?.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
        if (!state || !update) return message;
        if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
          state.options = update.configOptions;
        } else if (update.sessionUpdate === "current_model_update" && typeof update.currentModelId === "string") {
          state.models = { ...state.models, currentModelId: update.currentModelId };
        } else return message;
        capture?.(snapshot(state));
        return { ...message, params: { ...params, update: { sessionUpdate: "config_option_update", configOptions: options(state) } } };
      }
      if (message.id === null) return message;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (!request || !("result" in message)) return message;
      const result = record(message.result) ?? {};
      if (request.method === "session/new" || request.method === "session/load") {
        const sessionId = request.method === "session/new" ? result.sessionId : request.params.sessionId;
        const parsed = modelsSchema.safeParse(result.models);
        const nativeOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
        if (typeof sessionId !== "string" || !parsed.success ||
            nativeOptions.some(option => record(option)?.category === "model")) return message;
        let id = "clear-chat-native-model";
        while (nativeOptions.some(option => record(option)?.id === id)) id += "_";
        const state: State = { models: parsed.data, options: nativeOptions, id, modes: result.modes };
        sessions.set(sessionId, state);
        return { ...message, result: { ...result, ...snapshot(state) } };
      }
      const state = typeof request.params.sessionId === "string" ? sessions.get(request.params.sessionId) : undefined;
      if (!state) return message;
      // Native set_model confirms selection with an empty successful response.
      // Errors pass through above and never change the confirmed model.
      if (request.model !== undefined) state.models = { ...state.models, currentModelId: request.model };
      else if (request.method === "session/set_config_option" && Array.isArray(result.configOptions)) state.options = result.configOptions;
      capture?.(snapshot(state));
      return { ...message, result: { ...result, ...snapshot(state) } };
    },
  };
}
