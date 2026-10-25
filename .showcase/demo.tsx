/** One synthetic conversation for the README stills and motion capture. */
import React from "react";
import { useWindowDimensions } from "react-native";
import type { ToolCalloutData } from "../shared/contracts";
import type { ExtendedThemeTokens } from "../client/components/theme-tokens";
import { ToolCallout } from "../client/components/tool-callouts";
import { StepDetailPanel } from "../client/components/step-detail-panel";
import { createStepDetailState } from "../client/components/step-detail-state";
import type { StepDetailPresentation } from "../client/breakpoints";
import { stepDetailPresentation } from "../client/breakpoints";
import { MarkdownView } from "../client/components/markdown/markdown-view";
import { Glyph } from "../client/components/glyph";
import { AssistantFooter, formatReplyTime } from "../client/components/turn-footer";
import { DEMO_STEPS, DEMO_TIMES, PROMPT, REPLY, FOLLOW_UP, FOLLOW_UP_REPLY } from "./fixtures";

/** The host owns prompt timestamps; use its default formatter for both roles. */
function HostPrompt({ text, at, tokens, marginTop = 0 }: { text: string; at: string; tokens: ExtendedThemeTokens; marginTop?: number }) {
  return <div data-testid="demo-prompt" style={{ alignSelf: "flex-end", maxWidth: "82%", marginTop, padding: "8px 10px 8px 12px", borderRadius: 12, borderTopRightRadius: 5, border: `1px solid ${tokens.userBorder}`, background: tokens.userSurface, color: tokens.userText }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, fontSize: tokens.fs(10), color: tokens.userTextMuted, marginBottom: 3 }}>
      <span style={{ fontWeight: 600, letterSpacing: 0.4 }}>YOU</span>
      <time dateTime={at}>{formatReplyTime(new Date(at))}</time>
      <button aria-label="Copy message" onClick={() => navigator.clipboard.writeText(text)} style={{ display: "flex", border: 0, background: "transparent", padding: "2px 4px" }}><Glyph name="Copy" size={11} color={tokens.userTextMuted} /></button>
    </div>
    <div style={{ fontSize: tokens.fs(13.5), lineHeight: `${tokens.fs(20)}px` }}>{text}</div>
  </div>;
}

export function Demo({ tokens, animate = false, detailWidth, detailPresentation }: { tokens: ExtendedThemeTokens; animate?: boolean; detailWidth?: number; detailPresentation?: StepDetailPresentation }) {
  const { width } = useWindowDimensions();
  const compact = !detailPresentation && width < 744;
  const [phase, setPhase] = React.useState(animate ? -1 : DEMO_STEPS.length);
  const [selected, setSelected] = React.useState<ToolCalloutData | null>(null);
  const [viewState, setViewState] = React.useState(createStepDetailState);
  React.useEffect(() => {
    const advance = (event: Event) => setPhase((event as CustomEvent<number>).detail);
    window.addEventListener("demo-phase", advance);
    return () => window.removeEventListener("demo-phase", advance);
  }, []);
  // The capture host can reserve a side panel independently of its chat width.
  const presentation = detailPresentation ?? stepDetailPresentation(width);
  const openStep = (step: ToolCalloutData) => {
    if (selected?.id !== step.id) setViewState(createStepDetailState());
    setSelected(step);
  };
  return <div data-testid="demo" style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: tokens.surface0, color: tokens.foreground, fontFamily: tokens.fontUi }}>
    <main style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div data-testid="demo-chat" style={{ flex: 1, minWidth: 0, overflow: "auto", padding: compact ? "12px 12px" : "24px 28px" }}>
        <div data-testid="demo-transcript" style={{ maxWidth: 840, margin: "0 auto", display: "flex", flexDirection: "column", gap: compact ? 6 : 12 }}>
          <HostPrompt text={PROMPT} at={DEMO_TIMES.prompt} tokens={tokens} />
          {DEMO_STEPS.slice(0, Math.min(phase + 1, DEMO_STEPS.length)).map((step, index) => {
            const running = phase === index;
            return <div key={step.id} data-testid={`demo-step-${index}`}><ToolCallout
              data={running ? { ...step, status: "running", durationMs: undefined } : step}
              tokens={tokens} expanded={running} onExpandedChange={() => {}} onOpenDetail={() => openStep(step)}
            /></div>;
          })}
          {phase >= DEMO_STEPS.length ? <div data-testid="demo-reply">
            <MarkdownView text={REPLY} tokens={tokens} variant="document" />
            <div style={{ paddingTop: 8 }}><AssistantFooter text={REPLY} at={new Date(DEMO_TIMES.reply)} tokens={tokens} /></div>
          </div> : null}
          {phase >= DEMO_STEPS.length ? <>
            <HostPrompt text={FOLLOW_UP} at={DEMO_TIMES.followUp} tokens={tokens} marginTop={compact ? 32 : 0} />
            <div data-testid="demo-follow-up">
              <MarkdownView text={FOLLOW_UP_REPLY} tokens={tokens} variant="document" />
              <div style={{ paddingTop: 8 }}><AssistantFooter text={FOLLOW_UP_REPLY} at={new Date(DEMO_TIMES.followUpReply)} tokens={tokens} /></div>
            </div>
          </> : null}
        </div>
      </div>
      {selected ? <aside style={{ display: presentation === "side" ? "flex" : "contents", width: detailWidth ?? (tokens.textScale > 1 ? 690 : width >= 1400 ? 520 : 440), flexShrink: 0, minHeight: 0, borderLeft: `1px solid ${tokens.border}` }}>
        <StepDetailPanel key={selected.id} step={selected} open onOpenChange={open => { if (!open) setSelected(null); }} presentation={presentation} tokens={tokens} viewState={viewState} />
      </aside> : null}
    </main>
  </div>;
}
