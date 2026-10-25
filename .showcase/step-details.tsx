import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWindowDimensions, View } from "react-native";
import { createRoot } from "react-dom/client";
import type { PluginAgentPanelProps, PluginClientContext, PluginAgentPanelContribution } from "@getpaseo/plugin/client";
import { LiveToolCallRenderer } from "../client/live-renderers";
import { buildLiveToolCallData, type LiveToolCallPayload } from "../client/tool-call-data";
import { installStepDetailPanel, openHostStepDetail } from "../client/components/step-detail-host";
import { embedFonts } from "../client/components/embed-fonts";
import { installFrostedGlass } from "../client/components/frosted";
import { initializeEnhancerPreferences, updateEnhancerPreferences, useEnhancerPreferences } from "../client/preferences";
import { DESKTOP_MIN, stepDetailPresentation, TABLET_MIN } from "../client/breakpoints";
import { installCompactToolSpacing } from "../client/tool-row-spacing";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { ToolCallout } from "../client/components/tool-callouts";
import { UserMessage } from "../client/components/user-message";
import { MarkdownView } from "../client/components/markdown/markdown-view";
import { AssistantFooter } from "../client/components/turn-footer";
import { StepDetailPanel } from "../client/components/step-detail-panel";
import type { ToolCalloutData } from "../shared/contracts";
import { CALLS, DIFF, PROMPT, REPLY } from "./fixtures";
import { hydratePreviewWorkspace, previewWorkspaceReady, PluginTranslationProvider, PluginTranslationRuntime } from "./shims/step-detail-client";

declare global { interface Window {
  __stepDetailSamples: LiveToolCallPayload[];
  __stepDetailPanelAttempts: Array<{ width: number; workspaceReady: boolean }>;
} }
window.__stepDetailPanelAttempts = [];

embedFonts();
installCompactToolSpacing();
const captureShot = new URLSearchParams(location.search).get("capture") === "ipad";
if (captureShot) installFrostedGlass();

const colors = {
  ...(new URLSearchParams(location.search).get("theme") === "light" ? {
    surface0: "#f8fafc", surface1: "#ffffff", surface2: "#edf0f5", border: "#d5dbe5",
    foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff",
    statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642",
  } : {
    surface0: "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
    foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11",
    statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
  }),
};
const host = { id: "demo-host", label: "Demo host" };
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
let visible = false;
let contribution: PluginAgentPanelContribution;
installStepDetailPanel({
  addAgentPanel(value: PluginAgentPanelContribution) { contribution = value; return () => {}; },
  openPanel() {
    window.__stepDetailPanelAttempts.push({ width: innerWidth, workspaceReady: previewWorkspaceReady() });
    if (!previewWorkspaceReady()) throw new Error("Plugin panel context is unavailable");
    visible = true; publish();
  },
} as unknown as PluginClientContext);

/** Same synthetic turn as the hero comparison, with the edit step opened. */
const CAPTURE_STEPS = ["thinking", "search", "read", "edit", "bash", "git"] as const;
const captureEditCall: LiveToolCallPayload = {
  name: "edit", status: "completed", callId: "demo-edit",
  detail: {
    type: "edit", filePath: "src/cart.ts", durationMs: 84, unifiedDiff: DIFF,
    input: {
      path: "src/cart.ts",
      old_string: "  return \"Shipping calculated at checkout\";",
      new_string: "  return total >= 50\n    ? \"Free shipping\"\n    : \"Shipping calculated at checkout\";",
    },
    output: DIFF,
  },
};

function CaptureFrame() {
  const { width } = useWindowDimensions();
  const presentation = stepDetailPresentation(width);
  const tokens = useMemo(() => buildThemeTokens(colors), []);
  const editStep = useMemo(() => buildLiveToolCallData(captureEditCall), []);
  const showPanel = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => visible);
  const [popover, setPopover] = useState<ToolCalloutData | null>(null);
  useEffect(() => {
    document.documentElement.style.background = colors.surface0;
    document.body.style.margin = "0";
    document.body.style.background = colors.surface0;
    document.body.style.fontFamily = '"OMP Inter", sans-serif';
    const root = document.getElementById("root");
    if (!root) return;
    root.style.display = "block";
    root.style.width = "100%";
    root.style.height = "100%";
  }, []);
  const openStep = (step: ToolCalloutData) => {
    if (presentation === "side" && openHostStepDetail("demo-host", "demo-agent", "demo-workspace", { key: step.id, step }, true)) {
      setPopover(null);
      return;
    }
    setPopover(step);
  };
  const Component = contribution.Component as React.ComponentType<PluginAgentPanelProps>;
  return <div data-pmono="" data-testid="ipad-capture" style={{ display: "flex", width: "100%", height: "100%", overflow: "hidden", boxSizing: "border-box", background: colors.surface0, color: colors.foreground, fontFamily: '"OMP Inter", sans-serif' }}>
    <main data-testid="preview-chat" style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "16px 20px" }}>
      <View style={{ gap: 12 }}>
        <UserMessage text={PROMPT} timestamp={new Date("2026-01-01T12:00:00Z")} tokens={tokens} usage={{ inputTokens: 240, cachedInputTokens: 800, outputTokens: 160 }} />
        {CAPTURE_STEPS.map(name => {
          const step = name === "edit" ? editStep : CALLS[name]!;
          return <ToolCallout key={name} data={step} tokens={tokens} expanded={false} onExpandedChange={() => {}} onOpenDetail={() => openStep(step)} />;
        })}
        <View>
          <MarkdownView text={REPLY} tokens={tokens} variant="document" />
          <AssistantFooter text={REPLY} at={new Date("2026-01-01T12:01:00Z")} tokens={tokens} />
        </View>
      </View>
    </main>
    {showPanel ? <aside data-testid="preview-host-panel" style={{ width: "40vw", maxWidth: 440, flexShrink: 0, boxSizing: "border-box", display: width >= DESKTOP_MIN ? "flex" : "none", flexDirection: "column", minHeight: 0, background: colors.surface0, borderLeft: `1px solid ${colors.border}` }}>
      <Component host={host} params={{ agentId: "demo-agent" }} workspaceId="demo-workspace" revision={0} tab={{ state: undefined, setState() {}, setModified() {} }} layout={{ compact: false, platform: "web" }} theme={{ colors }} />
    </aside> : null}
    <StepDetailPanel step={popover} open={popover !== null && presentation !== "side"} presentation={presentation === "side" ? "popover" : presentation} onOpenChange={next => { if (!next) setPopover(null); }} tokens={tokens} />
  </div>;
}

