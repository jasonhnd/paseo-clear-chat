import React from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { usePaseo, useTranslation } from "@getpaseo/plugin/client";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { startMyMessagesFeed, useMyMessages } from "../my-messages-feed";
import type { MyMessageRow } from "../my-messages-store";
import { messages } from "../messages";
import { useEnhancerPreferences } from "../preferences";
import { buildThemeTokens } from "./theme-tokens";

interface MyMessagesFeedHandle {
  loadEarlier(): Promise<void>;
  stop(): void;
}

/**
 * "What I said": today's counts at the top, then the person's own messages, newest first.
 *
 * The panel draws beside the conversation in a host tab, so it owns its scroll container and
 * keeps no timeline spacing. Counts and rows come from the same timeline pages the answer card
 * reads; a row opens nothing, it copies the whole message and says so.
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
    const started = startMyMessagesFeed({ agentId, client: paseoRef.current });
    feed.current = started;
    // Unmounting the panel releases the timeline subscription it opened.
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
    if (!row.text) {
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

  return (
    <ScrollView
      testID="my-messages-panel"
      style={{ flex: 1, backgroundColor: tokens.surface0 }}
      contentContainerStyle={{ paddingHorizontal: compact ? 12 : 16, paddingVertical: compact ? 10 : 16, gap: 8 }}
    >
      <Text testID="my-messages-summary" style={{ ...mutedText, fontSize: tokens.fs(13) }} accessibilityRole="header">
        {t("myMessages.summary", { machine: state.machineToday, human: state.humanToday })}
      </Text>
      {state.status === "error" ? (
        <Text testID="my-messages-error" style={{ ...bodyText, color: tokens.danger }} accessibilityRole="alert">
          {t("myMessages.error")}
        </Text>
      ) : null}
      {state.status === "loading" && state.rows.length === 0 ? (
        <Text testID="my-messages-loading" style={mutedText}>{t("myMessages.loading")}</Text>
      ) : null}
      {state.status === "ready" && state.rows.length === 0 ? (
        <Text testID="my-messages-empty" style={mutedText}>{t("myMessages.empty")}</Text>
      ) : null}
      {state.rows.map(row => (
        <Pressable
          key={row.key}
          testID="my-message-row"
          accessibilityRole="button"
          accessibilityLabel={row.empty ? t("myMessages.imageOnly") : row.preview}
          onPress={() => openMessage(row)}
          style={{ paddingVertical: 6, paddingHorizontal: compact ? 8 : 10, borderRadius: 8, backgroundColor: tokens.surface1, gap: 2 }}
        >
          <Text style={{ ...mutedText, fontSize: tokens.fs(11) }}>{row.time}</Text>
          <Text style={bodyText} numberOfLines={3}>
            {row.empty ? t("myMessages.imageOnly") : row.preview}
            {row.truncated ? "…" : ""}
          </Text>
        </Pressable>
      ))}
      {state.hasEarlier ? (
        <Pressable
          testID="my-messages-earlier"
          accessibilityRole="button"
          onPress={() => { void feed.current?.loadEarlier(); }}
          style={{ paddingVertical: 8, alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: tokens.borderSubtle }}
        >
          <Text style={mutedText}>{t("myMessages.earlier")}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
