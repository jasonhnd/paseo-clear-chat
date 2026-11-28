import React from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation, type PluginScreenProps } from "@getpaseo/plugin/client";
import { formatClock, localDateKey } from "../../shared/local-day";
import { messages } from "../messages";
import { useMyMessageActions, type MyMessagesComposerHost } from "../my-messages-actions";
import {
  addDays,
  addMonths,
  buildWeek,
  buildYear,
  monthKeyOfDay,
  monthNumberOfKey,
  monthSummary,
  monthTotals,
  quartileThresholds,
  selectableDay,
  topConversations,
  type DayKey,
  type MonthKey,
} from "../my-messages-calendar";
import { displayedDayCount, type MyMessagesCalendarSnapshot } from "../my-messages-calendar-feed";
import { formatDayLabel, formatMonthTitle, formatWeekRange } from "../my-messages-calendar-labels";
import { nowMs } from "../my-messages-clock";
import { useEnhancerPreferences } from "../preferences";
import { isEmptyMessageText, messagePreview } from "../../shared/user-message-kind";
import { CalendarMonthView, CalendarYearView, buildLevelPalette, emptyCellFill } from "./my-messages-calendar-views";
import { MonthPanel } from "./my-messages-calendar-month-panel";
import { MyMessagesRowActions } from "./my-messages-row-actions";
import { buildThemeTokens } from "./theme-tokens";

export interface CalendarScreenActions {
  select(day: DayKey): void;
  refresh(): void;
  retry(): void;
}

type CalendarProps = PluginScreenProps & {
  snapshot: MyMessagesCalendarSnapshot;
  actions: CalendarScreenActions;
  composerHost?: MyMessagesComposerHost;
};

type CalendarView = "month" | "year";

const LEGEND_SIZE = 12;

