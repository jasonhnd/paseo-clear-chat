/**
 * Calendar arithmetic for the "What I said" screen.
 *
 * Every day is a local calendar day spelled `YYYY-MM-DD` on this device, never a UTC day.
 * The month grid starts on Monday, with empty cells before and after the month, so a
 * month always draws as six equal weeks. Pure functions only: the screen and its data
 * layer both build on this file, and it can be exercised without a host.
 */

export type DayKey = string;
/** `YYYY-MM`. Sorts and compares as a month. */
export type MonthKey = string;

export interface DayParts {
  year: number;
  /** 1-12, unlike `Date#getMonth`. */
  month: number;
  day: number;
}

export interface YearMonthCell {
  month: MonthKey;
  /** 1-12. */
  monthNumber: number;
  total: number;
  selectable: boolean;
}

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseDayKey(day: DayKey): DayParts {
  const match = DAY_KEY_PATTERN.exec(day);
  if (!match) throw new Error(`Not a local day: ${day}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatDayKey(year: number, month: number, day: number): DayKey {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Monday is 0, Sunday is 6. */
export function weekdayIndexMondayFirst(year: number, month: number, day: number): number {
  return (new Date(year, month - 1, day).getDay() + 6) % 7;
}

export function monthKeyOfDay(day: DayKey): MonthKey {
  const { year, month } = parseDayKey(day);
  return `${String(year).padStart(4, "0")}-${pad2(month)}`;
}

export function yearOfDay(day: DayKey): number {
  return parseDayKey(day).year;
}

export function monthNumberOfKey(month: MonthKey): number {
  const match = MONTH_KEY_PATTERN.exec(month);
  if (!match) throw new Error(`Not a month: ${month}`);
  return Number(match[2]);
}

/** The local calendar day of `at`, spelled as a day key. */
export function localDayKey(at: number): DayKey {
  const date = new Date(at);
  return formatDayKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function todayKey(now: number = Date.now()): DayKey {
  return localDayKey(now);
}

/**
 * Add calendar days. `Date` normalises month and year overflow, so
 * 2026-12-31 + 1 is 2027-01-01 and leap days land where the calendar says.
 */
export function addDays(day: DayKey, delta: number): DayKey {
  const { year, month, day: dayOfMonth } = parseDayKey(day);
  const date = new Date(year, month - 1, dayOfMonth + delta);
  return formatDayKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Add months to a month key, carrying the year in both directions. */
export function addMonths(month: MonthKey, delta: number): MonthKey {
  const match = MONTH_KEY_PATTERN.exec(month);
  if (!match) throw new Error(`Not a month: ${month}`);
  const date = new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1);
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}`;
}

/**
 * Six Monday-first weeks, with `null` before the first day and after the last.
 * A fixed height keeps the selected-day list from jumping as months change.
 */
export function buildMonthGrid(year: number, month: number): Array<DayKey | null> {
  const cells: Array<DayKey | null> = Array.from({ length: 42 }, () => null);
  const offset = weekdayIndexMondayFirst(year, month, 1);
  const count = daysInMonth(year, month);
  for (let index = 0; index < count; index += 1) {
    cells[offset + index] = formatDayKey(year, month, index + 1);
  }
  return cells;
}

/** The Monday-first week that contains `day`. */
export function buildWeek(day: DayKey): DayKey[] {
  const { year, month, day: dayOfMonth } = parseDayKey(day);
  const monday = addDays(day, -weekdayIndexMondayFirst(year, month, dayOfMonth));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export type DayDirection = "left" | "right" | "up" | "down";

/** Arrow-key movement in the month grid: one day across, one week up or down. */
export function moveDay(day: DayKey, direction: DayDirection): DayKey {
  switch (direction) {
    case "left": return addDays(day, -1);
    case "right": return addDays(day, 1);
    case "up": return addDays(day, -7);
    case "down": return addDays(day, 7);
  }
}

export function selectableDay(day: DayKey, firstDay: DayKey | null, today: DayKey): boolean {
  if (day > today) return false;
  return firstDay === null || day >= firstDay;
}

/**
 * Three thresholds that split positive daily counts into four levels.
 *
 * Nearest-rank quartiles: with five values the thresholds are the 2nd, 3rd and 4th
 * smallest, so ties stay stable and every positive count lands in 1-4. No history yet
 * means every positive count is level 1 rather than an arbitrary level 4.
 */
export function quartileThresholds(values: readonly number[]): [number, number, number] {
  const positive = values.filter(value => value > 0).sort((left, right) => left - right);
  if (!positive.length) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const at = (quantile: number) => {
    const index = Math.min(positive.length - 1, Math.max(0, Math.ceil(quantile * positive.length) - 1));
    return positive[index] ?? Number.POSITIVE_INFINITY;
  };
  return [at(0.25), at(0.5), at(0.75)];
}

/** 0 = no messages, 1-4 = increasingly busy. */
export function countLevel(count: number, thresholds: readonly [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  const [first, second, third] = thresholds;
  if (count <= first) return 1;
  if (count <= second) return 2;
  if (count <= third) return 3;
  return 4;
}

/** Sum daily counts by local month. */
export function monthTotals(days: readonly { day: DayKey; count: number }[]): Record<MonthKey, number> {
  const totals: Record<MonthKey, number> = {};
  for (const { day, count } of days) {
    if (count <= 0) continue;
    const month = monthKeyOfDay(day);
    totals[month] = (totals[month] ?? 0) + count;
  }
  return totals;
}

/**
 * The twelve cells of a year view. Months before the first recorded day and months
 * after the current one are not selectable; without a first day only the future is.
 */
export function buildYear(
  year: number,
  totals: Readonly<Record<MonthKey, number>>,
  firstDay: DayKey | null,
  today: DayKey,
): YearMonthCell[] {
  const firstMonth = firstDay === null ? null : monthKeyOfDay(firstDay);
  const currentMonth = monthKeyOfDay(today);
  return Array.from({ length: 12 }, (_, index) => {
    const month = `${String(year).padStart(4, "0")}-${pad2(index + 1)}`;
    return {
      month,
      monthNumber: index + 1,
      total: totals[month] ?? 0,
      selectable: (firstMonth === null || month >= firstMonth) && month <= currentMonth,
    };
  });
}

/** Arrow-key movement in the year view's 4- or 2-column month grid. */
export function moveMonthFocus(index: number, direction: DayDirection, columns: number): number {
  const next = direction === "left" ? index - 1
    : direction === "right" ? index + 1
    : direction === "up" ? index - columns
    : index + columns;
  return Math.min(11, Math.max(0, next));
}
