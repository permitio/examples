import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanupJob } from '#src/cleanup-job';
import type { CleanupResult } from '#src/portal-notifier';

const T0 = Date.parse('2026-10-05T09:00:00.000Z');
const INTERVAL = 60_000;

const cleanupJob = (runCleanup: () => Promise<CleanupResult>) =>
  new CleanupJob(INTERVAL, { runCleanup }, () => Date.now());

describe('CleanupJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has no last run and no next run until it is started', () => {
    expect(cleanupJob(async () => ({ removed: 0 })).status()).toEqual({
      intervalMs: INTERVAL,
      lastRunAt: null,
      nextRunAt: null,
      lastRemoved: null,
      lastError: null,
    });
  });

  it('start() runs the cleanup every intervalMs and moves nextRunAt on after each run', async () => {
    const runCleanup = vi.fn(async (): Promise<CleanupResult> => ({ removed: 0 }));
    const job = cleanupJob(runCleanup);
    job.start();
    expect(job.status().nextRunAt).toBe(T0 + INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(runCleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(job.status()).toMatchObject({ lastRunAt: T0 + INTERVAL, nextRunAt: T0 + 2 * INTERVAL });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(runCleanup).toHaveBeenCalledTimes(2);
    expect(job.status()).toMatchObject({
      lastRunAt: T0 + 2 * INTERVAL,
      nextRunAt: T0 + 3 * INTERVAL,
    });

    job.start(); // already started: no second schedule
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(runCleanup).toHaveBeenCalledTimes(3);

    job.stop();
    expect(job.status().nextRunAt).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(runCleanup).toHaveBeenCalledTimes(3);
  });

  it('runNow() calls the portal once and records what it removed', async () => {
    const runCleanup = vi.fn(async (): Promise<CleanupResult> => ({ removed: 3 }));
    const job = cleanupJob(runCleanup);
    vi.setSystemTime(T0 + 5_000);
    expect(await job.runNow()).toEqual({ removed: 3 });
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(job.status()).toEqual({
      intervalMs: INTERVAL,
      lastRunAt: T0 + 5_000,
      nextRunAt: null,
      lastRemoved: 3,
      lastError: null,
    });
  });

  it('makes one call for overlapping runNow() calls, such as a double click', async () => {
    let finish: (result: CleanupResult) => void = () => undefined;
    const runCleanup = vi.fn(
      () =>
        new Promise<CleanupResult>((resolve) => {
          finish = resolve;
        }),
    );
    const job = cleanupJob(runCleanup);
    const first = job.runNow();
    const second = job.runNow();
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    finish({ removed: 1 });
    expect(await Promise.all([first, second])).toEqual([{ removed: 1 }, { removed: 1 }]);
    expect(runCleanup).toHaveBeenCalledTimes(1);
    const later = job.runNow(); // the first run has finished, so this is a new one
    finish({ removed: 0 });
    expect(await later).toEqual({ removed: 0 });
    expect(runCleanup).toHaveBeenCalledTimes(2);
  });

  it('records a failing portal in lastError, and the schedule carries on', async () => {
    const runCleanup = vi
      .fn<() => Promise<CleanupResult>>()
      .mockResolvedValueOnce({ removed: 1 })
      .mockResolvedValueOnce({ error: 'portal unreachable: ECONNREFUSED' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ removed: 2 });
    const job = cleanupJob(runCleanup);
    job.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(job.status()).toMatchObject({ lastRemoved: 1, lastError: null });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    // The failed run's count is unknown, so the previous run's count is not shown as if it were
    // this one's.
    expect(job.status()).toEqual({
      intervalMs: INTERVAL,
      lastRunAt: T0 + 2 * INTERVAL,
      nextRunAt: T0 + 3 * INTERVAL,
      lastRemoved: null,
      lastError: 'portal unreachable: ECONNREFUSED',
    });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(job.status()).toMatchObject({ lastError: 'boom', nextRunAt: T0 + 4 * INTERVAL });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(runCleanup).toHaveBeenCalledTimes(4);
    expect(job.status()).toMatchObject({ lastRemoved: 2, lastError: null });
    job.stop();
  });

  it('reset() forgets the last run and restarts the countdown from now', async () => {
    const runCleanup = vi.fn(async (): Promise<CleanupResult> => ({ removed: 2 }));
    const job = cleanupJob(runCleanup);
    job.start();
    await vi.advanceTimersByTimeAsync(INTERVAL + 10_000);
    job.reset();
    const restartedAt = T0 + INTERVAL + 10_000;
    expect(job.status()).toEqual({
      intervalMs: INTERVAL,
      lastRunAt: null,
      nextRunAt: restartedAt + INTERVAL,
      lastRemoved: null,
      lastError: null,
    });
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(runCleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCleanup).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it('reset() leaves a stopped job stopped', () => {
    const job = cleanupJob(async () => ({ removed: 0 }));
    job.reset();
    expect(job.status().nextRunAt).toBeNull();
  });
});
