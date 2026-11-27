import React from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { usePaseo, useTranslation, type PluginScreenProps } from "@getpaseo/plugin/client";
import { formatClock, localDateKey } from "../local-day";
import { messages } from "../messages";
import { useMyMessageActions, type MyMessagesComposerHost } from "../my-messages-actions";
import { nowMs } from "../my-messages-clock";
import {
  emptyMessagesScreen,
  type createMyMessagesScreenFeed,
  type MyMessagesScreenRow,
} from "../my-messages-screen-feed";
import { useEnhancerPreferences } from "../preferences";
import { isEmptyMessageText, messagePreview } from "../user-message-kind";
import { MyMessagesRowActions } from "./my-messages-row-actions";
import { buildThemeTokens } from "./theme-tokens";

type Feed = ReturnType<typeof createMyMessagesScreenFeed>;

interface ScreenCapabilities {
  navigation?: {
    openAgent?: (input: { agentId: string; serverId?: string; focusHost?: boolean }) => void;
  };
  composerHost?: MyMessagesComposerHost;
}

export function MyMessagesScreen({ theme, layout, host, navigation, composerHost, feed }: PluginScreenProps & ScreenCapabilities & { feed: Feed }) {
  const { t } = useTranslation(messages);
  const { agents } = usePaseo();
  const agentsRef = React.useRef(agents);
  agentsRef.current = agents;
  const { copy, quote } = useMyMessageActions(t, composerHost);
  const openAgent = typeof navigation?.openAgent === "function" ? navigation.openAgent.bind(navigation) : undefined;
  const preferences = useEnhancerPreferences();
  const tokens = React.useMemo(() => buildThemeTokens(theme.colors, preferences), [theme, preferences]);
  const [state, setState] = React.useState(emptyMessagesScreen);
  const [, observeDay] = React.useState(() => localDateKey(nowMs()));
  const session = React.useRef<ReturnType<Feed["mount"]> | null>(null);

  React.useEffect(() => {
    const mounted = feed.mount({ hostId: host.id, agents: agentsRef.current, publish: setState });
    session.current = mounted;
    return () => {
      session.current = null;
      mounted.stop();
    };
  }, [feed, host.id]);

  // With no clock timer, check on render and on interactions that need not otherwise render.
  const checkDay = () => observeDay(localDateKey(nowMs()));
  const directoryKnown = state.status !== "error" && state.progress !== null;
  const stale = directoryKnown && state.day !== localDateKey(nowMs());
  const unavailableCount = state.unavailable.length;
  const incomplete = state.directoryPartial || state.partial.length > 0 || state.failed.length > 0 || unavailableCount > 0;
  const reading = state.status === "reading";
  const showRetry = !stale && (incomplete || state.status === "error");
  const padding = layout.compact ? 12 : 16;
  const body = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) };
  const muted = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) };
  const warning = { ...muted, color: tokens.warning };
  const button = { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: tokens.border };

  function copyRow(row: MyMessagesScreenRow) {
    checkDay();
    return copy(row.text, isEmptyMessageText(row.text));
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.surface0 }}>
      <View style={{ padding, gap: 8 }}>
        {directoryKnown ? (
          <Text testID="my-messages-screen-summary" style={body}>
            {stale
              ? t("myMessages.screenStale")
              : t("myMessages.screenSummary", { messages: state.rows.length, conversations: state.conversations })}
          </Text>
        ) : null}
        {!stale && reading ? (
          <Text testID="my-messages-screen-progress" style={muted}>
            {state.progress ? t("myMessages.screenProgress", {
              done: Math.min(state.progress.done + 1, state.progress.total), total: state.progress.total,
            }) : t("myMessages.screenLoading")}
          </Text>
        ) : null}
        {showRetry ? (
          <Text testID="my-messages-screen-incomplete" accessibilityRole="alert"
            style={state.status === "error" ? { ...muted, color: tokens.danger } : warning}>
            {state.status === "error" ? t("myMessages.directory") : t("myMessages.screenIncomplete")}
          </Text>
        ) : null}
        {!stale && unavailableCount > 0 ? (
          <Text testID="my-messages-screen-unavailable" accessibilityRole="alert" style={warning}>
            {t("myMessages.screenUnavailable", { count: unavailableCount })}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pressable testID="my-messages-screen-refresh" accessibilityRole="button" style={button}
            onPress={() => { checkDay(); void session.current?.refresh(); }}>
            <Text style={body}>{t("myMessages.screenRefresh")}</Text>
          </Pressable>
          {showRetry ? (
            <Pressable testID="my-messages-screen-retry" accessibilityRole="button" style={button}
              onPress={() => { checkDay(); void session.current?.retry(); }}>
              <Text style={body}>{t("myMessages.retry")}</Text>
            </Pressable>
          ) : null}
        </View>
        {!stale && !incomplete && state.status === "ready" && !state.rows.length ? (
          <Text style={muted}>{t("myMessages.empty")}</Text>
        ) : null}
      </View>
      <FlatList
        testID="my-messages-screen-list"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: padding, paddingBottom: padding, gap: 8 }}
        data={state.rows}
        keyExtractor={row => `${row.agentId}:${row.at}:${row.seq}`}
        onScroll={checkDay}
        scrollEventThrottle={250}
        renderItem={({ item: row }) => {
          const title = row.title?.trim() ? row.title : t("myMessages.screenUntitled");
          const { preview, truncated } = messagePreview(row.text);
          const label = isEmptyMessageText(row.text) ? t("myMessages.imageOnly") : preview + (truncated ? "…" : "");
          const time = formatClock(row.at);
          const openConversation = openAgent && (() => openAgent({ agentId: row.agentId, serverId: host.id }));
          return (
            <View style={{ paddingVertical: 8, paddingHorizontal: layout.compact ? 8 : 10, borderRadius: 8, backgroundColor: tokens.surface1, gap: 4 }}>
              <Pressable
                testID="my-messages-screen-row"
                accessibilityRole="button"
                accessibilityLabel={`${title}, ${time}, ${label}`}
                accessibilityHint={openConversation ? t("myMessages.screenOpenHint") : undefined}
                onPress={() => {
                  if (openConversation) {
                    checkDay();
                    openConversation();
                  } else {
                    void copyRow(row);
                  }
                }}
                style={{ gap: 3 }}
              >
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text style={{ ...muted, flex: 1 }}>{title}</Text>
                  <Text style={muted}>{time}</Text>
                </View>
                <Text style={body} numberOfLines={3}>{label}</Text>
              </Pressable>
              <MyMessagesRowActions
                copyLabel={t("myMessages.copy")}
                quoteLabel={t("myMessages.quote")}
                onCopy={() => { void copyRow(row); }}
                onQuote={() => {
                  checkDay();
                  void quote(row.text, row.agentId, openConversation);
                }}
                labelStyle={muted}
                borderColor={tokens.border}
              />
            </View>
          );
        }}
      />
    </View>
  );
}
