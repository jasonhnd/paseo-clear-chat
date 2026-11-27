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
import { formatDayLabel, formatMonthShort, formatMonthTitle, formatWeekday } from "../my-messages-calendar-labels";
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
/**
 * Ring plus the page-coloured seam, drawn inside the cell. Two pixels and a one pixel
 * seam keep the heat fill within six pixels of a neighbour. The month focus outline
 * is two pixels drawn one pixel outside the cell, leaving one pixel of the page
 * before the next cell. Year cells already have a six pixel gap, so that outline
 * stays two pixels out.
 */
const SELECTION_RING = 2;
const SELECTION_GAP = 1;
const FOCUS_RING = 2;
/** Reserved on every cell so today's dot does not change the row height. */
const MARK_SLOT = 4;
/**
 * Date line and the count line under it. Both are reserved on every day cell,
 * so a day with no messages does not sit its number lower than a counted neighbour.
 */
const DAY_LINE = 14;
const MONTH_FOCUS_OFFSET = 1;
const YEAR_FOCUS_OFFSET = 2;
/** Quiet year cells pad 8 inside a 1px border. The open month matches that inset. */
const YEAR_QUIET_PAD = 8;
const YEAR_CHOSEN_INNER = YEAR_QUIET_PAD - (SELECTION_RING + SELECTION_GAP - 1);
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

function hslOf(color: string): { h: number; s: number; l: number } | null {
  const read = readColor(color);
  if (!read) return null;
  const r = read.r / 255;
  const g = read.g / 255;
  const b = read.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const row = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round((value + m) * 255))).toString(16).padStart(2, "0");
  return `#${channel(row[0] ?? 0)}${channel(row[1] ?? 0)}${channel(row[2] ?? 0)}`;
}

const HEAT_EMPTY_GAP = 1.35;
const HEAT_STEP_GAP = 1.3;
const HEAT_STEP_GOAL = 1.4;
const SATURATION_TOLERANCE = 0.03;
const WASH_OPACITY = [0.42, 0.62, 0.8, 0.95];

/** Same hue and saturation as the accent, only the lightness moves, so the top step does not fade. */
function heatStops(
  empty: string,
  accent: string,
  dark: boolean,
  tokens: ExtendedThemeTokens,
  fallback: string,
): string[] {
  const tone = hslOf(accent);
  if (!tone) return [];
  const fills: string[] = [];
  let previous = empty;
  let previousS = 0;
  for (let level = 1; level <= 4; level += 1) {
    const floor = level === 1 ? HEAT_EMPTY_GAP : HEAT_STEP_GAP;
    const goal = level === 1 ? HEAT_EMPTY_GAP : HEAT_STEP_GOAL;
    const hueFloor = level === 1 && channelSpread(accent) >= 30 ? Math.min(48, channelSpread(accent) * 0.45) : 0;
    let found: string | null = null;
    for (const minGap of [goal, floor]) {
      for (let step = 1; step <= 70; step += 1) {
        const light = dark ? 0.03 + step * 0.01 : 0.86 - step * 0.01;
        const fill = fromHsl(tone.h, tone.s, light);
        const gap = directedGap(fill, previous, dark);
        if (gap === null || gap < minGap) continue;
        const next = hslOf(fill);
        if (fills.length > 0 && next && next.s + SATURATION_TOLERANCE < previousS) continue;
        if (hueFloor > 0 && channelSpread(fill) < hueFloor) continue;
        const readable = contrastOf(bestInk(fill, tokens, fallback), fill);
        if (readable === null || readable < 4.5) continue;
        found = fill;
        previousS = next?.s ?? previousS;
        break;
      }
      if (found) break;
    }
    const paint = found ?? mix(previous, dark ? "#ffffff" : "#000000", 0.45);
    fills.push(paint);
    previous = paint;
  }
  return fills;
}

/** A dot on today that stays readable on every heat fill, including an empty cell. */
export function todayMark(fill: string, tokens: ExtendedThemeTokens): string {
  const candidates = [tokens.foreground, tokens.accentForeground, "#111111", "#fafafa"];
  const unique = candidates.filter((color, index) => candidates.indexOf(color) === index);
  let best = tokens.foreground;
  let bestRatio = -1;
  for (const color of unique) {
    const ratio = contrastOf(color, fill);
    if (ratio !== null && ratio > bestRatio) {
      best = color;
      bestRatio = ratio;
    }
  }
  return best;
}

export interface MarkerRing {
  outer: string;
  inner: string | null;
}

