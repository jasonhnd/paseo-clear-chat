import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginTheme, PluginText, PluginAgentSnapshot } from "@getpaseo/plugin";
import type { AgentRef, ProjectRef } from "@getpaseo/plugin/client";
import React, { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { messages } from "../messages";
import { isBackgroundAgent, boardSection, compareBoardAgents, lastActivityTime, localDayBounds, runningMinutes, answerMarker, compareWaitingAgents, finishedClock, observeAgentTime, getObservedAgentTimes } from "../agent-board-model";
import type { ObservedAgentTimeState } from "../agent-board-model";
import { parseOutline, syncOutline } from "../outline-model";
import { useEnhancerPreferences } from "../preferences";

type BoardProps = { theme: PluginTheme; navigation: { openAgent(ref: AgentRef): void }; active?: { agent: AgentRef | null; workspace?: { hostId: string } | null } };
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

type ObservationProps = { observed: ObservedAgentTimeState; setObserved: React.Dispatch<React.SetStateAction<ObservedAgentTimeState>>; bounds: { start: number; end: number } };

function AgentRow({ agentRef, section, theme, navigation, observed, setObserved, bounds }: BoardProps & ObservationProps & { agentRef: AgentRef; section: "running" | "finished" }) {
  const agent = pluginClient.useAgent(agentRef);
  const { t } = pluginClient.useTranslation(messages);
  useEffect(() => {
    if (!agent) return;
    setObserved(previous => observeAgentTime(previous, agentRef.key, { status: agent.status, attentionReason: agent.attentionReason }, Date.now()));
  }, [agentRef.key, agent?.status, agent?.attentionReason]);
  if (!agent) return null;
  const startedAt: string | undefined = undefined; // createdAt is agent creation, not this run start (PM ruling 2026-11-12; see #470)
  const minutes = runningMinutes(startedAt, Date.now());
  const clock = section === "finished" ? finishedClock(getObservedAgentTimes(observed, agentRef.key)?.finishedAt, bounds) : null;
  return (
    <Pressable accessibilityRole="button" onPress={() => navigation.openAgent(agent.ref)} style={[styles.row, { borderColor: theme.colors.border }]}>
      <View style={styles.rowHeading}>
        <Text numberOfLines={1} style={[styles.rowTitle, styles.rowHeadingTitle, { color: theme.colors.foreground }]}>{agent.title?.trim() || agent.id.slice(0, 8)}</Text>
        {clock === null ? null : <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{t("sidebar.finishedAt").replace("{time}", clock)}</Text>}
      </View>
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

function ProjectGroup({ projectRef, bounds, observed, setObserved, ...props }: BoardProps & ObservationProps & { projectRef: ProjectRef }) {
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
          <View style={styles.sectionHeading}>
            <Text style={[styles.sectionTitle, { color: props.theme.colors.foregroundMuted }]}>{t(section === "running" ? "sidebar.running" : "sidebar.finished")}</Text>
            {section === "finished" ? <Text style={[styles.sectionNote, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.finishedAtNote")}</Text> : null}
          </View>
          {rows.map(ref => <AgentRow key={ref.key} agentRef={ref} section={section} bounds={bounds} observed={observed} setObserved={setObserved} {...props} />)}
        </View>
      ))}
    </View>
  );
}

function TodayBoard(props: BoardProps) {
  const projects = pluginClient.useProjects();
  const bounds = useToday();
  const [observed, setObserved] = useState<ObservedAgentTimeState>(() => new Map());
  const { t } = pluginClient.useTranslation(messages);
  return (
    <ScrollView contentContainerStyle={styles.board}>
      {projects.length === 0 ? <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.noProjects")}</Text>
        : projects.map(ref => <ProjectGroup key={ref.key} projectRef={ref} bounds={bounds} observed={observed} setObserved={setObserved} {...props} />)}
    </ScrollView>
  );
}

function WaitingRow({ agentRef, live, theme, navigation }: BoardProps & { agentRef: AgentRef; live?: WaitingLiveAgent }) {
  const agent = pluginClient.useAgent(agentRef, snapshot => snapshot);
  if (!agent) return null;
  return <WaitingAgentRow agent={live ? { ...agent, ...live, ref: agentRef, workspace: agent.workspace } : agent} theme={theme} navigation={navigation} />;
}

function WaitingAgentRow({ agent, theme, navigation }: BoardProps & { agent: PluginAgentSnapshot }) {
  const workspaceName = pluginClient.useWorkspace(agent.workspace, snapshot => snapshot.name);
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

function ErrorRow({ agentRef, theme, navigation }: BoardProps & { agentRef: AgentRef }) {
  const agent = pluginClient.useAgent(agentRef, snapshot => snapshot);
  if (!agent || agent.status !== "error") return null;
  return <ErrorAgentRow agent={agent} theme={theme} navigation={navigation} />;
}

function ErrorAgentRow({ agent, theme, navigation }: BoardProps & { agent: PluginAgentSnapshot }) {
  const workspaceName = pluginClient.useWorkspace(agent.workspace, snapshot => snapshot.name);
  const { t } = pluginClient.useTranslation(messages);
  return (
    <Pressable accessibilityRole="button" onPress={() => navigation.openAgent(agent.ref)} style={[styles.row, { borderColor: theme.colors.border }]}>
      <Text numberOfLines={1} style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{workspaceName ?? agent.workspace.id}</Text>
      <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.foreground }]}>{agent.title?.trim() || agent.id.slice(0, 8)}</Text>
      <Text style={[styles.meta, { color: theme.colors.statusDanger }]}>{t("sidebar.status.error")}</Text>
    </Pressable>
  );
}

