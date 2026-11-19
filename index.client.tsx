import { messages } from "./client/messages";
import { initializeClientTranslations, translate as t } from "./client/translation";
import type { PluginClientContext, PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";
import { turnWindowItemSchema } from "./client/turn-window-schema";
import { requireHostMethods, STARTUP_MESSAGES } from "./shared/startup-diagnostics";
import { ClearChatSidebar, type SidebarViewRegistration } from "./client/components/agent-board";
import { TurnWindowItem } from "./client/live-renderers";
import { SidebarHintItem } from "./client/components/sidebar-hint-item";
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
import { containsComponentFence } from "./client/component-fences";
import { projectedApprovalStatus } from "./client/tool-approval";
import { installStepDetailPanel } from "./client/components/step-detail-host";
import { AnswerStyleControl, answerStyleSupported } from "./client/components/answer-style-control";
import { setOptionSender, setAnswerDraftStore, setAnswerStatePublisher } from "./client/option-session";
import {
  getEnhancerPreferences,
  initializeEnhancerPreferences,
  onEnhancerPreferencesReady,
  getStoredAnswerDraft,
  storeAnswerDraft,
  clearStoredAnswerDraft,
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
  // Sidebar views were introduced in Paseo 0.16.
  const sidebarClient = client as PluginClientContext & SidebarViewRegistration;
  const removeTurnWindow = typeof (client as { addTimelineRenderer?: unknown }).addTimelineRenderer === "function"
    ? (client as unknown as { addTimelineRenderer(c: unknown): () => void }).addTimelineRenderer({
      kind: "turn-window", version: 1,
      schema: turnWindowItemSchema,
      Component: TurnWindowItem,
    })
    : undefined;
  const removeSidebar = typeof sidebarClient.addSidebarView === "function"
    ? sidebarClient.addSidebarView({ id: "clear-chat", title: messages.message("sidebar.title"),
      description: messages.message("sidebar.description"), Component: ClearChatSidebar })
    : undefined;
  // A header item is the only surface that mounts without the user selecting the view.
  const removeSidebarHint = typeof (sidebarClient as { addSidebarHeaderItem?: unknown }).addSidebarHeaderItem === "function"
    ? (sidebarClient as unknown as { addSidebarHeaderItem(c: { id: string; title: unknown; Component: unknown }): () => void })
        .addSidebarHeaderItem({ id: "clear-chat-hint", title: messages.message("sidebar.title"), Component: SidebarHintItem })
    : undefined;
  setOptionSender((agentId, text) => client.paseo.agents.ref(agentId).send(text));
  void initializeEnhancerPreferences((contract, input) => client.rpc(contract, input));
  // Drafts of an unfinished answer card live in host settings, one entry per card.
  setAnswerDraftStore({ read: getStoredAnswerDraft, write: storeAnswerDraft, clear: clearStoredAnswerDraft });
  // The sidebar lists conversations with open questions; it reads agent metadata.
  setAnswerStatePublisher({
    initialize(agentId, pending, total) {
      try {
        const composer = (client as unknown as { composers?: (selector: { agentId: string }) => readonly { agent?: { metadata?: Record<string, unknown> }; setMetadata?: (patch: Record<string, unknown>) => Promise<void> }[] }).composers?.({ agentId })?.[0];
        if (!composer?.setMetadata || composer.agent?.metadata?.clearChat !== undefined) return;
        void composer.setMetadata({ clearChat: { pending, total, updatedAt: new Date().toISOString() } }).catch(() => {});
      } catch { /* Metadata must not interrupt rendering. */ }
    },
    publish(agentId, pending, total) {
      try {
        const composers = (client as unknown as { composers?: (selector: { agentId: string }) => readonly { setMetadata?: (patch: Record<string, unknown>) => Promise<void> }[] }).composers;
        const composer = composers?.({ agentId })?.[0];
        if (!composer?.setMetadata) return;
        void composer.setMetadata({ clearChat: { pending, total, updatedAt: new Date().toISOString() } })
          .catch(() => { /* a sidebar hint must never surface as a card error */ });
      } catch { /* same */ }
    },
  });
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
  // Composer item needs the 0.16 host API; an older host simply does not get the control.
  const removeAnswerStyle = typeof (client as { addComposerItem?: unknown }).addComposerItem === "function"
    ? (client as unknown as { addComposerItem(c: { id: string; Component: unknown }): () => void })
        .addComposerItem({ id: "answer-style", Component: AnswerStyleControl })
    : null;

  // Configuration lives in the host Settings area.
  client.addSettingsScreen({
    id: "chat-presentation",
    title: messages.message("settings.title"),
    icon: "Blocks",
    Component: ClearChatSettingsPage,
  });

  // Live chat timeline interception: render real tool calls, reasoning, and todos with enhanced UI.
  const toolTransformer: PluginTimelineTransformerContribution<"tool_call"> = {
    id: "omp-enhanced-tool-call",
    query: { itemType: "tool_call" },
    transform({ item, phase }) {
      if (item.type !== "tool_call") return undefined;
      const preferences = getEnhancerPreferences();
      const approval = projectedApprovalStatus(item);
      const status: string = item.status;
      const waitingForApproval = ["waiting", "pending", "awaiting_approval", "pending_approval", "waiting_for_approval"].includes(status);
      const failed = status === "failed" || status === "error" || item.error != null;
      if (!approval && !waitingForApproval && !failed && preferences.hiddenTools.split(",").some((name) => name.trim() !== "" && name.trim() === item.name)) return { items: [] };
      if (preferences.delegatedTools.split(",").some((name) => name.trim() !== "" && name.trim() === item.name)) return undefined;
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
  };
  let removeToolTransformer = client.addTimelineTransformer(toolTransformer);
  // Once saved settings arrive, invalidate the host's cached projections.
  const stopWaitingForToolSettings = onEnhancerPreferencesReady(() => {
    removeToolTransformer();
    removeToolTransformer = client.addTimelineTransformer({ ...toolTransformer });
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
      // SDK 0.13's transform input is `{ item, phase }` only, so `agentId`
      // is not available here. The timeline renderer receives it as a prop.
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
              ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
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
      clientMessageId: z.string().optional(),
    }),
    Component: LiveUserMessageRenderer,
  });

  // The assistant's reply. The preference is read inside `transform` so a
  // change takes effect on the next message without a plugin reload, and a
  // reply the plugin should not own is left to the host.
  const removeAssistantTransformer = addTextTransformer<"assistant_message">(client, {
    id: "omp-enhanced-assistant",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      if (item.type !== "assistant_message") return undefined;
      if (!getEnhancerPreferences().assistantMarkdown) return undefined;
      if (containsComponentFence(item.text, getEnhancerPreferences().delegatedCodeBlocks)) return undefined;
      const images = extractGeneratedImages({ ...item, text: undefined });
      if (!item.text.trim() && !images.length) return undefined;
      return {
        items: [
          {
            type: "plugin" as const,
            kind: "omp-assistant",
            version: 1,
            data: { text: item.text, phase, images: toJsonValue(images), ...(item.messageId ? { messageId: item.messageId } : {}) },
          },
        ],
      };
    },
  });

  const removeAssistantRenderer = client.addTimelineRenderer({
    kind: "omp-assistant",
    version: 1,
    schema: z.object({ text: z.string(), phase: z.string().optional(), images: z.array(z.object({ source: z.string(), path: z.string().optional() })).optional(), messageId: z.string().optional() }),
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
    removeSidebar?.();
    removeTurnWindow?.();
    removeSidebarHint?.();
    setOptionSender(null);
    removeFonts();
    removeFrost();
    removeShimmer();
    removeGlow();
    removeNoticeStyle();
    removeChatFind();
    removeToolSpacing();
    removeStepDetails();
    stopWaitingForToolSettings();
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