/** A today or focus ring that clears both the cell fill and the page. Two bands when one colour cannot. */
export function markerRing(fill: string, page: string, tokens: ExtendedThemeTokens): MarkerRing {
  const candidates = [tokens.foreground, tokens.accentForeground, "#111111", "#fafafa"];
  const unique = candidates.filter((color, index) => candidates.indexOf(color) === index);
  const clears = (color: string, against: string) => {
    const ratio = contrastOf(color, against);
    return ratio !== null && ratio >= 3;
  };
  const single = unique.find(color => clears(color, fill) && clears(color, page));
  if (single) return { outer: single, inner: null };
  const outer = unique.find(color => clears(color, page)) ?? tokens.foreground;
  const inner = unique.find(color => clears(color, fill)) ?? (tokens.isDark ? "#111111" : "#fafafa");
  return { outer, inner };
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
  const empty = neutralStep(page, tokens.isDark);
  const accentParses = mix(tokens.surface0, tokens.accent, 0.5) !== tokens.surface0;
  const stops = accentParses ? heatStops(empty, tokens.accent, tokens.isDark, tokens, tokens.foreground) : [];
  for (let level = 0; level <= 4; level += 1) {
    const fallback = level >= 3 ? tokens.accentForeground : tokens.foreground;
    let fill = tokens.surface1;
    if (level === 0) {
      backgrounds.push(tokens.surface1);
      washes.push(null);
    } else if (accentParses) {
      fill = stops[level - 1] ?? empty;
      backgrounds.push(fill);
      washes.push(null);
    } else {
      backgrounds.push(tokens.surface0);
      washes.push(WASH_OPACITY[level - 1] ?? 0.95);
      const veiled = flattenColor(tokens.accent, page);
      const veil = veiled === null ? null : readColor(veiled);
      const base = readColor(page);
      const alpha = WASH_OPACITY[level - 1] ?? 0;
      fill = veil && base
        ? `rgb(${Math.round(base.r + (veil.r - base.r) * alpha)}, ${Math.round(base.g + (veil.g - base.g) * alpha)}, ${Math.round(base.b + (veil.b - base.b) * alpha)})`
        : tokens.surface0;
    }
    const painted = flattenColor(fill, page) ?? fill;
    text.push(bestInk(painted, tokens, fallback));
  }
  return { backgrounds, washes, text };
}

function keyFromEvent(event: unknown): string | null {
  const value = event as { key?: string; nativeEvent?: { key?: string } } | null;
  return value?.nativeEvent?.key ?? value?.key ?? null;
}

/**
 * Keep the bubble over its cell and inside the row.
 * Once the row has reported its width, left and width are pixels clamped to that row.
 * Before then, the first column sticks to the left, the last column sticks to the right,
 * and any column between them shifts by whole cells as a single percentage. The width
 * is the whole row, so the bubble cannot hang past either edge. No min, max or calc.
 */
