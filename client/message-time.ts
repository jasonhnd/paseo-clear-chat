/**
 * Matches `utils/time.ts:formatMessageTimestamp`: bare time today, weekday and
 * time within the week, and a dated label beyond it.
 */
export function formatReplyTime(date: Date, now: Date = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return time;

  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days >= 0 && days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  }

  const label = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${label} ${time}`;
}
