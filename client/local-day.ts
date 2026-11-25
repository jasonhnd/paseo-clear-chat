/**
 * Local-calendar arithmetic for the panel.
 *
 * "Today" means the reader's own calendar day on this device, not a UTC day and not a
 * rolling 24 hours. Day boundaries are built with the local calendar so a day that is 23
 * or 25 hours long (a daylight-saving change) still starts where the clock says it does.
 *
 * The panel remembers the days it covers as date keys (`YYYY-MM-DD`) rather than as day
 * counts: a count turns into the wrong day the moment midnight passes, while a date keeps
 * pointing at the day the reader asked for.
 */

/** Midnight at the start of the local day that contains `at`. */
export function startOfLocalDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The same clock time `days` local days away; negative counts backwards. */
export function shiftLocalDays(at: number, days: number): number {
  const date = new Date(at);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ).getTime();
}

/** The local day start `days` days before the day that contains `at`. */
export function localDayStartBefore(at: number, days: number): number {
  return startOfLocalDay(shiftLocalDays(startOfLocalDay(at), -days));
}

/** `HH:MM` on the reader's clock. */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The local calendar day of `at`, as `YYYY-MM-DD`. Sorts and compares as a date. */
export function localDateKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Midnight at the start of the local day named by `key`, or NaN when the key is not a date. */
export function localDayStartFor(key: string): number {
  const parts = key.split("-").map(Number);
  if (parts.length !== 3) return Number.NaN;
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return Number.NaN;
  return new Date(year, month - 1, day).getTime();
}

/** The day before `key`. */
export function previousLocalDateKey(key: string): string {
  const start = localDayStartFor(key);
  return localDateKey(Number.isFinite(start) ? shiftLocalDays(start, -1) : Date.now());
}

/** The day after `key`. */
export function nextLocalDateKey(key: string): string {
  const start = localDayStartFor(key);
  return localDateKey(Number.isFinite(start) ? shiftLocalDays(start, 1) : Date.now());
}

/** How many local days `fromKey` through `toKey` cover, both ends included. */
export function localDaySpan(fromKey: string, toKey: string): number {
  const from = localDayStartFor(fromKey);
  const to = localDayStartFor(toKey);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 1;
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}
