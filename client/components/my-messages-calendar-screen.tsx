import React from "react";
import { FlatList, Pressable, Text, View, type ViewProps } from "react-native";
import { useTranslation, type PluginScreenProps } from "@getpaseo/plugin/client";
import { formatClock, localDateKey } from "../local-day";
import { messages } from "../messages";
import { useMyMessageActions, type MyMessagesComposerHost } from "../my-messages-actions";
import {
  addDays,
  addMonths,
  buildMonthGrid,
  buildWeek,
  buildYear,
  countLevel,
  monthKeyOfDay,
  monthNumberOfKey,
  monthTotals,
  moveDay,
  moveMonthFocus,
  quartileThresholds,
  selectableDay,
  type DayDirection,
  type DayKey,
  type MonthKey,
} from "../my-messages-calendar";
import type { MyMessagesCalendarSnapshot } from "../my-messages-calendar-feed";
import {
  formatDayLabel,
  formatMonthName,
  formatMonthTitle,
  formatWeekday,
  formatWeekRange,
} from "../my-messages-calendar-labels";
import { nowMs } from "../my-messages-clock";
import { isEmptyMessageText, messagePreview } from "../user-message-kind";
import { MyMessagesRowActions } from "./my-messages-row-actions";
import { buildThemeTokens, mix } from "./theme-tokens";

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

interface HoverTarget {
  kind: "day" | "month";
  key: string;
}

const CELL_WIDTH = "14.2857%";
const GRID_ROLE = "grid" as unknown as ViewProps["accessibilityRole"];

function keyFromEvent(event: unknown): string | null {
  const value = event as { key?: string; nativeEvent?: { key?: string } } | null;
  return value?.nativeEvent?.key ?? value?.key ?? null;
}

