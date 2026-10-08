import { HttpError } from './errors';

/**
 * The time the portal sends as `current_time` with every check. It is the server's clock plus an offset
 * that only the demo-clock switch (decision 14, off by default) lets the presenter move.
 */
export class DemoClock {
  private offset = 0;

  constructor(
    readonly enabled: boolean,
    private readonly realNow: () => number = Date.now,
  ) {}

  now(): number {
    return this.realNow() + this.offset;
  }

  offsetMs(): number {
    return this.offset;
  }

  advance(ms: number): void {
    this.assertEnabled();
    this.offset += ms;
  }

  reset(): void {
    this.assertEnabled();
    this.offset = 0;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new HttpError(409, 'The demo clock is switched off');
  }
}
