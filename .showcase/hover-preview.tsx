import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolCallout } from "../client/components/tool-callouts";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { buildLiveToolCallData, type LiveToolCallPayload } from "../client/tool-call-data";

const calls = JSON.parse(document.getElementById("fixtures")!.textContent!) as LiveToolCallPayload[];
const data = calls.map(buildLiveToolCallData);
const tokens = buildThemeTokens({
  surface0: "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
  foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11",
  statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
});

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
  return <main style={{ padding: 16, minHeight: 1800, background: "#0f0f11", overflow: "hidden" }}>
    <div id="top"><Step index={0} /><Step index={1} /></div>
    <button id="unmount" onClick={() => setMounted(false)}>Unmount steps</button>
    {mounted ? <div id="middle" style={{ marginTop: 280 }}>{data.map((_, index) => <Step key={index} index={index} />)}</div> : null}
  </main>;
}

document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(<Replay />);
