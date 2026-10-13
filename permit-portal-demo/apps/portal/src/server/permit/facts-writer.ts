import type { UserAttributes } from '#src/server/model';
import type { EventLog } from '#src/server/events';
import { timedWrite } from '#src/server/permit/writes';

export interface UsersApi { get(key: string): Promise<{ attributes?: object | null }>; update(key: string, d: { attributes: object }): Promise<unknown> }
export interface FactsUpdate { attributes: UserAttributes; ms: number; skipped: boolean }

/**
 * The single writer of user attributes. Permit replaces a user's whole attribute set on every update, so
 * each change reads the current set, applies one mutation and writes the full set back, one change per user at
 * a time. A trust-fact flip therefore never erases a grant entry, and a grant never erases a trust fact.
 */
export class FactsWriter {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly users: UsersApi,
    private readonly events: EventLog,
  ) {}

  update(userKey: string, what: string, mutate: (a: UserAttributes) => UserAttributes): Promise<FactsUpdate> {
    const prev = this.tails.get(userKey) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async (): Promise<FactsUpdate> => {
      // Permit SDK: api.users.get(key) reads the user's current attributes.
      const current = structuredClone(((await this.users.get(userKey)).attributes ?? {}) as UserAttributes);
      const next = mutate(structuredClone(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return { attributes: current, ms: 0, skipped: true };
      // Permit SDK: api.users.update(key, { attributes }) stores the new attribute set: a grant entry or Great Eagle's
      // trust facts. It returns once the local PDP holds the change, and the next check uses it.
      const { ms } = await timedWrite(this.events, `${what} (${userKey})`, () => this.users.update(userKey, { attributes: next }));
      return { attributes: next, ms, skipped: false };
    });
    this.tails.set(userKey, run);
    void run.finally(() => { if (this.tails.get(userKey) === run) this.tails.delete(userKey); }).catch(() => undefined);
    return run;
  }
}