export function MyMessagesCalendarScreen({
  theme, layout, host, navigation, composerHost, snapshot, actions,
}: CalendarProps) {
  const { t, locale } = useTranslation(messages);
  const { copy, quote } = useMyMessageActions(t, composerHost);
  const preferences = useEnhancerPreferences();
  const tokens = React.useMemo(() => buildThemeTokens(theme.colors, preferences), [theme, preferences]);
  const palette = React.useMemo(() => buildLevelPalette(tokens), [tokens]);
  const emptyFill = React.useMemo(() => emptyCellFill(tokens, palette), [tokens, palette]);

  const today = localDateKey(nowMs());
  const selectedDay = snapshot.selectedDay;
  const [visibleMonth, setVisibleMonth] = React.useState<MonthKey>(monthKeyOfDay(selectedDay));
  const [year, setYear] = React.useState(() => Number(monthKeyOfDay(selectedDay).slice(0, 4)));
  const [view, setView] = React.useState<CalendarView>("month");
  const [expanded, setExpanded] = React.useState(!layout.compact);
  const [filterAgentId, setFilterAgentId] = React.useState<string | null>(null);

  React.useEffect(() => { setVisibleMonth(monthKeyOfDay(selectedDay)); }, [selectedDay]);

  const padding = layout.compact ? 12 : 16;
  const body = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) };
  const muted = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) };
  const small = { ...muted, fontSize: tokens.fs(11) };
  const warning = { ...muted, color: tokens.warning };
  const button = { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border };
  const arrowButton = layout.compact
    ? { ...button, minWidth: 44, minHeight: 44, alignItems: "center" as const, justifyContent: "center" as const }
    : button;
  const arrowDisabled = { ...arrowButton, opacity: 0.35 };
  const openAgent = typeof navigation?.openAgent === "function" ? navigation.openAgent.bind(navigation) : undefined;

  const detail = snapshot.detail;
  const selectedCount = displayedDayCount(snapshot.days, snapshot.extraDays, selectedDay);
  const countsKnown = snapshot.daysStatus === "ready";
  const displayedDays = React.useMemo(() => {
    const days: Record<DayKey, number> = { ...snapshot.days };
    for (const [day, extra] of Object.entries(snapshot.extraDays)) {
      days[day] = (days[day] ?? 0) + extra;
      if (days[day] <= 0) delete days[day];
    }
    return days;
  }, [snapshot.days, snapshot.extraDays]);
  const dayThresholds = React.useMemo(() => quartileThresholds(Object.values(displayedDays)), [displayedDays]);
  const totalsByMonth = React.useMemo(
    () => monthTotals(Object.entries(displayedDays).map(([day, count]) => ({ day, count }))),
    [displayedDays],
  );
  const months = React.useMemo(
    () => buildYear(year, totalsByMonth, snapshot.firstDay, today),
    [year, totalsByMonth, snapshot.firstDay, today],
  );
  const monthThresholds = React.useMemo(() => quartileThresholds(Object.values(totalsByMonth)), [totalsByMonth]);
  const monthEntries = snapshot.conversationMonths[visibleMonth] ?? [];
  const panelSummary = React.useMemo(
    () => monthSummary(displayedDays, visibleMonth, today),
    [displayedDays, visibleMonth, today],
  );
  const topConversationsThisMonth = React.useMemo(() => topConversations(monthEntries), [monthEntries]);
  const filterEntry = filterAgentId === null
    ? undefined
    : monthEntries.find(entry => entry.agentId === filterAgentId);
  const filterTitle = filterEntry?.title?.trim() ? filterEntry.title : t("myMessages.screenUntitled");
  // The ranking and the totals share the cells' records; a conversation the reader could not
  // reach, a partial directory, or rows only the opened day's fallback found leave both
  // short of the whole month, and the panel says so rather than presenting them as exact.
  const monthIncomplete = snapshot.notices.directoryPartial
    || snapshot.notices.cacheError
    || snapshot.notices.skippedDatabases.length > 0
    || snapshot.slowConversationIds.length > 0
    || Object.values(snapshot.extraDays).some(count => count > 0)
    // Totals with no per-conversation rows means the host did not answer the ranking.
    || (panelSummary.total > 0 && monthEntries.length === 0);
  const showMonthPanel = view === "month" && snapshot.daysStatus === "ready";
  const panelTitle = visibleMonth === monthKeyOfDay(today)
    ? t("myMessages.calendar.monthPanelTitle")
    : formatMonthTitle(locale, visibleMonth);

  const minMonth = monthKeyOfDay(snapshot.firstDay ?? today);
  const maxMonth = monthKeyOfDay(today);
  const minYear = Number(minMonth.slice(0, 4));
  const maxYear = Number(maxMonth.slice(0, 4));
  const weekFirst = snapshot.firstDay ?? today;
  const prevDisabled = view === "year"
    ? year <= minYear
    : layout.compact && !expanded
      ? selectedDay <= weekFirst
      : visibleMonth <= minMonth;
  const nextDisabled = view === "year"
    ? year >= maxYear
    : layout.compact && !expanded
      ? selectedDay >= today
      : visibleMonth >= maxMonth;

  function selectDay(day: DayKey) {
    if (!selectableDay(day, snapshot.firstDay, today)) return;
    if (day === selectedDay) {
      if (layout.compact) setExpanded(false);
      return;
    }
    if (monthKeyOfDay(day) !== visibleMonth) setFilterAgentId(null);
    actions.select(day);
    setVisibleMonth(monthKeyOfDay(day));
    if (layout.compact) setExpanded(false);
  }

  /** The left panel belongs to one month, so every month change drops the filter with it. */
  function showMonth(month: MonthKey) {
    setVisibleMonth(month);
    setFilterAgentId(null);
  }

  function toggleFilter(agentId: string) {
    setFilterAgentId(current => (current === agentId ? null : agentId));
  }

  function goToday() {
    showMonth(monthKeyOfDay(today));
    setView("month");
    if (layout.compact) setExpanded(false);
    actions.select(today);
  }

  function enterMonth(month: MonthKey) {
    setView("month");
    showMonth(month);
    if (layout.compact) setExpanded(true);
    const firstOfMonth = `${month}-01`;
    const firstCandidate = snapshot.firstDay && monthKeyOfDay(snapshot.firstDay) === month
      ? snapshot.firstDay : firstOfMonth;
    const target = month === monthKeyOfDay(today) ? today
      : selectableDay(firstCandidate, snapshot.firstDay, today) ? firstCandidate : selectedDay;
    if (target !== selectedDay) actions.select(target);
  }

  function toggleYearView() {
    if (view === "year") {
      setView("month");
      return;
    }
    setYear(Number(visibleMonth.slice(0, 4)));
    setView("year");
  }

  function stepCalendar(delta: number) {
    if (view === "year") {
      if ((delta < 0 && prevDisabled) || (delta > 0 && nextDisabled)) return;
      setYear(value => Math.min(maxYear, Math.max(minYear, value + delta)));
      return;
    }
    if (layout.compact && !expanded) {
      if ((delta < 0 && prevDisabled) || (delta > 0 && nextDisabled)) return;
      // Stop on the boundary week instead of disabling a week early: a day six days from
      // today is still reachable with the arrow when the selected day is further back.
      const step = addDays(selectedDay, delta * 7);
      selectDay(delta < 0 ? (step < weekFirst ? weekFirst : step) : step > today ? today : step);
      return;
    }
    const next = addMonths(visibleMonth, delta);
    if (next < minMonth || next > maxMonth) return;
    showMonth(next);
  }

  const summary = selectedDay === today
    ? t("myMessages.calendar.todaySummary", { date: formatDayLabel(locale, selectedDay) })
    : detail.status === "ready" && detail.rows.length > 0
      ? detail.conversations === 1
        ? selectedCount === 1
          ? t("myMessages.calendar.daySummarySingle", { date: formatDayLabel(locale, selectedDay) })
          : t("myMessages.calendar.daySummaryOne", {
              date: formatDayLabel(locale, selectedDay), messages: selectedCount, conversations: detail.conversations,
            })
        : t("myMessages.calendar.daySummary", {
            date: formatDayLabel(locale, selectedDay), messages: selectedCount, conversations: detail.conversations,
          })
      : t("myMessages.calendar.daySummaryMessages", {
          date: formatDayLabel(locale, selectedDay), messages: selectedCount,
        });
  const countedOnly = detail.status === "ready" ? Math.max(0, selectedCount - detail.rows.length) : 0;
  const listRows = filterAgentId === null
    ? detail.rows
    : detail.rows.filter(row => row.agentId === filterAgentId);
  const notice = snapshot.notices.directoryPartial || snapshot.notices.cacheError || snapshot.notices.skippedDatabases.length > 0;
  const noticeFull = snapshot.notices.cacheFull.length > 0;
  const incomplete = detail.partial.length > 0 || detail.failed.length > 0 || detail.directoryFailed;
  const daysFailed = snapshot.daysStatus === "error";

  return (
    <View style={{ flex: 1, backgroundColor: tokens.surface0, padding, gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pressable testID="my-messages-calendar-prev" accessibilityRole="button"
          accessibilityState={{ disabled: prevDisabled }}
          style={prevDisabled ? arrowDisabled : arrowButton}
          accessibilityLabel={view === "year" ? t("myMessages.calendar.previousYear") : t("myMessages.calendar.previousMonth")}
          disabled={prevDisabled}
          onPress={() => stepCalendar(-1)}>
          <Text style={body}>‹</Text>
        </Pressable>
        <Pressable testID="my-messages-calendar-title" accessibilityRole="button"
          accessibilityLabel={view === "year" ? t("myMessages.calendar.showMonthView") : t("myMessages.calendar.showYear")}
          onPress={toggleYearView}>
          <Text style={{ ...body, fontWeight: "600" }}>
            {view === "year" ? String(year) : formatMonthTitle(locale, visibleMonth)}
          </Text>
        </Pressable>
        <Pressable testID="my-messages-calendar-next" accessibilityRole="button"
          accessibilityState={{ disabled: nextDisabled }}
          style={nextDisabled ? arrowDisabled : arrowButton}
          accessibilityLabel={view === "year" ? t("myMessages.calendar.nextYear") : t("myMessages.calendar.nextMonth")}
          disabled={nextDisabled}
          onPress={() => stepCalendar(1)}>
          <Text style={body}>›</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable testID="my-messages-calendar-today" accessibilityRole="button" style={button} onPress={goToday}>
          <Text style={body}>{t("myMessages.calendar.today")}</Text>
        </Pressable>
        <Pressable testID="my-messages-screen-refresh" accessibilityRole="button" style={button} onPress={actions.refresh}>
          <Text style={body}>{t("myMessages.screenRefresh")}</Text>
        </Pressable>
      </View>
      {notice ? (
        <Text testID="my-messages-calendar-notice" accessibilityRole="alert" style={warning}>
          {t("myMessages.calendar.notice")}
        </Text>
      ) : null}
      {noticeFull ? (
        <Text testID="my-messages-calendar-notice-full" accessibilityRole="alert" style={warning}>
          {t("myMessages.calendar.noticeCacheFull")}
        </Text>
      ) : null}

      <View style={{ flex: 1, flexDirection: layout.compact ? "column" : "row", gap: 12, minHeight: 0 }}>
        <View style={layout.compact
          ? { gap: 6 }
          : { width: 320, gap: 6, alignSelf: "stretch", minHeight: 0 }}>
          {daysFailed ? (
            <View testID="my-messages-calendar-days-failed" accessibilityRole="alert" style={{ gap: 6 }}>
              <Text style={warning}>{t("myMessages.calendar.readFailed")}</Text>
              <Pressable testID="my-messages-calendar-days-retry" accessibilityRole="button" style={button}
                onPress={actions.refresh}>
                <Text style={body}>{t("myMessages.retry")}</Text>
              </Pressable>
            </View>
          ) : null}
          {view === "year" ? (
            <CalendarYearView
              year={year}
              months={months}
              startMonth={monthNumberOfKey(visibleMonth) - 1}
              visibleMonth={visibleMonth}
              thresholds={monthThresholds}
              palette={palette}
              tokens={tokens}
              locale={locale}
              t={t}
              compact={layout.compact}
              platform={layout.platform}
              onEnterMonth={enterMonth}
              onToday={goToday}
              today={today}
            />
          ) : layout.compact && !expanded ? (
            <View testID="my-messages-calendar-week" style={{ gap: 4 }}>
              <Text style={small}>{formatWeekRange(locale, buildWeek(selectedDay))}</Text>
              <CalendarMonthView
                month={visibleMonth}
                selectedDay={selectedDay}
                today={today}
                firstDay={snapshot.firstDay}
                days={snapshot.days}
                extraDays={snapshot.extraDays}
                countsKnown={countsKnown}
                thresholds={dayThresholds}
                palette={palette}
                tokens={tokens}
                locale={locale}
                t={t}
                compact={layout.compact}
                platform={layout.platform}
                weekMode
                onSelect={selectDay}
                onMonthChange={showMonth}
                onToday={goToday}
              />
            </View>
          ) : (
            <CalendarMonthView
              month={visibleMonth}
              selectedDay={selectedDay}
              today={today}
              firstDay={snapshot.firstDay}
              days={snapshot.days}
              extraDays={snapshot.extraDays}
              countsKnown={countsKnown}
              thresholds={dayThresholds}
              palette={palette}
              tokens={tokens}
              locale={locale}
              t={t}
              compact={layout.compact}
              platform={layout.platform}
              onSelect={selectDay}
              onMonthChange={showMonth}
              onToday={goToday}
            />
          )}
          {view === "month" && layout.compact ? (
            <Pressable testID="my-messages-calendar-expand" accessibilityRole="button" style={button}
              accessibilityLabel={expanded ? t("myMessages.calendar.hideMonth") : t("myMessages.calendar.showMonth")}
              onPress={() => setExpanded(value => !value)}>
              <Text style={body}>{expanded ? "▴" : "▾"}</Text>
            </Pressable>
          ) : null}
          <View testID="my-messages-calendar-legend" style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={small}>{t("myMessages.calendar.less")}</Text>
            {palette.backgrounds.map((background, level) => (
              <View key={level} style={{
                width: LEGEND_SIZE, height: LEGEND_SIZE, borderRadius: 4, overflow: "hidden",
                backgroundColor: level === 0 ? emptyFill : background ?? tokens.surface0,
                borderWidth: 1, borderColor: tokens.borderSubtle,
              }}>
                {palette.washes[level] !== null ? (
                  <View style={{ flex: 1, backgroundColor: tokens.accent, opacity: palette.washes[level] ?? 0 }} />
                ) : null}
              </View>
            ))}
            <Text style={small}>{t("myMessages.calendar.more")}</Text>
          </View>
          {showMonthPanel && layout.compact ? (
            <MonthPanel
              title={panelTitle}
              summary={panelSummary}
              conversations={topConversationsThisMonth}
              filterAgentId={filterAgentId}
              onToggleFilter={toggleFilter}
              incomplete={monthIncomplete}
              compact
              locale={locale}
              tokens={tokens}
              t={t}
            />
          ) : null}
          {showMonthPanel && !layout.compact ? (
            <ScrollView
              testID="my-messages-calendar-left-scroll"
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{ gap: 8, paddingBottom: padding }}
            >
              <MonthPanel
                title={panelTitle}
                summary={panelSummary}
                conversations={topConversationsThisMonth}
                filterAgentId={filterAgentId}
                onToggleFilter={toggleFilter}
                incomplete={monthIncomplete}
                compact={false}
                locale={locale}
                tokens={tokens}
                t={t}
              />
            </ScrollView>
          ) : null}
        </View>

        <View style={{ flex: 1, gap: 6, minHeight: 0 }}>
          {filterAgentId !== null ? (
            <Pressable
              testID="my-messages-calendar-filter"
              accessibilityRole="button"
              accessibilityLabel={t("myMessages.calendar.monthPanelFilterClear")}
              onPress={() => setFilterAgentId(null)}
              style={{
                flexDirection: "row", alignItems: "center", gap: 6,
                paddingVertical: 5, paddingHorizontal: 8,
                borderRadius: 8, borderWidth: 1,
                borderColor: tokens.accent, backgroundColor: tokens.accentBg,
              }}
            >
              <Text style={{ ...body, fontSize: tokens.fs(12), flex: 1 }} numberOfLines={1}>
                {t("myMessages.calendar.monthPanelFilter", { title: filterTitle })}
              </Text>
              <Text style={{ ...body, fontSize: tokens.fs(12) }}>×</Text>
            </Pressable>
          ) : null}
          <Text testID="my-messages-screen-summary" style={body}>{summary}</Text>
          {detail.status === "reading" ? (
            <Text testID="my-messages-screen-progress" style={muted}>
              {detail.progress
                ? t("myMessages.screenProgress", { done: detail.progress.done, total: detail.progress.total })
                : t("myMessages.calendar.dayLoading")}
            </Text>
          ) : null}
          {detail.status === "error" ? (
            <Text testID="my-messages-calendar-day-failed" accessibilityRole="alert" style={warning}>
              {t("myMessages.calendar.dayFailed")}
            </Text>
          ) : null}
          {incomplete ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text testID="my-messages-screen-incomplete" style={warning}>{t("myMessages.screenIncomplete")}</Text>
              <Pressable testID="my-messages-screen-retry" accessibilityRole="button" style={button} onPress={actions.retry}>
                <Text style={body}>{t("myMessages.retry")}</Text>
              </Pressable>
            </View>
          ) : null}
          {detail.unavailable.length > 0 ? (
            <Text testID="my-messages-screen-unavailable" accessibilityRole="alert" style={warning}>
              {t("myMessages.calendar.unavailable", { count: detail.unavailable.length })}
            </Text>
          ) : null}
          {detail.status === "error" ? (
            <Pressable testID="my-messages-screen-retry" accessibilityRole="button" style={button} onPress={actions.retry}>
              <Text style={body}>{t("myMessages.retry")}</Text>
            </Pressable>
          ) : null}
          {countedOnly > 0 ? (
            <Text testID="my-messages-calendar-count-only" style={muted}>
              {countedOnly === 1
                ? t("myMessages.calendar.countOnlyOne")
                : t("myMessages.calendar.countOnly", { count: countedOnly })}
            </Text>
          ) : null}
          {detail.status === "ready" && listRows.length === 0 && countedOnly === 0 ? (
            <Text style={muted}>
              {filterAgentId === null
                ? t("myMessages.calendar.dayEmpty")
                : t("myMessages.calendar.monthPanelFilterEmpty")}
            </Text>
          ) : null}
          <FlatList
            testID="my-messages-screen-list"
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: padding, gap: 8 }}
            data={listRows}
            keyExtractor={(row, index) => `${row.agentId}:${row.at}:${row.seq}:${index}`}
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
                      if (openConversation) openConversation();
                      else void copy(row.text, isEmptyMessageText(row.text));
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
                    onCopy={() => { void copy(row.text, isEmptyMessageText(row.text)); }}
                    onQuote={() => { void quote(row.text, row.agentId, openConversation); }}
                    labelStyle={muted}
                    borderColor={tokens.border}
                  />
                </View>
              );
            }}
          />
        </View>
      </View>
    </View>
  );
}
