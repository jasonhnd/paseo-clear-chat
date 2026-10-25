/** Offline captures of real plugin components, backed only by fixtures.ts. */
import React from "react";
import { Demo } from "./demo";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { PluginTranslationProvider, PluginTranslationRuntime } from "./shims/plugin-client";
import { embedFonts } from "../client/components/embed-fonts";
import { installFrostedGlass } from "../client/components/frosted";
import { buildThemeTokens } from "../client/components/theme-tokens";
import { ToolCallout as ControlledToolCallout, type ToolCalloutProps } from "../client/components/tool-callouts";
import { ReasoningTrace } from "../client/components/reasoning-trace";
import { TaskList } from "../client/components/task-list";
import { ApprovalCard } from "../client/components/approval-card";
import { UserMessage } from "../client/components/user-message";
import { HubCallout } from "../client/components/hub-callout";
import { PaseoToolCallout } from "../client/components/paseo-tool-callouts";
import { SyntaxHighlightBlock } from "../client/components/syntax-highlight";
import { ClearChatSettingsPage } from "../client/settings-page";
import { NoticeCallout } from "../client/components/notice-callout";
import { SystemCard } from "../client/components/system-card";
import { AssistantFooter } from "../client/components/turn-footer";
import { MarkdownView } from "../client/components/markdown/markdown-view";
import { FinalToolReply } from "../client/components/final-tool-reply";
import { parseSystemEnvelope } from "../client/system-envelope";
import { APPROVAL, CALLS, CODE, DIFF, JOB_NOTICE, PROMPT, REASONING, REPLY, TASKS, WRAP_UP } from "./fixtures";

