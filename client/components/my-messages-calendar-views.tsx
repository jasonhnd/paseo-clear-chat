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

function luminanceOf(color: string): number | null {
  const read = readColor(color);
  if (!read) return null;
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(read.r) + 0.7152 * linear(read.g) + 0.0722 * linear(read.b);
}

function contrastOf(first: string, second: string): number | null {
  const left = luminanceOf(first);
  const right = luminanceOf(second);
  if (left === null || right === null) return null;
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

const EMPTY_PAGE_CONTRAST = 1.16;

function onBusySide(color: string, than: string, dark: boolean): boolean {
  const left = luminanceOf(color);
  const right = luminanceOf(than);
  if (left === null || right === null) return false;
  return dark ? left > right : left < right;
}

/**
 * A neutral step from the page toward busier cells. Dark pages step toward white and
 * light pages step toward black, staying about 1.16:1 from the page so the cell reads
 * without leaving the gap between the page and the first heat level.
 */
function neutralStep(page: string, dark: boolean): string {
  const pageL = luminanceOf(page);
  if (pageL === null) return page;
  const toward = dark ? "#ffffff" : "#000000";
  let chosen = page;
  let closest = Number.POSITIVE_INFINITY;
  for (let step = 1; step <= 40; step += 1) {
    const fill = mix(page, toward, step / 40);
    const ratio = contrastOf(fill, page);
    const fillL = luminanceOf(fill);
    if (ratio === null || fillL === null) continue;
    if (!onBusySide(fill, page, dark) || ratio < 1.1 || ratio > 1.25) continue;
    const distance = Math.abs(ratio - EMPTY_PAGE_CONTRAST);
    if (distance < closest) {
      chosen = fill;
      closest = distance;
    }
  }
  return chosen;
}

function channelSpread(color: string): number {
  const read = readColor(color);
  if (!read) return 0;
  return Math.max(read.r, read.g, read.b) - Math.min(read.r, read.g, read.b);
}

function directedGap(fill: string, previous: string, dark: boolean): number | null {
  const fillL = luminanceOf(fill);
  const previousL = luminanceOf(previous);
  if (fillL === null || previousL === null) return null;
  if (dark) return fillL > previousL ? (fillL + 0.05) / (previousL + 0.05) : 0;
  return fillL < previousL ? (previousL + 0.05) / (fillL + 0.05) : 0;
}

/** Theme inks, or black / white when neither of those clears a bright or dark step. */
function bestInk(fill: string, tokens: ExtendedThemeTokens, fallback: string): string {
  const candidates = [tokens.foreground, tokens.accentForeground, "#111111", "#fafafa"];
  let best = fallback;
  let bestRatio = -1;
  for (const ink of candidates) {
    const ratio = contrastOf(ink, fill);
    if (ratio !== null && ratio > bestRatio) {
      best = ink;
      bestRatio = ratio;
    }
  }
  return best;
}

const HEAT_EMPTY_GAP = 1.35;
const HEAT_STEP_GAP = 1.3;
const HEAT_SELECTED_GAP = 1.15;
const WASH_OPACITY = [0.42, 0.62, 0.8, 0.95];

/**
 * One heat step past `previous`, toward the accent and then past it if the accent
 * is not far enough. The first step keeps the accent's saturation. The last step
 * stays off the selected accent so the two fills do not match.
 */
function heatStep(
  previous: string,
  accent: string,
  dark: boolean,
  tokens: ExtendedThemeTokens,
  fallback: string,
  minGap: number,
  requireHue: boolean,
  separateFrom: string | null,
): string {
  const pole = dark ? "#ffffff" : "#000000";
  const hueFloor = channelSpread(accent) >= 30 ? Math.min(48, channelSpread(accent) * 0.45) : 0;
  for (let nudge = 0; nudge <= 24; nudge += 1) {
    const target = nudge === 0 ? accent : mix(accent, pole, nudge / 24);
    for (let amount = 1; amount <= 48; amount += 1) {
      const fill = mix(previous, target, amount / 48);
      const gap = directedGap(fill, previous, dark);
      if (gap === null || gap < minGap) continue;
      if (requireHue && channelSpread(fill) < hueFloor) continue;
      const ratio = contrastOf(bestInk(fill, tokens, fallback), fill);
      if (ratio === null || ratio < 4.5) continue;
      if (separateFrom) {
        const apart = contrastOf(fill, separateFrom);
        if (apart === null || apart < HEAT_SELECTED_GAP) continue;
      }
      return fill;
    }
  }
  return mix(previous, pole, 0.85);
}

/** Background for a selectable cell with no messages: a neutral step off the page. */
export function emptyCellFill(tokens: ExtendedThemeTokens, _palette: LevelPalette): string {
  const page = flattenColor(tokens.surface0, "#ffffff") ?? tokens.surface0;
  return neutralStep(page, tokens.isDark);
}

/**
 * Four steps from the host accent, each far enough from the previous one to read as its
 * own shade. The first keeps the accent hue. A theme colour `mix` cannot parse falls
 * back to a stronger accent overlay at each step. The number uses whichever ink clears
 * the fill, including black or white when both theme inks are on the same side.
 */
export function buildLevelPalette(tokens: ExtendedThemeTokens): LevelPalette {
  const page = flattenColor(tokens.surface0, "#ffffff") ?? tokens.surface0;
  const backgrounds: Array<string | null> = [];
  const washes: Array<number | null> = [];
  const text: string[] = [];
  let previous = neutralStep(page, tokens.isDark);
  for (let level = 0; level <= 4; level += 1) {
    const fallback = level >= 3 ? tokens.accentForeground : tokens.foreground;
    let fill = tokens.surface1;
    if (level === 0) {
      backgrounds.push(tokens.surface1);
      washes.push(null);
    } else {
      const parsed = mix(tokens.surface0, tokens.accent, 0.5);
      if (parsed !== tokens.surface0) {
        fill = heatStep(
          previous,
          tokens.accent,
          tokens.isDark,
          tokens,
          fallback,
          level === 1 ? HEAT_EMPTY_GAP : HEAT_STEP_GAP,
          level === 1,
          level === 4 ? tokens.accent : null,
        );
        backgrounds.push(fill);
        washes.push(null);
      } else {
        backgrounds.push(tokens.surface0);
        washes.push(WASH_OPACITY[level - 1] ?? 0.95);
        const veiled = flattenColor(tokens.accent, page);
        const veil = veiled === null ? null : readColor(veiled);
        const base = readColor(page);
        fill = veil && base
          ? `rgb(${Math.round(base.r + (veil.r - base.r) * (WASH_OPACITY[level - 1] ?? 0))}, ${Math.round(base.g + (veil.g - base.g) * (WASH_OPACITY[level - 1] ?? 0))}, ${Math.round(base.b + (veil.b - base.b) * (WASH_OPACITY[level - 1] ?? 0))})`
          : tokens.surface0;
      }
    }
    const painted = flattenColor(fill, page) ?? fill;
    text.push(bestInk(painted, tokens, fallback));
    if (level > 0) previous = painted;
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
                    borderWidth: selected || focused || isToday ? 2 : 0,
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
