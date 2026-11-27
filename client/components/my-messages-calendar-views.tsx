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

function readColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const value = color.trim();
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map(channel => channel + channel).join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
    const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16);
    return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
  }
  const body = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (!body) return null;
  const parts = body.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(part => Number.isNaN(part))) return null;
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
}

/** Paint `color` over an opaque `under`, so a translucent surface can be measured. */
function flattenColor(color: string, under: string): string | null {
  const top = readColor(color);
  const base = readColor(under);
  if (!top || !base) return null;
  const channel = (value: number, below: number) => Math.round(value * top.a + below * (1 - top.a));
  return `rgb(${channel(top.r, base.r)}, ${channel(top.g, base.g)}, ${channel(top.b, base.b)})`;
}

function contrastOf(first: string, second: string): number | null {
  const left = readColor(first);
  const right = readColor(second);
  if (!left || !right) return null;
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color: { r: number; g: number; b: number }) =>
    0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

/** The darker or lighter ink, whichever reads better on `background`. */
function inkFor(background: string, dark: string, light: string, fallback: string): string {
  const darkRatio = contrastOf(dark, background);
  const lightRatio = contrastOf(light, background);
  if (darkRatio === null || lightRatio === null) return fallback;
  return darkRatio >= lightRatio ? dark : light;
}

const EMPTY_LEVEL_GAP = 1.3;

/** A neutral fill that does not sit on the first heat step. Steps away from the page until it does. */
function neutralApart(page: string, neighbor: string): string {
  const current = contrastOf(page, neighbor);
  if (current !== null && current >= EMPTY_LEVEL_GAP) return page;
  let best = page;
  let bestRatio = current ?? 0;
  for (let step = 1; step <= 10; step += 1) {
    for (const toward of ["#000000", "#ffffff"]) {
      const mixed = mix(page, toward, step / 10);
      const ratio = contrastOf(mixed, neighbor);
      if (ratio === null) continue;
      if (ratio >= EMPTY_LEVEL_GAP) return mixed;
      if (ratio > bestRatio) {
        best = mixed;
        bestRatio = ratio;
      }
    }
  }
  return best;
}

/** Background for a selectable cell with no messages, measured against the first heat step. */
export function emptyCellFill(tokens: ExtendedThemeTokens, palette: LevelPalette): string {
  const page = flattenColor(tokens.surface0, "#ffffff") ?? tokens.surface0;
  const levelFill = palette.backgrounds[1] ?? tokens.surface1;
  const neighbor = flattenColor(levelFill, page) ?? levelFill;
  return neutralApart(page, neighbor);
}

/**
 * Four tinted steps from the host accent. `mix` only parses hex and rgb(); a theme that
 * hands us hsl()/oklch() falls back to an accent overlay at the same opacity, so the four
 * steps stay visible and distinguishable instead of collapsing to the page background.
 * The number on a step uses whichever of the theme's two inks clears the fill.
 */
