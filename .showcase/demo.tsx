/** Synthetic conversation for the README motion capture. */
import React from "react";
import { useWindowDimensions } from "react-native";
import type { ToolCalloutData } from "../shared/contracts";
import type { ExtendedThemeTokens } from "../client/components/theme-tokens";
import { ToolCallout } from "../client/components/tool-callouts";
import { StepDetailPanel } from "../client/components/step-detail-panel";
import { createStepDetailState } from "../client/components/step-detail-state";
import { stepDetailPresentation } from "../client/breakpoints";
import { MarkdownView } from "../client/components/markdown/markdown-view";
import { UserMessage } from "../client/components/user-message";
import { DEMO_STEPS, PROMPT, REPLY } from "./fixtures";


export function Demo({ tokens }: { tokens: ExtendedThemeTokens }) {
  const { width } = useWindowDimensions();
  const [phase, setPhase] = React.useState(0);
  const [selected, setSelected] = React.useState<ToolCalloutData | null>(null);
  const [viewState] = React.useState(createStepDetailState);
  React.useEffect(() => {
    const advance = (event: Event) => setPhase((event as CustomEvent<number>).detail);
    window.addEventListener("demo-phase", advance);
    return () => window.removeEventListener("demo-phase", advance);
  }, []);
  const presentation = stepDetailPresentation(width);
  return <div data-testid="demo" style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: tokens.surface0, color: tokens.foreground, fontFamily: tokens.fontUi }}>
    <header style={{ padding: "18px 24px", borderBottom: `1px solid ${tokens.border}`, fontSize: 15, fontWeight: 600 }}>demo-shop <span style={{ color: tokens.foregroundMuted, fontWeight: 400 }}> / Clear Chat</span></header>
    <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div data-testid="demo-chat" style={{ flex: 1, minWidth: 0, overflow: "auto", padding: width < 744 ? 16 : 32 }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
          <UserMessage text={PROMPT} timestamp={new Date("2026-01-01T12:00:00Z")} tokens={tokens} />
          <MarkdownView text="I’ll check the cart helper, update the threshold, and run the boundary tests." tokens={tokens} variant="document" />
          {DEMO_STEPS.slice(0, Math.min(phase + 1, DEMO_STEPS.length)).map((step, index) => {
            const running = phase === index;
            return <div key={step.id} data-testid={`demo-step-${index}`}><ToolCallout
              data={running ? { ...step, status: "running", durationMs: undefined } : step}
              tokens={tokens} expanded={running} onExpandedChange={() => {}} onOpenDetail={() => setSelected(step)}
            /></div>;
          })}
          {phase >= 5 ? <div data-testid="demo-reply"><MarkdownView text={REPLY.replace("12 demo tests", "90 demo tests")} tokens={tokens} variant="document" /></div> : null}
        </div>
      </div>
      {selected ? <aside style={{ display: presentation === "side" ? "flex" : "contents", width: 440, flexShrink: 0, borderLeft: `1px solid ${tokens.border}` }}>
        <StepDetailPanel step={selected} open onOpenChange={open => { if (!open) setSelected(null); }} presentation={presentation} tokens={tokens} viewState={viewState} />
      </aside> : null}
    </main>
  </div>;
}
