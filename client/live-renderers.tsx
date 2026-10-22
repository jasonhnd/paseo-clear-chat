import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, useWindowDimensions } from "react-native";
import { useAgent, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useRevealedText } from "@getpaseo/plugin/client/react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { buildThemeTokens } from "./components/theme-tokens";
import { ToolCallout } from "./components/tool-callouts";
import { ReasoningTrace } from "./components/reasoning-trace";
import { TaskList } from "./components/task-list";
import { UserMessage } from "./components/user-message";
import { hostFontEscape } from "./components/host-font-escape";
import { promptRowAnchor } from "./components/prompt-anchor";
import { surfaceProps } from "./components/view-props";
import { useSelectionActions } from "./components/selection-actions";
import { usePointerGlow } from "./components/glow";
import type { TurnUsage } from "./components/user-message";
import { NoticeCallout } from "./components/notice-callout";
import { useEnhancerPreferences } from "./preferences";
import { publishHubSnapshot } from "./hub-activity";
import { MarkdownView } from "./components/markdown/markdown-view";
import { TimelineTailHub } from "./components/hub-live";
import { AssistantFooter } from "./components/turn-footer";
import { SystemCard } from "./components/system-card";
import { parseSystemEnvelope } from "./system-envelope";
import { toolErrorLine } from "./tool-error";
import type {
  ReasoningTraceData,
  TaskListData,
  NoticeCalloutData,
} from "../shared/contracts";
import { revealPathRpc } from "../shared/file-rpc";
import { useImageFile } from "./image-file";
import { buildLiveToolCallData } from "./tool-call-data";
import type { LiveToolCallPayload } from "./tool-call-data";
import { buildChecklist } from "./tool-detail";
import { useToolExpansion } from "./tool-expansion";
import { defaultToolExpanded } from "./tool-summary";
import { FinalToolReply } from "./components/final-tool-reply";
import { finalToolReplyMarkdown } from "./tool-final-reply";
import { toolRowMarker } from "./tool-row-spacing";
import { GeneratedImages } from "./components/generated-images";
import { extractGeneratedImages, type GeneratedImage } from "./generated-images";
import type { ApprovalStatus } from "./tool-approval";
import { Glyph } from "./components/glyph";
import { useReplyDuration } from "./reply-duration";
import { useProjectedAgentMessage } from "./projected-agent-message";
import { stepDetailPresentation } from "./breakpoints";
import { StepDetailPanel } from "./components/step-detail-panel";
import { createStepDetailState } from "./components/step-detail-state";
import { openHostStepDetail, updateHostStepDetail } from "./components/step-detail-host";

