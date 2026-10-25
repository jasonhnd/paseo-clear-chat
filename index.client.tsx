import { messages } from "./client/messages";
import { initializeClientTranslations, translate as t } from "./client/translation";
import type { PluginClientContext, PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import { requireHostMethods, STARTUP_MESSAGES } from "./shared/startup-diagnostics";
import { ClearChatSettingsPage } from "./client/settings-page";
import { embedFonts } from "./client/components/embed-fonts";
import { installFrostedGlass } from "./client/components/frosted";
import { installShimmer } from "./client/components/shimmer";
import { installPointerGlow } from "./client/components/glow";
import { installHostNoticeStyle } from "./client/components/host-notice";
import { installChatFind } from "./client/components/chat-find";
import { extractPromptImages } from "./client/prompt-images";
import { installCompactToolSpacing } from "./client/tool-row-spacing";
import { extractGeneratedImages } from "./client/generated-images";
import { projectedApprovalStatus } from "./client/tool-approval";
import { installStepDetailPanel } from "./client/components/step-detail-host";
import {
  getEnhancerPreferences,
  initializeEnhancerPreferences,
  onEnhancerPreferencesReady,
} from "./client/preferences";
import {
  LiveToolCallRenderer,
  LiveApprovalRenderer,
  LiveReasoningRenderer,
  LiveTodoRenderer,
  LiveUserMessageRenderer,
  LiveNoticeRenderer,
  LiveAssistantRenderer,
} from "./client/live-renderers";

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function addTextTransformer<ItemType extends "user_message" | "assistant_message">(
  client: PluginClientContext,
  contribution: PluginTimelineTransformerContribution<ItemType>,
) {
  let remove: ReturnType<PluginClientContext["addTimelineTransformer"]> | undefined;
  // Register only after the authoritative preferences arrive. The public SDK
  // registration notifies the host and gives its projection cache a new transform
  // callback, so replies first shown by the host are reconsidered without resizing.
  const stopWaiting = onEnhancerPreferencesReady(() => {
    remove = client.addTimelineTransformer(contribution);
  });
  return () => { stopWaiting(); return remove?.(); };
}

export default function contribute(client: PluginClientContext) {
  initializeClientTranslations(client);
  try {
    requireHostMethods(client, ["rpc", "addSettingsScreen", "addTimelineTransformer", "addTimelineRenderer"]);
    return registerClient(client);
  } catch (error) {
    if (error instanceof Error && error.message === STARTUP_MESSAGES.incompatibleHost) throw new Error(t("startup.incompatibleHost"));
    throw new Error(t("startup.startupFailed"));
  }
}

function registerClient(client: PluginClientContext) {
  void initializeEnhancerPreferences((contract, input) => client.rpc(contract, input));
  // Install the bundled faces before any surface paints.
  const removeFonts = embedFonts();
  const removeFrost = installFrostedGlass();
  const removeShimmer = installShimmer();
  const removeGlow = installPointerGlow();
  // The host draws  rows itself; this only re-chromes them.
  const removeNoticeStyle = installHostNoticeStyle();
  // Paseo's Ctrl+F cannot reveal rows this plugin draws; this bar can.
  const removeChatFind = installChatFind();
  const removeToolSpacing = installCompactToolSpacing();
  const removeStepDetails = installStepDetailPanel(client);

  // Configuration lives in the host Settings area.
  client.addSettingsScreen({
    id: "chat-presentation",
    title: messages.message("settings.title"),
    icon: "Blocks",
    Component: ClearChatSettingsPage,
  });

  // Live chat timeline interception: render real tool calls, reasoning, and todos with enhanced UI.
  const removeToolTransformer = client.addTimelineTransformer({
    id: "omp-enhanced-tool-call",
    query: { itemType: "tool_call" },
    transform({ item, phase }) {
      if (item.type !== "tool_call") return undefined;
      const approval = projectedApprovalStatus(item);
      if (approval) {
        return {
          items: [{
            type: "plugin" as const,
            kind: "omp-approval",
            version: 1,
            data: { status: approval },
          }],
        };
      }
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-tool-call",
            version: 1,
            data: {
              name: item.name,
              status: item.status,
              detail: toJsonValue(item.detail),
              ...("agentMessage" in item && item.agentMessage
                ? { agentMessage: toJsonValue(item.agentMessage) } : {}),
              ...("metadata" in item && item.metadata && typeof item.metadata === "object"
                ? { metadata: toJsonValue(item.metadata) } : {}),
              ...(item.callId ? { callId: item.callId } : {}),
              error: toJsonValue(item.error ?? null),
              phase,
            },
          },
        ],
      };
    },
  });

  const removeToolRenderer = client.addTimelineRenderer({
    kind: "omp-tool-call",
    version: 1,
    schema: z.object({
      name: z.string(),
      status: z.string(),
      detail: z.record(z.string(), z.unknown()).optional(),
      agentMessage: z.unknown().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      callId: z.string().optional(),
      error: z.unknown().optional(),
      phase: z.string().optional(),
    }),
    Component: LiveToolCallRenderer,
  });

  const removeApprovalRenderer = client.addTimelineRenderer({
    kind: "omp-approval",
    version: 1,
    schema: z.object({ status: z.enum(["approved", "denied", "waiting"]) }),
    Component: LiveApprovalRenderer,
  });

  const removeReasoningTransformer = client.addTimelineTransformer({
    id: "omp-enhanced-reasoning",
    query: { itemType: "reasoning" },
    transform({ item, phase }) {
      if (item.type !== "reasoning") return undefined;
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-reasoning",
            version: 1,
            data: {
              text: item.text,
              phase,
            },
          },
        ],
      };
    },
  });

  const removeReasoningRenderer = client.addTimelineRenderer({
    kind: "omp-reasoning",
    version: 1,
    schema: z.object({
      text: z.string(),
      phase: z.string().optional(),
    }),
    Component: LiveReasoningRenderer,
  });

  const removeTodoTransformer = client.addTimelineTransformer({
    id: "omp-enhanced-todo",
    query: { itemType: "todo" },
    transform({ item, phase }) {
      if (item.type !== "todo") return undefined;
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-todo",
            version: 1,
            data: {
              items: toJsonValue(item.items),
              phase,
            },
          },
        ],
      };
    },
  });

  const removeTodoRenderer = client.addTimelineRenderer({
    kind: "omp-todo",
    version: 1,
    schema: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      phase: z.string().optional(),
    }),
    Component: LiveTodoRenderer,
  });

  const removeUserTransformer = addTextTransformer<"user_message">(client, {
    id: "omp-enhanced-user-message",
    query: { itemType: "user_message" },
    transform({ item }) {
      if (item.type !== "user_message") return undefined;
      if (!getEnhancerPreferences().enhancedUserBubble) return undefined;
      const images = extractPromptImages(item);
      // Text-only timeline items commonly omit attachment metadata. Keep them
      // eligible for folding; unsupported attachments still need the host UI.
      if (images.hasOtherAttachments) return undefined;
      // `messageId` rides along so the renderer can carry the host's own
      // `data-history-row-id`, which is the id the chat outline scrolls to.
      // Replacing the item leaves the outline nothing to find otherwise.
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-user-message",
            version: 1,
            data: toJsonValue({
              text: item.text,
              ...(images.uris.length > 0 ? { images: images.uris } : {}),
              ...(images.count !== null && images.count > 0 ? { imageCount: images.count } : {}),
              ...(item.messageId ? { messageId: item.messageId } : {}),
            }),
          },
        ],
      };
    },
  });

  const removeUserRenderer = client.addTimelineRenderer({
    kind: "omp-user-message",
    version: 1,
    schema: z.object({
      text: z.string(),
      images: z.array(z.string()).optional(),
      imageCount: z.number().int().nonnegative().optional(),
      messageId: z.string().optional(),
    }),
    Component: LiveUserMessageRenderer,
  });

  // The assistant's reply. The preference is read inside `transform` so a
  // change takes effect on the next message without a plugin reload, and a
  // reply the plugin should not own is left to the host.
  const removeAssistantTransformer = addTextTransformer<"assistant_message">(client, {
    id: "omp-enhanced-assistant",
    query: { itemType: "assistant_message" },
    transform({ item }) {
      if (item.type !== "assistant_message") return undefined;
      if (!getEnhancerPreferences().assistantMarkdown) return undefined;
      const images = extractGeneratedImages({ ...item, text: undefined });
      if (!item.text.trim() && !images.length) return undefined;
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-assistant",
            version: 1,
            data: { text: item.text, images: toJsonValue(images), ...(item.messageId ? { messageId: item.messageId } : {}) },
          },
        ],
      };
    },
  });

  const removeAssistantRenderer = client.addTimelineRenderer({
    kind: "omp-assistant",
    version: 1,
    schema: z.object({ text: z.string(), images: z.array(z.object({ source: z.string(), path: z.string().optional() })).optional(), messageId: z.string().optional() }),
    Component: LiveAssistantRenderer,
  });

  // Only `error` is intercepted here. Paseo 0.8 accepts transformers for
  // user_message, assistant_message, reasoning, tool_call, todo, error, and
  // compaction; `notification` — the ⓘ row a finished background job produces —
  // is not on that list, and registering it throws. Every contribution in this
  // function shares one call frame, so that throw drops every renderer the
  // plugin installs and the whole chat falls back to native styling. Add the
  // notification transformer the day the host accepts the type, not before.

  const removeErrorTransformer = client.addTimelineTransformer({
    id: "omp-enhanced-error",
    query: { itemType: "error" },
    transform({ item }) {
      if (item.type !== "error") return undefined;
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-notice",
            version: 1,
            data: { level: "error", message: item.message, fatal: true },
          },
        ],
      };
    },
  });

  const removeNoticeRenderer = client.addTimelineRenderer({
    kind: "omp-notice",
    version: 1,
    schema: z.object({
      level: z.string(),
      message: z.string(),
      fatal: z.boolean().optional(),
    }),
    Component: LiveNoticeRenderer,
  });

  return () => {
    removeFonts();
    removeFrost();
    removeShimmer();
    removeGlow();
    removeNoticeStyle();
    removeChatFind();
    removeToolSpacing();
    removeStepDetails();
    removeToolTransformer();
    removeToolRenderer();
    removeApprovalRenderer();
    removeReasoningTransformer();
    removeReasoningRenderer();
    removeTodoTransformer();
    removeTodoRenderer();
    removeUserTransformer();
    removeUserRenderer();
    removeAssistantTransformer();
    removeAssistantRenderer();
    removeErrorTransformer();
    removeNoticeRenderer();
  };
}
