import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import contribute from "../index.client";
import { areEnhancerPreferencesReady } from "../client/preferences";

const { createColdLoadHost, coldLoadSessions } = require("../test/helpers/cold-load-host.cjs");
type Source = { type: string; text?: string; messageId?: string };
type Projected = Source & { kind?: string; data?: unknown };
const sessions = coldLoadSessions as Array<{ provider: string; items: Source[] }>;
const host = createColdLoadHost();
const cleanup = contribute({
  rpc: host.rpc,
  addSettingsScreen: () => () => {},
  addAgentPanel: () => () => {},
  addTimelineTransformer: host.addTimelineTransformer,
  addTimelineRenderer: host.addTimelineRenderer,
} as unknown as PluginClientContext);

declare global {
  interface Window {
    coldLoadReplay: {
      release(preferences?: Record<string, unknown>): void;
      ready(): boolean;
      revision(): number;
      widths: number[];
    };
  }
}
window.coldLoadReplay = {
  release: host.resolvePreferences, ready: areEnhancerPreferencesReady,
  revision: host.getRevision, widths: [innerWidth],
};
window.addEventListener("resize", () => window.coldLoadReplay.widths.push(innerWidth));
window.addEventListener("pagehide", cleanup, { once: true });

const colors = {
  surface0: "#f8fafc", surface1: "#ffffff", surface2: "#edf0f5", border: "#d5dbe5",
  foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff",
  statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642",
};
const timestamp = new Date("2026-01-01T12:00:00Z");
function Timeline() {
  useSyncExternalStore(host.subscribe, host.getRevision, host.getRevision);
  return <>
    <header data-testid="host-toolbar" style={{ height: 96, boxSizing: "border-box", background: "#edf0f5", padding: 24 }}>Sample conversation</header>
    <main data-testid="host-chat" style={{ height: "calc(100vh - 96px)", overflowY: "scroll", overflowAnchor: "none", padding: 16 }}>
      <div style={{ height: 700 }} />
      {sessions.map(({ provider, items }) => <section key={provider} aria-label={`${provider} session`}>
        {items.map((source, index) => (host.project(source) as Projected[]).map((item, part) => {
          const renderer = item.type === "plugin" ? host.renderers.get(item.kind) : undefined;
          const Component = renderer?.Component as React.ComponentType<PluginTimelineItemProps> | undefined;
          return <div key={`${index}:${part}`} data-source-type={source.type} data-projection-kind={item.kind ?? "host"} style={{ marginBottom: 16 }}>
            {Component ? <Component agentId={`sample-${provider}`} host={{ id: "sample-host", label: "Sample host" }}
              theme={{ colors }} layout={{ compact: innerWidth < 744, platform: "web" }} timestamp={timestamp}
              item={{ ...item, data: renderer.schema.parse(item.data) } as PluginTimelineItemProps["item"]} />
              : <p>{source.text ?? "Sample host row"}</p>}
          </div>;
        }))}
      </section>)}
      <div style={{ height: 900 }} />
    </main>
  </>;
}
document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(<Timeline />);
