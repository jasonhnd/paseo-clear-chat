/**
 * Local-calendar arithmetic for the panel.
 *
 * "Today" means the reader's own calendar day on this device, not a UTC day and not a
 * rolling 24 hours. Day boundaries are built with the local calendar so a day that is 23
 * or 25 hours long (a daylight-saving change) still starts where the clock says it does.
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
