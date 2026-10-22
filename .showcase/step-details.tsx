import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";
import { createRoot } from "react-dom/client";
import type { PluginAgentPanelProps, PluginClientContext, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { LiveToolCallRenderer } from "../client/live-renderers";
import type { LiveToolCallPayload } from "../client/tool-call-data";
import { installStepDetailPanel } from "../client/components/step-detail-host";
import { embedFonts } from "../client/components/embed-fonts";
import { initializeEnhancerPreferences, updateEnhancerPreferences, useEnhancerPreferences } from "../client/preferences";
import { DESKTOP_MIN, TABLET_MIN } from "../client/breakpoints";
import { installCompactToolSpacing } from "../client/tool-row-spacing";

declare global { interface Window { __stepDetailSamples: LiveToolCallPayload[] } }

embedFonts();
installCompactToolSpacing();

const colors = {
  surface0: "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
  foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11",
  statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
};
const host = { id: "demo-host", label: "Demo host" };
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
let visible = false;
let contribution: PluginWorkspacePanelContribution;
installStepDetailPanel({
  addWorkspacePanel(value: PluginWorkspacePanelContribution) { contribution = value; return () => {}; },
  openPanel() { visible = true; publish(); },
} as unknown as PluginClientContext);

function Preview() {
  const { width } = useWindowDimensions();
  const [samples, setSamples] = useState(window.__stepDetailSamples);
  const chat = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (chat.current) chat.current.scrollTop = 360; }, []);
  const showPanel = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => visible);
  const preferences = useEnhancerPreferences();
  const Component = contribution.Component as React.ComponentType<PluginAgentPanelProps>;
  return <div style={{ display: "flex", flexDirection: "column", width: "100vw", height: "100vh", background: colors.surface0, color: colors.foreground, font: "14px system-ui" }}>
    <header data-testid="preview-host-header" style={{ height: 64, flexShrink: 0, padding: 20, borderBottom: `1px solid ${colors.border}` }}>Conversation</header>
    <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
    <div ref={chat} data-testid="preview-chat" style={{ flex: 1, minWidth: 0, padding: 16, overflow: "auto" }}>
      <div style={{ height: 460 }} aria-hidden="true" />
      <p>Offline component replay · sanitized conversation</p>
      {samples.map((sample, index) => <div key={sample.callId} data-history-row-id={sample.callId} data-index={index}>
        <div style={{ marginBottom: 16 }}><LiveToolCallRenderer
        agentId="demo-agent" host={host} layout={{ compact: width < TABLET_MIN, platform: "web" }} theme={{ colors }}
        timestamp={new Date(Date.parse("2026-01-01T12:00:00Z") + index)}
        item={{ type: "plugin", kind: "omp-tool-call", version: 1, data: sample }}
      /></div></div>)}
      {location.pathname === "/keyboard" ? <>
        <div data-testid="preview-other-agent"><LiveToolCallRenderer
          agentId="other-agent" host={host} layout={{ compact: innerWidth < 744, platform: "web" }} theme={{ colors }}
          timestamp={new Date("2026-01-01T13:00:00Z")}
          item={{ type: "plugin", kind: "omp-tool-call", version: 1, data: samples[0]! }}
        /></div>
        <label>Message<input data-testid="preview-input" defaultValue="Sample message" /></label>
        <label>Notes<textarea data-testid="preview-textarea" defaultValue={"First line\nSecond line"} /></label>
        <div data-testid="preview-editable" contentEditable suppressContentEditableWarning role="textbox" aria-label="Draft">Editable draft</div>
      </> : null}
      {samples.length > 1 ? <button data-testid="preview-update-step" onClick={() => setSamples(previous => previous.map((sample, index) => index ? sample : {
        ...sample, detail: { ...sample.detail, output: `${sample.detail?.output}\nUpdated sample output` },
      }))}>Update first step output</button> : null}
      <div style={{ height: 500 }} aria-hidden="true" />
      <p data-testid="preview-reply">The conversation remains available beside the desktop panel.</p>
      <button data-testid="preview-action" onClick={() => updateEnhancerPreferences({ collapsedStepAction: preferences.collapsedStepAction === "details" ? "inline" : "details" })}>
        {preferences.collapsedStepAction === "details" ? "Use inline expansion" : "Use step details"}
      </button>
      <div style={{ height: 700 }}>Later conversation</div>
    </div>
    {showPanel ? <aside data-testid="preview-host-panel" style={{ width: "40vw", maxWidth: 440, flexShrink: 0, display: width >= DESKTOP_MIN ? "flex" : "none", flexDirection: "column", borderLeft: `1px solid ${colors.border}` }}>
      <button data-testid="preview-host-close" onClick={() => { visible = false; publish(); }}>Close host panel</button>
      <Component host={host} agentId="demo-agent" workspaceId="demo-workspace" context="agent" layout={{ compact: false, platform: "web" }} theme={{ colors }} />
    </aside> : null}
    </main>
  </div>;
}

let values = { preferences: { foldLongOutputAfter: 15 }, legacyMigrated: true };
void initializeEnhancerPreferences((async (contract: { name: string }, input: { values: typeof values }) => {
  if (contract.name.endsWith(".read")) return { status: "ready", revision: "0", values };
  values = input.values;
  return { status: "saved", revision: "0", values };
}) as PluginClientContext["rpc"]).then(() => createRoot(document.getElementById("root")!).render(<Preview />));