function Preview() {
  if (captureShot) return <CaptureFrame />;
  const { width } = useWindowDimensions();
  // The host may recreate its compact timeline in a later commit, after the
  // existing sheet has already reflowed and emitted a browser scroll event.
  const delayedRemount = new URLSearchParams(location.search).get("remount") === "next-frame";
  const [compact, setCompact] = useState(width < TABLET_MIN);
  useEffect(() => {
    if (!delayedRemount) return;
    const frame = requestAnimationFrame(() => setCompact(width < TABLET_MIN));
    return () => cancelAnimationFrame(frame);
  }, [width, delayedRemount]);
  const [samples, setSamples] = useState(window.__stepDetailSamples);
  const chat = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (chat.current) chat.current.scrollTop = 360; }, []);
  const showPanel = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => visible);
  const preferences = useEnhancerPreferences();
  const Component = contribution.Component as React.ComponentType<PluginAgentPanelProps>;
  return <div style={{ display: "flex", flexDirection: "column", width: "100vw", height: "100vh", background: colors.surface0, color: colors.foreground, font: "14px system-ui" }}>
    <header data-testid="preview-host-header" style={{ height: 64, flexShrink: 0, padding: 20, borderBottom: `1px solid ${colors.border}` }}>Conversation</header>
    <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
    <div key={location.pathname === "/host-remount" ? ((delayedRemount ? compact : width < TABLET_MIN) ? "chat-compact" : "chat-wide") : "chat"} ref={chat} data-testid="preview-chat" style={{ flex: 1, minWidth: 0, padding: 16, overflow: "auto" }}>
      <div style={{ height: 460 }} aria-hidden="true" />
      <div style={{ maxWidth: 600, padding: 16, borderRadius: 12, background: colors.surface1, border: `1px solid ${colors.border}` }}>
        <strong>demo-shop</strong><p style={{ marginBottom: 0 }}>Add a free-shipping message when the cart total reaches $50.</p>
      </div>
      {location.pathname === "/host-context" ? <button data-testid="preview-hydrate-workspace" onClick={hydratePreviewWorkspace}>Hydrate workspace context</button> : null}
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
      <p data-testid="preview-reply" style={{ maxWidth: 600, lineHeight: 1.6 }}>I found the cart summary helper and checked the threshold cases. The update is ready to review.</p>
      <button data-testid="preview-action" onClick={() => updateEnhancerPreferences({ collapsedStepAction: preferences.collapsedStepAction === "details" ? "inline" : "details" })}>
        {preferences.collapsedStepAction === "details" ? "Use inline expansion" : "Use step details"}
      </button>
      <div style={{ height: 700 }}>Later conversation</div>
    </div>
    {showPanel && !(location.pathname === "/host-remount" && width < TABLET_MIN) ? <aside key={location.pathname === "/host-remount" ? (width < TABLET_MIN ? "pane-compact" : "pane-wide") : "panel"} data-testid="preview-host-panel" style={{ width: "40vw", maxWidth: 440, flexShrink: 0, display: width >= DESKTOP_MIN ? "flex" : "none", flexDirection: "column", borderLeft: `1px solid ${colors.border}` }}>
      <button data-testid="preview-host-close" onClick={() => { visible = false; publish(); }} style={{ padding: 8, color: colors.foreground, background: colors.surface2, border: 0, borderBottom: `1px solid ${colors.border}`, textAlign: "left" }}>Close host panel</button>
      <Component host={host} context="agent" agentId="demo-agent" params={{ agentId: "demo-agent" }} workspaceId="demo-workspace" revision={0} tab={{ state: undefined, setState() {}, setModified() {} }} layout={{ compact: false, platform: "web" }} theme={{ colors }} />
    </aside> : null}
    </main>
  </div>;
}

let values = { preferences: { foldLongOutputAfter: 15 }, legacyMigrated: true };
const translations = new PluginTranslationRuntime({
  getLocale: () => new URLSearchParams(location.search).get("locale") ?? "en",
  subscribe: () => () => {},
});
void initializeEnhancerPreferences((async (contract: { name: string }, input: { values: typeof values }) => {
  if (contract.name.endsWith(".read")) return { status: "ready", revision: "0", values };
  values = input.values;
  return { status: "saved", revision: "0", values };
}) as PluginClientContext["rpc"]).then(() => createRoot(document.getElementById("root")!).render(<PluginTranslationProvider runtime={translations}><Preview /></PluginTranslationProvider>));
