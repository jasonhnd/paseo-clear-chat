/**
 * Local-calendar arithmetic for the "What I said" screen.
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

/** The next midnight on the local calendar, including across daylight-saving changes. */
export function startOfNextLocalDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
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
