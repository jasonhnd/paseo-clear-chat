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
  mergeConversationMonths,
  monthKeyOfDay,
  monthNumberOfKey,
  monthSummary,
  monthTotals,
  quartileThresholds,
  selectableDay,
  topConversations,
  type ConversationMonthExtra,
  type DayKey,
  type MonthKey,
} from "../my-messages-calendar";
import { displayedDayCount, type MyMessagesCalendarSnapshot } from "../my-messages-calendar-feed";
import { formatDayLabel, formatMonthTitle, formatWeekRange } from "../my-messages-calendar-labels";
import { nowMs } from "../my-messages-clock";
import { useEnhancerPreferences } from "../preferences";
import { isEmptyMessageText, messagePreview } from "../../shared/user-message-kind";
import { CalendarMonthView, CalendarYearView, buildLevelPalette, emptyCellFill } from "./my-messages-calendar-views";
import { MonthPanel, type RankingState } from "./my-messages-calendar-month-panel";
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

/**
 * Share of a compact page the calendar column may take. The six-row month, its legend and
 * the panel are about 470 px tall at 390 wide; unbounded, they push the day's list off the
 * first screen on a short window. The column scrolls inside this share instead, so the list
 * below keeps the rest of the page.
 */
const COMPACT_CALENDAR_SHARE = 0.58;
/** Stands in for the cap until the page has measured its body. */
const COMPACT_CALENDAR_MAX_HEIGHT = `${Math.round(COMPACT_CALENDAR_SHARE * 100)}%` as const;
/** Page padding above and below the column, outside its share. */
const COMPACT_PAGE_PADDING = 12;
/** The wrapped toolbar: the two 44 px arrow targets and the row with the month title. */
const COMPACT_TOOLBAR_MAX = 104;
/**
 * One list row, from the parts the row itself draws: 8 px of padding above and below, the
 * 12 px title line, a 3 px gap, three 14 px lines of message text, another 3 px gap and the
 * 44 px copy/quote buttons. A row is never shorter than this, so a floor in rows has to use
 * the whole height rather than the text alone.
 */
export const COMPACT_LIST_ROW = 144;
/** The summary line, the filter bar and the gaps above the list. */
const COMPACT_LIST_CHROME = 56;
/** Rows the narrow page keeps on screen before it shrinks the calendar column instead. */
const COMPACT_LIST_MIN_ROWS = 1;

/**
 * The room a page of `viewportHeight` leaves the calendar column and the list together.
 * This is measured from the page, not assumed: a pane shorter than the window only has as
 * much room as the pane itself gives.
 */
export function compactBodyHeight(viewportHeight: number): number {
  return Math.max(0, viewportHeight - COMPACT_PAGE_PADDING * 2 - COMPACT_TOOLBAR_MAX);
}

/**
 * Pixels the compact calendar column may take out of a body of `bodyHeight`.
 * The page measures the body and caps the column here, so the list's room is fixed
 * arithmetic rather than whatever the flex layout happens to leave.
 */
export function compactCalendarMaxHeight(bodyHeight: number): number {
  return Math.round(bodyHeight * COMPACT_CALENDAR_SHARE * 100) / 100;
}

/**
 * Pixels the compact page keeps for the list column: its summary line, its filter bar, its
 * gaps and one whole row. The column carries this as a `minHeight`, so the calendar column
 * above it shrinks rather than the list's first row leaving the screen. This is the
 * arithmetic the styles ask for, not a measurement of a laid-out page.
 */
