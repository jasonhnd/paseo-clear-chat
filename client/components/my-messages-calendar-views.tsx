import React from "react";
import { Pressable, Text, View, type ViewProps, type ViewStyle } from "react-native";
import {
  buildMonthGrid,
  buildWeek,
  countLevel,
  monthKeyOfDay,
  moveDay,
  moveMonthFocus,
  selectableDay,
  weekdayIndexMondayFirst,
  type DayDirection,
  type DayKey,
  type MonthKey,
  type YearMonthCell,
} from "../my-messages-calendar";
import { formatDayLabel, formatMonthTitle, formatWeekday } from "../my-messages-calendar-labels";
import { displayedDayCount } from "../my-messages-calendar-feed";
import type { Translate } from "../translation";
import { mix, type ExtendedThemeTokens } from "./theme-tokens";

/**
 * The two calendar panes own their hover and keyboard-focus state. A pointer move only
 * re-renders the pane and its floating tooltip; the page around it, including the
 * selected-day list, does not render again.
 */

const CELL_WIDTH = "14.2857%";
const TOOLTIP_WIDTH = 170;
const GRID_ROLE = "grid" as unknown as ViewProps["accessibilityRole"];

export interface LevelPalette {
  /** Background for a level; `null` means "paint the wash overlay instead". */
  backgrounds: Array<string | null>;
  /** Opacity of the accent wash when the theme colour cannot be mixed into a solid hex. */
  washes: Array<number | null>;
  text: string[];
}

/**
 * Four tinted steps from the host accent. `mix` only parses hex and rgb(); a theme that
 * hands us hsl()/oklch() falls back to an accent overlay at the same opacity, so the four
 * steps stay visible and distinguishable instead of collapsing to the page background.
 */
export function buildLevelPalette(tokens: ExtendedThemeTokens): LevelPalette {
  const alphas = [0, 0.2, 0.38, 0.58, 0.78];
  const backgrounds: Array<string | null> = [];
  const washes: Array<number | null> = [];
  const text: string[] = [];
  for (let level = 0; level <= 4; level += 1) {
    const alpha = alphas[level] ?? 0;
    if (level === 0) {
      backgrounds.push(tokens.surface1);
      washes.push(null);
    } else {
      const mixed = mix(tokens.surface0, tokens.accent, alpha);
      if (mixed !== tokens.surface0) {
        backgrounds.push(mixed);
        washes.push(null);
      } else {
        backgrounds.push(tokens.surface0);
        washes.push(alpha);
      }
    }
    text.push(level >= 3 ? tokens.accentForeground : tokens.foreground);
  }
  return { backgrounds, washes, text };
}

function keyFromEvent(event: unknown): string | null {
  const value = event as { key?: string; nativeEvent?: { key?: string } } | null;
  return value?.nativeEvent?.key ?? value?.key ?? null;
}

function bubbleStyle(column: number, columns: number, tokens: ExtendedThemeTokens): ViewStyle {
  const base: ViewStyle = {
    position: "absolute", bottom: "100%", marginBottom: 6, width: TOOLTIP_WIDTH,
    paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, zIndex: 20,
    backgroundColor: tokens.surface2, borderWidth: 1, borderColor: tokens.border,
  };
  if (column <= 0) return { ...base, left: 0 };
  if (column >= columns - 1) return { ...base, right: 0 };
  return { ...base, left: "50%", marginLeft: -TOOLTIP_WIDTH / 2 };
}

function LevelWash({ opacity, color, radius }: { opacity: number; color: string; radius: number }) {
  return (
    <View
      testID="my-messages-calendar-level-wash"
      pointerEvents="none"
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: radius, backgroundColor: color, opacity }}
    />
  );
}

interface MonthViewProps {
  month: MonthKey;
  selectedDay: DayKey;
  today: DayKey;
  firstDay: DayKey | null;
  days: Readonly<Record<DayKey, number>>;
  extraDays: Readonly<Record<DayKey, number>>;
  countsKnown: boolean;
  thresholds: readonly [number, number, number];
  palette: LevelPalette;
  tokens: ExtendedThemeTokens;
  locale: string;
  t: Translate;
  compact: boolean;
  platform: "ios" | "android" | "web";
  /** One week only (the compact strip), still with the same cells and tooltip. */
  weekMode?: boolean;
  onSelect(day: DayKey): void;
  onMonthChange(month: MonthKey): void;
  onToday(): void;
}

function firstFocusDay(month: MonthKey, selectedDay: DayKey, firstDay: DayKey | null, today: DayKey): DayKey {
  if (monthKeyOfDay(selectedDay) === month) return selectedDay;
  const first = `${month}-01`;
  if (selectableDay(first, firstDay, today)) return first;
  if (firstDay && monthKeyOfDay(firstDay) === month) return firstDay;
  return selectedDay;
}

