import React from "react";
import { FlatList, Pressable, Text } from "react-native";
import { usePaseo, useTranslation } from "@getpaseo/plugin/client";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { acquireMyMessagesFeed, useMyMessages } from "../my-messages-feed";
import type { MyMessageRow } from "../my-messages-store";
import { messages } from "../messages";
import { useEnhancerPreferences } from "../preferences";
import { buildThemeTokens } from "./theme-tokens";

interface MyMessagesFeedHandle {
  loadEarlier(): Promise<void>;
  retry(): void;
  stop(): void;
}

/**
 * "What I said": today's counts at the top, then the person's own messages, newest first.
 *
 * The panel draws beside the conversation in a host tab, so it owns its scroll container and
 * keeps no timeline spacing. The rows are a virtualized list: an open panel may keep a long
 * day on screen without drawing every row of it. A row opens nothing, it copies the whole
 * message and says so.
 *
 * What the panel says when something is missing:
 * - a day an Earlier press could not read is named, and Try again finishes that day;
 * - a window that could not be read at all says so and offers the same Try again;
 * - a timeline subscription that stopped delivering says the list may be out of date.
 *
 * No jump to the original message: the plugin API has no scroll-to-message surface, and a
 * panel that reached into the host's own list would break on the next host release. The row
 * press is the one place a future jump would be added.
 */
export function MyMessagesPanel(props: PluginAgentPanelProps) {
  const { t } = useTranslation(messages);
  const paseo = usePaseo();
  const toast = useToast();
  const preferences = useEnhancerPreferences();
  const tokens = React.useMemo(() => buildThemeTokens(props.theme.colors, preferences), [props.theme, preferences]);
  // `params.agentId` is the current field; the flat `agentId` is the host's deprecated copy.
  const agentId = props.params?.agentId ?? props.agentId;
  const compact = props.layout?.compact === true;
  const state = useMyMessages(agentId ?? "");
  const feed = React.useRef<MyMessagesFeedHandle | null>(null);
  // The toast API is read through a ref so a row press never depends on a stale render.
  const toastRef = React.useRef(toast);
  toastRef.current = toast;
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

  /**
   * The whole row press: copy the message and confirm it. Everything a future jump to the
   * original message would need belongs here and nowhere else.
   */
  const openMessage = React.useCallback((row: MyMessageRow) => {
    if (row.empty) {
      toastRef.current.show(t("myMessages.noText"), { variant: "info" });
      return;
    }
    void copyText(row.text).then(() => {
      toastRef.current.show(t("myMessages.copied"), { variant: "success" });
    }).catch(() => {
      toastRef.current.error(t("myMessages.copyFailed"));
    });
  }, [t]);

  const bodyText = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) };
  const mutedText = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) };
  const retryStyle = { alignSelf: "flex-start" as const, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: tokens.border };
  // A pending day is a calendar date (`YYYY-MM-DD`), so the label never drifts across midnight.
  const dayLabel = (key: string) => {
    const [, month, day] = key.split("-");
    return `${Number(month)}/${Number(day)}`;
  };
  const needsRetry = state.status === "error" || state.pendingDay !== null || state.partial
    || (state.status === "ready" && !state.live);

  const header = (
    <>
      <Text testID="my-messages-summary" style={{ ...mutedText, fontSize: tokens.fs(13) }} accessibilityRole="header">
        {state.stale
          ? t("myMessages.stale")
          : t("myMessages.summary", { machine: state.machineToday, human: state.humanToday })}
      </Text>
      {state.pendingDay !== null ? (
        <Text testID="my-messages-partial" style={{ ...mutedText, color: tokens.warning }}>
          {t("myMessages.partialDay", { date: dayLabel(state.pendingDay) })}
        </Text>
      ) : state.partial ? (
        <Text testID="my-messages-partial" style={{ ...mutedText, color: tokens.warning }}>{t("myMessages.partial")}</Text>
      ) : null}
      {state.status === "error" ? (
        <Text testID="my-messages-error" style={{ ...bodyText, color: tokens.danger }} accessibilityRole="alert">
          {t("myMessages.error")}
        </Text>
      ) : null}
      {state.status === "ready" && !state.live ? (
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
      {state.status === "ready" && state.rows.length === 0 ? (
        <Text testID="my-messages-empty" style={mutedText}>{t("myMessages.empty")}</Text>
      ) : null}
    </>
  );

  const footer = state.hasEarlier ? (
    <Pressable
      testID="my-messages-earlier"
      accessibilityRole="button"
      accessibilityState={{ disabled: state.earlierBusy }}
      disabled={state.earlierBusy}
      onPress={() => { void feed.current?.loadEarlier(); }}
      style={{ paddingVertical: 8, alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: tokens.borderSubtle, opacity: state.earlierBusy ? 0.5 : 1 }}
    >
      <Text style={mutedText}>{state.earlierBusy ? t("myMessages.loadingEarlier") : t("myMessages.earlier")}</Text>
    </Pressable>
  ) : null;

  return (
    <FlatList
      testID="my-messages-panel"
      style={{ flex: 1, backgroundColor: tokens.surface0 }}
      contentContainerStyle={{ paddingHorizontal: compact ? 12 : 16, paddingVertical: compact ? 10 : 16, gap: 8 }}
      data={state.rows}
      keyExtractor={row => row.key}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      extraData={`${state.earlierBusy}:${state.pendingDay}:${state.partial}:${state.live}:${state.stale}:${state.status}`}
      renderItem={({ item: row }: { item: MyMessageRow }) => (
        <Pressable
          testID="my-message-row"
          accessibilityRole="button"
          accessibilityLabel={row.empty ? t("myMessages.imageOnly") : row.preview}
          onPress={() => openMessage(row)}
          style={{ paddingVertical: 6, paddingHorizontal: compact ? 8 : 10, borderRadius: 8, backgroundColor: tokens.surface1, gap: 2 }}
        >
          <Text style={{ ...mutedText, fontSize: tokens.fs(11) }}>
            {row.day === state.day ? row.time : `${dayLabel(row.day)} ${row.time}`}
          </Text>
          <Text style={bodyText} numberOfLines={3}>
            {row.empty ? t("myMessages.imageOnly") : row.preview}
            {row.truncated ? "…" : ""}
          </Text>
        </Pressable>
      )}
    />
  );
}
