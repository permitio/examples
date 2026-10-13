import { permitUnreachable, statusOf } from '#src/server/errors';
import type { EventLog } from '#src/server/events';

export class WriteFailedError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

export function describeWriteError(e: unknown): string {
  if (statusOf(e) === 424) return 'The PDP did not confirm this change within 5 seconds.';
  return permitUnreachable(e) ?? (e instanceof Error ? e.message : String(e));
}

/** Records a failed write for the decision panel and answers the error the route throws. */
function failedWrite(events: EventLog, what: string, ms: number, e: unknown): WriteFailedError {
  const error = describeWriteError(e);
  events.push({ kind: 'write', at: Date.now(), what, ms, ok: false, error });
  return new WriteFailedError(error, statusOf(e));
}

/**
 * Runs one waited write, records it for the decision panel and measures how long the PDP took to
 * apply it.
 */
export async function timedWrite<T>(
  events: EventLog,
  what: string,
  fn: () => Promise<T>,
): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  try {
    const result = await fn();
    const ms = performance.now() - start;
    events.push({ kind: 'write', at: Date.now(), what, ms, ok: true });
    return { result, ms };
  } catch (e) {
    throw failedWrite(events, what, performance.now() - start, e);
  }
}

/**
 * A waited write inside a multi-write flow that a retry repeats after a 424. The PDP may not have
 * confirmed a write that still landed, so the repeat may meet Permit's `alreadyDone` answer (409
 * for a create, 404 for an unassign): the step is done, and is recorded as "… (already done)".
 * Permit takes a repeated role on one resource with success, so that repeat is simply written and
 * confirmed again; its 409 stays a tolerated answer. Answers how long the write took.
 */
export async function resumableWrite(
  events: EventLog,
  what: string,
  alreadyDone: 404 | 409,
  fn: () => Promise<unknown>,
): Promise<number> {
  const start = performance.now();
  let done = what;
  try {
    await fn();
  } catch (e) {
    if (statusOf(e) !== alreadyDone) throw failedWrite(events, what, performance.now() - start, e);
    done = `${what} (already done)`;
  }
  const ms = performance.now() - start;
  events.push({ kind: 'write', at: Date.now(), what: done, ms, ok: true });
  return ms;
}
