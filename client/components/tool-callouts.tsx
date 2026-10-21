import React, { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { Glyph } from "./glyph";
import { frosted } from "./frosted";
import { surfaceProps } from "./view-props";
import { glowing } from "./glow";
import { Rotate } from "./motion";
import { ToolSpinner } from "./tool-spinner";
import { toolSummary, toolDuration } from "../tool-summary";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { HubCallout } from "./hub-callout";
import { PaseoToolCallout } from "./paseo-tool-callouts";
import { renderTerminalOutput } from "./syntax-highlight";
import { ToolCodeBlock, ToolOutput } from "./tool-output";
import { ImagePreview } from "./image-preview";
import { GitHubBody } from "./github-body";
import { SubagentBatch } from "./subagent-batch";
import { useToolCalloutStyles } from "./tool-callout-styles";
import { hasToolDetailBody, ToolDetailBody } from "./tool-detail-body";
import { isImagePath } from "../image-file";
import type { ImageFile } from "../image-file";
import { selectionCodeText, selectionSurface } from "./selection-actions";
import type { ToolCalloutData } from "../../shared/contracts";
import { useEnhancerPreferences } from "../preferences";
import { toolErrorLine } from "../tool-error";

function getToolIconName(tool: string): string {
  if (tool === "git") return "Git";
  if (tool === "paseo") return "Paseo";
  if (tool === "github") return "GitHub";
  if (tool === "bash" || tool === "shell") return "Terminal";
  if (tool === "read") return "Book";
  if (tool === "edit" || tool === "write") return "Pencil";
  if (tool === "thinking") return "Brain";
  if (tool === "eval") return "Play";
  if (tool === "ask") return "HelpCircle";
  if (tool === "mcp") return "Plug";
  if (tool === "task" || tool === "sub_agent") return "Bot";
  if (tool === "search" || tool === "web_search" || tool === "tool_search") return "Search";
  if (tool === "fetch") return "Globe";
  if (tool === "plan" || tool === "todo") return "ListChecks";
  if (tool === "plain_text") return "FileText";
  if (tool === "hub") return "Radio";
  return "Wrench";
}

export interface ToolCalloutProps {
  data: ToolCalloutData;
  tokens: ExtendedThemeTokens;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Shows a path in the machine's own file manager. */
  onRevealPath?: (path: string) => void;
  /**
   * The image this call read, when it read one. `undefined` keeps the code
   * block, so a harness with no daemon still renders the card; `null` means
   * the read is in flight.
   */
  imageFile?: ImageFile | null;
}

export function ToolCallout({
  data,
  tokens,
  expanded,
  onExpandedChange,
  onRevealPath,
  imageFile,
}: ToolCalloutProps) {
  const { foldLongOutputAfter } = useEnhancerPreferences();
  const errorLine = toolErrorLine(data, foldLongOutputAfter);
  // Every branch below needs a payload. A tool that carries none — a hub op
  // with no parsed record, an unmapped kind — would otherwise draw an empty
  // panel, so the raw output takes over.
  const hasTypedBody =
    hasToolDetailBody(data) ||
    data.tool === "bash" ||
    data.tool === "shell" ||
    data.tool === "git" ||
    data.tool === "github" ||
    data.tool === "thinking" ||
    data.tool === "read" ||
    data.tool === "write" ||
    data.tool === "edit" ||
    (data.tool === "eval" && Boolean(data.cells?.some((cell) => cell.code || cell.output) || data.code || data.output)) ||
    (data.tool === "mcp" && Boolean(data.mcp)) ||
    (data.tool === "ask" && Boolean(data.askOptions)) ||
    ((data.tool === "task" || data.tool === "sub_agent") && Boolean(data.subagent)) ||
    (data.tool === "hub" && Boolean(data.hub)) ||
    (data.tool === "paseo" && Boolean(data.paseo));

  const filePath = data.filePath;
  // A tool without a path, or a host that cannot reveal one, leaves the file
  // name as a plain label rather than a link that does nothing.
  const revealFile = useMemo(
    () => (onRevealPath && filePath ? () => onRevealPath(filePath) : undefined),
    [onRevealPath, filePath],
  );

  const isSuccess = data.status === "completed";
  const isRunning = data.status === "running";
  const isFailed = data.status === "failed";
  const isWaiting = data.status === "waiting";
  const duration = toolDuration(data.durationMs);

  // Only a real shell call can "complete without output". A git op or an
  // unmapped tool that prints nothing is not a silent command, so neither
  // inherits the shell sentence.
  const isShellCall = data.tool === "bash" || data.tool === "shell";

  const statusColor = isSuccess ? tokens.success : isRunning || isWaiting ? tokens.accent : isFailed ? tokens.danger : tokens.foregroundMuted;

  const statusBg = isSuccess ? tokens.successBg : isRunning || isWaiting ? tokens.accentBg : isFailed ? tokens.dangerBg : tokens.surface2;

  const iconColor =
    data.tool === "git" ? "#F05032" : data.tool === "github" ? tokens.foreground : tokens.accent;

  // A reply that matches no offered label is free text the user typed, so it
  // is labelled as such rather than pretending an option was picked.
  const answered = data.askAnswer ?? [];
  const typedReply =
    answered.length > 0 &&
    !answered.some((answer) =>
      (data.askOptions ?? []).some(
        (option) => option.label.trim().toLowerCase() === answer.trim().toLowerCase(),
      ),
    );

  const styles = useToolCalloutStyles(tokens, statusBg, statusColor);

  return (
    <View
      testID={`tool-card-${hasTypedBody ? data.tool : "unknown"}`}
      {...surfaceProps(frosted, glowing(tokens.isDark), selectionSurface)}
      style={styles.container}
    >
      <Pressable
        testID="tool-summary-row"
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${toolSummary(data)}`}
        accessibilityState={{ expanded }}
        onPress={() => onExpandedChange(!expanded)}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <Glyph name={getToolIconName(data.tool)} size={13} color={iconColor} />
          <Text selectable testID="tool-summary-text" style={styles.titleText} numberOfLines={1}>
            {toolSummary(data)}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {duration !== undefined ? <Text testID="tool-duration" style={styles.durationBadge} numberOfLines={1}>{duration}</Text> : null}
          {data.exitCode !== undefined && data.exitCode !== 0 ? (
            <Text style={[styles.durationBadge, { color: tokens.danger }]} numberOfLines={1}>exit {data.exitCode}</Text>
          ) : null}
          <View testID={`tool-status-${data.status}`} accessibilityLabel={data.status}>
            {isRunning ? <ToolSpinner color={tokens.accent} /> : (
              <Text style={styles.indicatorText} numberOfLines={1}>
                {isSuccess ? "✓" : isFailed ? "✗" : isWaiting ? "Waiting" : "canceled"}
              </Text>
            )}
          </View>
          <Rotate active={expanded}>
            <Glyph name="ChevronDown" size={14} color={tokens.foregroundMuted} />
          </Rotate>
        </View>
      </Pressable>

      {expanded && (
        <View testID="tool-card-body" style={styles.body}>
          {errorLine ? <Text testID="tool-error-line" selectable style={styles.mcpErrorText}>{errorLine}</Text> : null}
          {hasToolDetailBody(data) ? <ToolDetailBody data={data} tokens={tokens} onRevealPath={onRevealPath} /> : null}
          {(data.tool === "bash" || data.tool === "shell" || data.tool === "git") && (
            <View style={styles.terminalWindow}>
              {(data.shell?.command || data.command) && (
                <ToolCodeBlock
                  code={`$ ${data.shell?.command || data.command}`}
                  language="bash"
                  tokens={tokens}
                  compact
                />
              )}

              {data.shell?.stdout && (
                <ToolOutput text={data.shell.stdout} tokens={tokens}>
                  {shown => <Text selectable {...selectionCodeText} style={styles.terminalOutput}>{renderTerminalOutput(shown, tokens)}</Text>}
                </ToolOutput>
              )}
              {data.shell?.stderr && (
                <ToolOutput text={data.shell.stderr} tokens={tokens}>
                  {shown => <Text selectable style={[styles.terminalOutput, { color: tokens.danger }]}>{shown}</Text>}
                </ToolOutput>
              )}
              {data.output && !data.shell?.stdout && (
                <ToolOutput text={data.output} tokens={tokens}>
                  {shown => <Text selectable {...selectionCodeText} style={styles.terminalOutput}>{renderTerminalOutput(shown, tokens)}</Text>}
                </ToolOutput>
              )}
              {!data.shell?.stdout && !data.shell?.stderr && !data.output && (
                <Text selectable style={styles.silentCommandText}>
                  {isRunning
                    ? "Waiting for command output…"
                    : isFailed ? "Command failed without output."
                    : data.status === "canceled" ? "Command canceled without output."
                    : isShellCall
                      ? "Command completed without output."
                      : "The call returned no output."}
                </Text>
              )}
            </View>
          )}

          {data.tool === "github" && (
            <GitHubBody data={data.github} tokens={tokens} running={isRunning} />
          )}

          {data.tool === "thinking" && (
            <View style={styles.thinkingContainer}>
              <View style={styles.thinkingHeader}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Glyph name="Brain" size={13} color={tokens.accent} />
                  <Text selectable style={styles.thinkingTitle}>
                    {data.thinking?.status === "thinking"
                      ? "Live Reasoning Stream…"
                      : "Reasoning Completed"}
                  </Text>
                </View>
                {data.thinking?.tokenCount ? (
                  <Text selectable style={styles.thinkingTokenBadge}>
                    {data.thinking.tokenCount} tokens
                  </Text>
                ) : null}
              </View>

              <Text selectable style={styles.thinkingText}>
                {data.thinking?.text ||
                  data.code ||
                  data.output ||
                  "Analyzing constraints and formulating steps..."}
              </Text>
              {data.thinking?.steps && data.thinking.steps.length > 0 && (
                <View style={styles.thinkingStepsList}>
                  {data.thinking.steps.map((step, idx) => (
                    <View key={idx} style={styles.thinkingStepRow}>
                      <Text
                        selectable
                        style={{
                          fontSize: tokens.fs(11),
                          color: tokens.foregroundSubtle,
                          fontFamily: tokens.fontMono,
                        }}
                      >
                        {idx + 1}.
                      </Text>
                      <Text
                        selectable
                        style={[styles.thinkingStepText, { color: tokens.foreground }]}
                      >
                        {step}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {data.tool === "mcp" && data.mcp && (
            <View style={styles.mcpContainer}>
              <View style={styles.mcpHeader}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Text selectable style={styles.mcpServerBadge}>
                    {data.mcp.server}
                  </Text>
                  <Text selectable style={styles.mcpToolName}>
                    {data.mcp.tool}
                  </Text>
                </View>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {data.mcp.transport && (
                    <Text selectable style={styles.mcpTransportBadge}>
                      {data.mcp.transport}
                    </Text>
                  )}
                  {data.durationMs ? (
                    <Text selectable style={styles.durationBadge}>
                      {data.durationMs}ms
                    </Text>
                  ) : null}
                </View>
              </View>

              <View style={{ gap: 4 }}>
                <Text selectable style={styles.mcpSectionTitle}>
                  Input Parameters
                </Text>
                <ToolCodeBlock
                  code={JSON.stringify(data.mcp.arguments, null, 2)}
                  language="json"
                  tokens={tokens}
                  compact
                />
              </View>

              {data.mcp.result !== undefined && (
                <View style={{ gap: 4, marginTop: 4 }}>
                  <Text selectable style={styles.mcpSectionTitle}>
                    Response Payload
                  </Text>
                  <ToolCodeBlock
                    code={
                      typeof data.mcp.result === "string"
                        ? data.mcp.result
                        : JSON.stringify(data.mcp.result, null, 2)
                    }
                    language={typeof data.mcp.result === "string" ? "typescript" : "json"}
                    tokens={tokens}
                    compact
                  />
                </View>
              )}

              {data.mcp.error && (
                <View style={styles.mcpErrorBox}>
                  <Text selectable style={styles.mcpErrorText}>
                    Error: {data.mcp.error}
                  </Text>
                </View>
              )}
            </View>
          )}

          {(data.tool === "read" || data.tool === "write") && !data.skill &&
            (imageFile !== undefined && isImagePath(data.filePath) ? (
              <ImagePreview
                path={data.filePath ?? ""}
                file={imageFile}
                tokens={tokens}
                onReveal={revealFile}
              />
            ) : (
              <ToolCodeBlock
                code={data.code || "// [Empty content or pending stream]"}
                language={data.language ?? "text"}
                filename={data.filePath ? `${data.filePath} ${data.lineRange || ""}` : undefined}
                tokens={tokens}
                showLineNumbers={Boolean(data.code)}
                onRevealFile={revealFile}
                compact
              />
            ))}

          {data.tool === "edit" && (
            <ToolCodeBlock
              code={data.diff || data.code || "// [Edit: diff applied]"}
              language={data.changes ? "diff" : "text"}
              filename={data.filePath}
              tokens={tokens}
              showLineNumbers
              onRevealFile={revealFile}
              compact
            />
          )}

          {data.tool === "eval" && hasTypedBody && (
            <View style={{ gap: 10 }}>
              {(
                data.cells ?? [
                  {
                    code: data.code || "",
                    language: data.language || "typescript",
                    output: data.output,
                  },
                ]
              ).map((cell, idx) => (
                <View key={idx} style={{ gap: 4 }}>
                  {cell.code ? (
                    <ToolCodeBlock
                      code={cell.code}
                      language={cell.language}
                      filename={cell.title || "Persistent Kernel Cell"}
                      tokens={tokens}
                      showLineNumbers
                      compact
                    />
                  ) : null}
                  {cell.output ? (
                    <View style={styles.evalOutput}>
                      <Text selectable style={styles.evalOutputLabel}>
                        stdout
                      </Text>
                      <ToolOutput text={cell.output} tokens={tokens}>
                        {shown => <Text selectable {...selectionCodeText} style={styles.evalOutputText}>{renderTerminalOutput(shown, tokens)}</Text>}
                      </ToolOutput>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          )}

          {data.tool === "ask" && data.askOptions && (
            <View style={styles.askContainer}>
              <Text selectable style={styles.askPrompt}>
                {answered.length > 0 ? "Options offered:" : "Waiting for a decision:"}
              </Text>
              {data.askOptions.map((opt) => {
                // The answer is whatever the tool reported, so a label match
                // marks the chosen row. A typed reply matches nothing and is
                // shown on its own line below.
                const isChosen = (data.askAnswer ?? []).some(
                  (answer) => answer.trim().toLowerCase() === opt.label.trim().toLowerCase(),
                );
                return (
                  <View
                    key={opt.id}
                    style={[styles.askOptionCard, isChosen && styles.askOptionCardSelected]}
                  >
                    <View style={styles.askOptionLeft}>
                      <View style={styles.askOptionLabelRow}>
                        <Text
                          selectable
                          style={[styles.askOptionLabel, isChosen && styles.askOptionLabelChosen]}
                        >
                          {opt.label}
                        </Text>
                        {opt.recommended ? (
                          <Text selectable style={styles.recommendedBadge}>
                            Recommended
                          </Text>
                        ) : null}
                      </View>
                      {opt.description ? (
                        <Text selectable style={styles.askOptionDesc}>
                          {opt.description}
                        </Text>
                      ) : null}
                    </View>
                    {isChosen ? (
                      <Glyph name="CheckCircle" size={16} color={tokens.success} />
                    ) : (
                      <Glyph name="Circle" size={14} color={tokens.foregroundSubtle} />
                    )}
                  </View>
                );
              })}
              {answered.length > 0 ? (
                <View style={styles.askAnswerRow}>
                  <Text selectable style={styles.askAnswerKey}>
                    {typedReply ? "typed" : "answered"}
                  </Text>
                  <Text selectable style={styles.askAnswerValue}>
                    {answered.join(", ")}
                  </Text>
                </View>
              ) : null}
            </View>
          )}

          {(data.tool === "task" || data.tool === "sub_agent") && data.subagent && (
            <SubagentBatch batch={data.subagent} running={isRunning} tokens={tokens} showModel={data.tool === "sub_agent"} />
          )}
          {data.tool === "hub" && data.hub && <HubCallout data={data.hub} tokens={tokens} />}
          {data.tool === "paseo" && data.paseo && (
            <PaseoToolCallout data={data.paseo} tokens={tokens} />
          )}

          {!hasTypedBody ? <ToolDetailBody data={data} tokens={tokens} /> : null}
        </View>
      )}
    </View>
  );
}
