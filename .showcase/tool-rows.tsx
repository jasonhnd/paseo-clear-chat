import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { ToolCallout } from "../client/components/tool-callouts";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { embedFonts } from "../client/components/embed-fonts";
import { buildLiveToolCallData } from "../client/tool-call-data";
import { installCompactToolSpacing, toolRowMarker } from "../client/tool-row-spacing";
import fixture from "../test/fixtures/real-claude-session.json";

const dark = new URLSearchParams(location.search).get("theme") !== "light";
const colors = {
  surface0: dark ? "#0f0f11" : "#f8fafc", surface1: dark ? "#17171a" : "#ffffff",
  surface2: dark ? "#1f1f23" : "#edf0f5", border: dark ? "#2a2a30" : "#d5dbe5",
  foreground: dark ? "#f2f3f5" : "#18202d", foregroundMuted: dark ? "#a3a6ad" : "#586579",
  accent: "#7aa2f7", accentForeground: "#0f0f11", statusSuccess: "#4cb782",
  statusWarning: "#d9a53f", statusDanger: "#f2555a",
};
const tokens = buildThemeTokens(colors);
const calls = fixture.items.filter(item => item.type === "tool_call");
const clicks: number[] = [];
Object.assign(window, { toolRowClicks: clicks });

function Row({ index }: { index: number }) {
  const [expanded, setExpanded] = useState(false);
  const data = buildLiveToolCallData(calls[index] as Parameters<typeof buildLiveToolCallData>[0]);
  return <div data-history-row-id={`sample-${index}`} data-index={index} style={{ display: "flex", flexDirection: "column" }}>
    <div data-host-frame style={{ display: "flex", flexDirection: "column", marginBottom: 16 }}>
      <View {...toolRowMarker(!expanded)}>
        <ToolCallout data={data} tokens={tokens} expanded={expanded} onExpandedChange={value => {
          clicks.push(index);
          setExpanded(value);
        }} />
      </View>
    </div>
  </div>;
}

function Replay() {
  useEffect(() => {
    const removeFonts = embedFonts();
    const removeSpacing = installCompactToolSpacing();
    return () => { removeFonts(); removeSpacing(); };
  }, []);
  return <main style={{ padding: "64px 12px 0", background: colors.surface0, minHeight: "100vh" }}>
    {calls.map((_, index) => <Row key={index} index={index} />)}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Replay />);
