import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import { Glyph } from "./glyph";
import { Rotate } from "./motion";
import { PulseDot } from "./pulse-dot";
import { radius } from "./theme-tokens";
import { unselectable } from "./selection";
import type { ExtendedThemeTokens } from "./theme-tokens";
import type { ToolCalloutData } from "../../shared/contracts";

/**
 * A brief's status belongs to the spawned agent, not to the spawn call, so it
 * reads on the same three colours the card header uses and stays muted for
 * anything else the hub may report later.
 */
function subagentTone(status: string, tokens: ExtendedThemeTokens): { fg: string; bg: string } {
  if (status === "running") return { fg: tokens.accent, bg: tokens.accentBg };
  if (status === "completed") return { fg: tokens.success, bg: tokens.successBg };
  if (status === "failed") return { fg: tokens.danger, bg: tokens.dangerBg };
  return { fg: tokens.foregroundMuted, bg: tokens.surface2 };
}

/** The agent type always shows; the status only once the batch reports one. */
function SubagentChips({
  agent,
  tokens,
  styles,
}: {
  agent: { agentType: string; status?: string };
  tokens: ExtendedThemeTokens;
  styles: SubagentStyles;
}) {
  const status = agent.status;
  const tone = status ? subagentTone(status, tokens) : undefined;

  return (
    <>
      <Text selectable style={[styles.chip, styles.typeChip]}>
        {agent.agentType}
      </Text>
      {status && tone ? (
        <Text selectable style={[styles.chip, { color: tone.fg, backgroundColor: tone.bg }]}>
          {status}
        </Text>
      ) : null}
    </>
  );
}

/**
 * One `task` call spawns a batch, so the card reads as a roster: one row per
 * brief, every brief clamped to two lines, and the shared preamble folded away
 * until it is asked for. A brief runs to hundreds of words, and six of them
 * printed whole would bury the rest of the transcript.
 */
export function SubagentBatch({
  batch,
  running,
  tokens,
}: {
  batch: NonNullable<ToolCalloutData["subagent"]>;
  running: boolean;
  tokens: ExtendedThemeTokens;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const styles = useSubagentStyles(tokens);

  const agents = batch.agents;
  const count = agents.length;
  // A batch of one is a single delegation rather than a list, so its name
  // leads the header and the row below carries the brief on its own.
  const only = count === 1 ? agents[0] : undefined;
  const headline = only ? only.name : count === 0 ? "subagents" : `${count} subagents`;
  const pending =
    count === 0
      ? "spawning subagents…"
      : count === 1
        ? "spawning 1 subagent…"
        : `spawning ${count} subagents…`;

  return (
    <View style={styles.batch}>
      <View style={styles.head}>
        <Glyph name="Bot" size={13} color={tokens.accent} />
        <Text selectable style={styles.headline} numberOfLines={1}>
          {headline}
        </Text>
        {only ? <SubagentChips agent={only} tokens={tokens} styles={styles} /> : null}
      </View>

      {batch.context ? (
        <View style={styles.contextBox}>
          <Pressable
            onPress={() => setContextOpen((previous) => !previous)}
            accessibilityRole="button"
            style={styles.contextToggle}
          >
            <Rotate active={contextOpen}>
              <Glyph name="ChevronDown" size={12} color={tokens.foregroundMuted} />
            </Rotate>
            <Text style={styles.contextLabel}>shared context</Text>
          </Pressable>
          <Text selectable style={styles.contextBody} numberOfLines={contextOpen ? undefined : 2}>
            {batch.context}
          </Text>
        </View>
      ) : null}

      {agents.map((agent, index) => (
        <View key={`${agent.name}-${index}`} style={styles.row}>
          {only ? null : (
            <View style={styles.rowHead}>
              <Text selectable style={styles.name} numberOfLines={1}>
                {agent.name}
              </Text>
              <SubagentChips agent={agent} tokens={tokens} styles={styles} />
            </View>
          )}
          <Text selectable style={styles.brief} numberOfLines={2}>
            {agent.task}
          </Text>
        </View>
      ))}

      {running ? (
        <View style={styles.pending}>
          <PulseDot color={tokens.accent} size={5} />
          <Text style={styles.pendingText}>{pending}</Text>
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------- styles */

interface SubagentStyles {
  batch: ViewStyle;
  head: ViewStyle;
  contextBox: ViewStyle;
  contextToggle: ViewStyle;
  row: ViewStyle;
  rowHead: ViewStyle;
  pending: ViewStyle;
  headline: TextStyle;
  chip: TextStyle;
  typeChip: TextStyle;
  contextLabel: TextStyle;
  contextBody: TextStyle;
  name: TextStyle;
  brief: TextStyle;
  pendingText: TextStyle;
}

function useSubagentStyles(tokens: ExtendedThemeTokens): SubagentStyles {
  return useMemo(
    () =>
      StyleSheet.create({
        batch: {
          padding: 10,
          borderRadius: radius.block,
          backgroundColor: tokens.surface1,
          borderWidth: 1,
          borderColor: tokens.borderSubtle,
          gap: 8,
          ...tokens.boxShadow,
        },
        head: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        headline: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(13),
          fontWeight: "700",
          color: tokens.foreground,
          flexShrink: 1,
        },
        chip: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(10),
          fontWeight: "700",
          textTransform: "lowercase",
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: radius.chip,
        },
        typeChip: {
          color: tokens.foregroundSubtle,
          backgroundColor: tokens.surface2,
        },
        contextBox: {
          gap: 4,
          padding: 8,
          borderRadius: radius.block,
          backgroundColor: tokens.surface0,
        },
        contextToggle: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        contextLabel: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(10),
          fontWeight: "700",
          letterSpacing: 0.4,
          textTransform: "lowercase",
          color: tokens.foregroundSubtle,
          ...unselectable,
        },
        contextBody: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(12),
          lineHeight: tokens.fs(17),
          color: tokens.foregroundSubtle,
        },
        row: {
          gap: 3,
        },
        rowHead: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        name: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(12.5),
          fontWeight: "600",
          color: tokens.foreground,
          flexShrink: 1,
        },
        brief: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(12),
          lineHeight: tokens.fs(16),
          color: tokens.foregroundMuted,
        },
        pending: {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        pendingText: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(11),
          fontWeight: "500",
          color: tokens.accent,
          ...unselectable,
        },
      }),
    [tokens],
  );
}