export function compactListFloor(): number {
  return COMPACT_LIST_ROW * COMPACT_LIST_MIN_ROWS + COMPACT_LIST_CHROME;
}

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
  // The narrow column is capped in pixels from the measured body, so the list's room is fixed
  // arithmetic the tests can read back. Before the first measurement the share stands in.
  const [compactBody, setCompactBody] = React.useState<number | null>(null);
  const compactCalendarHeight = compactBody === null ? COMPACT_CALENDAR_MAX_HEIGHT : compactCalendarMaxHeight(compactBody);
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
  /** The rows the reader filled in by opening a day, for the month on screen. */
  const monthExtras = React.useMemo(() => {
    const extras: ConversationMonthExtra[] = [];
    for (const [day, perConversation] of Object.entries(snapshot.extraConversations)) {
      if (monthKeyOfDay(day) !== visibleMonth) continue;
      for (const [agentId, extra] of Object.entries(perConversation)) {
        extras.push({ agentId, title: extra.title, count: extra.count, lastAt: extra.lastAt });
      }
    }
    return extras;
  }, [snapshot.extraConversations, visibleMonth]);
  // The ranking and the totals share the cells' records. The days RPC supplies the month's
  // per-conversation counts; a day the reader opened can add rows from conversations the
  // fast read never reached, and those rows are in the cell and the summary, so they are in
  // the ranking too. A conversation's day is replaced when the day is re-read, never added
  // twice.
  const monthEntries = React.useMemo(
    () => mergeConversationMonths(snapshot.conversationMonths[visibleMonth] ?? [], monthExtras),
    [snapshot.conversationMonths, visibleMonth, monthExtras],
  );
  const panelSummary = React.useMemo(
    () => monthSummary(displayedDays, visibleMonth, today),
    [displayedDays, visibleMonth, today],
  );
  const topConversationsThisMonth = React.useMemo(() => topConversations(monthEntries), [monthEntries]);
  const filterEntry = filterAgentId === null
    ? undefined
    : monthEntries.find(entry => entry.agentId === filterAgentId);
  const filterTitle = filterEntry?.title?.trim() ? filterEntry.title : t("myMessages.screenUntitled");
  // Whatever the cells and the summary count but the ranking does not list makes the
  // ranking short: a conversation the reader could not reach, a partial directory, or a
  // day whose fast count arrived without its split. The panel says so rather than
  // presenting the list as exact.
  const monthRankedTotal = monthEntries.reduce((sum, entry) => sum + entry.count, 0);
  const monthIncomplete = snapshot.notices.directoryPartial
    || snapshot.notices.cacheError
    || snapshot.notices.skippedDatabases.length > 0
    || snapshot.slowConversationIds.length > 0
    // A host that sent no per-conversation field at all cannot have ranked the month; a list
    // built from the days the reader opened is a partial ranking, not a complete one.
    || !snapshot.conversationMonthsKnown
    || panelSummary.total > monthRankedTotal
    // A day in this month whose count could not be matched makes the month's numbers
    // possibly incomplete too.
    || (detail.unreconciled && monthKeyOfDay(detail.day) === visibleMonth);
  const showMonthPanel = view === "month" && snapshot.daysStatus === "ready";
  // Three states, not two: the host never ranked the month, the month is ranked from a
  // partial read, or the ranking is complete. An empty list reads differently in each.
  const rankingState: RankingState = snapshot.daysStatus !== "ready" || !snapshot.conversationMonthsKnown
    ? "unavailable"
    : monthIncomplete ? "partial" : "complete";
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

  /**
   * Collapsing returns the panel to the month the week strip shows. A filter chosen in that
   * same month still applies, so it is dropped only when the month actually changes.
   */
  function collapseMonth() {
    const month = monthKeyOfDay(selectedDay);
    if (month !== visibleMonth) showMonth(month);
    setExpanded(false);
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
  // Records whose text is not on screen at all. They are a multiset: one row consumes one
  // record at the same conversation and instant, so a second message in that millisecond is
  // not swallowed. Only a record the RPC named is counted here; the day's own difference is
  // never turned into "the text was not kept". With a conversation filtered, only that
  // conversation's own records are consulted, so another conversation's record cannot cover
  // its empty answer.
  const unmatchedCountOnly = (() => {
    if (detail.status !== "ready" || !detail.countedKnown) return [];
    const left = new Map<string, number>();
    for (const row of detail.rows) {
      const key = `${row.agentId}\u0000${row.at}`;
      left.set(key, (left.get(key) ?? 0) + 1);
    }
    const out: { agentId: string; at: number }[] = [];
    for (const record of detail.countedRows) {
      const key = `${record.agentId}\u0000${record.at}`;
      const count = left.get(key) ?? 0;
      if (count > 1) left.set(key, count - 1);
      else if (count === 1) left.delete(key);
      else out.push(record);
    }
    return out;
  })();
  const countOnlyRecords = filterAgentId === null
    ? (detail.unreconciled ? [] : unmatchedCountOnly)
    : unmatchedCountOnly.filter(row => row.agentId === filterAgentId);
  const countOnly = countOnlyRecords.length;
  const listRows = filterAgentId === null
    ? detail.rows
    : detail.rows.filter(row => row.agentId === filterAgentId);
  const notice = snapshot.notices.directoryPartial || snapshot.notices.cacheError || snapshot.notices.skippedDatabases.length > 0;
  const noticeFull = snapshot.notices.cacheFull.length > 0;
  const incomplete = detail.partial.length > 0 || detail.failed.length > 0 || detail.directoryFailed
    || (detail.status === "ready" && !detail.countedKnown);
  const daysFailed = snapshot.daysStatus === "error";
  const emptyAnswer = detail.status === "ready" && detail.fromRpc && detail.countedKnown
    && listRows.length === 0 && countOnly === 0
    && (filterAgentId !== null || !detail.unreconciled);

  // The calendar, its expansion control and the legend travel together; the panels below
  // are per layout so the wide screen can keep only the panel scrolling.
  const calendarBlock = (
    <>
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
          onPress={() => {
            if (expanded) collapseMonth();
            else setExpanded(true);
          }}>
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
    </>
  );

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

      <View
        testID="my-messages-calendar-body"
        onLayout={event => {
          const height = event.nativeEvent.layout.height;
          if (height > 0) setCompactBody(current => current === height ? current : height);
        }}
        style={{ flex: 1, flexDirection: layout.compact ? "column" : "row", gap: 12, minHeight: 0 }}
      >
        {/* The month, its legend and the panel scroll inside a bounded share of the page;
            the day's list keeps the rest, so its first row stays on the first screen. */}
        {layout.compact ? (
          <ScrollView
            testID="my-messages-calendar-compact-scroll"
            style={{ flexGrow: 0, flexShrink: 1, maxHeight: compactCalendarHeight }}
            contentContainerStyle={{ gap: 6 }}
          >
            {calendarBlock}
            {showMonthPanel && layout.compact ? (
              <MonthPanel
                title={panelTitle}
                summary={panelSummary}
                conversations={topConversationsThisMonth}
                filterAgentId={filterAgentId}
                onToggleFilter={toggleFilter}
                incomplete={monthIncomplete}
                rankingState={rankingState}
                compact
                locale={locale}
                tokens={tokens}
                t={t}
              />
            ) : null}
          </ScrollView>
        ) : (
          <View style={{ width: 320, gap: 6, alignSelf: "stretch", minHeight: 0 }}>
            {calendarBlock}
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
                  rankingState={rankingState}
                  compact={false}
                  locale={locale}
                  tokens={tokens}
                  t={t}
                />
              </ScrollView>
            ) : null}
          </View>
        )}

        <View testID="my-messages-calendar-list-column" style={{ flex: 1, gap: 6, minHeight: compactListFloor() }}>
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
          {detail.unreconciled && filterAgentId === null ? (
            <Text testID="my-messages-calendar-unreconciled" accessibilityRole="alert" style={warning}>
              {t("myMessages.calendar.dayUnreconciled")}
            </Text>
          ) : null}
          {countOnly > 0 ? (
            <Text testID="my-messages-calendar-count-only" style={muted}>
              {countOnly === 1
                ? t("myMessages.calendar.countOnlyOne")
                : t("myMessages.calendar.countOnly", { count: countOnly })}
            </Text>
          ) : null}
          {emptyAnswer ? (
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
