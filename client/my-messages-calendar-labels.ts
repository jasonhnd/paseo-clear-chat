import { DayKey, MonthKey, monthNumberOfKey, parseDayKey } from "./my-messages-calendar";

/**
 * Calendar labels built on the platform's `Intl` data, so English, Chinese and Japanese
 * month and weekday names follow the same language switch as the rest of the plugin.
 * Dates are formatted in UTC because a day key is already a calendar date, not an instant:
 * the machine's zone must not move "Nov 25" to "Nov 24".
 */

const UTC = "UTC";

function utcDate(day: DayKey): Date {
  const { year, month, day: dayOfMonth } = parseDayKey(day);
  return new Date(Date.UTC(year, month - 1, dayOfMonth));
}

function monthDate(month: MonthKey): Date {
  const year = Number(month.slice(0, 4));
  return new Date(Date.UTC(year, monthNumberOfKey(month) - 1, 1));
}

function format(locale: string, date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: UTC }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", { ...options, timeZone: UTC }).format(date);
  }
}

/** "November 2026" / "2026年11月". */
export function formatMonthTitle(locale: string, month: MonthKey): string {
  return format(locale, monthDate(month), { year: "numeric", month: "long" });
}

/** "Nov 25 Wed" / "11月25日 周三". */
export function formatDayLabel(locale: string, day: DayKey): string {
  const date = utcDate(day);
  return `${format(locale, date, { month: "short", day: "numeric" })} ${format(locale, date, { weekday: "short" })}`;
}

/** "Nov 25" without the weekday, for range labels. */
export function formatMonthDay(locale: string, day: DayKey): string {
  return format(locale, utcDate(day), { month: "short", day: "numeric" });
}

/** "November" in the year view. */
export function formatMonthName(locale: string, month: MonthKey): string {
  return format(locale, monthDate(month), { month: "long" });
}

/** "Mon", "周一", "月". */
export function formatWeekday(locale: string, mondayFirstIndex: number): string {
  const monday = new Date(Date.UTC(2024, 0, 1 + mondayFirstIndex));
  return format(locale, monday, { weekday: "short" });
}

/** "Nov 24–30", or both month names when the week crosses one. */
export function formatWeekRange(locale: string, week: readonly DayKey[]): string {
  const first = week[0];
  const last = week[week.length - 1];
  if (!first || !last) return "";
  const firstMonth = first.slice(0, 7);
  const lastMonth = last.slice(0, 7);
  if (firstMonth !== lastMonth) return `${formatMonthDay(locale, first)} – ${formatMonthDay(locale, last)}`;
  return `${formatMonthDay(locale, first)}–${parseDayKey(last).day}`;
}
