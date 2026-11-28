import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ConversationMonthCount, MonthSummary } from "../my-messages-calendar";
import { formatMonthDay } from "../my-messages-calendar-labels";
import type { Translate } from "../translation";
import type { ExtendedThemeTokens } from "./theme-tokens";

/**
 * The calendar's left-column panel: this month's summary and its five busiest conversations.
 *
 * Both read the numbers the grid already shows, so a cell and the summary can never disagree.
 * The ranking comes from the days RPC's per-conversation counts; the one place it can fall
 * short of the cells is a conversation the reader could not reach, and `incomplete` is what
 * says so out loud instead of hiding it.
 *
 * Pressing a conversation filters the day list to it; pressing it again shows every
 * conversation again. The caller owns that state so a month change can clear it.
 */
export interface MonthPanelProps {
  title: string;
  summary: MonthSummary;
  conversations: readonly ConversationMonthCount[];
  filterAgentId: string | null;
  onToggleFilter(agentId: string): void;
  incomplete: boolean;
  /**
   * What the caller knows about this month's per-conversation counts:
   * `complete` — the host ranked the whole month; an empty list is an empty month.
   * `partial` — the ranking is the days the reader opened, or a conversation could not be
   * read; an empty list is "nothing ranked yet", not an empty month.
   * `unavailable` — the host sent no per-conversation counts at all; the list is not a
   * ranking and nothing may be called empty on its strength.
   */
  rankingState: RankingState;
  compact: boolean;
  locale: string;
  tokens: ExtendedThemeTokens;
  t: Translate;
}

export type RankingState = "complete" | "partial" | "unavailable";

interface Stat {
  key: string;
  testID: string;
  labelKey: Parameters<Translate>[0];
  value: string;
}

function formatCount(locale: string, value: number): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

export function MonthPanel({
  title, summary, conversations, filterAgentId, onToggleFilter, incomplete, rankingState, compact, locale, tokens, t,
}: MonthPanelProps) {
  const body = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) };
  const muted = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) };
  const warning = { ...muted, color: tokens.warning };
  const heading = { ...body, fontWeight: "600" as const };
  const stats: Stat[] = [
    {
      key: "total",
      testID: "my-messages-calendar-month-total",
      labelKey: "myMessages.calendar.monthPanelTotal",
      value: formatCount(locale, summary.total),
    },
    {
      key: "days",
      testID: "my-messages-calendar-month-days",
      labelKey: "myMessages.calendar.monthPanelDays",
      value: formatCount(locale, summary.daysWithMessages),
    },
    {
      key: "busiest",
      testID: "my-messages-calendar-month-busiest",
      labelKey: "myMessages.calendar.monthPanelBusiest",
      value: summary.busiestDay === null ? "—"
        : `${formatMonthDay(locale, summary.busiestDay)} · ${formatCount(locale, summary.busiestCount)}`,
    },
    {
      key: "average",
      testID: "my-messages-calendar-month-average",
      labelKey: "myMessages.calendar.monthPanelAverage",
      value: formatCount(locale, Number(summary.dailyAverage.toFixed(1))),
    },
  ];
  const top = conversations;

  const row = (entry: ConversationMonthCount) => {
    const selected = entry.agentId === filterAgentId;
    const title = entry.title?.trim() ? entry.title : t("myMessages.screenUntitled");
    return (
      <Pressable
        key={entry.agentId}
        testID="my-messages-calendar-top-conversation"
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${title}, ${entry.count === 1
          ? t("myMessages.calendar.monthTotalOne")
          : t("myMessages.calendar.monthTotal", { count: entry.count })}`}
        accessibilityHint={t("myMessages.calendar.monthPanelFilterHint")}
        onPress={() => onToggleFilter(entry.agentId)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 5,
          paddingHorizontal: 7,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: selected ? tokens.accent : "transparent",
          backgroundColor: selected ? tokens.surface2 : "transparent",
          maxWidth: compact ? 220 : undefined,
        }}
      >
        <Text style={{ ...body, fontSize: tokens.fs(13), flexShrink: 1 }} numberOfLines={1}>{title}</Text>
        <Text style={muted}>{formatCount(locale, entry.count)}</Text>
      </Pressable>
    );
  };

  return (
    <View
      testID="my-messages-calendar-month-panel"
      style={{
        backgroundColor: tokens.surface1,
        borderWidth: 1,
        borderColor: tokens.borderSubtle,
        borderRadius: 10,
        padding: compact ? 8 : 10,
        gap: compact ? 4 : 6,
      }}
    >
      <Text testID="my-messages-calendar-month-title" style={heading}>
        {title}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: compact ? 12 : 8, rowGap: 2 }}>
        {stats.map(stat => (
          <View key={stat.key} style={{ flexDirection: "row", alignItems: "baseline", gap: 5, width: compact ? undefined : "100%" }}>
            <Text style={muted}>{t(stat.labelKey)}</Text>
            {compact ? null : <View style={{ flex: 1 }} />}
            <Text testID={stat.testID} style={{ ...body, fontSize: tokens.fs(13), fontWeight: "600" }}>
              {stat.value}
            </Text>
          </View>
        ))}
      </View>
      {incomplete ? (
        <Text testID="my-messages-calendar-month-partial" style={warning}>
          {t("myMessages.calendar.monthPanelPartial")}
        </Text>
      ) : null}
      <Text style={{ ...heading, fontSize: tokens.fs(12), marginTop: compact ? 2 : 4 }}>
        {t("myMessages.calendar.monthPanelTop")}
      </Text>
      {top.length === 0 ? (
        rankingState === "complete" ? (
          // Only a complete ranking can call a month empty: no totals, no unread
          // conversation, nothing missing from the list.
          <Text testID="my-messages-calendar-month-empty" style={muted}>
            {t("myMessages.calendar.monthPanelEmpty")}
          </Text>
        ) : rankingState === "partial" ? (
          // The month was not read whole and nothing is ranked yet: that is not an empty
          // month, and the may-be-incomplete line above is not a substitute for saying so.
          <Text testID="my-messages-calendar-month-partial-ranking" style={muted}>
            {t("myMessages.calendar.monthPanelPartialRanking")}
          </Text>
        ) : (
          // Totals with no per-conversation rows is a host that did not answer the ranking,
          // not a month with nothing in it: the two must not read the same.
          <Text testID="my-messages-calendar-month-no-ranking" style={muted}>
            {t("myMessages.calendar.monthPanelNoRanking")}
          </Text>
        )
      ) : rankingState === "unavailable" ? (
        // The rows exist only because days were opened; without the host's own counts this
        // is a partial ranking, and the may-be-incomplete line above says so.
        <Text testID="my-messages-calendar-month-no-ranking" style={muted}>
          {t("myMessages.calendar.monthPanelNoRanking")}
        </Text>
      ) : null}
      {top.length > 0 ? (
        compact ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 34 }}>
            <View style={{ flexDirection: "row", gap: 6 }}>{top.map(row)}</View>
          </ScrollView>
        ) : (
          <View style={{ gap: 1 }}>{top.map(row)}</View>
        )
      ) : null}
    </View>
  );
}
