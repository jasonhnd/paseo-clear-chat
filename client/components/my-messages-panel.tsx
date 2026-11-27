import React from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { usePaseo, useTranslation } from "@getpaseo/plugin/client";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useMyMessageActions, type MyMessagesComposerHost } from "../my-messages-actions";
import { acquireMyMessagesFeed, useMyMessages } from "../my-messages-feed";
import { localDateKey } from "../local-day";
import { nowMs } from "../my-messages-clock";
import type { MyMessageRow } from "../my-messages-store";
import { messages } from "../messages";
import { useEnhancerPreferences } from "../preferences";
import { MyMessagesRowActions } from "./my-messages-row-actions";
import { buildThemeTokens } from "./theme-tokens";

interface MyMessagesFeedHandle {
  retry(): void;
  stop(): void;
}

export function createMyMessagesPanel(composerHost: MyMessagesComposerHost) {
  return function RegisteredMyMessagesPanel(props: PluginAgentPanelProps) {
    return <MyMessagesPanel {...props} composerHost={composerHost} />;
  };
}

/**
 * "What I said": today's counts at the top, then the person's own messages, newest first.
 *
 * The panel draws beside the conversation in a host tab, so it owns its scroll container and
 * keeps no timeline spacing. The rows are a virtualized list: an open panel may keep a long
 * day on screen without drawing every row of it.
 *
 * What the panel says when something is missing:
 * - a day that was only partly read says so, and Try again reads further;
 * - counts that belong to an earlier day are marked stale and offer the same Try again;
 * - a day that could not be read at all says so and offers the same Try again;
 * - a timeline subscription that stopped delivering says the list may be out of date.
 *
 * A row press copies the original message without navigating away.
 */
export function MyMessagesPanel(props: PluginAgentPanelProps & { composerHost?: MyMessagesComposerHost }) {
  const { t } = useTranslation(messages);
  const paseo = usePaseo();
  const { copy, quote } = useMyMessageActions(t, props.composerHost);
  const preferences = useEnhancerPreferences();
  const tokens = React.useMemo(() => buildThemeTokens(props.theme.colors, preferences), [props.theme, preferences]);
  // `params.agentId` is the current field; the flat `agentId` is the host's deprecated copy.
  const agentId = props.params?.agentId ?? props.agentId;
  const compact = props.layout?.compact === true;
  const state = useMyMessages(agentId ?? "");
  const feed = React.useRef<MyMessagesFeedHandle | null>(null);
  // The host's API object is stable; holding it in a ref keeps a host that hands back a new
  // wrapper from restarting the feed on every render.
  const paseoRef = React.useRef(paseo);
  paseoRef.current = paseo;

  React.useEffect(() => {
    if (!agentId) return undefined;
    // One reference-counted feed per conversation: a second mount of this panel shares it,
    // and the last one to close releases the subscription and forgets the rows.
    const started = acquireMyMessagesFeed({ agentId, client: paseoRef.current });
    feed.current = started;
    return () => {
      feed.current = null;
      started.stop();
    };
  }, [agentId]);

  const bodyText = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) };
  const mutedText = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) };
  const retryStyle = { alignSelf: "flex-start" as const, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: tokens.border };
  // Compare with the current clock even if the rollover read has not finished yet.
  const stale = state.day !== "" && state.day !== localDateKey(nowMs());
  const liveStopped = state.status === "ready" && state.offline;
  const needsRetry = stale || state.status === "error" || state.partial || liveStopped;

  const header = (
    <>
      {state.day !== "" ? (
        <Text testID="my-messages-summary" style={{ ...mutedText, fontSize: tokens.fs(13) }} accessibilityRole="header">
          {stale
            ? t("myMessages.stale")
            : t("myMessages.summary", { machine: state.machineToday, human: state.humanToday })}
        </Text>
      ) : null}
      {!stale && state.partial ? (
        <Text testID="my-messages-partial" style={{ ...mutedText, color: tokens.warning }}>{t("myMessages.partial")}</Text>
      ) : null}
      {state.status === "error" ? (
        <Text testID="my-messages-error" style={{ ...bodyText, color: tokens.danger }} accessibilityRole="alert">
          {t("myMessages.error")}
        </Text>
      ) : null}
      {liveStopped ? (
        <Text testID="my-messages-live-error" style={{ ...bodyText, color: tokens.warning }} accessibilityRole="alert">
          {t("myMessages.liveStopped")}
        </Text>
      ) : null}
      {needsRetry ? (
        <Pressable
          testID="my-messages-retry"
          accessibilityRole="button"
          onPress={() => feed.current?.retry()}
          style={retryStyle}
        >
          <Text style={mutedText}>{t("myMessages.retry")}</Text>
        </Pressable>
      ) : null}
      {state.status === "loading" && state.rows.length === 0 ? (
        <Text testID="my-messages-loading" style={mutedText}>{t("myMessages.loading")}</Text>
      ) : null}
      {!stale && state.status === "ready" && state.rows.length === 0 ? (
        <Text testID="my-messages-empty" style={mutedText}>{t("myMessages.empty")}</Text>
      ) : null}
    </>
  );

  return (
    <FlatList
      testID="my-messages-panel"
      style={{ flex: 1, backgroundColor: tokens.surface0 }}
      contentContainerStyle={{ paddingHorizontal: compact ? 12 : 16, paddingVertical: compact ? 10 : 16, gap: 8 }}
      data={stale ? [] : state.rows}
      keyExtractor={row => row.key}
      ListHeaderComponent={header}
      renderItem={({ item: row }: { item: MyMessageRow }) => {
        const copyRow = () => { void copy(row.text, row.empty); };
        return (
          <View style={{ paddingVertical: 6, paddingHorizontal: compact ? 8 : 10, borderRadius: 8, backgroundColor: tokens.surface1, gap: 4 }}>
            <Pressable
              testID="my-message-row"
              accessibilityRole="button"
              accessibilityLabel={row.empty ? t("myMessages.imageOnly") : row.preview}
              onPress={copyRow}
              style={{ gap: 2 }}
            >
              <Text style={{ ...mutedText, fontSize: tokens.fs(11) }}>
                {row.time}
              </Text>
              <Text style={bodyText} numberOfLines={3}>
                {row.empty ? t("myMessages.imageOnly") : row.preview}
                {row.truncated ? "…" : ""}
              </Text>
            </Pressable>
            <MyMessagesRowActions
              copyLabel={t("myMessages.copy")}
              quoteLabel={t("myMessages.quote")}
              onCopy={copyRow}
              onQuote={() => { void quote(row.text, agentId); }}
              labelStyle={mutedText}
              borderColor={tokens.border}
            />
          </View>
        );
      }}
    />
  );
}
