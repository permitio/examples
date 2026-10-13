import { formatCountdown, formatWhen } from '@/format';
import { useMeta, useNow } from '@/hooks';

// A quarter-second tick keeps the display within 250 ms of the real boundary, so "expired" appears
// when access actually ends rather than up to a second later.
const TICK_MS = 250;

/**
 * Live time left before `until` (epoch ms). Grant expiries are written on the portal's demo clock,
 * so `demoClock` counts them down against that clock's offset; the cleanup job runs on real time.
 */
export function Countdown({
  until,
  demoClock = false,
  pastLabel = 'expired',
}: {
  until: number | null | undefined;
  demoClock?: boolean;
  /** Shown once the moment has passed. */
  pastLabel?: string;
}) {
  const meta = useMeta();
  const now = useNow(TICK_MS);
  if (typeof until !== 'number' || !Number.isFinite(until)) return <span className="font-bold">—</span>;
  const left = until - (now + (demoClock ? meta.demoClock.offsetMs : 0));
  return (
    <time className={left < 0 ? 'font-bold text-muted-foreground' : 'font-bold tabular-nums'} dateTime={new Date(until).toISOString()} title={formatWhen(until)}>
      {left < 0 ? pastLabel : formatCountdown(left)}
    </time>
  );
}
