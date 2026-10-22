import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolCallout } from "../client/components/tool-callouts";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { buildLiveToolCallData, type LiveToolCallPayload } from "../client/tool-call-data";
import { DEFAULT_PREFERENCES } from "../client/preferences";

const calls = JSON.parse(document.getElementById("fixtures")!.textContent!) as LiveToolCallPayload[];
const data = calls.map(buildLiveToolCallData);
const params = new URLSearchParams(location.search);
const light = params.get("theme") === "light";
const colors = {
  surface0: light ? "#ffffff" : "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
  foreground: light ? "#17171a" : "#f2f3f5", foregroundMuted: light ? "#62656c" : "#a3a6ad",
  accent: "#7aa2f7", accentForeground: "#0f0f11",
  statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
};
const tokens = buildThemeTokens(colors, { ...DEFAULT_PREFERENCES, frostedGlass: params.get("glass") === "true" });

function Step({ index }: { index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [replacement, setReplacement] = useState(false);
  return <div data-step={index}>
    <ToolCallout data={data[replacement ? 1 : index]!} tokens={tokens} expanded={expanded} onExpandedChange={setExpanded} />
    {index === 0 ? <button id="replace" onClick={() => setReplacement(value => !value)}>Replace step data</button> : null}
  </div>;
}

function Replay() {
  const [mounted, setMounted] = useState(true);
  return <main style={{ padding: 16, minHeight: 1800, background: colors.surface0, color: colors.foreground, overflow: "hidden" }}>
    <div id="top"><Step index={0} /><Step index={1} /></div>
    <button id="unmount" onClick={() => setMounted(false)}>Unmount steps</button>
    <div id="behind-preview" style={{ position: "absolute", top: 430, left: 16, right: 16, pointerEvents: "none" }}>
      <p>A sample reply sits behind the preview. Its text must stay covered.</p>
      <pre style={{ padding: 12, background: light ? "#e8e8ef" : "#30303e" }}>
        {Array.from({ length: 9 }, (_, i) => `const backgroundLine${i + 1} = "Keep this code behind the solid preview.";`).join("\n")}
      </pre>
    </div>
    {mounted ? <div id="middle" style={{ marginTop: 280 }}>{data.map((_, index) => <Step key={index} index={index} />)}</div> : null}
  </main>;
}

document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(<Replay />);
