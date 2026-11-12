import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginTheme, PluginText, PluginAgentSnapshot } from "@getpaseo/plugin";
import type { AgentRef, ProjectRef } from "@getpaseo/plugin/client";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { messages } from "../messages";
import { isBackgroundAgent, boardSection, compareBoardAgents, lastActivityTime, localDayBounds, runningMinutes, answerMarker, compareWaitingAgents } from "../agent-board-model";

type BoardProps = { theme: PluginTheme; navigation: { openAgent(ref: AgentRef): void } };
export type SidebarViewRegistration = {
  addSidebarView?: (contribution: { id: string; title: PluginText; description: PluginText; Component: React.ComponentType<BoardProps> }) => () => void | Promise<void>;
};

function useToday() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const next = localDayBounds(now).end;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now() + 50));
    return () => clearTimeout(timer);
  }, [now]);
  return localDayBounds(now);
}

function AgentRow({ agentRef, section, theme, navigation }: BoardProps & { agentRef: AgentRef; section: "running" | "finished" }) {
  const agent = pluginClient.useAgent(agentRef);
  const { t } = pluginClient.useTranslation(messages);
  if (!agent) return null;
  const startedAt: string | undefined = undefined; // createdAt is agent creation, not this run start (PM ruling 2026-11-12; see #470)
  const minutes = runningMinutes(startedAt, Date.now());
  return (
    <Pressable accessibilityRole="button" onPress={() => navigation.openAgent(agent.ref)} style={[styles.row, { borderColor: theme.colors.border }]}>
      <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.foreground }]}>{agent.title?.trim() || agent.id.slice(0, 8)}</Text>
      {section === "finished" ? (
        agent.status === "error" ? (
          <Text style={[styles.meta, { color: theme.colors.statusDanger }]}>{[t("sidebar.status.error")]}</Text>
        ) : null
      ) : agent.status === "initializing" ? (
        <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{[t("sidebar.status.initializing")]}</Text>
      ) : (
        <View style={styles.runningMeta}>
          <View style={[styles.pill, { backgroundColor: theme.colors.accent }]}>
            <Text style={[styles.pillText, { color: theme.colors.accentForeground }]}>{["● " + t("sidebar.runningPill")]}</Text>
          </View>
          {minutes === null ? null : (
            <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{[t("sidebar.runningFor").replace("{n}", String(minutes))]}</Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

function ProjectGroup({ projectRef, bounds, ...props }: BoardProps & { projectRef: ProjectRef; bounds: { start: number; end: number } }) {
  const { t } = pluginClient.useTranslation(messages);
  const project = pluginClient.useProject(projectRef);
  const workspaces = pluginClient.useWorkspaces({ where: workspace => workspace.project.key === projectRef.key });
  const workspaceKeys = new Set(workspaces.map(ref => ref.key));
  const groups = pluginClient.useAgents({
    where: agent => workspaceKeys.has(agent.workspace.key) && !isBackgroundAgent(agent) && boardSection(agent, bounds) !== null,
    groupBy: agent => boardSection(agent, bounds) ?? "",
    orderBy: compareBoardAgents,
  });
  if (!project) return null;
  const running = groups.find(group => group.key === "running")?.items ?? [];
  const finished = groups.find(group => group.key === "finished")?.items ?? [];
  return (
    <View style={styles.project}>
      <Text style={[styles.projectTitle, { color: props.theme.colors.foreground }]}>{project.displayName || project.rootPath}</Text>
      {!running.length && !finished.length && <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.noTodayActivity")}</Text>}
      {([ ["running", running], ["finished", finished] ] as const).map(([section, rows]) => (
        <View key={section} style={styles.section}>
          <Text style={[styles.sectionTitle, { color: props.theme.colors.foregroundMuted }]}>{t(section === "running" ? "sidebar.running" : "sidebar.finished")}</Text>
          {rows.map(ref => <AgentRow key={ref.key} agentRef={ref} section={section} {...props} />)}
        </View>
      ))}
    </View>
  );
}

function TodayBoard(props: BoardProps) {
  const projects = pluginClient.useProjects();
  const bounds = useToday();
  const { t } = pluginClient.useTranslation(messages);
  return (
    <ScrollView contentContainerStyle={styles.board}>
      {projects.length === 0 ? <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.noProjects")}</Text>
        : projects.map(ref => <ProjectGroup key={ref.key} projectRef={ref} bounds={bounds} {...props} />)}
    </ScrollView>
  );
}

function WaitingRow({ agentRef, theme, navigation }: BoardProps & { agentRef: AgentRef }) {
  const agent = pluginClient.useAgent(agentRef.id, snapshot => snapshot);
  if (!agent) return null;
  return <WaitingAgentRow agent={agent} theme={theme} navigation={navigation} />;
}

function WaitingAgentRow({ agent, theme, navigation }: BoardProps & { agent: PluginAgentSnapshot }) {
  const workspaceName = pluginClient.useWorkspace(agent.workspace.id, snapshot => snapshot.name);
  const { t } = pluginClient.useTranslation(messages);
  const marker = answerMarker(agent);
  if (!marker) return null;
  return (
    <Pressable accessibilityRole="button" onPress={() => navigation.openAgent(agent.ref)} style={[styles.row, { borderColor: theme.colors.border }]}>
      <Text numberOfLines={1} style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{workspaceName ?? agent.workspace.id}</Text>
      <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.foreground }]}>{agent.title?.trim() || agent.id.slice(0, 8)}</Text>
      <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{t("sidebar.answeredOf", { answered: marker.answered, total: marker.total })}</Text>
      <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{marker.time === null ? t("sidebar.unknownTime") : new Date(marker.time).toLocaleString()}</Text>
    </Pressable>
  );
}

function WaitingBoard(props: BoardProps) {
  const { t } = pluginClient.useTranslation(messages);
  const groups = pluginClient.useAgents({
    where: agent => answerMarker(agent) !== null,
    groupBy: () => "waiting",
    orderBy: compareWaitingAgents,
  });
  const agents = groups.flatMap(group => group.items);
  return (
    <ScrollView contentContainerStyle={styles.board}>
      {agents.length ? agents.map(ref => <WaitingRow key={ref.key} agentRef={ref} {...props} />)
        : <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.waitingEmpty")}</Text>}
    </ScrollView>
  );
}

export function ClearChatSidebar(props: BoardProps) {
  const [tab, setTab] = useState<"today" | "waiting" | "directory">("today");
  const { t } = pluginClient.useTranslation(messages);
  return (
    <View style={styles.shell}>
      <View accessibilityRole="tablist" style={[styles.tabs, { borderColor: props.theme.colors.border }]}>
        {(["today", "waiting", "directory"] as const).map(name => (
          <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: tab === name }}
            onPress={() => setTab(name)} style={[styles.tab, tab === name && { borderBottomColor: props.theme.colors.accent, borderBottomWidth: 2 }]}>
            <Text style={{ color: tab === name ? props.theme.colors.foreground : props.theme.colors.foregroundMuted }}>{t(`sidebar.${name}`)}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "today" ? <TodayBoard {...props} /> : tab === "waiting" ? <WaitingBoard {...props} /> :
        <Text style={[styles.placeholder, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.directoryEmpty")}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10 },
  placeholder: { padding: 14, fontSize: 12, lineHeight: 18 },
  board: { paddingHorizontal: 14, paddingVertical: 16 },
  project: { marginBottom: 20 },
  projectTitle: { fontSize: 15, fontWeight: "600", marginBottom: 8 },
  section: { marginTop: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "600", marginBottom: 5 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 5 },
  rowTitle: { fontSize: 13, fontWeight: "500" },
  runningMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: "600" },
  meta: { fontSize: 11, marginTop: 3 },
  empty: { fontSize: 12, lineHeight: 18 },
});