type WaitingLiveAgent = Pick<PluginAgentSnapshot, "id" | "title" | "metadata">;

function WaitingBoard(props: BoardProps) {
  const { t } = pluginClient.useTranslation(messages);
  const groups = pluginClient.useAgents({
    where: agent => answerMarker(agent) !== null,
    groupBy: () => "waiting",
    orderBy: compareWaitingAgents,
  });
  const errors = pluginClient.useAgents({
    where: agent => agent.status === "error",
    groupBy: () => "error",
    orderBy: compareWaitingAgents,
  }).flatMap(group => group.items);
  const candidates = pluginClient.useAgents({
    where: agent => !isBackgroundAgent(agent),
    groupBy: () => "waiting",
    orderBy: compareWaitingAgents,
  }).flatMap(group => group.items);
  const { usePaseo: usePaseoHook, useHosts: useHostsHook }: {
    usePaseo?: typeof pluginClient.usePaseo; useHosts?: typeof pluginClient.useHosts;
  } = pluginClient;
  const paseo = usePaseoHook ? usePaseoHook() : null;
  const hosts = useHostsHook ? useHostsHook() : [];
  const [state, setLive] = useState<Record<string, WaitingLiveAgent | null>>({});
  // The candidate and host hooks may return new arrays on every render.
  const candidateKey = JSON.stringify(candidates.map(ref => [ref.id, ref.hostId, ref.key]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const hostKey = JSON.stringify(hosts.map(host => [host.serverId, host.status]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  useEffect(() => {
    if (!paseo || !useHostsHook) return;
    let cancelled = false;
    const unique = new Map(candidates.map(ref => [ref.id, ref]));
    const skipped: Record<string, null> = {};
    for (const ref of unique.values()) {
      if (!hosts.some(host => host.serverId === ref.hostId && host.status === "online")) skipped[ref.id] = null;
    }
    setLive(skipped);
    for (const ref of unique.values()) {
      const serverId = hosts.find(host => host.serverId === ref.hostId && host.status === "online")?.serverId;
      if (!serverId) continue;
      void (async () => {
        try {
          const fresh = await paseo.agents.ref(ref).refresh();
          if (cancelled || !fresh?.agent) return;
          const agent = { id: ref.id, title: fresh.agent.title, metadata: fresh.agent.metadata ?? {} };
          setLive(previous => ({ ...previous, [ref.id]: agent }));
        } catch {
          // A failed refresh leaves this agent's snapshot in place.
        }
      })();
    }
    return () => { cancelled = true; };
  }, [paseo, candidateKey, hostKey]);
  const live = state && typeof state === "object" ? state : {};
  const snapshots = [...new Map(groups.flatMap(group => group.items).map(ref => [ref.id, ref])).values()];
  const snapshotIds = new Set(snapshots.map(ref => ref.id));
  const refs = new Map(candidates.map(ref => [ref.id, ref]));
  const rows = snapshots.filter(ref => { const fresh = live[ref.id]; return !fresh || answerMarker(fresh) !== null; });
  const extras = Object.values(live).filter((agent): agent is WaitingLiveAgent => !!agent && !snapshotIds.has(agent.id) && refs.has(agent.id) && answerMarker(agent) !== null)
    .sort(compareWaitingAgents).map(agent => refs.get(agent.id)!);
  const agents = [...rows, ...extras];
  return (
    <ScrollView contentContainerStyle={styles.board}>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.waiting")}</Text>
        {agents.length ? agents.map(ref => <WaitingRow key={ref.key} agentRef={ref} live={live[ref.id] ?? undefined} {...props} />)
          : <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.waitingEmpty")}</Text>}
      </View>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.errors")}</Text>
        {errors.length ? errors.map(ref => <ErrorRow key={ref.key} agentRef={ref} {...props} />)
          : <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.errorsEmpty")}</Text>}
      </View>
    </ScrollView>
  );
}

function OutlineForAgent({ agentRef, theme }: { agentRef: AgentRef; theme: PluginTheme }) {
  const hosts = pluginClient.useHosts();
  const snapshot = pluginClient.useAgent(agentRef);
  const { t } = pluginClient.useTranslation(messages);
  const serverId = hosts.find(h => h.serverId === agentRef.hostId)?.serverId;
  const marker = serverId ? parseOutline(snapshot?.metadata?.clearChatOutline) : null;
  useEffect(() => {
    if (!serverId) return;
    let current = true;
    void syncOutline([{ serverId }], agentRef, pluginClient.getPaseoClient, undefined, () => current).catch(() => {});
    return () => { current = false; };
  }, [serverId, agentRef.hostId, agentRef.id, snapshot?.updatedAt]);
  if (!marker?.headings.length) return <Text style={[styles.placeholder, { color: theme.colors.foregroundMuted }]}>{t("sidebar.directoryEmpty")}</Text>;
  return <ScrollView contentContainerStyle={styles.board}>{marker.headings.map((heading, index) =>
    <Text key={`${heading.offset}:${index}`} style={{ color: theme.colors.foreground, paddingLeft: (heading.level - 1) * 12, paddingVertical: 4 }}>{heading.text}</Text>)}</ScrollView>;
}

function OutlineBoard(props: BoardProps) {
  const { t } = pluginClient.useTranslation(messages);
  const agent = props.active?.agent;
  return agent ? <OutlineForAgent agentRef={agent} theme={props.theme} /> :
    <Text style={[styles.placeholder, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.directoryEmpty")}</Text>;
}

function SearchRow({ agentRef, ...props }: BoardProps & { agentRef: AgentRef }) {
  const agent = pluginClient.useAgent(agentRef);
  if (!agent) return null;
  return (
    <Pressable accessibilityRole="button" onPress={() => props.navigation.openAgent(agent.ref)} style={[styles.row, { borderColor: props.theme.colors.border }]}>
      <Text numberOfLines={1} style={[styles.rowTitle, { color: props.theme.colors.foreground }]}>{agent.title?.trim() || agent.id.slice(0, 8)}</Text>
    </Pressable>
  );
}

function SearchBoard(props: BoardProps) {
  const [query, setQuery] = useState("");
  const { t } = pluginClient.useTranslation(messages);
  const hosts = pluginClient.useHosts();
  const hostId = props.active?.agent?.hostId ?? props.active?.workspace?.hostId ?? (hosts.length === 1 ? hosts[0]?.serverId : undefined);
  const needle = query.trim().toLocaleLowerCase();
  const paseo = pluginClient.usePaseo();
  const candidates = pluginClient.useAgents({ where: agent => !!hostId && agent.ref.hostId === hostId });
  const candidateKey = JSON.stringify(candidates.map(ref => [ref.id, ref.hostId, ref.key]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const [loaded, setLoaded] = useState<{ hostId: string; texts: Record<string, string[]>; hasOlder: boolean } | null>(null);
  useEffect(() => {
    if (!hostId) return;
    let current = true;
    setLoaded({ hostId, texts: {}, hasOlder: false });
    for (const ref of candidates) {
      void paseo.agents.ref(ref).timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" }).then(page => {
        if (!current || page.error) return;
        const texts = page.entries.flatMap(({ item }) => "text" in item && typeof item.text === "string" ? [item.text] : []);
        setLoaded(previous => previous?.hostId === hostId
          ? { hostId, texts: { ...previous.texts, [ref.key]: texts }, hasOlder: previous.hasOlder || page.hasOlder === true } : previous);
      }).catch(() => {});
    }
    return () => { current = false; };
  }, [paseo, hostId, candidateKey]);
  const agents = pluginClient.useAgents({
    where: agent => !!hostId && agent.ref.hostId === hostId && !!needle && (
      (agent.title ?? "").toLocaleLowerCase().includes(needle) ||
      (loaded?.hostId === hostId && (loaded.texts[agent.ref.key] ?? []).some(text => text.toLocaleLowerCase().includes(needle)))
    ),
  });
  const limitKey = loaded && loaded.hostId === hostId && loaded.hasOlder ? "sidebar.searchLimitOlder" : "sidebar.searchLimit";
  const translatedLimit = t(limitKey);
  const searchLimit = limitKey === "sidebar.searchLimitOlder" && translatedLimit === limitKey
    ? messages.resources.en.sidebar.searchLimitOlder : translatedLimit;
  return (
    <ScrollView contentContainerStyle={styles.board} keyboardShouldPersistTaps="handled">
      <TextInput value={query} onChangeText={setQuery} placeholder={t("sidebar.searchPlaceholder")}
        placeholderTextColor={props.theme.colors.foregroundMuted} accessibilityLabel={t("sidebar.search")}
        style={[styles.searchInput, { borderColor: props.theme.colors.border, color: props.theme.colors.foreground }]} />
      <Text style={[styles.searchLimit, { color: props.theme.colors.foregroundMuted }]}>{searchLimit}</Text>
      {needle && (agents.length ? agents.map(ref => <SearchRow key={ref.key} agentRef={ref} {...props} />)
        : <Text style={[styles.empty, { color: props.theme.colors.foregroundMuted }]}>{t("sidebar.searchEmpty")}</Text>)}
    </ScrollView>
  );
}

export function ClearChatSidebar(props: BoardProps) {
  const [tab, setTab] = useState<"today" | "waiting" | "directory" | "search">("today");
  const { t } = pluginClient.useTranslation(messages);
  const agentId = props.active?.agent?.id ?? "";
  const composers = pluginClient.useComposers({ agentId: agentId || "no-agent" });
  const composer = composers[0];
  const { savedReplies } = useEnhancerPreferences();
  return (
    <View style={styles.shell}>
      <View accessibilityRole="tablist" style={[styles.tabs, { borderColor: props.theme.colors.border }]}>
        {(["today", "waiting", "directory", "search"] as const).map(name => (
          <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: tab === name }}
            onPress={() => setTab(name)} style={[styles.tab, tab === name && { borderBottomColor: props.theme.colors.accent, borderBottomWidth: 2 }]}>
            <Text style={{ color: tab === name ? props.theme.colors.foreground : props.theme.colors.foregroundMuted }}>{t(`sidebar.${name}`)}</Text>
          </Pressable>
        ))}
      </View>
      {savedReplies.length > 0 ? <ScrollView horizontal accessibilityLabel={t("answerStyle.savedRepliesLabel")} style={styles.savedRepliesScroll} contentContainerStyle={styles.savedReplies}>
        {savedReplies.map((phrase, index) => <Pressable key={index} testID={`sidebar-saved-reply-${index}`}
          accessibilityRole="button" accessibilityLabel={phrase} disabled={!agentId || !composer || !phrase}
          {...(Platform.OS === "web" && agentId && composer && phrase ? { onMouseDown: (event: React.MouseEvent) => event.preventDefault() } : {})}
          onPress={() => { if (agentId && composer && phrase) composer.insertText(phrase); }}
          style={[styles.savedReply, { borderColor: props.theme.colors.border }]}>
          <Text style={{ color: props.theme.colors.foreground }}>{phrase}</Text>
        </Pressable>)}
      </ScrollView> : null}
      {tab === "today" ? <TodayBoard {...props} /> : tab === "waiting" ? <WaitingBoard {...props} /> :
        tab === "directory" ? <OutlineBoard {...props} /> : <SearchBoard {...props} />}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10 },
  savedRepliesScroll: { flexGrow: 0, maxHeight: 64 },
  savedReplies: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  savedReply: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderRadius: 18 },
  placeholder: { padding: 14, fontSize: 12, lineHeight: 18 },
  board: { paddingHorizontal: 14, paddingVertical: 16 },
  project: { marginBottom: 20 },
  projectTitle: { fontSize: 15, fontWeight: "600", marginBottom: 8 },
  section: { marginTop: 8 },
  sectionHeading: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "600", marginBottom: 5 },
  sectionNote: { fontSize: 11, marginBottom: 5, flexShrink: 1 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 5 },
  rowTitle: { fontSize: 13, fontWeight: "500" },
  rowHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowHeadingTitle: { flex: 1 },
  runningMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: "600" },
  meta: { fontSize: 11, marginTop: 3 },
  empty: { fontSize: 12, lineHeight: 18 },
  searchInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  searchLimit: { fontSize: 11, lineHeight: 16, marginTop: 6, marginBottom: 12 },
});
