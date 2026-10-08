import type { CleanupResult, PortalNotifier } from './portal-notifier';

export const DEFAULT_CLEANUP_INTERVAL_MS = 600_000;

/** Times are epoch ms; null means "not yet" (or, for nextRunAt, that the job is stopped). */
export interface CleanupStatus { intervalMs: number; lastRunAt: number | null; nextRunAt: number | null; lastRemoved: number | null; lastError: string | null }

/**
 * Housekeeping that asks the portal to remove expired grant entries, every `intervalMs`. It is not the security control:
 * a grant stops working at its expiry whether or not this has run. A failed run is recorded and the schedule carries on.
 */
export class CleanupJob {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextRunAt: number | null = null;
  private lastRunAt: number | null = null;
  private lastRemoved: number | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<CleanupResult> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly notifier: Pick<PortalNotifier, 'runCleanup'>,
    private readonly now: () => number,
  ) {}

  /** Schedules a run every intervalMs from now. Starting a started job changes nothing. */
  start(): void {
    if (this.timer === undefined) this.schedule();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = null;
  }

  /** Forgets the last run and, when the job is started, restarts the countdown at the full interval. */
  reset(): void {
    this.lastRunAt = null;
    this.lastRemoved = null;
    this.lastError = null;
    if (this.timer !== undefined) {
      this.stop();
      this.schedule();
    }
  }

  /** Runs the cleanup now. A call made while a run is in flight shares that run instead of starting another. */
  runNow(): Promise<CleanupResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  status(): CleanupStatus {
    return { intervalMs: this.intervalMs, lastRunAt: this.lastRunAt, nextRunAt: this.nextRunAt, lastRemoved: this.lastRemoved, lastError: this.lastError };
  }

  private schedule(): void {
    this.nextRunAt = this.now() + this.intervalMs;
    this.timer = setTimeout(() => {
      this.schedule();
      void this.runNow();
    }, this.intervalMs);
  }

  private async run(): Promise<CleanupResult> {
    const startedAt = this.now();
    const result = await this.notifier.runCleanup().catch((error: unknown): CleanupResult => ({ error: error instanceof Error ? error.message : String(error) }));
    this.lastRunAt = startedAt;
    if ('error' in result) {
      this.lastRemoved = null;
      this.lastError = result.error;
    } else {
      this.lastRemoved = result.removed;
      this.lastError = null;
    }
    return result;
  }
}
