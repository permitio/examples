const MINUTE = 60_000;

const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
const day = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * When something happened, as people say it: "Just now", "5 mins ago", "Today · 09:05 AM",
 * "Yesterday · 11:40 PM", or "08 Nov 26 · 09:05 AM".
 */
export function formatTime(iso: string, now: Date): string {
  const when = new Date(iso);
  const elapsed = now.getTime() - when.getTime();
  if (elapsed < MINUTE) return 'Just now';
  if (elapsed < 60 * MINUTE) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  }
  const time = clock.format(when);
  const today = startOfDay(now).getTime();
  const whenDay = startOfDay(when).getTime();
  if (whenDay === today) return `Today · ${time}`;
  if (whenDay === startOfDay(new Date(today - 1)).getTime()) return `Yesterday · ${time}`;
  return `${day.format(when)} · ${time}`;
}