const dark = new URLSearchParams(location.search).get("theme") !== "light";
const colors = dark ? {
  surface0: "#0f0f11", surface1: "#17171a", surface2: "#1f1f23", border: "#2a2a30",
  foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11",
  statusSuccess: "#4cb782", statusWarning: "#d9a53f", statusDanger: "#f2555a",
} : {
  surface0: "#f8fafc", surface1: "#ffffff", surface2: "#edf0f5", border: "#d5dbe5",
  foreground: "#18202d", foregroundMuted: "#586579", accent: "#315fba", accentForeground: "#ffffff",
  statusSuccess: "#23845b", statusWarning: "#986500", statusDanger: "#c93642",
};
const tokens = buildThemeTokens(colors);
const demoImage = (globalThis as { __showcaseImage?: string }).__showcaseImage ?? "";
const sampleImage = { dataUri: demoImage, width: 480, height: 240, bytes: atob(demoImage.split(",")[1] ?? "").length, error: null };
const noop = () => {};
function Tool({ name, initialExpanded = true, ...props }: { name: string; initialExpanded?: boolean } & Partial<ToolCalloutProps>) {
  const [expanded, setExpanded] = React.useState(initialExpanded);
  return <ControlledToolCallout data={CALLS[name]!} tokens={tokens} expanded={expanded} onExpandedChange={setExpanded} onRevealPath={noop} {...props} />;
}
function Prompt() {
  return <UserMessage text={PROMPT} timestamp={new Date("2026-01-01T12:00:00Z")} tokens={tokens} usage={{ inputTokens: 240, cachedInputTokens: 800, outputTokens: 160 }} />;
}
function Reply() {
  return <View><MarkdownView text={REPLY} tokens={tokens} variant="document" /><AssistantFooter text={REPLY} at={new Date("2026-01-01T12:01:00Z")} tokens={tokens} /></View>;
}
function Conversation() {
  return <View style={{ gap: 12 }}><Prompt /><Tool name="search" initialExpanded={false} /><Tool name="read" /><Tool name="edit" initialExpanded={false} /><Tool name="bash" initialExpanded={false} /><Reply /></View>;
}
/** An illustrative host fallback, not a capture of a running Paseo host. */
function Baseline() {
  return <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: "20px" }}>
    <div style={{ background: colors.surface2, borderRadius: 8, padding: "12px 14px", alignSelf: "flex-end" }}>{PROMPT}</div>
    <NativeTool title="Search: shippingLabel" />
    <NativeTool title="Read src/cart.ts"><pre>{CODE}</pre></NativeTool>
    <NativeTool title="Edit src/cart.ts" />
    <NativeTool title="$ npm test" />
    <div style={{ padding: "8px 0" }}><h3 style={{ fontSize: 18, margin: "0 0 12px" }}>Ready to review</h3><p>The cart now shows <strong>Free shipping</strong> at $50.</p><ul><li>Added the threshold check in <code>src/cart.ts</code>.</li><li>Covered totals below, at, and above $50.</li><li>All 12 demo tests passed.</li></ul></div>
  </div>;
}
function NativeTool({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div style={{ padding: "8px 10px", border: `1px solid ${colors.border}`, borderRadius: 6, color: colors.foregroundMuted }}><div style={{ fontFamily: tokens.fontMono, fontSize: 12 }}>⌄ {title} <span style={{ float: "right" }}>✓</span></div>{children}</div>;
}
function Comparison() {
  return <div style={{ width: 1440, padding: 28, background: colors.surface0, color: colors.foreground, fontFamily: tokens.fontUi }}>
    <div style={{ fontSize: 26, fontWeight: 650, marginBottom: 6 }}>One conversation. Clearer at every step.</div>
    <div style={{ fontSize: 13, color: colors.foregroundMuted, marginBottom: 24 }}>Offline demo · identical synthetic messages · illustrative host baseline</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
      {[false, true].map(enhanced => <div key={String(enhanced)} style={{ border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden", background: colors.surface1 }}>
        <div style={{ padding: "14px 20px", background: colors.surface2, borderBottom: `1px solid ${colors.border}`, fontSize: 14, fontWeight: 600 }}>{enhanced ? "With Clear Chat" : "Without Clear Chat"}</div>
        <div style={{ padding: 20 }}>{enhanced ? <Conversation /> : <Baseline />}</div>
      </div>)}
    </div>
  </div>;
}
function Shot({ id, title, width = 840, children }: { id: string; title: string; width?: number; children: React.ReactNode }) {
  return <section id={`shot-${id}`} data-fixture={id} style={{ width, padding: 24, background: colors.surface0, color: colors.foreground, fontFamily: tokens.fontUi }}>
    <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: colors.foregroundMuted, marginBottom: 8 }}>Clear Chat · {dark ? "Dark" : "Light"} · Synthetic demo</div>
    <h2 style={{ fontSize: 20, lineHeight: "28px", margin: "0 0 18px", fontWeight: 600 }}>{title}</h2>
    <View style={{ gap: 12 }}>{children}</View>
  </section>;
}
function Showcase() {
  const envelope = parseSystemEnvelope(JOB_NOTICE);
  return <main style={{ display: "flex", flexDirection: "column", gap: 24 }}>
    <div id="shot-compare" data-fixture="compare"><Comparison /></div>
    <Shot id="thread" title="A complete demo turn"><Prompt /><ReasoningTrace data={REASONING} tokens={tokens} defaultExpanded /><Tool name="search" initialExpanded={false} /><Tool name="read" /><Tool name="edit" /><Tool name="bash" /><TaskList data={TASKS} tokens={tokens} />{envelope ? <SystemCard envelope={envelope} tokens={tokens} /> : null}<FinalToolReply text={WRAP_UP} tokens={tokens} variant="document" /></Shot>
    <Shot id="tool-collapsed" title="Finished tools fold into compact rows">{["search", "read", "edit", "bash"].map(name => <Tool key={name} name={name} initialExpanded={false} />)}</Shot>
    <Shot id="tool-expanded" title="Open a row to inspect the details"><Tool name="bash" /></Shot>
    <Shot id="tool-bash" title="Shell output and Git changes"><Tool name="bash" /><Tool name="git" /></Shot>
    <Shot id="tool-read" title="File contents with syntax and line numbers"><Tool name="read" /></Shot>
    <Shot id="tool-image" title="Preview a local image"><Tool name="image" imageFile={sampleImage} /></Shot>
    <Shot id="tool-edit" title="Read an edit as a diff"><Tool name="edit" /></Shot>
    <Shot id="tool-thinking" title="Reasoning in a tool card"><Tool name="thinking" /></Shot>
    <Shot id="tool-mcp" title="MCP arguments and results"><Tool name="mcp" /></Shot>
    <Shot id="tool-eval" title="Code cells and their output"><Tool name="eval" /></Shot>
    <Shot id="tool-ask" title="A clear choice and the selected answer"><Tool name="ask" /></Shot>
    <Shot id="tool-task" title="A roster for delegated work"><Tool name="task" /></Shot>
    <Shot id="tool-sub-agent" title="Subagent instructions and reported model"><Tool name="subagent" /></Shot>
    <Shot id="tool-search" title="Search matches with file links"><Tool name="search" /></Shot>
    <Shot id="tool-fetch" title="Fetched page with a readable preview"><Tool name="fetch" /></Shot>
    <Shot id="tool-web-search" title="Web search query and source"><Tool name="websearch" /></Shot>
    <Shot id="tool-discovery" title="Find a tool by its purpose"><Tool name="discovery" /></Shot>
    <Shot id="tool-plan" title="Plans with active and blocked steps"><Tool name="plan" /></Shot>
    <Shot id="tool-todo" title="Track the remaining work"><Tool name="todo" /></Shot>
    <Shot id="tool-failure" title="A failed call keeps its reason visible"><Tool name="failure" /><Tool name="failure" initialExpanded={false} /></Shot>
    <Shot id="wrap-up" title="The reply stays outside tool disclosures"><Tool name="bash" initialExpanded={false} /><FinalToolReply text={WRAP_UP} tokens={tokens} variant="document" /></Shot>
    <Shot id="generated-images" title="An image in an assistant reply"><MarkdownView text={`Here is the **synthetic checkout preview**.\n\n![Demo checkout with a free-shipping message](${demoImage})`} tokens={tokens} variant="document" /></Shot>
    <Shot id="hub" title="Background process and job status"><HubCallout data={{ kind: "process", data: { op: "start", name: "demo-preview", spec: { application: "npm", args: ["run", "preview"] }, daemon: { name: "demo-preview", state: "ready", readyMatch: "Demo preview ready" }, logs: ["Demo preview ready on localhost:4173"] } }} tokens={tokens} /></Shot>
    <Shot id="paseo" title="An agent created by a Paseo tool"><PaseoToolCallout data={{ id: "demo-paseo", tool: "create_agent", durationMs: 480, createAgent: { title: "Demo cart reviewer", provider: "codex", model: "Demo model", initialPrompt: "Review the synthetic cart boundary tests.", agentId: "demo-reviewer", status: "created" } }} tokens={tokens} /></Shot>
    <Shot id="tool-github" title="Checks summarized in a GitHub card"><Tool name="github" /></Shot>
    <Shot id="notice" title="Background information and warnings"><NoticeCallout data={{ id: "demo-info", level: "info", message: "The demo cart review is complete." }} tokens={tokens} /><NoticeCallout data={{ id: "demo-warning", level: "warning", message: "The demo preview server is offline." }} tokens={tokens} /></Shot>
    <Shot id="reasoning" title="A reasoning trace with connected steps"><ReasoningTrace data={REASONING} tokens={tokens} defaultExpanded /></Shot>
    <Shot id="tasks" title="Progress, pending work, and a blocked task"><TaskList data={TASKS} tokens={tokens} /></Shot>
    <Shot id="approval" title="Review the command before approving"><ApprovalCard request={APPROVAL} tokens={tokens} /></Shot>
    <Shot id="user" title="Prompt bubble. Copy button and token usage."><Prompt /></Shot>
    <Shot id="syntax" title="Shared syntax highlighting and copy controls"><SyntaxHighlightBlock code={CODE} language="typescript" filename="src/cart.ts" tokens={tokens} showLineNumbers onRevealFile={noop} /><SyntaxHighlightBlock code={DIFF} language="diff" tokens={tokens} showLineNumbers /></Shot>
    <Shot id="settings" title="Presentation preferences" width={760}><ClearChatSettingsPage theme={{ colors }} host={{ id: "demo-host", label: "Demo host" }} layout={{ compact: false, platform: "web" }} /></Shot>
  </main>;
}
embedFonts();
installFrostedGlass();
document.body.style.background = colors.surface0;
const translations = new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} });
createRoot(document.getElementById("root")!).render(<PluginTranslationProvider runtime={translations}>{new URLSearchParams(location.search).has("demo") ? <Demo tokens={tokens} /> : <Showcase />}</PluginTranslationProvider>);