export function buildLevelPalette(tokens: ExtendedThemeTokens): LevelPalette {
  const alphas = [0, 0.2, 0.38, 0.58, 0.78];
  const page = flattenColor(tokens.surface0, "#ffffff") ?? tokens.surface0;
  const backgrounds: Array<string | null> = [];
  const washes: Array<number | null> = [];
  const text: string[] = [];
  for (let level = 0; level <= 4; level += 1) {
    const alpha = alphas[level] ?? 0;
    const fallback = level >= 3 ? tokens.accentForeground : tokens.foreground;
    let fill = tokens.surface1;
    if (level === 0) {
      backgrounds.push(tokens.surface1);
      washes.push(null);
    } else {
      const mixed = mix(tokens.surface0, tokens.accent, alpha);
      if (mixed !== tokens.surface0) {
        backgrounds.push(mixed);
        washes.push(null);
        fill = mixed;
      } else {
        backgrounds.push(tokens.surface0);
        washes.push(alpha);
        const veiled = flattenColor(tokens.accent, page);
        const veil = veiled === null ? null : readColor(veiled);
        const base = readColor(page);
        fill = veil && base
          ? `rgb(${Math.round(base.r + (veil.r - base.r) * alpha)}, ${Math.round(base.g + (veil.g - base.g) * alpha)}, ${Math.round(base.b + (veil.b - base.b) * alpha)})`
          : tokens.surface0;
      }
    }
    const painted = flattenColor(fill, page) ?? fill;
    text.push(inkFor(painted, tokens.foreground, tokens.accentForeground, fallback));
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

/** The node a web Pressable forwards its ref to; only `focus` is used here. */
interface FocusTarget {
  focus?: () => void;
}

/** The nearest selectable month, so a tab stop never sits on a grey cell. */
function nearestSelectableMonth(index: number, months: readonly YearMonthCell[]): number {
  if (months[index]?.selectable) return index;
  let best = -1;
  for (let candidate = 0; candidate < months.length; candidate += 1) {
    if (!months[candidate]?.selectable) continue;
    if (best < 0 || Math.abs(candidate - index) < Math.abs(best - index)) best = candidate;
  }
  return best >= 0 ? best : index;
}

/** Arrow movement that steps over greyer months instead of stopping on them. */
function nextSelectableMonth(
  index: number, direction: DayDirection, columns: number, months: readonly YearMonthCell[],
): number {
  let current = index;
  for (let step = 0; step < months.length; step += 1) {
    const next = moveMonthFocus(current, direction, columns);
    if (next === current) return index;
    current = next;
    if (months[current]?.selectable) return current;
  }
  return index;
}

export function CalendarMonthView({
  month, selectedDay, today, firstDay, days, extraDays, countsKnown, thresholds, palette,
  tokens, locale, t, compact, platform, weekMode = false, onSelect, onMonthChange, onToday,
}: MonthViewProps) {
  const [focusedDay, setFocusedDay] = React.useState<DayKey>(() => firstFocusDay(month, selectedDay, firstDay, today));
  const focusedDayRef = React.useRef(focusedDay);
  const [weekAnchor, setWeekAnchor] = React.useState<DayKey>(selectedDay);
  const [hoverDay, setHoverDay] = React.useState<DayKey | null>(null);
  const [focusInside, setFocusInside] = React.useState(false);
  const cellNodes = React.useRef(new Map<DayKey, FocusTarget>());
  const pendingFocus = React.useRef<DayKey | null>(null);

  /** State plus the ref the key handler reads, so held-down arrows do not use a stale day. */
  function commitFocusDay(day: DayKey) {
    focusedDayRef.current = day;
    setFocusedDay(day);
  }

  /** Attach a cell; if a cross-month arrow asked for it, focus it as it mounts. */
  function registerCell(day: DayKey, node: FocusTarget | null) {
    if (!node) {
      cellNodes.current.delete(day);
      return;
    }
    cellNodes.current.set(day, node);
    if (pendingFocus.current === day) {
      pendingFocus.current = null;
      node.focus?.();
    }
  }

  function moveFocusTo(day: DayKey) {
    const node = cellNodes.current.get(day);
    if (!node) {
      // The cell is in a month or week that has not rendered yet; its ref moves focus.
      pendingFocus.current = day;
      return;
    }
    pendingFocus.current = null;
    node.focus?.();
  }

  React.useEffect(() => {
    commitFocusDay(selectedDay);
    setWeekAnchor(selectedDay);
  }, [selectedDay]);
  React.useEffect(() => {
    if (monthKeyOfDay(focusedDayRef.current) !== month) {
      commitFocusDay(firstFocusDay(month, selectedDay, firstDay, today));
      setHoverDay(null);
    }
  }, [month, focusedDay, selectedDay, firstDay, today]);
  // A cross-month or next-week arrow asks for a cell that did not exist in the previous
  // render. Refs normally focus it as it mounts; this effect is the same hand-off after
  // commit, so the keyboard never falls back to the document body.
  React.useEffect(() => {
    const day = pendingFocus.current;
    if (day === null) return;
    const node = cellNodes.current.get(day);
    if (!node) return;
    pendingFocus.current = null;
    node.focus?.();
  }, [focusedDay, month, weekAnchor]);

  const grid = buildMonthGrid(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const rows: Array<Array<DayKey | null>> = weekMode
    ? [buildWeek(weekAnchor)]
    : Array.from({ length: 6 }, (_, week) => grid.slice(week * 7, week * 7 + 7));
  const tooltipDay = hoverDay ?? (focusInside ? focusedDay : null);
  const emptyFill = emptyCellFill(tokens, palette);

  function handleKeyDown(event: unknown) {
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = () => (event as { preventDefault?: () => void } | null)?.preventDefault?.();
    if (key === "t" || key === "T") {
      prevent?.();
      onToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      onSelect(focusedDayRef.current);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    const next = moveDay(focusedDayRef.current, direction);
    if (!selectableDay(next, firstDay, today)) return;
    prevent?.();
    setFocusInside(true);
    commitFocusDay(next);
    if (monthKeyOfDay(next) !== month) onMonthChange(monthKeyOfDay(next));
    if (weekMode && !buildWeek(weekAnchor).includes(next)) setWeekAnchor(next);
    moveFocusTo(next);
  }

  const keyProps = platform === "web" ? ({ onKeyDown: handleKeyDown } as unknown as Partial<ViewProps>) : {};

  return (
    <View
      testID="my-messages-calendar-grid"
      accessibilityRole={GRID_ROLE}
      tabIndex={-1}
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
            const quietDay = countsKnown && count === 0 && !disabled && !selected;
            const background = selected ? tokens.accent : quietDay ? emptyFill : palette.backgrounds[level] ?? tokens.surface1;
            const wash = selected || quietDay ? null : palette.washes[level] ?? null;
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
                  ref={node => registerCell(day, node as unknown as FocusTarget | null)}
                  tabIndex={focused ? 0 : -1}
                  onPress={() => onSelect(day)}
                  onFocus={() => { commitFocusDay(day); setFocusInside(true); }}
                  onHoverIn={() => setHoverDay(day)}
                  onHoverOut={() => setHoverDay(null)}
                  style={{
                    minHeight: compact ? 44 : 54, borderRadius: 6, paddingVertical: 3,
                    alignItems: "center", justifyContent: "center", gap: 1,
                    backgroundColor: background, opacity: disabled ? 0.35 : 1,
                    borderWidth: selected || focused || isToday ? 2 : quietDay ? 1 : 0,
                    borderColor: selected ? tokens.accentForeground : focused || isToday ? tokens.foreground : tokens.border,
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
  const [focusedMonth, setFocusedMonth] = React.useState(() => nearestSelectableMonth(Math.min(11, Math.max(0, startMonth)), months));
  const focusedMonthRef = React.useRef(focusedMonth);
  const [hoverMonth, setHoverMonth] = React.useState<MonthKey | null>(null);
  const [focusInside, setFocusInside] = React.useState(false);
  const monthNodes = React.useRef(new Map<number, FocusTarget>());
  const pendingMonthFocus = React.useRef<number | null>(null);

  /** State plus the ref the key handler reads, so held-down arrows do not use a stale month. */
  function commitFocusMonth(index: number) {
    focusedMonthRef.current = index;
    setFocusedMonth(index);
  }

  function registerMonth(index: number, node: FocusTarget | null) {
    if (!node) {
      monthNodes.current.delete(index);
      return;
    }
    monthNodes.current.set(index, node);
    if (pendingMonthFocus.current === index) {
      pendingMonthFocus.current = null;
      node.focus?.();
    }
  }

  function moveMonthFocusTo(index: number) {
    const node = monthNodes.current.get(index);
    if (!node) {
      pendingMonthFocus.current = index;
      return;
    }
    pendingMonthFocus.current = null;
    node.focus?.();
  }

  React.useEffect(() => {
    setHoverMonth(null);
    const clamped = Math.min(11, Math.max(0, focusedMonthRef.current));
    commitFocusMonth(months[clamped]?.selectable ? clamped : nearestSelectableMonth(clamped, months));
  }, [year, months]);
  // A year arrow moves DOM focus onto the month cell that holds the single tab stop.
  React.useEffect(() => {
    const index = pendingMonthFocus.current;
    if (index === null) return;
    const node = monthNodes.current.get(index);
    if (!node) return;
    pendingMonthFocus.current = null;
    node.focus?.();
  }, [focusedMonth, months]);
  const tooltipMonth = hoverMonth ?? (focusInside ? months[focusedMonth]?.month ?? null : null);
  const emptyFill = emptyCellFill(tokens, palette);

  function handleKeyDown(event: unknown) {
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = () => (event as { preventDefault?: () => void } | null)?.preventDefault?.();
    if (key === "t" || key === "T") {
      prevent?.();
      onToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      const cell = months[focusedMonthRef.current];
      if (cell?.selectable) onEnterMonth(cell.month);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    prevent?.();
    setFocusInside(true);
    const next = nextSelectableMonth(focusedMonthRef.current, direction, columns, months);
    commitFocusMonth(next);
    moveMonthFocusTo(next);
  }

  const keyProps = platform === "web" ? ({ onKeyDown: handleKeyDown } as unknown as Partial<ViewProps>) : {};
  const width = `${100 / columns}%` as `${number}%`;

  return (
    <View
      testID="my-messages-calendar-year"
      accessibilityRole={GRID_ROLE}
      tabIndex={-1}
      onFocus={() => setFocusInside(true)}
      onBlur={() => setFocusInside(false)}
      {...keyProps}
      style={{ flexDirection: "row", flexWrap: "wrap" }}
    >
      {months.map((cell, index) => {
        const level = countLevel(cell.total, thresholds);
        const focused = index === focusedMonth;
        const quiet = cell.selectable && cell.total === 0;
        const background = quiet ? emptyFill : palette.backgrounds[level] ?? tokens.surface1;
        const wash = quiet ? null : palette.washes[level] ?? null;
        const color = quiet ? tokens.foreground : palette.text[level] ?? tokens.foreground;
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
              ref={node => registerMonth(index, node as unknown as FocusTarget | null)}
              tabIndex={focused && cell.selectable ? 0 : -1}
              onPress={() => onEnterMonth(cell.month)}
              onFocus={() => { commitFocusMonth(index); setFocusInside(true); }}
              onHoverIn={() => setHoverMonth(cell.month)}
              onHoverOut={() => setHoverMonth(null)}
              style={{
                minHeight: compact ? 56 : 64, borderRadius: 8, padding: 8, gap: 2,
                backgroundColor: background, opacity: cell.selectable ? 1 : 0.35,
                borderWidth: focused ? 2 : 1, borderColor: focused ? tokens.foreground : tokens.border,
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