function bubbleStyle(column: number, columns: number, rowWidth: number | null, tokens: ExtendedThemeTokens): ViewStyle {
  const base: ViewStyle = {
    position: "absolute", bottom: "100%", marginBottom: 6,
    paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, zIndex: 20,
    backgroundColor: tokens.surface2, borderWidth: 1, borderColor: tokens.border,
  };
  const index = column < 0 ? 0 : column > columns - 1 ? columns - 1 : column;
  if (rowWidth !== null && rowWidth > 0) {
    const width = rowWidth < TOOLTIP_WIDTH ? rowWidth : TOOLTIP_WIDTH;
    const cell = rowWidth / columns;
    const ideal = index * cell + cell / 2 - width / 2;
    const room = rowWidth - width;
    const rowLeft = ideal < 0 ? 0 : ideal > room ? room : ideal;
    return { ...base, width, left: rowLeft - index * cell };
  }
  const span = `${columns * 100}%` as ViewStyle["width"];
  if (index <= 0) return { ...base, left: 0, width: span };
  if (index >= columns - 1) return { ...base, right: 0, width: span };
  return { ...base, left: `${-index * 100}%` as ViewStyle["left"], width: span };
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

/** Same box on every cell. The dot is painted only for today, so a row stays level. */
function TodayMark({ color }: { color: string | null }) {
  return (
    <View testID="my-messages-calendar-mark-slot" style={{ width: MARK_SLOT, height: MARK_SLOT }}>
      {color ? (
        <View testID="my-messages-calendar-today-dot" style={{ width: MARK_SLOT, height: MARK_SLOT, borderRadius: MARK_SLOT / 2, backgroundColor: color }} />
      ) : null}
    </View>
  );
}

/**
 * Web only. Capture runs before the browser moves focus, including a press on a
 * disabled cell, a weekday header or a gap. Pressable's press-in is later and
 * does not fire for those targets, so it cannot hide the ring in time.
 */
function pointerKeyProps(
  platform: "ios" | "android" | "web",
  onKeyDown: (event: unknown) => void,
  pointerDown: React.MutableRefObject<boolean>,
  setKeysVisible: (visible: boolean) => void,
): Partial<ViewProps> {
  if (platform !== "web") return {};
  const release = () => { pointerDown.current = false; };
  return {
    onKeyDown,
    onPointerDownCapture: () => {
      pointerDown.current = true;
      setKeysVisible(false);
    },
    onPointerUpCapture: release,
    onPointerCancelCapture: release,
  } as unknown as Partial<ViewProps>;
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
  const [keysVisible, setKeysVisible] = React.useState(false);
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  const pointerDown = React.useRef(false);
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

  const dayLine = tokens.fs(DAY_LINE);
  const grid = buildMonthGrid(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const rows: Array<Array<DayKey | null>> = weekMode
    ? [buildWeek(weekAnchor)]
    : Array.from({ length: 6 }, (_, week) => grid.slice(week * 7, week * 7 + 7));
  const tooltipDay = hoverDay ?? (focusInside ? focusedDay : null);
  const emptyFill = emptyCellFill(tokens, palette);
  const page = flattenColor(tokens.surface0, "#ffffff") ?? tokens.surface0;

  function handleKeyDown(event: unknown) {
    pointerDown.current = false;
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = () => (event as { preventDefault?: () => void } | null)?.preventDefault?.();
    if (key === "t" || key === "T") {
      prevent?.();
      setKeysVisible(true);
      onToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      setKeysVisible(true);
      onSelect(focusedDayRef.current);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    const next = moveDay(focusedDayRef.current, direction);
    setKeysVisible(true);
    if (!selectableDay(next, firstDay, today)) return;
    prevent?.();
    setFocusInside(true);
    commitFocusDay(next);
    if (monthKeyOfDay(next) !== month) onMonthChange(monthKeyOfDay(next));
    if (weekMode && !buildWeek(weekAnchor).includes(next)) setWeekAnchor(next);
    moveFocusTo(next);
  }

  const keyProps = pointerKeyProps(platform, handleKeyDown, pointerDown, setKeysVisible);

  return (
    <View
      testID="my-messages-calendar-grid"
      accessibilityRole={GRID_ROLE}
      tabIndex={-1}
      onFocus={() => {
        setFocusInside(true);
        if (pointerDown.current) pointerDown.current = false;
        else setKeysVisible(true);
      }}
      onBlur={() => { setFocusInside(false); setKeysVisible(false); }}
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
        <View key={week} testID="my-messages-calendar-row" onLayout={event => {
          const width = event.nativeEvent.layout.width;
          if (width > 0) setRowWidth(current => current === width ? current : width);
        }} style={{ flexDirection: "row" }}>
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
            const showFocus = focused && keysVisible;
            const column = weekdayIndexMondayFirst(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));
            const label = countsKnown
              ? count > 0
                ? count === 1
                  ? t("myMessages.calendar.dayCellLabelOne", { date: formatDayLabel(locale, day) })
                  : t("myMessages.calendar.dayCellLabel", { date: formatDayLabel(locale, day), count })
                : t("myMessages.calendar.dayCellEmpty", { date: formatDayLabel(locale, day) })
              : formatDayLabel(locale, day);
            const quietDay = countsKnown && count === 0 && !disabled;
            const heatFill = quietDay ? emptyFill : palette.backgrounds[level] ?? tokens.surface1;
            const wash = quietDay ? null : palette.washes[level] ?? null;
            const color = palette.text[level] ?? tokens.foreground;
            const flatHeat = flattenColor(heatFill, page) ?? heatFill;
            const dot = isToday ? todayMark(flatHeat, tokens) : null;
            const focus = focused ? markerRing(flatHeat, page, tokens) : null;
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
                  onPressIn={() => {
                    if (platform !== "web") pointerDown.current = true;
                    setKeysVisible(false);
                  }}
                  onPress={() => { pointerDown.current = false; onSelect(day); }}
                  onFocus={() => { commitFocusDay(day); setFocusInside(true); }}
                  onHoverIn={() => setHoverDay(day)}
                  onHoverOut={() => setHoverDay(null)}
                  style={{
                    minHeight: compact ? 44 : 54, borderRadius: 6,
                    alignItems: "center", justifyContent: "center",
                    backgroundColor: selected ? page : heatFill, opacity: disabled ? 0.35 : 1,
                    borderWidth: selected ? SELECTION_RING : showFocus && focus?.inner ? 2 : 0,
                    borderStyle: selected ? "solid" : "dashed",
                    borderColor: selected ? tokens.foreground : focus?.inner ?? "transparent",
                    padding: selected ? SELECTION_GAP : 0,
                    paddingVertical: selected ? SELECTION_GAP : 3,
                    outlineWidth: showFocus ? FOCUS_RING : 0,
                    outlineStyle: "dashed",
                    outlineColor: showFocus ? focus?.outer ?? tokens.foreground : "transparent",
                    outlineOffset: MONTH_FOCUS_OFFSET,
                  }}
                >
                  {selected ? (
                    <View testID="my-messages-calendar-cell-fill" pointerEvents="none" style={{ position: "absolute", top: SELECTION_GAP, right: SELECTION_GAP, bottom: SELECTION_GAP, left: SELECTION_GAP, borderRadius: 3, backgroundColor: heatFill }}>
                      {wash !== null ? <LevelWash opacity={wash} color={tokens.accent} radius={3} /> : null}
                    </View>
                  ) : wash !== null ? <LevelWash opacity={wash} color={tokens.accent} radius={6} /> : null}
                  <View testID="my-messages-calendar-day-body" style={{ alignItems: "center", gap: 1 }}>
                    <View testID="my-messages-calendar-day-number" style={{ height: dayLine, justifyContent: "center" }}>
                      <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(11), lineHeight: dayLine, fontWeight: isToday ? "600" : "400", textAlign: "center", includeFontPadding: false }}>
                        {Number(day.slice(8, 10))}
                      </Text>
                    </View>
                    <View testID="my-messages-calendar-day-count" style={{ height: dayLine, justifyContent: "center" }}>
                      {countsKnown && count > 0 ? (
                        <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(11), lineHeight: dayLine, textAlign: "center", includeFontPadding: false }}>{count}</Text>
                      ) : null}
                    </View>
                    <TodayMark color={dot} />
                  </View>
                </Pressable>
                {showTooltip ? (
                  <View testID="my-messages-calendar-tooltip" pointerEvents="none" style={bubbleStyle(column, 7, rowWidth, tokens)}>
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
  /** The month the calendar is open on, `YYYY-MM`, not just a month index. */
  visibleMonth: MonthKey;
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
  today: DayKey;
}

export function CalendarYearView({
  year, months, visibleMonth, startMonth, thresholds, palette, tokens, locale, t, compact, platform, onEnterMonth, onToday, today,
}: YearViewProps) {
  const columns = compact ? 2 : 4;
  const [focusedMonth, setFocusedMonth] = React.useState(() => nearestSelectableMonth(Math.min(11, Math.max(0, startMonth)), months));
  const focusedMonthRef = React.useRef(focusedMonth);
  const [hoverMonth, setHoverMonth] = React.useState<MonthKey | null>(null);
  const [focusInside, setFocusInside] = React.useState(false);
  const [keysVisible, setKeysVisible] = React.useState(false);
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  const pointerDown = React.useRef(false);
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
  const yearPage = flattenColor(tokens.surface0, "#ffffff") ?? tokens.surface0;

  function handleKeyDown(event: unknown) {
    pointerDown.current = false;
    const key = keyFromEvent(event);
    if (!key) return;
    const prevent = () => (event as { preventDefault?: () => void } | null)?.preventDefault?.();
    if (key === "t" || key === "T") {
      prevent?.();
      setKeysVisible(true);
      onToday();
      return;
    }
    if (key === "Enter" || key === " ") {
      prevent?.();
      setKeysVisible(true);
      const cell = months[focusedMonthRef.current];
      if (cell?.selectable) onEnterMonth(cell.month);
      return;
    }
    const direction: DayDirection | null = key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right"
      : key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : null;
    if (!direction) return;
    prevent?.();
    setKeysVisible(true);
    setFocusInside(true);
    const next = nextSelectableMonth(focusedMonthRef.current, direction, columns, months);
    commitFocusMonth(next);
    moveMonthFocusTo(next);
  }

  const keyProps = pointerKeyProps(platform, handleKeyDown, pointerDown, setKeysVisible);
  const width = `${100 / columns}%` as `${number}%`;

  return (
    <View
      testID="my-messages-calendar-year"
      accessibilityRole={GRID_ROLE}
      tabIndex={-1}
      onFocus={() => {
        setFocusInside(true);
        if (pointerDown.current) pointerDown.current = false;
        else setKeysVisible(true);
      }}
      onBlur={() => { setFocusInside(false); setKeysVisible(false); }}
      onLayout={event => {
        const width = event.nativeEvent.layout.width;
        if (width > 0) setRowWidth(current => current === width ? current : width);
      }}
      {...keyProps}
      style={{ flexDirection: "row", flexWrap: "wrap" }}
    >
      {months.map((cell, index) => {
        const level = countLevel(cell.total, thresholds);
        const focused = index === focusedMonth;
        const showFocus = focused && keysVisible;
        const quiet = cell.selectable && cell.total === 0;
        const background = quiet ? emptyFill : palette.backgrounds[level] ?? tokens.surface1;
        const wash = quiet ? null : palette.washes[level] ?? null;
        const color = quiet ? tokens.foreground : palette.text[level] ?? tokens.foreground;
        const monthTitle = formatMonthTitle(locale, cell.month);
        const monthShort = formatMonthShort(locale, cell.month);
        const label = cell.total === 1
          ? t("myMessages.calendar.yearMonthLabelOne", { month: monthTitle, count: cell.total })
          : t("myMessages.calendar.yearMonthLabel", { month: monthTitle, count: cell.total });
        const tooltip = cell.total === 1
          ? t("myMessages.calendar.yearMonthLabelOne", { month: monthTitle, count: cell.total })
          : t("myMessages.calendar.yearMonthLabel", { month: monthTitle, count: cell.total });
        const showTooltip = tooltipMonth === cell.month;
        const chosen = cell.month === visibleMonth;
        const current = monthKeyOfDay(today) === cell.month;
        const flatMonth = flattenColor(background, yearPage) ?? background;
        const yearDot = current ? todayMark(flatMonth, tokens) : null;
        const yearFocus = focused ? markerRing(flatMonth, yearPage, tokens) : null;
        const monthBody = (
          <>
            <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(14), fontWeight: current ? "600" : "400" }}>{monthShort}</Text>
            <Text style={{ color, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>
              {cell.total === 1
                ? t("myMessages.calendar.monthTotalOne")
                : t("myMessages.calendar.monthTotal", { count: cell.total })}
            </Text>
            <TodayMark color={yearDot} />
          </>
        );
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
              onPressIn={() => {
                if (platform !== "web") pointerDown.current = true;
                setKeysVisible(false);
              }}
              onPress={() => { pointerDown.current = false; onEnterMonth(cell.month); }}
              onFocus={() => { commitFocusMonth(index); setFocusInside(true); }}
              onHoverIn={() => setHoverMonth(cell.month)}
              onHoverOut={() => setHoverMonth(null)}
              style={{
                minHeight: compact ? 56 : 64, borderRadius: 8, gap: 2,
                backgroundColor: chosen ? yearPage : background, opacity: cell.selectable ? 1 : 0.35,
                borderWidth: chosen ? SELECTION_RING : showFocus && yearFocus?.inner ? 2 : 1,
                borderStyle: chosen || !(showFocus && yearFocus?.inner) ? "solid" : "dashed",
                borderColor: chosen ? tokens.foreground : showFocus && yearFocus?.inner ? yearFocus.inner : tokens.border,
                padding: chosen ? SELECTION_GAP : YEAR_QUIET_PAD,
                outlineWidth: showFocus ? FOCUS_RING : 0,
                outlineStyle: "dashed",
                outlineColor: showFocus ? yearFocus?.outer ?? tokens.foreground : "transparent",
                outlineOffset: YEAR_FOCUS_OFFSET,
              }}
            >
              {chosen ? (
                <View testID="my-messages-calendar-month-fill" pointerEvents="none" style={{ position: "absolute", top: SELECTION_GAP, right: SELECTION_GAP, bottom: SELECTION_GAP, left: SELECTION_GAP, borderRadius: 5, backgroundColor: background }}>
                  {wash !== null ? <LevelWash opacity={wash} color={tokens.accent} radius={5} /> : null}
                </View>
              ) : wash !== null ? <LevelWash opacity={wash} color={tokens.accent} radius={6} /> : null}
              <View testID="my-messages-calendar-month-body" style={{ gap: 2, padding: chosen ? YEAR_CHOSEN_INNER : 0 }}>{monthBody}</View>
            </Pressable>
            {showTooltip ? (
              <View testID="my-messages-calendar-tooltip" pointerEvents="none" style={bubbleStyle(index % columns, columns, rowWidth, tokens)}>
                <Text style={{ color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(11) }}>{tooltip}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
