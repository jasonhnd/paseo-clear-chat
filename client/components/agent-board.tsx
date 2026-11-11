import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginTheme, PluginText } from "@getpaseo/plugin";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { messages } from "../messages";
import { boardSection, compareBoardAgents, lastActivityTime, localDayBounds } from "../agent-board-model";

// These types describe the 0.16 API while the plugin still develops against 0.13.
type Ref = { readonly key: string; readonly hostId: string; readonly id: string };
type AgentRef = Ref & { readonly kind: "agent" };
type ProjectRef = Ref & { readonly kind: "project" };
type WorkspaceRef = Ref & { readonly kind: "workspace" };
type Agent = { readonly ref: AgentRef; readonly workspace: WorkspaceRef; readonly id: string; readonly title: string | null; readonly status: "initializing" | "idle" | "running" | "error" | "closed"; readonly lastActivityAt: string; readonly updatedAt: string; readonly attentionReason: "finished" | "error" | "permission" | null };
type Workspace = { readonly ref: WorkspaceRef; readonly project: ProjectRef };
type Group<T> = { readonly key: string; readonly items: readonly T[] };
type BoardHooks = {
  useProjects(): readonly ProjectRef[];
  useProject(ref: ProjectRef): { readonly displayName: string; readonly rootPath: string } | null;
  useWorkspaces(query: { where(workspace: Workspace): boolean }): readonly WorkspaceRef[];
  useAgents(query: { where(agent: Agent): boolean; groupBy(agent: Agent): string; orderBy(a: Agent, b: Agent): number }): readonly Group<AgentRef>[];
  useAgent(ref: AgentRef): Agent | null;
};
const boardHooks = pluginClient as unknown as BoardHooks;

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
  const agent = boardHooks.useAgent(agentRef);
  const { t, locale } = pluginClient.useTranslation(messages);
  if (!agent) return null;
  const time = lastActivityTime(agent);
  const displayedTime = Number.isFinite(time) ? new Date(time).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) : t("sidebar.unknownTime");
  return (
    <Pressable accessibilityRole="button" onPress={() => navigation.openAgent(agent.ref)} style={[styles.row, { borderColor: theme.colors.border }]}>
      <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.foreground }]}>{agent.title?.trim() || agent.id.slice(0, 8)}</Text>
      {section === "finished" && agent.status !== "error" ? null : (
        <Text style={[styles.meta, { color: agent.status === "error" ? theme.colors.statusDanger : theme.colors.foregroundMuted }]}>
          {[section === "finished" ? t("sidebar.status.error") : `${t(`sidebar.status.${agent.status}`)} · ${displayedTime}`]}
        </Text>
      )}
    </Pressable>
  );
}

function ProjectGroup({ projectRef, bounds, ...props }: BoardProps & { projectRef: ProjectRef; bounds: { start: number; end: number } }) {
  const { t } = pluginClient.useTranslation(messages);
  const project = boardHooks.useProject(projectRef);
  const workspaces = boardHooks.useWorkspaces({ where: workspace => workspace.project.key === projectRef.key });
  const workspaceKeys = new Set(workspaces.map(ref => ref.key));
  const groups = boardHooks.useAgents({
    where: agent => workspaceKeys.has(agent.workspace.key) && boardSection(agent, bounds) !== null,
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
  const projects = boardHooks.useProjects();
  const bounds = useToday();
  const { t } = pluginClient.useTranslation(messages);
  return (
    <ScrollView contentContainerStyle={styles.board}>
      {projects.length === 0 ? <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.noProjects")}</Text>
        : projects.map(ref => <ProjectGroup key={ref.key} projectRef={ref} bounds={bounds} {...props} />)}
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
      {tab === "today" ? <TodayBoard {...props} /> :
        <Text style={[styles.placeholder, { color: props.theme.colors.foregroundMuted }]}>{t(tab === "waiting" ? "sidebar.waitingEmpty" : "sidebar.directoryEmpty")}</Text>}
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
  meta: { fontSize: 11, marginTop: 3 },
  empty: { fontSize: 12, lineHeight: 18 },
});
