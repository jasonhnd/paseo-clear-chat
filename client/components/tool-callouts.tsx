import React, { useState, useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { Glyph } from "./glyph";
import { frosted } from "./frosted";
import { surfaceProps } from "./view-props";
import { glowing } from "./glow";
import { Rotate } from "./motion";
import { Breathe } from "./breathe";
import { PulseDot } from "./pulse-dot";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { HubCallout } from "./hub-callout";
import { PaseoToolCallout } from "./paseo-tool-callouts";
import { SyntaxHighlightBlock, renderTerminalOutput } from "./syntax-highlight";
import { FileTypeLogo } from "./file-type-logo";
import { ImagePreview } from "./image-preview";
import { GitHubBody } from "./github-body";
import { SubagentBatch } from "./subagent-batch";
import { useToolCalloutStyles } from "./tool-callout-styles";
import { isImagePath } from "../image-file";
import type { ImageFile } from "../image-file";
import { selectionCodeText, selectionSurface } from "./selection-actions";
import type { ToolCalloutData } from "../../shared/contracts";

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
  if (tool === "task") return "Bot";
  if (tool === "hub") return "Radio";
  return "Wrench";
}

interface ToolCalloutProps {
  data: ToolCalloutData;
  tokens: ExtendedThemeTokens;
  defaultExpanded?: boolean;
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
  defaultExpanded = true,
  onRevealPath,
  imageFile,
}: ToolCalloutProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Every branch below needs a payload. A tool that carries none — a hub op
  // with no parsed record, an unmapped kind — would otherwise draw an empty
  // panel, so the raw output takes over.
  const hasTypedBody =
    data.tool === "bash" ||
    data.tool === "shell" ||
    data.tool === "git" ||
    data.tool === "github" ||
    data.tool === "thinking" ||
    data.tool === "read" ||
    data.tool === "write" ||
    data.tool === "edit" ||
    data.tool === "eval" ||
    (data.tool === "mcp" && Boolean(data.mcp)) ||
    (data.tool === "ask" && Boolean(data.askOptions)) ||
    (data.tool === "task" && Boolean(data.subagent)) ||
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

  // Only a real shell call can "complete without output". A git op or an
  // unmapped tool that prints nothing is not a silent command, so neither
  // inherits the shell sentence.
  const isShellCall = data.tool === "bash" || data.tool === "shell";

  const statusColor = isSuccess ? tokens.success : isRunning ? tokens.accent : tokens.danger;

  const statusBg = isSuccess ? tokens.successBg : isRunning ? tokens.accentBg : tokens.dangerBg;

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
      {...surfaceProps(frosted, glowing(tokens.isDark), selectionSurface)}
      style={styles.container}
    >
      <Pressable onPress={() => setExpanded((p) => !p)} style={styles.header}>
        <View style={styles.headerLeft}>
          <Breathe depth={1.08} durationMs={1800}>
            <Glyph name={getToolIconName(data.tool)} size={13} color={iconColor} />
          </Breathe>
          <Text selectable style={styles.toolPill}>
            {data.tool}
          </Text>
          {data.filePath ? (
            <Breathe depth={1.08} durationMs={1800}>
              {isImagePath(data.filePath) ? (
                // An image has no language logo to show, and the generic page
                // mark says less than the picture mark does.
                <Glyph name="Image" size={13} color={tokens.foreground} />
              ) : (
                <FileTypeLogo
                  filename={data.filePath}
                  language={data.language}
                  size="sm"
                  foregroundColor={tokens.foreground}
                />
              )}
            </Breathe>
          ) : null}
          <Text selectable style={styles.titleText} numberOfLines={1}>
            {data.title}
          </Text>
        </View>

        <View style={styles.headerRight}>
          {data.durationMs ? (
            <Text selectable style={styles.durationBadge}>
              {data.durationMs}ms
            </Text>
          ) : null}

          {data.exitCode !== undefined && data.exitCode !== 0 && (
            <Text selectable style={[styles.durationBadge, { color: tokens.danger }]}>
              exit {data.exitCode}
            </Text>
          )}

          {isFailed && (
            <Text selectable style={{ fontSize: tokens.fs(11), fontWeight: "600", color: tokens.danger }}>
              failed
            </Text>
          )}

          {isRunning && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <PulseDot color={tokens.accent} size={5} />
              <Text
                selectable
                style={{
                  fontSize: tokens.fs(11),
                  color: tokens.accent,
                  fontWeight: "500",
                }}
              >
                running
              </Text>
            </View>
          )}

          <Rotate active={expanded}>
            <Breathe depth={1.08} durationMs={1800}>
              <Glyph name="ChevronDown" size={16} color={tokens.foregroundMuted} />
            </Breathe>
          </Rotate>
        </View>
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          {(data.tool === "bash" || data.tool === "shell" || data.tool === "git") && (
            <View style={styles.terminalWindow}>
              {(data.shell?.command || data.command) && (
                <SyntaxHighlightBlock
                  code={`$ ${data.shell?.command || data.command}`}
                  language="bash"
                  tokens={tokens}
                  compact
                />
              )}

              {data.shell?.stdout && (
                <Text selectable {...selectionCodeText} style={styles.terminalOutput}>
                  {renderTerminalOutput(data.shell.stdout, tokens)}
                </Text>
              )}
              {data.shell?.stderr && (
                <Text selectable style={[styles.terminalOutput, { color: tokens.danger }]}>
                  {data.shell.stderr}
                </Text>
              )}
              {data.output && !data.shell?.stdout && (
                <Text selectable {...selectionCodeText} style={styles.terminalOutput}>
                  {renderTerminalOutput(data.output, tokens)}
                </Text>
              )}
              {!data.shell?.stdout && !data.shell?.stderr && !data.output && (
                <Text selectable style={styles.silentCommandText}>
                  {isRunning
                    ? "Waiting for command output…"
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
                <SyntaxHighlightBlock
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
                  <SyntaxHighlightBlock
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

          {(data.tool === "read" || data.tool === "write") &&
            (imageFile !== undefined && isImagePath(data.filePath) ? (
              <ImagePreview
                path={data.filePath ?? ""}
                file={imageFile}
                tokens={tokens}
                onReveal={revealFile}
              />
            ) : (
              <SyntaxHighlightBlock
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
            <SyntaxHighlightBlock
              code={data.diff || data.code || "// [Edit: diff applied]"}
              language="diff"
              filename={data.filePath}
              tokens={tokens}
              showLineNumbers
              onRevealFile={revealFile}
              compact
            />
          )}

          {data.tool === "eval" && (
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
                    <SyntaxHighlightBlock
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
                      <Text selectable {...selectionCodeText} style={styles.evalOutputText}>
                        {renderTerminalOutput(cell.output, tokens)}
                      </Text>
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

          {data.tool === "task" && data.subagent && (
            <SubagentBatch batch={data.subagent} running={isRunning} tokens={tokens} />
          )}
          {data.tool === "hub" && data.hub && <HubCallout data={data.hub} tokens={tokens} />}
          {data.tool === "paseo" && data.paseo && (
            <PaseoToolCallout data={data.paseo} tokens={tokens} />
          )}

          {!hasTypedBody && (
            <View style={styles.terminalWindow}>
              {data.output ? (
                <Text selectable {...selectionCodeText} style={styles.terminalOutput}>
                  {renderTerminalOutput(data.output, tokens)}
                </Text>
              ) : (
                <Text selectable style={styles.silentCommandText}>
                  {isRunning ? "Waiting for output…" : "The call returned no output."}
                </Text>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