export function MyMessagesCalendarScreen({
  theme, layout, host, navigation, composerHost, snapshot, actions,
}: CalendarProps) {
  const { t, locale } = useTranslation(messages);
  const { copy, quote } = useMyMessageActions(t, composerHost);
  const tokens = React.useMemo(() => buildThemeTokens(theme.colors), [theme]);

  const today = localDateKey(nowMs());
  const selectedDay = snapshot.selectedDay;
  const [visibleMonth, setVisibleMonth] = React.useState<MonthKey>(monthKeyOfDay(selectedDay));
  const [year, setYear] = React.useState(() => Number(monthKeyOfDay(selectedDay).slice(0, 4)));
  const [view, setView] = React.useState<CalendarView>("month");
  const [focusedMonth, setFocusedMonth] = React.useState(() => monthNumberOfKey(monthKeyOfDay(selectedDay)) - 1);
  const [focusedDay, setFocusedDay] = React.useState<DayKey>(selectedDay);
  const [expanded, setExpanded] = React.useState(!layout.compact);
  const [hover, setHover] = React.useState<HoverTarget | null>(null);

  React.useEffect(() => {
    setVisibleMonth(monthKeyOfDay(selectedDay));
    setFocusedDay(selectedDay);
  }, [selectedDay]);

  const padding = layout.compact ? 12 : 16;
  const body = { color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) };
  const muted = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) };
  const small = { ...muted, fontSize: tokens.fs(11) };
  const warning = { ...muted, color: tokens.warning };
  const button = { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: tokens.border };
  const openAgent = typeof navigation?.openAgent === "function" ? navigation.openAgent.bind(navigation) : undefined;

  const headerMonth = layout.compact ? monthKeyOfDay(selectedDay) : visibleMonth;
  const headerYear = Number(headerMonth.slice(0, 4));
  const detail = snapshot.detail;
  const selectedCount = snapshot.days[selectedDay] ?? 0;
  const countsKnown = snapshot.daysStatus === "ready";
  const dayThresholds = quartileThresholds(Object.values(snapshot.days));
  const totalsByMonth = monthTotals(Object.entries(snapshot.days).map(([day, count]) => ({ day, count })));
  const months = buildYear(year, totalsByMonth, snapshot.firstDay, today);
  // Month levels use every month with history, not only the twelve on screen.
  const monthThresholds = quartileThresholds(Object.values(totalsByMonth));

  // The empty cell is the theme's raised surface; the four filled steps tint towards the
  // host accent, so dark and light themes each keep their own hue instead of a fixed palette.
  const levelColors = [
    tokens.surface1,
    mix(tokens.surface0, tokens.accent, 0.2),
    mix(tokens.surface0, tokens.accent, 0.38),
    mix(tokens.surface0, tokens.accent, 0.58),
    mix(tokens.surface0, tokens.accent, 0.78),
  ];
  const levelText = [
    tokens.foreground, tokens.foreground, tokens.foreground, tokens.accentForeground, tokens.accentForeground,
  ];

  function selectDay(day: DayKey, collapse = false) {
    if (!selectableDay(day, snapshot.firstDay, today)) return;
    actions.select(day);
    setFocusedDay(day);
    setVisibleMonth(monthKeyOfDay(day));
    if (collapse && layout.compact) setExpanded(false);
  }

  function moveSelection(direction: DayDirection) {
    selectDay(moveDay(selectedDay, direction));
  }

  function goToday() {
    setHover(null);
    actions.select(today);
    setVisibleMonth(monthKeyOfDay(today));
    setFocusedDay(today);
    setView("month");
    if (layout.compact) setExpanded(false);
  }

  function enterMonth(month: MonthKey) {
    setHover(null);
    setView("month");
    setVisibleMonth(month);
    if (layout.compact) setExpanded(true);
    const firstOfMonth = `${month}-01`;
    const firstCandidate = snapshot.firstDay && monthKeyOfDay(snapshot.firstDay) === month
      ? snapshot.firstDay : firstOfMonth;
    const target = month === monthKeyOfDay(today) ? today
      : selectableDay(firstCandidate, snapshot.firstDay, today) ? firstCandidate : selectedDay;
    if (target !== selectedDay) actions.select(target);
  }

  function toggleYearView() {
    setHover(null);
    if (view === "year") {
      setView("month");
      return;
    }
    setYear(headerYear);
    setFocusedMonth(monthNumberOfKey(headerMonth) - 1);
    setView("year");
  }

  function stepCalendar(delta: number) {
    setHover(null);
    if (view === "year") {
      setYear(value => value + delta);
      return;
    }
    if (layout.compact) {
      selectDay(addDays(selectedDay, delta * 7));
      return;
    }
    setVisibleMonth(month => addMonths(month, delta));
  }

  function handleKeyDown(event: unknown) {
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = (event as { preventDefault?: () => void } | null)?.preventDefault;

    if (view === "year") {
      if (key === "t" || key === "T") {
        prevent?.();
        goToday();
        return;
      }
      if (key === "Enter" || key === " ") {
        prevent?.();
        const cell = months[focusedMonth];
        if (cell?.selectable) enterMonth(cell.month);
        return;
      }
      const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
        : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
      if (!direction) return;
      prevent?.();
      setFocusedMonth(index => moveMonthFocus(index, direction, layout.compact ? 2 : 4));
      return;
    }

    if (key === "t" || key === "T") {
      prevent?.();
      goToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      selectDay(focusedDay);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    prevent?.();
    const next = moveDay(focusedDay, direction);
    if (selectableDay(next, snapshot.firstDay, today)) {
      setFocusedDay(next);
      actions.select(next);
      setVisibleMonth(monthKeyOfDay(next));
    }
  }

  const keyProps = layout.platform === "web"
    ? ({ onKeyDown: handleKeyDown } as unknown as Partial<ViewProps>)
    : {};

  function hoverText(): string | null {
    if (!hover) return null;
    if (hover.kind === "day") {
      if (!countsKnown) return null;
      return t("myMessages.calendar.dayTooltip", {
        date: formatDayLabel(locale, hover.key), count: snapshot.days[hover.key] ?? 0,
      });
    }
    const cell = months.find(month => month.month === hover.key);
    if (!cell) return null;
    return t("myMessages.calendar.yearMonthLabel", {
      month: formatMonthName(locale, cell.month), year, count: cell.total,
    });
  }

  function renderDayCell(day: DayKey) {
    const count = snapshot.days[day] ?? 0;
    const level = countsKnown ? countLevel(count, dayThresholds) : 0;
    const selected = day === selectedDay;
    const isToday = day === today;
    const disabled = !selectableDay(day, snapshot.firstDay, today);
    const focused = day === focusedDay;
    const label = countsKnown
      ? count > 0
        ? t("myMessages.calendar.dayCellLabel", { date: formatDayLabel(locale, day), count })
        : t("myMessages.calendar.dayCellEmpty", { date: formatDayLabel(locale, day) })
      : formatDayLabel(locale, day);
    const background = selected ? tokens.accent : levelColors[level] ?? tokens.surface1;
    const color = selected ? tokens.accentForeground : levelText[level] ?? tokens.foreground;
    return (
      <View key={day} style={{ width: CELL_WIDTH, padding: 2 }}>
        <Pressable
          testID="my-messages-calendar-cell"
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected, disabled }}
          disabled={disabled}
          focusable
          onPress={() => selectDay(day, true)}
          onFocus={() => setFocusedDay(day)}
          onHoverIn={() => setHover({ kind: "day", key: day })}
          onHoverOut={() => setHover(null)}
          style={{
            minHeight: layout.compact ? 44 : 54, borderRadius: 6, paddingVertical: 3,
            alignItems: "center", justifyContent: "center", gap: 1,
            backgroundColor: background, opacity: disabled ? 0.35 : 1,
            borderWidth: selected || focused || isToday ? 1 : 0,
            borderColor: selected ? tokens.accentForeground : focused ? tokens.accent : tokens.border,
          }}
        >
          <Text style={{ ...small, color, fontWeight: isToday ? "600" : "400" }}>{Number(day.slice(8, 10))}</Text>
          {countsKnown && count > 0 ? <Text style={{ ...small, color }}>{count}</Text> : null}
        </Pressable>
      </View>
    );
  }

  function renderMonthGrid() {
    const grid = buildMonthGrid(headerYear, monthNumberOfKey(headerMonth));
    return (
      <View testID="my-messages-calendar-grid" accessibilityRole={GRID_ROLE} focusable tabIndex={0} {...keyProps}
        style={{ borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 6, gap: 2 }}>
        <View style={{ flexDirection: "row" }}>
          {Array.from({ length: 7 }, (_, index) => (
            <Text key={index} style={{ ...small, width: CELL_WIDTH, textAlign: "center" }}>
              {formatWeekday(locale, index)}
            </Text>
          ))}
        </View>
        {Array.from({ length: 6 }, (_, week) => (
          <View key={week} style={{ flexDirection: "row" }}>
            {grid.slice(week * 7, week * 7 + 7).map((day, index) => day
              ? renderDayCell(day)
              : <View key={`blank-${week}-${index}`} style={{ width: CELL_WIDTH, padding: 2 }}>
                  <View style={{ minHeight: layout.compact ? 44 : 54 }} />
                </View>)}
          </View>
        ))}
      </View>
    );
  }

  function renderWeekStrip() {
    const week = buildWeek(selectedDay);
    return (
      <View testID="my-messages-calendar-week" style={{ gap: 4 }}>
        <Text style={small}>{formatWeekRange(locale, week)}</Text>
        <View accessibilityRole={GRID_ROLE} focusable tabIndex={0} {...keyProps}>
          <View style={{ flexDirection: "row" }}>
            {Array.from({ length: 7 }, (_, index) => (
              <Text key={index} style={{ ...small, width: CELL_WIDTH, textAlign: "center" }}>{formatWeekday(locale, index)}</Text>
            ))}
          </View>
          <View style={{ flexDirection: "row" }}>{week.map(day => renderDayCell(day))}</View>
        </View>
      </View>
    );
  }

  function renderYearGrid() {
    const columns = layout.compact ? 2 : 4;
    const width = `${100 / columns}%` as `${number}%`;
    return (
      <View testID="my-messages-calendar-year" accessibilityRole={GRID_ROLE} focusable tabIndex={0} {...keyProps}
        style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {months.map((cell, index) => {
          const level = countLevel(cell.total, monthThresholds);
          const focused = index === focusedMonth;
          const background = levelColors[level] ?? tokens.surface1;
          const color = levelText[level] ?? tokens.foreground;
          return (
            <View key={cell.month} style={{ width, padding: 3 }}>
              <Pressable
                testID="my-messages-calendar-year-month"
                accessibilityRole="button"
                accessibilityState={{ disabled: !cell.selectable, selected: focused }}
                accessibilityLabel={t("myMessages.calendar.yearMonthLabel", {
                  month: formatMonthName(locale, cell.month), year, count: cell.total,
                })}
                disabled={!cell.selectable}
                focusable
                onPress={() => enterMonth(cell.month)}
                onFocus={() => setFocusedMonth(index)}
                onHoverIn={() => setHover({ kind: "month", key: cell.month })}
                onHoverOut={() => setHover(null)}
                style={{
                  minHeight: layout.compact ? 56 : 64, borderRadius: 8, padding: 8, gap: 2,
                  backgroundColor: background, opacity: cell.selectable ? 1 : 0.35,
                  borderWidth: focused ? 2 : 1,
                  borderColor: focused ? tokens.accent : tokens.border,
                }}
              >
                <Text style={{ ...body, color }}>{formatMonthName(locale, cell.month)}</Text>
                <Text style={{ ...small, color }}>{t("myMessages.calendar.monthTotal", { count: cell.total })}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    );
  }

  const summary = selectedDay === today
    ? t("myMessages.calendar.todaySummary", { date: formatDayLabel(locale, selectedDay) })
    : detail.status === "ready"
      ? detail.conversations === 1
        ? t("myMessages.calendar.daySummaryOne", {
            date: formatDayLabel(locale, selectedDay), messages: selectedCount, conversations: detail.conversations,
          })
        : t("myMessages.calendar.daySummary", {
            date: formatDayLabel(locale, selectedDay), messages: selectedCount, conversations: detail.conversations,
          })
      : t("myMessages.calendar.daySummaryMessages", {
          date: formatDayLabel(locale, selectedDay), messages: selectedCount,
        });
  const notice = snapshot.notices.directoryPartial || snapshot.notices.cacheError || snapshot.notices.skippedDatabases.length > 0;
  const incomplete = detail.partial.length > 0 || detail.failed.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.surface0, padding, gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Pressable testID="my-messages-calendar-prev" accessibilityRole="button" style={button}
          accessibilityLabel={view === "year" ? t("myMessages.calendar.previousYear") : t("myMessages.calendar.previousMonth")}
          onPress={() => stepCalendar(-1)}>
          <Text style={body}>‹</Text>
        </Pressable>
        <Pressable testID="my-messages-calendar-title" accessibilityRole="button"
          accessibilityLabel={view === "year" ? t("myMessages.calendar.showMonthView") : t("myMessages.calendar.showYear")}
          onPress={toggleYearView}>
          <Text style={{ ...body, fontWeight: "600" }}>
            {view === "year" ? String(year) : formatMonthTitle(locale, headerMonth)}
          </Text>
        </Pressable>
        <Pressable testID="my-messages-calendar-next" accessibilityRole="button" style={button}
          accessibilityLabel={view === "year" ? t("myMessages.calendar.nextYear") : t("myMessages.calendar.nextMonth")}
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
      <View style={{ minHeight: 18 }}>
        {hoverText() ? <Text testID="my-messages-calendar-tooltip" style={small}>{hoverText()}</Text> : null}
      </View>

      <View style={{ flex: 1, flexDirection: layout.compact ? "column" : "row", gap: 12 }}>
        <View style={{ width: layout.compact ? undefined : 320, gap: 6 }}>
          {view === "year" ? renderYearGrid() : layout.compact && !expanded ? renderWeekStrip() : renderMonthGrid()}
          {view === "month" && layout.compact ? (
            <Pressable testID="my-messages-calendar-expand" accessibilityRole="button" style={button}
              accessibilityLabel={expanded ? t("myMessages.calendar.hideMonth") : t("myMessages.calendar.showMonth")}
              onPress={() => setExpanded(value => !value)}>
              <Text style={body}>{expanded ? "▴" : "▾"}</Text>
            </Pressable>
          ) : null}
          <View testID="my-messages-calendar-legend" style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={small}>{t("myMessages.calendar.less")}</Text>
            {levelColors.map((color, level) => (
              <View key={level} style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color, borderWidth: 1, borderColor: tokens.borderSubtle }} />
            ))}
            <Text style={small}>{t("myMessages.calendar.more")}</Text>
          </View>
        </View>

        <View style={{ flex: 1, gap: 6 }}>
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
            <Text testID="my-messages-screen-incomplete" style={warning}>{t("myMessages.screenIncomplete")}</Text>
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
          {detail.status === "ready" && detail.rows.length === 0 ? (
            <Text style={muted}>{t("myMessages.calendar.dayEmpty")}</Text>
          ) : null}
          <FlatList
            testID="my-messages-screen-list"
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: padding, gap: 8 }}
            data={detail.rows}
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
