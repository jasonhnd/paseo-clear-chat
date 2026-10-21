import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ToolCalloutData } from "../../shared/contracts";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { openLink } from "./open-link";
import { TaskList } from "./task-list";
import { preview } from "../tool-detail";
import { ToolOutput } from "./tool-output";

export function hasToolDetailBody(data: ToolCalloutData): boolean {
  return Boolean(data.skill) || ["search", "fetch", "web_search", "plan", "todo", "plain_text", "unknown"].includes(data.tool);
}

export function ToolDetailBody({ data, tokens, onRevealPath }: {
  data: ToolCalloutData;
  tokens: ExtendedThemeTokens;
  onRevealPath?: (path: string) => void;
}) {
  const styles = StyleSheet.create({
    body: { gap: 8 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    key: { fontFamily: tokens.fontUi, fontSize: tokens.fs(11), color: tokens.foregroundSubtle },
    text: { fontFamily: tokens.fontMono, fontSize: tokens.fs(12), lineHeight: tokens.fs(18), color: tokens.foreground, flexShrink: 1 },
    title: { fontFamily: tokens.fontUi, fontSize: tokens.fs(13), fontWeight: "600", color: tokens.foreground },
    link: { fontFamily: tokens.fontMono, fontSize: tokens.fs(12), color: tokens.accent, flexShrink: 1 },
    result: { gap: 3, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: tokens.borderSubtle },
  });
  const empty = <Text selectable style={styles.key}>{`No output. Status: ${data.status}.`}</Text>;

  if (data.skill) return (
    <View style={styles.body}>
      <Text selectable style={styles.title}>{`Skill: ${data.skill.name}`}</Text>
      {data.skill.text?.trim() ? <ToolOutput text={data.skill.text} tokens={tokens}>{shown => <Text selectable style={styles.text}>{shown}</Text>}</ToolOutput> : empty}
    </View>
  );

  if (data.tool === "plan" || data.tool === "todo") return (
    <View style={styles.body}>
      <TaskList data={data.checklist ?? { id: data.id, phaseName: data.title, tasks: [] }} tokens={tokens} />
      {!data.checklist?.tasks.length ? <Text selectable style={styles.key}>{`No tasks reported. Status: ${data.status}.`}</Text> : null}
    </View>
  );

  if (data.tool === "plain_text") return (
    <View style={styles.body}>
      {data.plainText?.trim() ? <ToolOutput text={data.plainText} tokens={tokens}>{shown => <Text selectable style={styles.text}>{shown}</Text>}</ToolOutput> : empty}
    </View>
  );

  if (data.tool === "search" || data.tool === "web_search") return (
    <View style={styles.body}>
      <Text selectable style={styles.text}>{`Query: ${data.search?.query || "Not reported"}`}</Text>
      <Text selectable style={styles.key}>{`Scope: ${data.search?.scope || (data.tool === "web_search" ? "Web" : "Workspace")}`}</Text>
      <Text selectable style={styles.key}>{`Matches: ${data.search?.count ?? 0}${data.search?.truncated ? " (truncated)" : ""}`}</Text>
      {data.search?.results.map((row, index) => (
        <Pressable
          key={`${row.label}-${index}`}
          style={styles.result}
          accessibilityRole={row.url || row.path ? "link" : undefined}
          accessibilityLabel={`Open ${row.url ?? row.path ?? row.label}`}
          onPress={() => row.url ? openLink(row.url) : onRevealPath?.(row.path ?? ".")}
        >
          <Text selectable style={styles.link} numberOfLines={1}>{row.label}</Text>
          {row.url && row.url !== row.label ? <Text selectable style={styles.link}>{row.url}</Text> : null}
          {row.preview ? <Text selectable style={styles.text}>{preview(row.preview, 5).text}</Text> : null}
        </Pressable>
      ))}
      {data.search?.preview && data.search.results.length > 0 ? <Text selectable style={styles.text}>{data.search.preview}</Text> : null}
      {!data.search?.results.length && data.fetch ? <FetchPreview data={data.fetch} tokens={tokens} status={data.status} /> : null}
      {!data.search?.results.length && !data.fetch ? (
        <Text selectable style={styles.key}>{data.status === "running" ? "Searching…" : "No results reported."}</Text>
      ) : null}
    </View>
  );

  if (data.tool === "fetch") return <FetchPreview data={data.fetch} tokens={tokens} status={data.status} />;

  return (
    <View testID="tool-generic-content" style={styles.body}>
      {data.fallback?.parameters.map((parameter) => (
        <View key={parameter.name} style={styles.row}>
          <Text selectable style={styles.key}>{`${parameter.name}:`}</Text>
          <ToolOutput text={parameter.value} tokens={tokens}>{shown => <Text selectable style={styles.text}>{shown}</Text>}</ToolOutput>
        </View>
      ))}
      {data.fallback?.output ? <ToolOutput text={data.fallback.output} tokens={tokens}>{shown => <Text selectable style={styles.text}>{shown}</Text>}</ToolOutput> : empty}
    </View>
  );
}

function FetchPreview({ data, tokens, status }: {
  data: ToolCalloutData["fetch"];
  tokens: ExtendedThemeTokens;
  status?: ToolCalloutData["status"];
}) {
  const text = { fontFamily: tokens.fontMono, fontSize: tokens.fs(12), lineHeight: tokens.fs(18), color: tokens.foreground };
  return (
    <View style={{ gap: 6 }}>
      {data?.url ? (
        <Pressable accessibilityRole="link" accessibilityLabel={`Open ${data.url}`} onPress={() => openLink(data.url!)}>
          <Text selectable style={[text, { color: tokens.accent }]}>{data.url}</Text>
        </Pressable>
      ) : null}
      {data?.query ? <Text selectable style={text}>{`Query: ${data.query}`}</Text> : null}
      {data?.title ? <Text selectable style={[text, { fontWeight: "600" }]}>{data.title}</Text> : null}
      <Text selectable style={text}>{data?.preview || `No content reported. Status: ${status ?? "completed"}.`}</Text>
    </View>
  );
}