export function CalendarMonthView({
  month, selectedDay, today, firstDay, days, extraDays, countsKnown, thresholds, palette,
  tokens, locale, t, compact, platform, weekMode = false, onSelect, onMonthChange, onToday,
}: MonthViewProps) {
  const [focusedDay, setFocusedDay] = React.useState<DayKey>(() => firstFocusDay(month, selectedDay, firstDay, today));
  const [weekAnchor, setWeekAnchor] = React.useState<DayKey>(selectedDay);
  const [hoverDay, setHoverDay] = React.useState<DayKey | null>(null);
  const [focusInside, setFocusInside] = React.useState(false);

  React.useEffect(() => {
    setFocusedDay(selectedDay);
    setWeekAnchor(selectedDay);
  }, [selectedDay]);
  React.useEffect(() => {
    if (monthKeyOfDay(focusedDay) !== month) {
      setFocusedDay(firstFocusDay(month, selectedDay, firstDay, today));
      setHoverDay(null);
    }
  }, [month, focusedDay, selectedDay, firstDay, today]);

  const grid = buildMonthGrid(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const rows: Array<Array<DayKey | null>> = weekMode
    ? [buildWeek(weekAnchor)]
    : Array.from({ length: 6 }, (_, week) => grid.slice(week * 7, week * 7 + 7));
  const tooltipDay = hoverDay ?? (focusInside ? focusedDay : null);

  function handleKeyDown(event: unknown) {
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = (event as { preventDefault?: () => void } | null)?.preventDefault;
    if (key === "t" || key === "T") {
      prevent?.();
      onToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      onSelect(focusedDay);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    const next = moveDay(focusedDay, direction);
    if (!selectableDay(next, firstDay, today)) return;
    prevent?.();
    setFocusInside(true);
    setFocusedDay(next);
    if (monthKeyOfDay(next) !== month) onMonthChange(monthKeyOfDay(next));
    if (weekMode && !buildWeek(weekAnchor).includes(next)) setWeekAnchor(next);
  }

  const keyProps = platform === "web" ? ({ onKeyDown: handleKeyDown } as unknown as Partial<ViewProps>) : {};

  return (
    <View
      testID="my-messages-calendar-grid"
      accessibilityRole={GRID_ROLE}
      focusable
      tabIndex={0}
      onFocus={() => setFocusInside(true)}
      onBlur={() => setFocusInside(false)}
      {...keyProps}
      style={{ borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 6, gap: 2 }}
    >
      <View style={{ flexDirection: "row" }}>
        {Array.from({ length: 7 }, (_, index) => (
          <Text key={index} style={{ color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(11), width: CELL_WIDTH, textAlign: "center" }}>
            {formatWeekday(locale, index)}
          </Text>
        ))}
      </View>
      {rows.map((row, week) => (
        <View key={week} style={{ flexDirection: "row" }}>
          {row.map((day, index) => {
            if (!day) {
              return <View key={`blank-${week}-${index}`} style={{ width: CELL_WIDTH, padding: 2 }}>
                <View style={{ minHeight: compact ? 44 : 54 }} />
              </View>;
            }
            const count = displayedDayCount(days, extraDays, day);
            const level = countsKnown ? countLevel(count, thresholds) : 0;
            const selected = day === selectedDay;
            const isToday = day === today;
            const disabled = !selectableDay(day, firstDay, today);
            const focused = day === focusedDay;
            const column = weekdayIndexMondayFirst(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));
            const label = countsKnown
              ? count > 0
                ? count === 1
                  ? t("myMessages.calendar.dayCellLabelOne", { date: formatDayLabel(locale, day) })
                  : t("myMessages.calendar.dayCellLabel", { date: formatDayLabel(locale, day), count })
                : t("myMessages.calendar.dayCellEmpty", { date: formatDayLabel(locale, day) })
              : formatDayLabel(locale, day);
            const background = selected ? tokens.accent : palette.backgrounds[level] ?? tokens.surface1;
            const wash = selected ? null : palette.washes[level] ?? null;
            const color = selected ? tokens.accentForeground : palette.text[level] ?? tokens.foreground;
            const showTooltip = countsKnown && tooltipDay === day;
            const tooltip = count === 1
              ? t("myMessages.calendar.dayTooltipOne", { date: formatDayLabel(locale, day) })
              : t("myMessages.calendar.dayTooltip", { date: formatDayLabel(locale, day), count });
            return (
              <View key={day} testID="my-messages-calendar-cell-wrap"
                style={{ width: CELL_WIDTH, padding: 2, position: "relative", zIndex: showTooltip ? 30 : 1 }}>
                <Pressable
                  testID="my-messages-calendar-cell"
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected, disabled }}
                  disabled={disabled}
                  focusable
                  onPress={() => onSelect(day)}
                  onFocus={() => { setFocusedDay(day); setFocusInside(true); }}
                  onHoverIn={() => setHoverDay(day)}
                  onHoverOut={() => setHoverDay(null)}
                  style={{
                    minHeight: compact ? 44 : 54, borderRadius: 6, paddingVertical: 3,
                    alignItems: "center", justifyContent: "center", gap: 1,
                    backgroundColor: background, opacity: disabled ? 0.35 : 1,
                    borderWidth: selected || focused || isToday ? 1 : 0,
                    borderColor: selected ? tokens.accentForeground : focused ? tokens.accent : isToday ? tokens.accent : tokens.border,
                  }}
                >
                  {wash !== null ? <LevelWash opacity={wash} color={tokens.accent} radius={6} /> : null}
                  <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(11), fontWeight: isToday ? "600" : "400" }}>
                    {Number(day.slice(8, 10))}
                  </Text>
                  {countsKnown && count > 0 ? <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>{count}</Text> : null}
                </Pressable>
                {showTooltip ? (
                  <View testID="my-messages-calendar-tooltip" pointerEvents="none" style={bubbleStyle(column, 7, tokens)}>
                    <Text style={{ color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>{tooltip}</Text>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

interface YearViewProps {
  year: number;
  months: readonly YearMonthCell[];
  startMonth: number;
  thresholds: readonly [number, number, number];
  palette: LevelPalette;
  tokens: ExtendedThemeTokens;
  locale: string;
  t: Translate;
  compact: boolean;
  platform: "ios" | "android" | "web";
  onEnterMonth(month: MonthKey): void;
  onToday(): void;
}

export function CalendarYearView({
  year, months, startMonth, thresholds, palette, tokens, locale, t, compact, platform, onEnterMonth, onToday,
}: YearViewProps) {
  const columns = compact ? 2 : 4;
  const [focusedMonth, setFocusedMonth] = React.useState(() => Math.min(11, Math.max(0, startMonth)));
  const [hoverMonth, setHoverMonth] = React.useState<MonthKey | null>(null);
  const [focusInside, setFocusInside] = React.useState(false);

  React.useEffect(() => {
    setHoverMonth(null);
    setFocusedMonth(index => Math.min(11, Math.max(0, index)));
  }, [year]);
  const tooltipMonth = hoverMonth ?? (focusInside ? months[focusedMonth]?.month ?? null : null);

  function handleKeyDown(event: unknown) {
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = (event as { preventDefault?: () => void } | null)?.preventDefault;
    if (key === "t" || key === "T") {
      prevent?.();
      onToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      const cell = months[focusedMonth];
      if (cell?.selectable) onEnterMonth(cell.month);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    prevent?.();
    setFocusInside(true);
    setFocusedMonth(index => moveMonthFocus(index, direction, columns));
  }

  const keyProps = platform === "web" ? ({ onKeyDown: handleKeyDown } as unknown as Partial<ViewProps>) : {};
  const width = `${100 / columns}%` as `${number}%`;

  return (
    <View
      testID="my-messages-calendar-year"
      accessibilityRole={GRID_ROLE}
      focusable
      tabIndex={0}
      onFocus={() => setFocusInside(true)}
      onBlur={() => setFocusInside(false)}
      {...keyProps}
      style={{ flexDirection: "row", flexWrap: "wrap" }}
    >
      {months.map((cell, index) => {
        const level = countLevel(cell.total, thresholds);
        const focused = index === focusedMonth;
        const background = palette.backgrounds[level] ?? tokens.surface1;
        const wash = palette.washes[level] ?? null;
        const color = palette.text[level] ?? tokens.foreground;
        const monthTitle = formatMonthTitle(locale, cell.month);
        const label = cell.total === 1
          ? t("myMessages.calendar.yearMonthLabelOne", { month: monthTitle, count: cell.total })
          : t("myMessages.calendar.yearMonthLabel", { month: monthTitle, count: cell.total });
        const tooltip = cell.total === 1
          ? t("myMessages.calendar.yearMonthLabelOne", { month: monthTitle, count: cell.total })
          : t("myMessages.calendar.yearMonthLabel", { month: monthTitle, count: cell.total });
        const showTooltip = tooltipMonth === cell.month;
        return (
          <View key={cell.month} testID="my-messages-calendar-year-wrap"
            style={{ width, padding: 3, position: "relative", zIndex: showTooltip ? 30 : 1 }}>
            <Pressable
              testID="my-messages-calendar-year-month"
              accessibilityRole="button"
              accessibilityState={{ disabled: !cell.selectable, selected: focused }}
              accessibilityLabel={label}
              disabled={!cell.selectable}
              focusable
              onPress={() => onEnterMonth(cell.month)}
              onFocus={() => { setFocusedMonth(index); setFocusInside(true); }}
              onHoverIn={() => setHoverMonth(cell.month)}
              onHoverOut={() => setHoverMonth(null)}
              style={{
                minHeight: compact ? 56 : 64, borderRadius: 8, padding: 8, gap: 2,
                backgroundColor: background, opacity: cell.selectable ? 1 : 0.35,
                borderWidth: focused ? 2 : 1, borderColor: focused ? tokens.accent : tokens.border,
              }}
            >
              {wash !== null ? <LevelWash opacity={wash} color={tokens.accent} radius={8} /> : null}
              <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(14) }}>{monthTitle}</Text>
              <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>
                {cell.total === 1
                  ? t("myMessages.calendar.monthTotalOne")
                  : t("myMessages.calendar.monthTotal", { count: cell.total })}
              </Text>
            </Pressable>
            {showTooltip ? (
              <View testID="my-messages-calendar-tooltip" pointerEvents="none" style={bubbleStyle(index % columns, columns, tokens)}>
                <Text style={{ color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>{tooltip}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