export function LiveApprovalRenderer({
  item,
  theme,
}: PluginTimelineItemProps<{ status: ApprovalStatus }>) {
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(() => buildThemeTokens(theme.colors, preferences), [theme.colors, preferences]);
  const [expanded, setExpanded] = useState(true);
  const status = item.data.status;
  const waiting = status === "waiting";
  const label = status === "approved" ? "Approved" : status === "denied" ? "Denied" : "Awaiting approval";
  const color = status === "approved" ? tokens.success : status === "denied" ? tokens.danger : tokens.accent;
  const summary = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}>
      <Glyph name={status === "approved" ? "Check" : status === "denied" ? "X" : "Clock"} size={13} color={color} />
      <Text selectable testID={`approval-status-${status}`} style={{ color, fontSize: tokens.fs(12) }}>{label}</Text>
      {waiting ? <Glyph name={expanded ? "ChevronUp" : "ChevronDown"} size={13} color={tokens.foregroundMuted} /> : null}
    </View>
  );

  return (
    <View testID="approval-timeline-item" {...hostFontEscape}>
      {waiting ? (
        <Pressable
          testID="approval-summary-row"
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} approval details`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
        >
          {summary}
        </Pressable>
      ) : summary}
      {waiting && expanded ? (
        <Text selectable testID="approval-body" style={{ color: tokens.foregroundMuted, fontSize: tokens.fs(12), paddingLeft: 21, paddingBottom: 6 }}>
          This edit is awaiting approval in Paseo.
        </Text>
      ) : null}
    </View>
  );
}

export interface LiveReasoningPayload {
  text: string;
  phase?: string;
}

export interface LiveTodoPayload {
  items: Array<Record<string, unknown>>;
  phase?: string;
}

export interface LiveNoticePayload {
  level: string;
  message: string;
  fatal?: boolean;
}

export function LiveToolCallRenderer({
  host,
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<LiveToolCallPayload>) {
  const revealPath = useRpc(revealPathRpc);
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  // The host can publish the workspace after its agent; pane opening needs both.
  const panelWorkspaceId = useWorkspace(workspaceId ?? "", (workspace) => workspace.id);
  const { width } = useWindowDimensions();
  const presentation = stepDetailPresentation(width);
  const [detailOpen, setDetailOpen] = useState(false);
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [theme.colors, preferences],
  );
  useSelectionActions(tokens, preferences.selectionActions);
  usePointerGlow(preferences.pointerGlow);
  const recoveredMessage = useProjectedAgentMessage(host.id, agentId, item.data);
  const data = useMemo(() => recoveredMessage ? { ...item.data, agentMessage: recoveredMessage } : item.data,
    [item.data, recoveredMessage]);

  const calloutData = useMemo(() => buildLiveToolCallData(data), [data]);
  const durationMs = useReplyDuration(host.id, agentId, timestamp,
    calloutData.finalReply ? { type: "tool_call", callId: data.callId, name: data.name } : null);
  const replyImages = useMemo(() => new Set(extractGeneratedImages(calloutData.finalReply)
    .map((image) => image.path ?? image.source)), [calloutData.finalReply]);
  const generatedImages = useMemo(() => (calloutData.images ?? []).filter((image) =>
    !replyImages.has(image.path ?? image.source) &&
    !((calloutData.tool === "read" || calloutData.tool === "write") && image.path && image.path === calloutData.filePath)),
  [calloutData, replyImages]);

  // The dock has no access to the job manager, so the timeline is its only
  // source: every job snapshot that passes through a card is republished, and
  // the store drops the agent's entry once a snapshot reports nothing running.
  const hubData = calloutData.hub;
  useEffect(() => {
    if (!hubData || hubData.kind !== "jobs") return;
    publishHubSnapshot(agentId, {
      at: timestamp.getTime(),
      running: hubData.data.jobs.filter((job) => job.status === "running"),
      agents: hubData.data.agents ?? [],
    });
  }, [hubData, agentId]);

  // Saved choices win over status and preference defaults, including false.
  const expansion = useToolExpansion({
    hostId: host.id,
    agentId,
    callId: data.callId,
    name: data.name,
    timestamp: timestamp.getTime(),
  }, defaultToolExpanded(calloutData, preferences.foldFinishedSteps));

  // The daemon side owns the shell, so revealing a file is one RPC. A path the
  // daemon cannot stat answers with an error the press simply ignores.
  const handleRevealPath = useCallback(
    (path: string) => {
      void revealPath({ cwd: cwd ?? "", path }).catch(() => {});
    },
    [cwd, revealPath],
  );

  // Only a read or write of an image asks the daemon for bytes; the hook
  // itself refuses every other path, so a code read costs no RPC.
  const imageFile = useImageFile(
    calloutData.tool === "read" || calloutData.tool === "write" ? calloutData.filePath : undefined,
    cwd,
  );

  const detailKey = JSON.stringify([data.callId, data.name, timestamp.getTime()]);
  const readingState = useRef<{ key: string; state: ReturnType<typeof createStepDetailState> } | null>(null);
  if (readingState.current?.key !== detailKey) readingState.current = { key: detailKey, state: createStepDetailState() };
  const detailState = readingState.current.state;
  const selectedDetail = useMemo(() => ({
    key: detailKey,
    step: calloutData,
    onRevealPath: handleRevealPath,
    imageFile,
    viewState: detailState,
  }), [detailKey, calloutData, handleRevealPath, imageFile, detailState]);
  const openDetail = useCallback(() => {
    if (presentation === "side" && openHostStepDetail(host.id, agentId, workspaceId ?? undefined, selectedDetail, true)) return;
    Object.assign(detailState, createStepDetailState());
    setDetailOpen(true);
  }, [presentation, host.id, agentId, workspaceId, selectedDetail, detailState]);
  useEffect(() => {
    updateHostStepDetail(host.id, agentId, selectedDetail);
  }, [host.id, agentId, selectedDetail]);
  useEffect(() => {
    if (preferences.collapsedStepAction === "inline") setDetailOpen(false);
    else if (detailOpen && presentation === "side" && openHostStepDetail(host.id, agentId, workspaceId ?? undefined, selectedDetail)) setDetailOpen(false);
  }, [preferences.collapsedStepAction, detailOpen, presentation, host.id, agentId, workspaceId, panelWorkspaceId, selectedDetail]);

  return (
    <View testID="tool-timeline-item" {...surfaceProps(hostFontEscape, toolRowMarker(!calloutData.finalReply && !generatedImages.length && !expansion.expanded && !expansion.error))}>
      {calloutData.finalReply ? (
        <View testID="tool-final-reply">
          <FinalToolReply text={calloutData.finalReply} cwd={cwd} tokens={tokens} variant={preferences.markdownVariant}
            expansionIdentity={{ hostId: host.id, agentId, callId: data.callId, name: `final-tool:${data.name}`, timestamp: timestamp.getTime() }} />
          {toolErrorLine(calloutData, "never") ? <Text testID="tool-error-line" selectable style={{ color: tokens.danger }}>{calloutData.error}</Text> : null}
          <AssistantFooter text={finalToolReplyMarkdown(calloutData.finalReply)} at={timestamp} tokens={tokens} durationMs={durationMs} />
        </View>
      ) : (
        <ToolCallout
          data={calloutData}
          tokens={tokens}
          expanded={expansion.expanded}
          onExpandedChange={expansion.onExpandedChange}
          onOpenDetail={preferences.collapsedStepAction === "details" ? openDetail : undefined}
          navigationScope={JSON.stringify([host.id, agentId])}
          onRevealPath={handleRevealPath}
          imageFile={imageFile}
        />
      )}
      <StepDetailPanel
        viewState={detailState}
        step={calloutData}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        presentation={presentation === "side" ? "popover" : presentation}
        tokens={tokens}
        onRevealPath={handleRevealPath}
        imageFile={imageFile}
      />
      <GeneratedImages
        images={generatedImages}
        cwd={cwd}
        tokens={tokens}
      />
      {expansion.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.danger, fontSize: tokens.fs(11) }}>
          Tool expansion choice could not be saved or loaded: {expansion.error}
        </Text>
      ) : null}
      <TimelineTailHub
        agentId={agentId}
        tokens={tokens}
        itemKey={`tool:${data.callId ?? calloutData.title}:${timestamp.getTime()}`}
        at={timestamp.getTime()}
        kind="tool"
      />
    </View>
  );
}

export function LiveReasoningRenderer({
  item,
  theme,
}: PluginTimelineItemProps<LiveReasoningPayload>) {
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [theme.colors, preferences],
  );
  useSelectionActions(tokens, preferences.selectionActions);
  usePointerGlow(preferences.pointerGlow);
  const data = item.data;
  // The host owns the reveal cadence, so streamed reasoning animates the same
  // way it does in the native timeline instead of appearing in whole blocks.
  const revealed = useRevealedText(
    data.text || "",
    data.phase === "streaming" ? "streaming" : "complete",
  );

  const reasoningData: ReasoningTraceData = useMemo(() => {
    const rawText = revealed;
    // Split into paragraphs or steps if separated
    const paragraphs = rawText.split("\n\n").filter(Boolean);
    // No fabricated title: slicing the first 60 characters of the body cut
    // words in half and then repeated the same text underneath.
    // The final paragraph is the one still being written, so it reads as
    // active while streaming. That is what advances the timeline rail one
    // tick at a time instead of lighting the whole thing up at once.
    const streaming = data.phase === "streaming";
    const steps = paragraphs.map((p, idx) => ({
      id: `live-step-${idx}`,
      number: idx + 1,
      status:
        streaming && idx === paragraphs.length - 1 ? ("active" as const) : ("completed" as const),
      content: p,
    }));

    return {
      id: "live-reasoning",
      agentModel: "",
      durationMs: 0,
      totalTokens: Math.round(rawText.length / 4),
      status: data.phase === "streaming" ? "thinking" : "completed",
      steps:
        steps.length > 0
          ? steps
          : [
              {
                id: "step-1",
                number: 1,
                title: "Thought Process",
                status: "completed" as const,
                content: rawText,
              },
            ],
    };
  }, [data, revealed]);

  return (
    <View {...hostFontEscape}>
      <ReasoningTrace
        data={reasoningData}
        tokens={tokens}
        defaultExpanded={data.phase === "streaming"}
      />
    </View>
  );
}

export function LiveTodoRenderer({ item, theme }: PluginTimelineItemProps<LiveTodoPayload>) {
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [theme.colors, preferences],
  );
  useSelectionActions(tokens, preferences.selectionActions);
  usePointerGlow(preferences.pointerGlow);
  const data = item.data;

  const taskListData: TaskListData = useMemo(() => buildChecklist({ items: data.items }, {}, "todo"), [data]);

  return (
    <View {...hostFontEscape} testID="tool-card-todo">
      <View testID="tool-card-body">
        <TaskList data={taskListData} tokens={tokens} />
        {!taskListData.tasks.length ? (
          <Text selectable style={{ color: tokens.foregroundMuted, fontSize: tokens.fs(12) }}>No tasks reported.</Text>
        ) : null}
      </View>
    </View>
  );
}

export interface LiveAssistantPayload {
  text: string;
  images?: GeneratedImage[];
  messageId?: string;
}

/**
 * The assistant's own reply, drawn with the plugin's markdown renderer.
 *
 * The host's renderer carries a pipeline this plugin cannot import — mermaid
 * and file navigation — so `assistantMarkdown` exists to hand the
 * turn back when a reply needs any of that.
 */
export function LiveAssistantRenderer({
  host,
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<LiveAssistantPayload>) {
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [theme.colors, preferences],
  );
  useSelectionActions(tokens, preferences.selectionActions);
  usePointerGlow(preferences.pointerGlow);

  // Copy belongs to this reply, even when another item or conversation owns
  // the global hub tail. Canonical turn timing belongs only to the final reply.
  const itemKey = `assistant:${timestamp.getTime()}`;

  // Job results, IRC relays and reminders arrive as replies because the host
  // files any unclaimed `custom` message under this item kind. They are not
  // the model's words, so they are drawn as a card, not as prose.
  const envelope = useMemo(() => parseSystemEnvelope(item.data.text), [item.data.text]);
  const durationMs = useReplyDuration(host.id, agentId, timestamp,
    envelope ? null : { type: "assistant_message", text: item.data.text });

  return (
    <View {...hostFontEscape}>
      {envelope ? (
        <SystemCard envelope={envelope} tokens={tokens} />
      ) : (
        <MarkdownView text={item.data.text} images={item.data.images} cwd={cwd} tokens={tokens} variant={preferences.markdownVariant}
          expansionIdentity={{ hostId: host.id, agentId, callId: item.data.messageId, name: "assistant-message", timestamp: timestamp.getTime() }} />
      )}
      {!envelope ? (
        <AssistantFooter text={item.data.text} at={timestamp} tokens={tokens} durationMs={durationMs} />
      ) : null}
      <TimelineTailHub
        agentId={agentId}
        tokens={tokens}
        itemKey={itemKey}
        at={timestamp.getTime()}
        kind="reply"
      />
    </View>
  );
}

/**
 * The host draws a `notification` or `error` item as bare text with an icon,
 * which reads as a different product beside the plugin's callouts. Both carry
 * only a level and a message, so the card is a badge plus that message.
 */
export function LiveNoticeRenderer({ item, theme }: PluginTimelineItemProps<LiveNoticePayload>) {
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [theme.colors, preferences],
  );
  useSelectionActions(tokens, preferences.selectionActions);
  usePointerGlow(preferences.pointerGlow);
  const data = item.data;
  const level = data.level === "warning" || data.level === "error" ? data.level : "info";

  const noticeData: NoticeCalloutData = useMemo(
    () => ({
      id: `notice-${data.message.length}-${level}`,
      level,
      message: data.message,
      ...(data.fatal ? { fatal: true } : {}),
    }),
    [data.message, data.fatal, level],
  );

  return (
    <View {...hostFontEscape}>
      <NoticeCallout data={noticeData} tokens={tokens} />
    </View>
  );
}

export interface LiveUserMessagePayload {
  text: string;
  images?: string[];
  imageCount?: number;
  /** The host's own id for this message, when the provider gave one. */
  messageId?: string;
}

/**
 * Usage is reported on the agent, not on the timeline item, so it is read from
 * the live agent handle while the turn runs and frozen once the agent leaves
 * `running`. A turn this client never observed live has no recoverable usage,
 * so its footer is omitted rather than filled with the current session total.
 */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

export function LiveUserMessageRenderer({
  item,
  theme,
  agentId,
  timestamp,
  host,
}: PluginTimelineItemProps<LiveUserMessagePayload>) {
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(
    () => buildThemeTokens(theme.colors, preferences),
    [theme.colors, preferences],
  );
  useSelectionActions(tokens, preferences.selectionActions);
  usePointerGlow(preferences.pointerGlow);
  const paseo = usePaseo();
  const handle = useMemo(() => paseo.agents.ref(agentId), [paseo, agentId]);

  // Decided once, on mount: a replayed turn must not borrow later figures.
  const observedLive = useMemo(
    () => Date.now() - timestamp.getTime() < LIVE_WINDOW_MS,
    [timestamp],
  );

  const snapshot = useAgent(agentId, (agent) => ({
    status: agent.status,
    updatedAt: agent.updatedAt,
  }));
  const running = snapshot?.status === "running";

  const [usage, setUsage] = useState<TurnUsage | null>(null);
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    if (!observedLive || frozen) return;
    let cancelled = false;
    handle
      .refresh()
      .then((result) => {
        if (cancelled || !result) return;
        const next = result.agent.lastUsage;
        if (next) setUsage(next);
        // The turn has settled, so this reading is final.
        if (next && !running) setFrozen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [handle, observedLive, frozen, running, snapshot?.updatedAt]);

  // The same envelopes reach this item kind on some hosts and on history
  // replay. A job result is not something the user said, so it never takes the
  // user bubble.
  const envelope = useMemo(() => parseSystemEnvelope(item.data.text), [item.data.text]);

  return (
    <View {...surfaceProps(hostFontEscape, promptRowAnchor(item.data.messageId))}>
      {envelope ? (
        <SystemCard envelope={envelope} tokens={tokens} />
      ) : (
        <UserMessage
          text={item.data.text}
          images={item.data.images}
          imageCount={item.data.imageCount}
          timestamp={timestamp}
          tokens={tokens}
          usage={observedLive ? usage : null}
          pending={running && !frozen}
          expansionIdentity={{ hostId: host.id, agentId, callId: item.data.messageId, name: "user-message", timestamp: timestamp.getTime() }}
        />
      )}
    </View>
  );
}
