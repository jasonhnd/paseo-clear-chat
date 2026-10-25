/** One synthetic conversation for the README stills and motion capture. */
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
import { AssistantFooter } from "../client/components/turn-footer";
import { DEMO_STEPS, PROMPT, REPLY } from "./fixtures";

export function Demo({ tokens, animate = false }: { tokens: ExtendedThemeTokens; animate?: boolean }) {
  const { width } = useWindowDimensions();
  const compact = width < 744;
  const [phase, setPhase] = React.useState(animate ? -1 : DEMO_STEPS.length);
  const [selected, setSelected] = React.useState<ToolCalloutData | null>(null);
  const [viewState, setViewState] = React.useState(createStepDetailState);
  React.useEffect(() => {
    const advance = (event: Event) => setPhase((event as CustomEvent<number>).detail);
    window.addEventListener("demo-phase", advance);
    return () => window.removeEventListener("demo-phase", advance);
  }, []);
  const presentation = stepDetailPresentation(width);
  const openStep = (step: ToolCalloutData) => {
    if (selected?.id !== step.id) setViewState(createStepDetailState());
    setSelected(step);
  };
  return <div data-testid="demo" style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: tokens.surface0, color: tokens.foreground, fontFamily: tokens.fontUi }}>
    <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div data-testid="demo-chat" style={{ flex: 1, minWidth: 0, overflow: "auto", padding: compact ? "12px 12px" : "24px 28px" }}>
        <div data-testid="demo-transcript" style={{ maxWidth: 840, margin: "0 auto", display: "flex", flexDirection: "column", gap: compact ? 6 : 12 }}>
          <UserMessage text={PROMPT} timestamp={new Date("2026-01-01T12:00:00Z")} tokens={tokens} />
          {DEMO_STEPS.slice(0, Math.min(phase + 1, DEMO_STEPS.length)).map((step, index) => {
            const running = phase === index;
            return <div key={step.id} data-testid={`demo-step-${index}`}><ToolCallout
              data={running ? { ...step, status: "running", durationMs: undefined } : step}
              tokens={tokens} expanded={running} onExpandedChange={() => {}} onOpenDetail={() => openStep(step)}
            /></div>;
          })}
          {phase >= DEMO_STEPS.length ? <div data-testid="demo-reply">
            <MarkdownView text={REPLY} tokens={tokens} variant="document" />
            <div style={{ paddingTop: 8 }}><AssistantFooter text={REPLY} at={new Date("2026-01-01T12:01:00Z")} tokens={tokens} /></div>
          </div> : null}
        </div>
      </div>
      {selected ? <aside style={{ display: presentation === "side" ? "flex" : "contents", width: width >= 1400 ? 520 : 440, flexShrink: 0, minHeight: 0, borderLeft: `1px solid ${tokens.border}` }}>
        <StepDetailPanel key={selected.id} step={selected} open onOpenChange={open => { if (!open) setSelected(null); }} presentation={presentation} tokens={tokens} viewState={viewState} />
      </aside> : null}
    </main>
  </div>;
}
