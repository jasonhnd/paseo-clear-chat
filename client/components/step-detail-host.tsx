import React, { useEffect, useMemo, useSyncExternalStore } from "react";
import { Text, useWindowDimensions } from "react-native";
import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import type { ToolCalloutData } from "../../shared/contracts";
import type { ImageFile } from "../image-file";
import { useEnhancerPreferences } from "../preferences";
import { TABLET_MIN, stepDetailPresentation } from "../breakpoints";
import { buildThemeTokens } from "./theme-tokens";
import { StepDetailPanel } from "./step-detail-panel";
import { createStepDetailState, type StepDetailState } from "./step-detail-state";

export interface SelectedStepDetail {
  key: string;
  step: ToolCalloutData;
  onRevealPath?: (path: string) => void;
  imageFile?: ImageFile | null;
  viewState?: StepDetailState;
}

const PANEL_ID = "step-details";
const selections = new Map<string, SelectedStepDetail>();
const listeners = new Set<() => void>();
const panelOwners = new Map<string, Set<object>>();
let panelClient: PluginClientContext | undefined;
const selectionKey = (hostId: string, agentId: string) => JSON.stringify([hostId, agentId]);
const publish = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function clear(hostId: string, agentId: string) {
  if (selections.delete(selectionKey(hostId, agentId))) publish();
}

/** A recreated timeline row shares the reading state of its still-hosted step. */
export function hostStepDetailState(hostId: string, agentId: string, detailKey: string) {
  const selected = selections.get(selectionKey(hostId, agentId));
  return selected?.key === detailKey ? selected.viewState : undefined;
}

/** Transfer the selection to the compact timeline without discarding its state. */
export function reclaimHostStepDetail(hostId: string, agentId: string, detailKey: string) {
  if (selections.get(selectionKey(hostId, agentId))?.key === detailKey) clear(hostId, agentId);
}

/** Explorer hosting reserves space beside chat; no timeline or host DOM is resized. */
export function openHostStepDetail(hostId: string, agentId: string, workspaceId: string | undefined, selection: SelectedStepDetail, newSelection = false): boolean {
  if (!panelClient || !workspaceId) return false;
  const key = selectionKey(hostId, agentId);
  const previous = selections.get(key);
  if (newSelection && previous?.key !== selection.key && selection.viewState) Object.assign(selection.viewState, createStepDetailState());
  selections.set(key, selection);
  try {
    panelClient.openPanel(PANEL_ID, { workspaceId, agentId, location: "explorer" });
    publish();
    return true;
  } catch {
    if (previous) selections.set(key, previous); else selections.delete(key);
    return false;
  }
}

/** Keep a selected call live while its timeline row is mounted. */
export function updateHostStepDetail(hostId: string, agentId: string, selection: SelectedStepDetail) {
  const key = selectionKey(hostId, agentId);
  const current = selections.get(key);
  if (current?.key !== selection.key ||
    (current.step === selection.step && current.imageFile === selection.imageFile && current.onRevealPath === selection.onRevealPath && current.viewState === selection.viewState)) return;
  selections.set(key, selection);
  publish();
}

export function StepDetailHostPanel({ host, params: { agentId }, theme }: PluginAgentPanelProps) {
  const preferences = useEnhancerPreferences();
  const tokens = useMemo(() => buildThemeTokens(theme.colors, preferences), [theme.colors, preferences]);
  const { width } = useWindowDimensions();
  const selection = useSyncExternalStore(subscribe, () => selections.get(selectionKey(host.id, agentId)) ?? null, () => null);
  useEffect(() => {
    const key = selectionKey(host.id, agentId);
    const owners = panelOwners.get(key) ?? new Set<object>();
    panelOwners.set(key, owners);
    const token = {};
    owners.add(token);
    return () => {
      owners.delete(token);
      // The host can replace this panel in the same React commit. Clear an
      // actual close only after replacement owners have registered.
      queueMicrotask(() => {
        if (!owners.size && panelOwners.get(key) === owners) {
          panelOwners.delete(key);
          clear(host.id, agentId);
        }
      });
    };
  }, [host.id, agentId]);
  useEffect(() => {
    if (preferences.collapsedStepAction === "inline") clear(host.id, agentId);
  }, [preferences.collapsedStepAction, host.id, agentId]);
  // Compact navigation gives the session to its replacement timeline row.
  // Explorer's viewport subscription can run before the host removes its root;
  // a Modal escapes that hidden root, so it must never own the phone sheet.
  if (width < TABLET_MIN) return null;
  if (!selection) {
    return <Text style={{ color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(13), padding: 16 }}>Select a collapsed step to see its details. Use the panel tab's close control to return this space to chat.</Text>;
  }
  return (
    <StepDetailPanel
      key={selection.key}
      step={selection.step}
      open
      presentation={stepDetailPresentation(width)}
      onOpenChange={open => { if (!open) clear(host.id, agentId); }}
      tokens={tokens}
      onRevealPath={selection.onRevealPath}
      imageFile={selection.imageFile}
      viewState={selection.viewState}
    />
  );
}

export function installStepDetailPanel(client: PluginClientContext): () => void {
  const remove = client.addAgentPanel({
    id: PANEL_ID, title: "Step details", icon: "PanelRight", locations: ["explorer"], Component: StepDetailHostPanel,
  });
  panelClient = client;
  return () => {
    if (panelClient === client) panelClient = undefined;
    panelOwners.clear();
    selections.clear();
    publish();
    remove();
  };
}
